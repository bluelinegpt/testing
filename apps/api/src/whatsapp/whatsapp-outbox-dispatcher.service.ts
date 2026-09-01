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
import { TRADER_NOTIFIABLE_DELIVERY_STATUSES } from "./whatsapp-message-templates.js";

/** Central retry/lifecycle policy — one place, per Prompt 4 §28 / Prompt 5 §34. */
export const WHATSAPP_DISPATCH_POLICY = {
  batchSize: 10,
  /** Fairness: one Company may take at most this many of a batch, so a noisy
   *  tenant with a huge backlog cannot starve the others (Prompt 5 §35). */
  perCompanyClaimLimit: 5,
  /** 1m, 5m, 15m, then 1h between automatic retries of safe failures. */
  retryDelaysSeconds: [60, 300, 900, 3600],
  maxSendAttempts: 5,
  /** A `processing` row older than this is a crashed worker; the send outcome
   *  is unknowable, so recovery is requires_review — never a blind resend. */
  staleProcessingMinutes: 10,
  /** A status message older than this confuses more than it informs. */
  maxPendingAgeHours: 24,
  /** Supersession (Prompt 5 §16): an order-status message older than this
   *  grace period whose Order already has a NEWER eligible status event is
   *  cancelled rather than sent — the Trader has already moved past it. A
   *  fresh backlog (within grace) still sends in order, preserving the
   *  normal multi-status sequence of a short outage. */
  supersededGraceMinutes: 30,
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
  readonly messageType: string;
  readonly orderId: string | null;
  readonly orderStatusHistoryId: string | null;
  readonly createdAt: Date;
}

export interface DispatcherHealthSnapshot {
  readonly running: boolean;
  readonly lastTickAt: Date | null;
  readonly lastClaimAt: Date | null;
  readonly lastSendAt: Date | null;
  readonly lastClaimedCount: number;
  readonly counters: {
    readonly sent: number;
    readonly transientFailures: number;
    readonly permanentFailures: number;
    readonly requiresReview: number;
    readonly superseded: number;
    readonly heldNotConnected: number;
  };
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
 * Backpressure is deliberately conservative for an unofficial transport:
 * small batches every few seconds, sequential sends within a tick, a
 * per-Company claim cap for fairness, and no burst mode after a reconnect —
 * a long backlog drains steadily, never as a flood.
 *
 * Tenancy: every send resolves the Company runtime from the CLAIMED ROW's
 * own `company_id`, and the destination is the row's snapshotted
 * `provider_group_id` — never current Trader settings, never caller input.
 *
 * Runtime placement: runs in the API process, matching the current
 * single-instance Render deployment (and Prompt 2's in-process sockets).
 * `WHATSAPP_RUNTIME_ENABLED=false` disables both this dispatcher and the
 * connection runtime on an instance — the guard for any future
 * multi-instance topology, where exactly ONE process may own WhatsApp.
 * Horizontal scaling of the owning service is prohibited (see
 * `Documentation/whatsapp-operations.md`).
 */
@Injectable()
export class WhatsAppOutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppOutboxDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private shuttingDown = false;
  private lastTickAt: Date | null = null;
  private lastClaimAt: Date | null = null;
  private lastSendAt: Date | null = null;
  private lastClaimedCount = 0;
  private readonly counters = {
    heldNotConnected: 0,
    permanentFailures: 0,
    requiresReview: 0,
    sent: 0,
    superseded: 0,
    transientFailures: 0,
  };

  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(CompanyWhatsAppProvider) private readonly provider: CompanyWhatsAppProvider,
  ) {}

