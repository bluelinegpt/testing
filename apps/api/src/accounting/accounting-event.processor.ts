import { randomUUID } from "node:crypto";

import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
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
    void this.events.recoverStaleLocks().then(() => this.drain()).catch(() => undefined);
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
          await this.database.transaction().execute((transaction) =>
            this.posting.process(transaction, event),
          );
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
    const databaseCode =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    const code = application?.errorCode
      ?? (retryableCodes.has(databaseCode) ? "accounting_event_transient_failure" : "accounting_event_processing_failed");
    const retryable = retryableCodes.has(databaseCode);
    const category = retryable
      ? "transient"
      : code.includes("mapping") || code.includes("configuration")
        ? "configuration"
        : code.includes("period") || code.includes("fiscal")
          ? "period"
          : code.includes("source") || code.includes("not_")
            ? "source"
            : "validation";
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
             safe_error_summary=${application?.message ?? "Accounting processing failed safely"},
             error_metadata=${JSON.stringify({ retryable: willRetry })}::jsonb,
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
