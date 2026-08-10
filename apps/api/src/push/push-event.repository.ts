import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import type { PushSendResult } from "./push-provider.port.js";

export interface ClaimedNotification {
  readonly id: string;
  readonly companyId: string;
  readonly recipientAccountId: string;
  readonly notificationType: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly titleKey: string;
  readonly bodyKey: string | null;
  readonly bodyParams: Record<string, unknown>;
  readonly attempts: number;
}

export interface EligibleDevice {
  readonly token: string;
  readonly platform: string;
}

const maxAttempts = 5;

@Injectable()
export class PushEventRepository {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
  ) {}

  /**
   * Claims one pending/due-for-retry row via `for update skip locked` — the
   * same safe-concurrent-worker pattern `AccountingEventRepository.next`
   * uses. Goes through `KyselyTransactionManager` rather than calling
   * `this.database.transaction()` directly, so a test that has already
   * wrapped `DATABASE` itself in an outer transaction (and stubs
   * `KyselyTransactionManager.execute` to run directly against it — Kysely
   * does not support nesting `.transaction()` calls on an already-active
   * `Transaction`) can exercise this without a second, unsupported nested
   * transaction. Matches the pattern `CommunicationService`/
   * `OrdersWorkflowService` already use for the identical reason.
   */
  public async next(): Promise<ClaimedNotification | undefined> {
    return this.transactions.execute(async (transaction) => {
      const result = await sql<ClaimedNotification>`
        select id, company_id as "companyId", recipient_account_id as "recipientAccountId",
               notification_type as "notificationType", target_type as "targetType",
               target_id as "targetId", title_key as "titleKey",
               body_key as "bodyKey", body_params as "bodyParams", attempts
          from notification_outbox_events
         where status in ('pending', 'retryable_failure')
           and coalesce(next_retry_at, now()) <= now()
         order by created_at, id
         for update skip locked limit 1
      `.execute(transaction);
      const event = result.rows[0];
      if (event === undefined) return undefined;
      await sql`
        update notification_outbox_events
           set status = 'processing', last_attempted_at = now()
         where id = ${event.id}::uuid
      `.execute(transaction);
      return event;
    });
  }

  /**
   * Re-verifies eligibility AT DISPATCH TIME, independently of whatever was
   * true when the outbox row was written (Section M) — an account or Company
   * could have been disabled/suspended/closed, or the device registration
   * revoked, in between. Returns the current active registration, or a
   * reason there is none to deliver to.
   */
  public async resolveEligibleDevice(
    companyId: string,
    accountId: string,
  ): Promise<EligibleDevice | "recipient_ineligible" | "no_active_device"> {
    const account = await sql<{ accountStatus: string; companyStatus: string | null }>`
      select a.status as "accountStatus", c.status as "companyStatus"
        from accounts a join companies c on c.id = a.company_id
       where a.id = ${accountId}::uuid and a.company_id = ${companyId}::uuid
    `.execute(this.database);
    const identity = account.rows[0];
    if (
      identity === undefined ||
      identity.accountStatus !== "active" ||
      identity.companyStatus !== "active"
    ) {
      return "recipient_ineligible";
    }
    const device = await sql<EligibleDevice>`
      select push_token as token, platform
        from device_registrations
       where company_id = ${companyId}::uuid and account_id = ${accountId}::uuid and status = 'active'
       order by updated_at desc
       limit 1
    `.execute(this.database);
    return device.rows[0] ?? "no_active_device";
  }

  public async markSent(id: string): Promise<void> {
    await sql`
      update notification_outbox_events set status = 'sent', sent_at = now(), error_category = null
       where id = ${id}::uuid
    `.execute(this.database);
  }

  public async markSkipped(id: string, category: string): Promise<void> {
    await sql`
      update notification_outbox_events set status = 'skipped', error_category = ${category}
       where id = ${id}::uuid
    `.execute(this.database);
  }

  /** Firebase explicitly reported the token dead — the notification stops
   *  retrying AND the registration is revoked so nothing else keeps trying
   *  to reach it (Section K: "deactivate/revoke that device registration; do
   *  not continue retrying that token"). */
  public async recordInvalidToken(
    id: string,
    companyId: string,
    accountId: string,
    token: string,
  ): Promise<void> {
    await sql`
      update notification_outbox_events
         set status = 'permanent_failure', error_category = 'invalid_token'
       where id = ${id}::uuid
    `.execute(this.database);
    await sql`
      update device_registrations
         set status = 'revoked', revoked_at = now(), revoked_reason = 'invalid_token', updated_at = now()
       where company_id = ${companyId}::uuid and account_id = ${accountId}::uuid
         and push_token = ${token} and status = 'active'
    `.execute(this.database);
  }

  /** Transient failures get bounded, backed-off retries; anything else (or a
   *  transient failure that has exhausted `maxAttempts`) is permanent. */
  public async recordFailure(
    id: string,
    attempts: number,
    result: Extract<PushSendResult, { outcome: "transient_failure" | "permanent_failure" }>,
  ): Promise<void> {
    const willRetry = result.outcome === "transient_failure" && attempts < maxAttempts;
    const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
    await sql`
      update notification_outbox_events
         set status = ${willRetry ? "retryable_failure" : "permanent_failure"},
             error_category = ${result.reason},
             next_retry_at = case when ${willRetry}
               then now() + (${delaySeconds}::text || ' seconds')::interval else null end
       where id = ${id}::uuid
    `.execute(this.database);
  }

  /** Resets rows stuck `processing` for more than 5 minutes (a worker that
   *  crashed mid-send) — mirrors `AccountingEventRepository.recoverStaleLocks`. */
  public async recoverStaleLocks(): Promise<void> {
    await sql`
      update notification_outbox_events
         set status = case when attempts < ${maxAttempts} then 'retryable_failure' else 'permanent_failure' end,
             next_retry_at = case when attempts < ${maxAttempts} then now() else null end,
             error_category = 'processing_interrupted'
       where status = 'processing'
         and last_attempted_at < now() - interval '5 minutes'
    `.execute(this.database);
  }
}