  public onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    if (process.env.WHATSAPP_RUNTIME_ENABLED === "false") {
      this.logger.warn("whatsapp_dispatcher_disabled_by_configuration");
      return;
    }
    this.timer = setInterval(() => {
      if (this.draining || this.shuttingDown) return;
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

  /** Graceful shutdown (Prompt 5 §31): stop claiming new work. In-flight
   *  work either completes or is recovered by the stale-processing lease as
   *  requires_review — never blind-resent. Nothing here logs out or touches
   *  auth state: a deploy restart is NOT a user Disconnect. */
  public onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Safe operational snapshot — process-local dispatcher liveness. Company
   *  WhatsApp health is a separate axis and never affects API health. */
  public healthSnapshot(): DispatcherHealthSnapshot {
    return {
      counters: { ...this.counters },
      lastClaimAt: this.lastClaimAt,
      lastClaimedCount: this.lastClaimedCount,
      lastSendAt: this.lastSendAt,
      lastTickAt: this.lastTickAt,
      running: this.timer !== null && !this.shuttingDown,
    };
  }

  /** One dispatch round: housekeeping, claim a batch, process each row. */
  public async tick(): Promise<number> {
    this.lastTickAt = new Date();
    await this.recoverStaleProcessing();
    await this.expireStalePending();
    const claimed = await this.claimBatch();
    this.lastClaimedCount = claimed.length;
    if (claimed.length > 0) this.lastClaimAt = new Date();
    const connectionStatusCache = new Map<string, string>();
    for (const message of claimed) {
      if (this.shuttingDown) break;
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

  /**
   * Fair claim: candidates are ranked per Company (row_number over
   * company_id, oldest first) and capped at `perCompanyClaimLimit`, THEN
   * limited to the batch size overall — so a Company with thousands of
   * pending rows takes at most half a batch while other Companies' rows
   * always fit. The final UPDATE re-checks status/eligibility under
   * `FOR UPDATE SKIP LOCKED`, which keeps the two-step selection safe
   * against concurrent workers.
   */
  private async claimBatch(): Promise<readonly ClaimedMessage[]> {
    const result = await sql<ClaimedMessage>`
      update whatsapp_message_outbox
         set status = 'processing', processing_at = now(), updated_at = now()
       where id in (
         select id from whatsapp_message_outbox
          where id in (
                  select id from (
                    select id, created_at,
                           row_number() over (partition by company_id order by created_at) as company_rank
                      from whatsapp_message_outbox
                     where status = 'pending'
                       and (next_attempt_at is null or next_attempt_at <= now())
                  ) ranked
                  where company_rank <= ${WHATSAPP_DISPATCH_POLICY.perCompanyClaimLimit}
                  order by created_at
                  limit ${WHATSAPP_DISPATCH_POLICY.batchSize}
                )
            and status = 'pending'
            and (next_attempt_at is null or next_attempt_at <= now())
          for update skip locked
       )
       returning id, company_id as "companyId", provider_group_id as "providerGroupId",
                 message_body as "messageBody", attempt_count as "attemptCount",
                 message_type as "messageType", order_id as "orderId",
                 order_status_history_id as "orderStatusHistoryId", created_at as "createdAt"
    `.execute(this.database);
    return result.rows;
  }

  private async process(
    message: ClaimedMessage,
    connectionStatusCache: Map<string, string>,
  ): Promise<void> {
    // Supersession policy (§16): a stale order-status message whose Order
    // already carries a NEWER eligible status event would mislead the Trader
    // — cancel it (preserved for audit) instead of sending an obsolete
    // update hours later. Recent messages (within grace) still send, so a
    // short outage delivers its sequence in order.
    if (await this.cancelIfSuperseded(message)) {
      this.counters.superseded += 1;
      return;
    }

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
      this.counters.heldNotConnected += 1;
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
      this.counters.sent += 1;
      this.lastSendAt = new Date();
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
      this.counters.transientFailures += 1;
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
      this.counters.permanentFailures += 1;
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
    this.counters.requiresReview += 1;
  }

  /** Returns true when the claimed row was cancelled as superseded. */
  private async cancelIfSuperseded(message: ClaimedMessage): Promise<boolean> {
    if (message.messageType !== "order_status") return false;
    if (message.orderId === null || message.orderStatusHistoryId === null) return false;
    const graceCutoffMs = Date.now() - WHATSAPP_DISPATCH_POLICY.supersededGraceMinutes * 60_000;
    if (message.createdAt.getTime() >= graceCutoffMs) return false;
    const eligible = [...TRADER_NOTIFIABLE_DELIVERY_STATUSES];
    const superseded = (
      await sql<{ superseded: boolean }>`
        select exists (
          select 1
            from order_status_history newer
            join order_status_history own
              on own.id = ${message.orderStatusHistoryId}::uuid
             and own.company_id = ${message.companyId}::uuid
           where newer.company_id = ${message.companyId}::uuid
             and newer.order_id = ${message.orderId}::uuid
             and newer.status_dimension = 'delivery'
             and newer.to_status = any(${eligible})
             and newer.occurred_at > own.occurred_at
        ) as superseded
      `.execute(this.database)
    ).rows[0];
    if (superseded?.superseded !== true) return false;
    await sql`
      update whatsapp_message_outbox
         set status = 'cancelled', failure_code = 'superseded_by_newer_status',
             failure_reason = 'newer_eligible_status_event_exists', next_attempt_at = null,
             updated_at = now()
       where id = ${message.id}::uuid and status = 'processing'
    `.execute(this.database);
    return true;
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
