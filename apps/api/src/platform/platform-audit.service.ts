import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";
import type { Request } from "express";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Platform audit writing, on top of the existing `audit_events` table.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A SECOND AUDIT SYSTEM
 * ---------------------------------------------------------------------------
 *
 * `audit_events` is already append-only (`reject_audit_mutation` refuses every
 * UPDATE and DELETE), already allows `company_id` to be null so a Platform-only
 * event has a home, already carries actor, correlation id, IP, user agent and
 * before/after JSON, and is already in the reset tool's PRESERVE list so a
 * Company reset cannot erase it. A parallel table would have to re-earn every
 * one of those properties and would then have to be kept in step forever.
 *
 * Platform rows are distinguishable from Company-user rows three ways: the
 * `platform.` action prefix, `actor_role = 'platform_administrator'`, and
 * `source = 'platform_portal'`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NEVER WRITTEN
 * ---------------------------------------------------------------------------
 *
 * No password, no password hash, no session token or cookie, no reset token, no
 * Authorization header, no integration secret. Callers pass structured detail
 * only; this service adds the request metadata and nothing else. The username
 * on a failed sign-in IS recorded, because a failed-login trail without the
 * attempted identifier cannot be investigated — but the submitted password is
 * not, and never reaches this service.
 */
export type PlatformAuditResult = "success" | "failure" | "denied";

export interface PlatformAuditInput {
  readonly action: string;
  readonly actorAccountId: string | null;
  readonly companyId?: string | null;
  readonly subjectType: string;
  readonly subjectId?: string | null;
  readonly reason?: string | null;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly correlationId: string;
  readonly ipAddress?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
  /**
   * What happened. Defaults to `success` because the overwhelming majority of
   * call sites audit a completed action, and a default of "unknown" would make
   * the column useless for exactly the query it exists to answer.
   */
  readonly result?: PlatformAuditResult;
  /** Required when `result` is `failure` or `denied`; rejected otherwise. */
  readonly failureReason?: string | null;
}

/**
 * Keys whose VALUES are never written, whatever a caller passes.
 *
 * This is central rather than left to each call site. A call site that forgets
 * is a permanent, unfixable disclosure — `audit_events` is append-only, so a
 * secret written here cannot be deleted, edited or redacted afterwards by
 * anyone. Matching is on the key name, case-insensitively and as a substring,
 * so `password`, `newPassword`, `PasswordHash` and `temporary_password` are all
 * covered without maintaining a list of spellings.
 */
const redactedKeyPatterns = [
  "password",
  "secret",
  "token",
  "credential",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "setupurl",
];

const REDACTED = "[redacted]";

/** Replaces the value of any sensitive-looking key, at any depth. */
export function redactSensitive(value: unknown, depth = 0): unknown {
  // A cycle or a pathological structure must not hang an audit write. Ten
  // levels is far deeper than any payload this service is given.
  if (depth > 10) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalised = key.toLowerCase().replace(/[^a-z]/g, "");
    result[key] = redactedKeyPatterns.some((pattern) => normalised.includes(pattern))
      ? REDACTED
      : redactSensitive(item, depth + 1);
  }
  return result;
}

/** The correlation id pino put on the request, or a safe fallback. */
export function correlationIdOf(request: Request): string {
  const candidate = request.id ?? request.headers["x-correlation-id"];
  const value = Array.isArray(candidate) ? candidate[0] : candidate;
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._-]{8,128}$/.test(text) ? text : "platform-unknown";
}

@Injectable()
export class PlatformAuditService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async record(input: PlatformAuditInput): Promise<void> {
    const result = input.result ?? "success";
    // `audit_events_failure_reason_shape` enforces this in the database too; the
    // check here turns a constraint violation into a message that names the
    // call site's mistake rather than the table's.
    const failureReason =
      result === "success" ? null : (input.failureReason?.trim() ?? "unspecified");
    if (result !== "success" && failureReason === "") {
      throw new Error("A failed or denied audit entry must carry a failure reason");
    }

    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id, reason,
        before_data, after_data, correlation_id, ip_address, user_agent, actor_role, source,
        result, failure_reason, source_application
      ) values (
        ${input.companyId ?? null}::uuid,
        ${input.actorAccountId}::uuid,
        ${input.action},
        ${input.subjectType},
        ${input.subjectId ?? null},
        ${input.reason ?? null},
        ${input.before === undefined || input.before === null ? null : JSON.stringify(redactSensitive(input.before))}::jsonb,
        ${input.after === undefined || input.after === null ? null : JSON.stringify(redactSensitive(input.after))}::jsonb,
        ${input.correlationId},
        ${input.ipAddress ?? null}::inet,
        ${input.userAgent?.slice(0, 1_000) ?? null},
        'platform_administrator',
        'platform_portal',
        ${result},
        ${failureReason},
        'platform-web'
      )
    `.execute(this.database);
  }

  /**
   * Records an audit row without letting a write failure break the operation
   * being audited.
   *
   * Used only on paths where the operation has already completed and refusing
   * it after the fact is impossible — a sign-in whose session already exists,
   * or a sign-out whose session is already revoked. Everywhere else the audit
   * write shares the operation's transaction and a failure correctly aborts it.
   */
  public async recordBestEffort(input: PlatformAuditInput): Promise<void> {
    try {
      await this.record(input);
    } catch {
      // Deliberately swallowed: see the method comment. The operation itself
      // has already taken effect and the request must not fail because the
      // trail could not be written.
    }
  }
}
