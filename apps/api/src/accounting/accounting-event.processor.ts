import { randomUUID } from "node:crypto";

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingEventRepository } from "./accounting-event.repository.js";
import { OperationalJournalPostingService } from "./operational-journal-posting.service.js";

const retryableCodes = new Set([
  "40001",
  "40P01",
  "55P03",
  "accounting_event_processing_interrupted",
]);

// Safe business summaries for database failures the Accounting module can
// recognise. Nothing derived from the driver message is ever stored: the raw
// text can carry SQL, parameter values and internal query fragments, so only
// these curated sentences and the identifier-shaped code/constraint names below
// ever reach `accounting_events` and, through it, the frontend.
const constraintFailures = new Map<string, { category: string; code: string; summary: string }>([
  [
    "accounting_event_components_amount_positive",
    {
      category: "source",
      code: "accounting_event_component_amount_invalid",
      summary: "An Accounting Event component carried an amount that was not greater than zero",
    },
  ],
  [
    "journal_lines_amount_check",
    {
      category: "validation",
      code: "accounting_journal_line_amount_invalid",
      summary: "A Journal Line must carry exactly one positive Debit or Credit amount",
    },
  ],
  [
    "accounting_events_identity_unique",
    {
      category: "source",
      code: "accounting_event_duplicate",
      summary: "This operational Accounting Event was already received",
    },
  ],
  [
    "journal_entries_company_id_journal_number_key",
    {
      category: "transient",
      code: "accounting_journal_number_generation_failed",
      summary: "A unique Journal Number could not be reserved",
    },
  ],
]);

const databaseCodeSummaries = new Map<string, { category: string; summary: string }>([
  ["23502", { category: "source", summary: "A required Accounting value was missing" }],
  [
    "23503",
    { category: "configuration", summary: "A referenced Accounting record was not available" },
  ],
  ["23505", { category: "source", summary: "The Accounting record already exists" }],
  [
    "23514",
    {
      category: "validation",
      summary: "The Accounting values did not satisfy a financial integrity rule",
    },
  ],
  [
    "23P01",
    { category: "configuration", summary: "The Accounting record overlaps an existing record" },
  ],
  // 42601 is a malformed statement — an internal defect, never the User's data.
  // Categorised as `system` rather than `validation` so it is not mistaken for
  // a business-rule failure the User could resolve. The message deliberately
  // carries no SQL, driver text or statement detail.
  [
    "42601",
    {
      category: "system",
      summary: "An internal Accounting statement could not be executed safely",
    },
  ],
  [
    "40001",
    { category: "transient", summary: "The Accounting operation was interrupted and will retry" },
  ],
  [
    "40P01",
    { category: "transient", summary: "The Accounting operation was interrupted and will retry" },
  ],
  [
    "55P03",
    { category: "transient", summary: "The Accounting records were busy and the retry is pending" },
  ],
]);

// Only identifier-shaped values are ever persisted. A pg constraint or error
// code is always a bare identifier; anything else is a driver-specific payload
// that may embed query text, so it is discarded rather than truncated.
function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 128) return undefined;
  return /^[A-Za-z0-9_]+$/.test(trimmed) ? trimmed : undefined;
}

