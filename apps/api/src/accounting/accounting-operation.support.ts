import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import {
  accountingDefaultSegregationPolicy,
  type AccountingSegregationPolicy,
} from "./accounting.constants.js";

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,200}$/;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

@Injectable()
export class AccountingOperationSupport {
  public constructor(
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  public context(): { readonly actorId: string; readonly companyId: string } {
    return {
      actorId: this.identities.current().identityId,
      companyId: this.tenants.current().companyId,
    };
  }

  public assertPermission(permission: string): void {
    this.assertAnyPermission(permission);
  }

  /**
   * The actor's permissions, for a service that must PASS them to a decider
   * rather than assert one itself.
   *
   * Balance override authorisation is BalanceControlService's rule, keyed on a
   * permission name held in the Company policy. This hands over the raw set so
   * that rule stays in one place; it deliberately does not apply the
   * `users_roles.manage` escalation the assertions above use, because whether a
   * super-permission authorises a negative balance is the policy's question to
   * answer, not this accessor's to presume.
   */
  public permissions(): readonly string[] {
    return [...this.identities.current().permissions];
  }

  /**
   * Non-throwing permission probe, for deciding whether a response may carry
   * technical fields (internal identifiers, mapping keys) rather than whether
   * the operation is allowed at all.
   */
  public hasAnyPermission(...required: readonly string[]): boolean {
    const permissions = this.identities.current().permissions;
    return (
      required.some((permission) => permissions.has(permission)) ||
      permissions.has("users_roles.manage")
    );
  }

  public assertAnyPermission(...required: readonly string[]): void {
    const permissions = this.identities.current().permissions;
    if (
      !required.some((permission) => permissions.has(permission)) &&
      !permissions.has("users_roles.manage")
    ) {
      throw new ApplicationException(
        "accounting_permission_denied",
        "The authenticated account cannot perform this Accounting operation",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  public requestHash(payload: unknown): string {
    return createHash("sha256").update(canonicalJson(payload)).digest("hex");
  }

  public async reserveIdempotency<TResponse = unknown>(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly idempotencyKey: string | undefined;
      readonly operation: string;
      readonly payload: unknown;
    },
  ): Promise<{ readonly replayResourceId?: string; readonly replayResponse?: TResponse }> {
    const { companyId } = this.context();
    const key = input.idempotencyKey?.trim() ?? "";
    if (!idempotencyKeyPattern.test(key)) {
      throw new ApplicationException(
        "accounting_idempotency_conflict",
        "A valid idempotency key is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const requestHash = this.requestHash(input.payload);
    const inserted = await sql<{ id: string }>`
      insert into idempotency_records (
        company_id, operation, idempotency_key, request_hash, expires_at
      ) values (
        ${companyId}::uuid, ${input.operation}, ${key}, ${requestHash},
        now() + interval '24 hours'
      )
      on conflict (company_id, operation, idempotency_key) do nothing
      returning id
    `.execute(database);
    if (inserted.rows[0] !== undefined) return {};

    const existing = await sql<{
      requestHash: string;
      resourceId: string | null;
      responseBody: TResponse | null;
    }>`
      select request_hash as "requestHash", resource_id as "resourceId",
             response_body as "responseBody"
        from idempotency_records
       where company_id = ${companyId}::uuid
         and operation = ${input.operation} and idempotency_key = ${key}
       for update
    `.execute(database);
    const record = existing.rows[0];
    if (record === undefined || record.requestHash !== requestHash) {
      throw new ApplicationException(
        "accounting_idempotency_payload_mismatch",
        "This idempotency key was already used with different Accounting details",
        HttpStatus.CONFLICT,
      );
    }
    if (record.resourceId === null) {
      throw new ApplicationException(
        "accounting_operation_already_completed",
        "This Accounting operation is already being processed",
        HttpStatus.CONFLICT,
      );
    }
    return {
      replayResourceId: record.resourceId,
      ...(record.responseBody === null ? {} : { replayResponse: record.responseBody }),
    };
  }

  public async completeIdempotency(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly idempotencyKey: string;
      readonly operation: string;
      readonly resourceId: string;
      readonly resourceType: string;
      readonly responseBody: unknown;
    },
  ): Promise<void> {
    const { companyId } = this.context();
    await sql`
      update idempotency_records
         set response_status = 200, resource_type = ${input.resourceType},
             resource_id = ${input.resourceId}::uuid,
             response_body = ${JSON.stringify(input.responseBody)}::jsonb,
             completed_at = now()
       where company_id = ${companyId}::uuid
         and operation = ${input.operation}
         and idempotency_key = ${input.idempotencyKey.trim()}
    `.execute(database);
  }

  public async audit(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly action: string;
      readonly after: object;
      readonly correlationId: string;
      readonly subjectId: string;
      readonly subjectType: string;
    },
  ): Promise<void> {
    const { actorId, companyId } = this.context();
    await this.history.audit(database, { ...input, actorId, companyId });
  }

  /**
   * The Company's Segregation of Duties policy. A Company with no Accounting
   * configuration row falls back to the module default.
   *
   * Read through `to_jsonb(c)->>'segregation_policy'` rather than naming the
   * column directly, so this resolves whether or not
   * `20260803110000_accounting_segregation_policy` has been applied yet: a
   * missing column simply yields a missing JSON key, and the default is used.
   * Naming the column would raise `undefined_column` and take down every
   * approval, posting, payment, confirmation and reversal in the module on any
   * database that is one migration behind — an optional setting must never be
   * able to do that.
   */
  public async segregationPolicy(
    database: Kysely<DatabaseSchema>,
  ): Promise<AccountingSegregationPolicy> {
    const { companyId } = this.context();
    const result = await sql<{ policy: string | null }>`
      select to_jsonb(c)->>'segregation_policy' as policy
        from accounting_configurations c
       where c.company_id = ${companyId}::uuid
    `.execute(database);
    const policy = result.rows[0]?.policy;
    return policy === "strict" || policy === "conditional" || policy === "single_user"
      ? policy
      : accountingDefaultSegregationPolicy;
  }

  /**
   * Whether a second authorized user must take over a step the current actor
   * is not allowed to perform alone. Every Segregation of Duties rule in the
   * module — approve, post, pay, confirm a Movement, reverse — asks this one
   * question, so it is also the single place the Company policy is applied.
   *
   * - `single_user`: never — one accountant performs every step.
   * - `strict`: always — dual control is required even when nobody else is
   *   currently available, so the record waits for a second person.
   * - `conditional`: only while another active, authorized account exists, so
   *   a record can never wait on a person who does not exist.
   *
   * The actor is recorded on the record and in `audit_events` under every
   * policy.
   */
  public async hasAlternateAuthorizedActor(
    database: Kysely<DatabaseSchema>,
    permission: string,
  ): Promise<boolean> {
    const policy = await this.segregationPolicy(database);
    if (policy === "single_user") return false;
    if (policy === "strict") return true;
    const { actorId, companyId } = this.context();
    const result = await sql<{ available: boolean }>`
      select exists (
        select 1
          from accounts a
          join account_roles ar
            on ar.account_id = a.id and ar.company_id = a.company_id
          join roles r
            on r.id = ar.role_id and r.company_id = ar.company_id and r.is_active
          join role_permissions rp
            on rp.role_id = r.id
         where a.company_id = ${companyId}::uuid
           and a.id <> ${actorId}::uuid and a.status = 'active'
           and rp.permission_code in (${permission}, 'users_roles.manage')
      ) as available
    `.execute(database);
    return result.rows[0]?.available ?? false;
  }

  public async enforceApprovalSegregation(
    database: Kysely<DatabaseSchema>,
    createdBy: string,
  ): Promise<void> {
    const { actorId } = this.context();
    if (
      actorId === createdBy &&
      (await this.hasAlternateAuthorizedActor(database, "accounting.approve"))
    ) {
      throw new ApplicationException(
        "accounting_journal_approval_conflict",
        "Another authorized Accounting user must approve this record",
        HttpStatus.CONFLICT,
      );
    }
  }

  public async enforcePostingSegregation(
    database: Kysely<DatabaseSchema>,
    approvedBy: string | null,
  ): Promise<void> {
    const { actorId } = this.context();
    if (
      approvedBy === actorId &&
      (await this.hasAlternateAuthorizedActor(database, "accounting.post"))
    ) {
      throw new ApplicationException(
        "accounting_journal_posting_segregation_conflict",
        "Another authorized Accounting user must post this record",
        HttpStatus.CONFLICT,
      );
    }
  }

  public async enforceReversalSegregation(
    database: Kysely<DatabaseSchema>,
    record: {
      readonly approvedBy: string | null;
      readonly createdBy: string;
      readonly postedBy: string | null;
    },
  ): Promise<void> {
    const { actorId } = this.context();
    if (
      record.createdBy === actorId &&
      record.approvedBy === actorId &&
      record.postedBy === actorId &&
      (await this.hasAlternateAuthorizedActor(database, "accounting.reverse"))
    ) {
      throw new ApplicationException(
        "accounting_journal_reversal_conflict",
        "Another authorized Accounting user must reverse this record",
        HttpStatus.CONFLICT,
      );
    }
  }

  public pagination(input: { readonly page?: number; readonly pageSize?: number }) {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50));
    return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
  }

  /**
   * Resolves a client-requested sort into a SAFE ordering.
   *
   * The client never names a database column. It sends a business key
   * (`journalDate`, `totalDebit`) which is looked up in an allowlist the query
   * owns; anything unrecognised falls back to that list's default rather than
   * erroring, so a stale bookmark degrades instead of breaking.
   *
   * The returned `column` is a fragment the caller interpolates with
   * `sql.raw`. That is only safe because the value can never come from input —
   * it is always a literal from the caller's own allowlist.
   */
  // `TKey` is inferred from the ALLOWLIST alone. It used to be inferred from
  // `fallback` as well, and the string literal there won: passing "createdAt"
  // pinned TKey to that single key, and `Record<"createdAt", string>` then
  // rejected every other entry in the map as an excess property.
  //
  // `NoInfer` removes the fallback as an inference site while still constraining
  // it to the map keys, so an unallowlisted fallback is a compile error.
  //
  // Indexing a `Record<TKey, string>` -- a mapped type over a finite union, not
  // an index signature -- yields a definite `string`, so the SQL column can never
  // be undefined and only a mapped expression reaches ORDER BY.
  public sorting<TKey extends string>(
    input: { readonly sortBy?: string; readonly sortDirection?: string },
    allowed: Readonly<Record<TKey, string>>,
    fallback: NoInfer<TKey>,
  ): {
    readonly column: string;
    readonly direction: "asc" | "desc";
    readonly sortBy: TKey;
    readonly sortDirection: "asc" | "desc";
  } {
    const requested = typeof input.sortBy === "string" ? input.sortBy.trim() : "";
    // Unchanged: a requested key is honoured only when the allowlist owns it.
    const sortBy = (Object.hasOwn(allowed, requested) ? requested : fallback) as TKey;
    const direction = input.sortDirection === "asc" ? "asc" : "desc";
    return { column: allowed[sortBy], direction, sortBy, sortDirection: direction };
  }
}

/**
 * SQL that orders a business reference by its NUMERIC sequence.
 *
 * `JRN-000010` must come after `JRN-000009`, and lexical ordering only happens
 * to agree while the zero-padding width is constant — it breaks the moment a
 * sequence rolls past its padding, or where two prefixes share a column. The
 * digits are extracted and compared as a number instead.
 *
 * `[^0-9]` rather than `\D`: inside a template literal the backslash escape
 * would collapse to a literal `D` and strip the letter D from the reference.
 *
 * `column` is always a caller-owned literal, never client input.
 */
export function numericReferenceOrder(column: string): string {
  return `nullif(regexp_replace(${column}, '[^0-9]', '', 'g'), '')::bigint`;
}
