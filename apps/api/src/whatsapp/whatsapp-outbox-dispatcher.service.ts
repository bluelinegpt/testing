import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { CompanyWhatsAppProvider } from "./company-whatsapp-provider.port.js";

/** Central retry/lifecycle policy — one place, per Prompt 4 §28. */
export const WHATSAPP_DISPATCH_POLICY = {
  batchSize: 10,
  /** 1m, 5m, 15m, then 1h between automatic retries of safe failures. */
  retryDelaysSeconds: [60, 300, 900, 3600],
  maxSendAttempts: 5,
  /** A `processing` row older than this is a crashed worker; the send outcome
   *  is unknowable, so recovery is requires_review — never a blind resend. */
  staleProcessingMinutes: 10,
  /** A status message older than this confuses more than it informs. */
  maxPendingAgeHours: 24,
  /** Requeue delays while the Company connection is not live: short for
   *  transient states, longer where a human must re-pair (never a hot loop —
   *  these are single indexed-row updates, no provider traffic). */
  notConnectedRetrySeconds: 60,
  humanActionRetrySeconds: 300,
  sendTimeoutMs: 30_000,
  tickMs: 5_000,
} as const;

interface ClaimedMessage {
  readonly id: string;
  readonly companyId: string;
  readonly providerGroupId: string;
  readonly messageBody: string;
  readonly attemptCount: number;
}

/**
 * Drains `whatsapp_message_outbox` — the WhatsApp counterpart of
 * `PushDispatcher`, same architecture: an unref'd interval inside the API
 * process, PostgreSQL `FOR UPDATE SKIP LOCKED` claiming so concurrent
 * workers/ticks can never process the same row, bounded backoff, and
 * conservative handling of every uncertain outcome.
 *
 * Delivery semantics (Prompt 4 §15, stated precisely): the database
 * guarantees exactly one durable notification INTENT per
 * Company+Order+status-history-event+group, and this dispatcher never
 * intentionally sends a confirmed `sent` row twice — but an unofficial
 * WhatsApp transport cannot give mathematical exactly-once delivery, so any
 * ambiguous network outcome (timeout, socket error after dispatch) parks the
 * row in `requires_review` instead of blind-resending.
 *
 * Tenancy: every send resolves the Company runtime from the CLAIMED ROW's
 * own `company_id`, and the destination is the row's snapshotted
 * `provider_group_id` — never current Trader settings, never caller input.
 *
 * Runtime placement: runs in the API process, matching the current
 * single-instance Render deployment (and Prompt 2's in-process sockets). If
 * the API ever scales horizontally, dispatcher + sockets need single-owner
 * coordination or a dedicated worker — SKIP LOCKED already prevents
 * duplicate claims, but each instance would try (and fail) to send through
 * sockets it doesn't own.
 */
