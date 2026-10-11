import { createHash } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";

/**
 * DURABLE REPAIR ATTEMPT AUDIT (Phase 2, Prompt 5).
 *
 * Boundary: `record()` writes on the POOL, never inside the repair
 * transaction. It is called only AFTER that transaction has finished:
 *   - REFUSED / FAILED: after the rollback, so the attempt row survives it;
 *   - REPLAYED: after the replay's read-only transaction commits.
 * A success is NOT recorded here: its row is written atomically inside the
 * business transaction in `platform_repair_executions`.
 *
 * Writing an attempt can never change a repair's outcome: a failure to record
 * is logged and swallowed, the original error is still thrown (or the
 * original success still returned).
 *
 * Retention rule (anti-amplification): only requests that REACHED Repair
 * Center execution are recorded -- i.e. an authenticated Platform
 * administrator holding the execute permission, past tenant resolution and
 * request validation. Anonymous traffic, non-Platform identities, permission
 * denials (rejected by the authentication guard before any Repair Center code
 * runs, where no actor is established) and malformed bodies (rejected by the
 * validation pipe) are NOT recorded here; they remain in the request log.
 */

export type RepairAttemptResult = "REFUSED" | "FAILED" | "REPLAYED";

export interface RepairAttemptInput {
  readonly companyId: string;
  readonly entityType: "order" | "trader_receivable" | "accounting_event" | "payroll_period";
  readonly entityId: string;
  readonly entityNumber: string | null;
  readonly findingId: string | null;
  readonly reasonCode: string | null;
  readonly capabilityCode: string | null;
  readonly actorAccountId: string;
  readonly actorAuthority: string;
  readonly reason: string | null;
  readonly previewVersion: string | null;
  readonly idempotencyKey: string | null;
  readonly result: RepairAttemptResult;
  readonly error?: unknown;
  readonly repairExecutionId?: string | null;
  readonly correlationId: string | null;
}

const UNEXPECTED_SUMMARY = "The repair failed unexpectedly; no repair was applied.";

/** The error code and a summary safe to store and show (never a stack or SQL). */
export function safeErrorOf(error: unknown): { code: string | null; summary: string | null } {
  if (error === undefined) return { code: null, summary: null };
  if (error instanceof ApplicationException) {
    const code = /^[a-z0-9_]{1,80}$/u.test(error.errorCode) ? error.errorCode : "repair_refused";
    return { code, summary: error.message.slice(0, 500) };
  }
  return { code: "repair_execution_failed", summary: UNEXPECTED_SUMMARY };
}

@Injectable()
export class RepairAttemptRecorder {
  private readonly logger = new Logger(RepairAttemptRecorder.name);

  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  /** Never throws. Returns the attempt id, or null when it could not be written. */
  public async record(input: RepairAttemptInput): Promise<string | null> {
    try {
      const { code, summary } = safeErrorOf(input.error);
      const keyHash =
        input.idempotencyKey === null || input.idempotencyKey === ""
          ? null
          : createHash("sha256").update(input.idempotencyKey).digest("hex");
      const row = await sql<{ id: string }>`
        insert into platform_repair_attempts (
          company_id, entity_type, entity_id, entity_number, finding_id, reason_code, capability_code,
          actor_account_id, actor_authority, reason, preview_version, idempotency_key_sha256, result,
          error_code, safe_error_summary, repair_execution_id, correlation_id
        ) values (
          ${input.companyId}::uuid, ${input.entityType}, ${input.entityId}::uuid,
          ${input.entityNumber?.slice(0, 200) ?? null}, ${input.findingId?.slice(0, 80) ?? null},
          ${input.reasonCode?.slice(0, 80) ?? null}, ${input.capabilityCode?.slice(0, 80) ?? null},
          ${input.actorAccountId}::uuid, ${input.actorAuthority},
          ${input.reason === null ? null : input.reason.trim().slice(0, 1000) || null},
          ${input.previewVersion?.slice(0, 120) ?? null}, ${keyHash}, ${input.result},
          ${code}, ${summary}, ${input.repairExecutionId ?? null}::uuid, ${input.correlationId?.slice(0, 200) ?? null}
        )
        returning id
      `.execute(this.database);
      return row.rows[0]?.id ?? null;
    } catch (error) {
      // An audit write failure must never turn a refusal into a success or a
      // success into a failure. It is logged for operators.
      this.logger.warn(
        `repair attempt audit write failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return null;
    }
  }
}
