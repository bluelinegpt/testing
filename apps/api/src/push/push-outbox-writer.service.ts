import { Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

type ExecuteContext = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

/**
 * Writes durable `notification_outbox_events` rows — the ONLY thing Order and
 * Communication business services do to trigger a push (Section I: "Do not
 * send push synchronously ... Business services should produce
 * notification/outbox events. Dispatcher handles provider delivery."). No
 * `PushProvider` dependency here at all; `PushDispatcher` owns that.
 *
 * Every write goes through `on conflict (company_id, dedupe_key) do nothing`
 * — the caller's own deterministic key is what makes a retried business
 * transaction (an outer `KyselyTransactionManager` retry, a resubmitted
 * idempotent request) produce at most one logical notification, satisfying
 * Section L without this class needing to know anything about WHY it might
 * be called twice for the same logical event.
 */
@Injectable()
export class PushOutboxWriter {
  /**
   * Fans out to every active, non-revoked conversation participant with a
   * real account, excluding the sender — the exact same recipient set
   * `CommunicationService.writeNotificationOutbox` already computes for
   * `communication_notification_outbox` (Prompt 14, tested by
   * `communication.replay-outbox.database.test.ts` G1-G5). This is an
   * additive SECOND write alongside that one, not a replacement — that
   * table's tested contract is untouched.
   */
  public async writeCommunicationMessage(
    execute: ExecuteContext,
    input: {
      readonly conversationId: string;
      readonly messageId: string;
      readonly senderAccountId: string | null;
      readonly messageType: "text" | "voice";
    },
  ): Promise<void> {
    const bodyKey =
      input.messageType === "voice"
        ? "push.communication.newVoiceMessageBody"
        : "push.communication.newTextMessageBody";
    await sql`
      insert into notification_outbox_events (
        company_id, recipient_account_id, notification_type, target_type, target_id,
        title_key, body_key, body_params, dedupe_key
      )
      select cp.company_id, cp.account_id, 'communication.message.created', 'conversation',
             cp.conversation_id, 'push.communication.newMessageTitle', ${bodyKey}, '{}'::jsonb,
             'message:' || ${input.messageId} || ':' || cp.account_id::text
        from conversation_participants cp
       where cp.conversation_id = ${input.conversationId}
         and cp.account_id is not null
         and (${input.senderAccountId}::uuid is null or cp.account_id <> ${input.senderAccountId})
         and cp.is_active = true
         and cp.revoked_at is null
      on conflict (company_id, dedupe_key) do nothing
    `.execute(execute);
  }

  /** Driver assignment/reassignment. No-op if the Driver has no linked
   *  account yet (`drivers.account_id` is nullable — see the driver-account
   *  guard migration) — nothing to register a push to. */
  public async writeOrderAssigned(
    execute: ExecuteContext,
    input: {
      readonly companyId: string;
      readonly orderId: string;
      readonly driverAccountId: string | null;
      readonly isReassignment: boolean;
      readonly correlationId: string;
    },
  ): Promise<void> {
    if (input.driverAccountId === null) return;
    const notificationType = input.isReassignment ? "order.reassigned" : "order.assigned";
    const titleKey = input.isReassignment ? "push.order.reassignedTitle" : "push.order.assignedTitle";
    await sql`
      insert into notification_outbox_events (
        company_id, recipient_account_id, notification_type, target_type, target_id,
        title_key, body_key, body_params, dedupe_key
      ) values (
        ${input.companyId}::uuid, ${input.driverAccountId}::uuid, ${notificationType}, 'order',
        ${input.orderId}::uuid, ${titleKey}, null, '{}'::jsonb,
        'order-assign:' || ${input.orderId} || ':' || ${input.driverAccountId} || ':' || ${input.correlationId}
      )
      on conflict (company_id, dedupe_key) do nothing
    `.execute(execute);
  }

  /**
   * A meaningful Order status change, notifying the Trader who owns it.
   * Resolves the Trader's account via `orders.trader_id` itself (a plain
   * join, always current at write time) rather than requiring the caller to
   * have already looked it up — `changeOrderStatus` already re-selects the
   * Order `for update` before this runs, but not `trader_id`, and this keeps
   * that query untouched. A silent no-op if the Trader has no linked
   * account.
   */
  public async writeOrderStatusChanged(
    execute: ExecuteContext,
    input: {
      readonly companyId: string;
      readonly orderId: string;
      readonly newStatus: string;
      readonly correlationId: string;
    },
  ): Promise<void> {
    await sql`
      insert into notification_outbox_events (
        company_id, recipient_account_id, notification_type, target_type, target_id,
        title_key, body_key, body_params, dedupe_key
      )
      select o.company_id, t.account_id, 'order.status_changed', 'order', o.id,
             'push.order.statusChangedTitle', null, ${JSON.stringify({ status: input.newStatus })}::jsonb,
             'order-status:' || o.id::text || ':' || ${input.newStatus} || ':' || ${input.correlationId}
        from orders o
        join traders t on t.id = o.trader_id and t.company_id = o.company_id
       where o.id = ${input.orderId}::uuid and o.company_id = ${input.companyId}::uuid
         and t.account_id is not null
      on conflict (company_id, dedupe_key) do nothing
    `.execute(execute);
  }
}