@Injectable()
export class WhatsAppOutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppOutboxDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(CompanyWhatsAppProvider) private readonly provider: CompanyWhatsAppProvider,
  ) {}

  public onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => {
      if (this.draining) return;
      this.draining = true;
      this.tick()
        .catch((error: unknown) => {
          this.logger.warn(`whatsapp_dispatch_tick_failed: ${(error as Error).message}`);
        })
        .finally(() => {
          this.draining = false;
        });
    }, WHATSAPP_DISPATCH_POLICY.tickMs);
    this.timer.unref();
  }

  public onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** One dispatch round: housekeeping, claim a batch, process each row. */
  public async tick(): Promise<number> {
    await this.recoverStaleProcessing();
    await this.expireStalePending();
    const claimed = await this.claimBatch();
    const connectionStatusCache = new Map<string, string>();
    for (const message of claimed) {
      await this.process(message, connectionStatusCache);
    }
    return claimed.length;
  }

  /** Crashed mid-send: the provider outcome is unknowable — park for a
   *  human, never blind-resend (§14). */
  public async recoverStaleProcessing(): Promise<void> {
    await sql`
      update whatsapp_message_outbox
         set status = 'requires_review', failure_code = 'processing_interrupted',
             failure_reason = 'stale_processing_recovered', updated_at = now()
       where id in (
         select id from whatsapp_message_outbox
          where status = 'processing'
            and processing_at < now() - make_interval(mins => ${WHATSAPP_DISPATCH_POLICY.staleProcessingMinutes})
          for update skip locked
       )
    `.execute(this.database);
  }

  /** A day-old status update helps nobody; surface it for review instead of
   *  eventually surprising the Trader (§28). */
  public async expireStalePending(): Promise<void> {
    await sql`
      update whatsapp_message_outbox
         set status = 'requires_review', failure_code = 'notification_expired',
             failure_reason = 'pending_older_than_maximum_age', updated_at = now()
       where id in (
         select id from whatsapp_message_outbox
          where status = 'pending'
            and created_at < now() - make_interval(hours => ${WHATSAPP_DISPATCH_POLICY.maxPendingAgeHours})
          for update skip locked
       )
    `.execute(this.database);
  }

  private async claimBatch(): Promise<readonly ClaimedMessage[]> {
    const result = await sql<ClaimedMessage>`
      update whatsapp_message_outbox
         set status = 'processing', processing_at = now(), updated_at = now()
       where id in (
         select id from whatsapp_message_outbox
          where status = 'pending'
            and (next_attempt_at is null or next_attempt_at <= now())
          order by created_at
          for update skip locked
          limit ${WHATSAPP_DISPATCH_POLICY.batchSize}
       )
       returning id, company_id as "companyId", provider_group_id as "providerGroupId",
                 message_body as "messageBody", attempt_count as "attemptCount"
    `.execute(this.database);
    return result.rows;
  }

  private async process(
    message: ClaimedMessage,
    connectionStatusCache: Map<string, string>,
  ): Promise<void> {
    // The live runtime decides whether a send can happen NOW; the persisted
    // connection status decides how long to hold off when it can't.
    const live = await this.provider.getConnectionStatus(message.companyId);
    if (live !== "connected") {
      let persisted = connectionStatusCache.get(message.companyId);
      if (persisted === undefined) {
        persisted =
          (
            await sql<{ status: string }>`
              select status from company_whatsapp_connections
               where company_id = ${message.companyId}::uuid
            `.execute(this.database)
          ).rows[0]?.status ?? "not_connected";
        connectionStatusCache.set(message.companyId, persisted);
      }
      const holdSeconds = ["authentication_failed", "requires_reconnect"].includes(persisted)
        ? WHATSAPP_DISPATCH_POLICY.humanActionRetrySeconds
        : WHATSAPP_DISPATCH_POLICY.notConnectedRetrySeconds;
      // Not a send attempt: no attempt row, no attempt_count increment — the
      // row simply waits for the connection to come back (§11, §29).
      await sql`
        update whatsapp_message_outbox
           set status = 'pending', next_attempt_at = now() + make_interval(secs => ${holdSeconds}),
               updated_at = now()
         where id = ${message.id}::uuid and status = 'processing'
      `.execute(this.database);
      return;
    }

    const attemptNumber = message.attemptCount + 1;
    const outcome = await this.sendWithTimeout(message);

    if (outcome.kind === "sent") {
      await sql`
        update whatsapp_message_outbox
           set status = 'sent', sent_at = now(), provider_message_id = ${outcome.providerMessageId},
               attempt_count = ${attemptNumber}, next_attempt_at = null, updated_at = now()
         where id = ${message.id}::uuid and status = 'processing'
      `.execute(this.database);
      await this.recordAttempt(message, attemptNumber, "sent", null, "accepted_by_provider", null);
      return;
    }

    if (outcome.kind === "transient") {
      const exhausted = attemptNumber >= WHATSAPP_DISPATCH_POLICY.maxSendAttempts;
      const delay =
        WHATSAPP_DISPATCH_POLICY.retryDelaysSeconds[
          Math.min(attemptNumber - 1, WHATSAPP_DISPATCH_POLICY.retryDelaysSeconds.length - 1)
        ] ?? 3600;
      if (exhausted) {
        await sql`
          update whatsapp_message_outbox
             set status = 'failed', failed_at = now(), failure_code = ${outcome.failureCode},
                 failure_reason = 'retry_attempts_exhausted', attempt_count = ${attemptNumber},
                 next_attempt_at = null, updated_at = now()
           where id = ${message.id}::uuid and status = 'processing'
        `.execute(this.database);
      } else {
        await sql`
          update whatsapp_message_outbox
             set status = 'pending', attempt_count = ${attemptNumber}, failure_code = ${outcome.failureCode},
                 next_attempt_at = now() + make_interval(secs => ${delay}), updated_at = now()
           where id = ${message.id}::uuid and status = 'processing'
        `.execute(this.database);
      }
      await this.recordAttempt(
        message,
        attemptNumber,
        "failed",
        outcome.failureCode,
        "send_failed",
        "transient",
      );
      return;
    }

    if (outcome.kind === "permanent") {
      await sql`
        update whatsapp_message_outbox
           set status = 'failed', failed_at = now(), failure_code = ${outcome.failureCode},
               failure_reason = 'permanent_send_failure', attempt_count = ${attemptNumber},
               next_attempt_at = null, updated_at = now()
         where id = ${message.id}::uuid and status = 'processing'
      `.execute(this.database);
      await this.recordAttempt(
        message,
        attemptNumber,
        "failed",
        outcome.failureCode,
        "send_failed",
        "permanent",
      );
      return;
    }

    // Uncertain: the provider MAY have accepted (timeout / socket error after
    // dispatch). Never blind-retry — park for review (§26).
    await sql`
      update whatsapp_message_outbox
         set status = 'requires_review', failure_code = ${outcome.failureCode},
             failure_reason = 'provider_outcome_uncertain', attempt_count = ${attemptNumber},
             next_attempt_at = null, updated_at = now()
       where id = ${message.id}::uuid and status = 'processing'
    `.execute(this.database);
    await this.recordAttempt(
      message,
      attemptNumber,
      "failed",
      outcome.failureCode,
      "outcome_uncertain",
      "unknown",
    );
  }

  private async sendWithTimeout(
    message: ClaimedMessage,
  ): Promise<
    | { readonly kind: "sent"; readonly providerMessageId: string | null }
    | { readonly kind: "transient"; readonly failureCode: string }
    | { readonly kind: "permanent"; readonly failureCode: string }
    | { readonly kind: "uncertain"; readonly failureCode: string }
  > {
    const timeout = new Promise<{ outcome: "timeout" }>((resolve) => {
      const timer = setTimeout(
        () => resolve({ outcome: "timeout" }),
        WHATSAPP_DISPATCH_POLICY.sendTimeoutMs,
      );
      timer.unref?.();
    });
    const result = await Promise.race([
      this.provider.sendMessage({
        body: message.messageBody,
        companyId: message.companyId,
        providerGroupId: message.providerGroupId,
      }),
      timeout,
    ]);
    if (result.outcome === "timeout") {
      return { failureCode: "provider_timeout", kind: "uncertain" };
    }
    if (result.outcome === "sent") {
      return { kind: "sent", providerMessageId: result.providerMessageId };
    }
    if (result.outcome === "transient_failure") {
      return { failureCode: result.failureCode, kind: "transient" };
    }
    // Permanent failures split: a definitively-rejected destination is final;
    // a generic send rejection happens mid-dispatch where acceptance cannot
    // be ruled out — that is uncertain, not retryable (§26).
    return result.failureCode === "whatsapp_send_rejected"
      ? { failureCode: result.failureCode, kind: "uncertain" }
      : { failureCode: result.failureCode, kind: "permanent" };
  }

  private async recordAttempt(
    message: ClaimedMessage,
    attemptNumber: number,
    result: "sent" | "failed",
    providerResponseCode: string | null,
    summary: string,
    classification: "transient" | "permanent" | "unknown" | null,
  ): Promise<void> {
    await sql`
      insert into whatsapp_message_attempts (
        company_id, message_id, attempt_number, completed_at, result,
        provider_response_code, provider_response_summary, failure_classification
      ) values (
        ${message.companyId}::uuid, ${message.id}::uuid, ${attemptNumber}, now(), ${result},
        ${providerResponseCode}, ${summary}, ${classification}
      )
    `.execute(this.database);
  }
}