@Injectable()
export class AccountingEventProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly workerId = `accounting-${randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;

  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(AccountingEventRepository) private readonly events: AccountingEventRepository,
    @Inject(OperationalJournalPostingService)
    private readonly posting: OperationalJournalPostingService,
  ) {}

  public onModuleInit(): void {
    void this.events
      .recoverStaleLocks()
      .then(() => this.drain())
      .catch(() => undefined);
    this.timer = setInterval(() => {
      void this.drain().catch(() => undefined);
    }, 5_000);
    this.timer.unref();
  }

  public onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  public async drain(limit = 25): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let processed = 0;
    try {
      while (processed < limit) {
        const event = await this.events.next(this.workerId);
        if (event === undefined) break;
        try {
          await this.database
            .transaction()
            .execute((transaction) => this.posting.process(transaction, event));
        } catch (error) {
          await this.recordFailure(event.id, event.companyId, error);
        }
        processed += 1;
      }
      return processed;
    } finally {
      this.draining = false;
    }
  }

  private async recordFailure(eventId: string, companyId: string, error: unknown): Promise<void> {
    const application = error instanceof ApplicationException ? error : undefined;
    const details =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown; constraint?: unknown })
        : {};
    const databaseCode = safeIdentifier(details.code);
    const constraintName = safeIdentifier(details.constraint);
    const mapped =
      constraintName === undefined ? undefined : constraintFailures.get(constraintName);
    const codeSummary = databaseCode === undefined ? undefined : databaseCodeSummaries.get(databaseCode);
    const code =
      application?.errorCode ??
      mapped?.code ??
      (databaseCode !== undefined && retryableCodes.has(databaseCode)
        ? "accounting_event_transient_failure"
        : "accounting_event_processing_failed");
    const retryable = databaseCode !== undefined && retryableCodes.has(databaseCode);
    const category = retryable
      ? "transient"
      : (application === undefined ? (mapped?.category ?? codeSummary?.category) : undefined) ??
        (code.includes("mapping") || code.includes("configuration")
          ? "configuration"
          : code.includes("period") || code.includes("fiscal")
            ? "period"
            : code.includes("source") || code.includes("not_")
              ? "source"
              : "validation");
    // Application messages are already written for the operator; otherwise fall
    // back to a mapped business summary, then to the generic sentence. The raw
    // driver message is deliberately never used.
    const summary =
      application?.message ??
      mapped?.summary ??
      codeSummary?.summary ??
      "Accounting processing failed safely";
    const result = await sql<{
      actorId: string | null;
      attempts: number;
      correlationId: string;
      eventType: string;
      maximum: number;
    }>`
      select attempt_count as attempts,max_attempts as maximum,
             actor_id as "actorId",correlation_id as "correlationId",
             event_type as "eventType"
        from accounting_events where id=${eventId}::uuid and company_id=${companyId}::uuid
    `.execute(this.database);
    const row = result.rows[0] ?? {
      actorId: null,
      attempts: 5,
      correlationId: eventId,
      eventType: "unknown",
      maximum: 5,
    };
    const willRetry = retryable && row.attempts < row.maximum;
    const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, row.attempts - 1));
    await sql`
      update accounting_events
         set processing_status=${willRetry ? "retry_pending" : "failed"},
             failure_category=${category},error_code=${code},
             safe_error_summary=${summary},
             error_metadata=${JSON.stringify({
               ...(constraintName === undefined ? {} : { constraint: constraintName }),
               ...(databaseCode === undefined ? {} : { databaseCode }),
               recognised: mapped !== undefined || codeSummary !== undefined,
               retryable: willRetry,
             })}::jsonb,
             failed_at=now(),
             next_attempt_at=case when ${willRetry}
               then now()+(${delaySeconds}::text||' seconds')::interval else null end,
             processing_locked_at=null,processing_locked_by=null
       where id=${eventId}::uuid and company_id=${companyId}::uuid
    `.execute(this.database);
    if (row.actorId !== null) {
      await sql`
        insert into audit_events(
          company_id,actor_account_id,action,subject_type,subject_id,
          after_data,correlation_id
        ) values(
          ${companyId}::uuid,${row.actorId}::uuid,'accounting.operational_event.failed',
          'accounting_event',${eventId},
          ${JSON.stringify({
            ...(constraintName === undefined ? {} : { constraint: constraintName }),
            ...(databaseCode === undefined ? {} : { databaseCode }),
            errorCode: code,
            eventType: row.eventType,
            failureCategory: category,
            retryPending: willRetry,
          })}::jsonb,${row.correlationId}
        )
      `.execute(this.database);
    }
  }
}
