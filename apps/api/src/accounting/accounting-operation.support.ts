import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

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

  public assertAnyPermission(...required: readonly string[]): void {
    const permissions = this.identities.current().permissions;
    if (
      !required.some((permission) => permissions.has(permission))
      && !permissions.has("users_roles.manage")
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

  public async hasAlternateAuthorizedActor(
    database: Kysely<DatabaseSchema>,
    permission: string,
  ): Promise<boolean> {
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
            on rp.role_id = r.id and rp.company_id = r.company_id
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
}
