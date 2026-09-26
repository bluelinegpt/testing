import { HttpStatus, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  isTraderNotifiableDeliveryStatus,
  renderOrderStatusMessage,
  renderOrderStatusMessageFromTemplate,
} from "./whatsapp-message-templates.js";

type ExecuteContext = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export interface CreateTraderWhatsAppNotificationInput {
  readonly companyId: string;
  readonly traderId: string;
  readonly orderId: string;
  readonly orderStatusHistoryId: string;
  readonly messageBody: string;
}

export type CreateTraderWhatsAppNotificationResult =
  /** A new outbox row was created for this status-history event. */
  | { readonly outcome: "created"; readonly messageId: string; readonly idempotencyKey: string }
  /** The exact idempotency key already exists — the earlier row is returned,
   *  a second logical notification is never produced. */
  | {
      readonly outcome: "already_exists";
      readonly messageId: string;
      readonly idempotencyKey: string;
    }
  /** The Trader has no enabled group mapping, or the Company has no WhatsApp
   *  connection row — nothing to notify, deliberately NOT an error so the
   *  future order-status hook (Prompt 4) can call this unconditionally. */
  | { readonly outcome: "skipped"; readonly reason: "not_configured" | "no_connection" };

/**
 * The ONLY writer of `whatsapp_message_outbox` rows — the WhatsApp
 * counterpart of `PushOutboxWriter`. Like that writer it takes an explicit
 * execute context so the caller's own business transaction owns the write
 * (Prompt 4 will call this from inside the order-status-change transaction),
 * and it sends nothing: delivery belongs to the future dispatcher behind
 * `CompanyWhatsAppProvider`.
 *
 * Duplicate prevention is layered: the deterministic idempotency key
 * (company + Order + exact `order_status_history` event + provider group) is
 * enforced by the database's `unique (company_id, idempotency_key)` — the
 * `on conflict do nothing` + re-select below is just the ergonomic surface
 * over that guarantee. API retries, worker retries, double-clicks, replayed
 * transactions and concurrent calls all collapse onto at most one row.
 */
@Injectable()
export class WhatsAppOutboxWriter {
  /**
   * The automatic Order-status hook (Prompt 4), called from
   * `OperationsHistoryWriter.statusHistory` INSIDE the same business
   * transaction that persists the Order update and its status-history row —
   * so the notification intent commits and rolls back atomically with the
   * Order change, and the API response never waits on WhatsApp (a dispatcher
   * sends later).
   *
   * Deliberately quiet: an ineligible status, a Trader without an enabled
   * group mapping, or a Company that never configured WhatsApp simply
   * produces no row — an Order status change must never fail or complain
   * because notifications aren't set up. A Company whose WhatsApp is merely
   * DISCONNECTED still gets a durable pending row (its connection row
   * exists), so nothing is lost during an outage.
   *
   * Everything the message needs is SNAPSHOTTED here, at event time: group
   * id + name, language, and the fully rendered body. Later changes to the
   * Trader's mapping/language, group renames, or disabling notifications
   * never rewrite or reroute this event — history stays immutable.
   */
  public async writeOrderStatusChanged(
    execute: ExecuteContext,
    input: {
      readonly companyId: string;
      readonly orderId: string;
      readonly orderStatusHistoryId: string;
      readonly toStatus: string;
      readonly occurredAt: Date;
    },
  ): Promise<void> {
    if (!isTraderNotifiableDeliveryStatus(input.toStatus)) return;
    const context = (
      await sql<{
        providerGroupId: string;
        groupNameSnapshot: string | null;
        messageLanguage: "both" | "ar" | "en";
        connectionId: string;
        traderId: string;
        orderNumber: string;
        referenceNumber: string | null;
        companyName: string;
        templateBodyAr: string | null;
        templateBodyEn: string | null;
      }>`
        select s.provider_group_id as "providerGroupId",
               s.group_name_snapshot as "groupNameSnapshot",
               s.message_language as "messageLanguage",
               c.id as "connectionId",
               o.trader_id as "traderId",
               o.order_number as "orderNumber",
               o.serial_number as "referenceNumber",
               co.name_en as "companyName",
               tpl.body_ar as "templateBodyAr",
               tpl.body_en as "templateBodyEn"
          from orders o
          join trader_whatsapp_settings s
            on s.trader_id = o.trader_id and s.company_id = o.company_id
          join company_whatsapp_connections c on c.company_id = o.company_id
          join companies co on co.id = o.company_id
          left join company_whatsapp_message_templates tpl
            on tpl.company_id = o.company_id and tpl.status = ${input.toStatus}
         where o.id = ${input.orderId}::uuid and o.company_id = ${input.companyId}::uuid
           and s.notifications_enabled = true and s.provider_group_id is not null
           -- Platform kill switch AND status selection: absence of a row (or
           -- a NULL enabled_statuses) means every notifiable status sends. A
           -- disabled Company — or a status outside the Company's allowlist —
           -- records nothing here, deliberately quiet like every other
           -- not-configured case in this hook.
           and not exists (
             select 1 from company_whatsapp_platform_settings p
              where p.company_id = o.company_id
                and (
                  p.whatsapp_enabled = false
                  or (p.enabled_statuses is not null
                      and not (${input.toStatus} = any(p.enabled_statuses)))
                )
           )
      `.execute(execute)
    ).rows[0];
    if (context === undefined) return;

    const messageInput = {
      companyName: context.companyName,
      language: context.messageLanguage,
      occurredAt: input.occurredAt,
      orderNumber: context.orderNumber,
      referenceNumber: context.referenceNumber,
      status: input.toStatus,
    };
    const body =
      context.templateBodyAr !== null && context.templateBodyEn !== null
        ? renderOrderStatusMessageFromTemplate(
            { bodyAr: context.templateBodyAr, bodyEn: context.templateBodyEn },
            messageInput,
          )
        : renderOrderStatusMessage(messageInput);
    const idempotencyKey = `order:${input.orderId}:status-history:${input.orderStatusHistoryId}:group:${context.providerGroupId}`;
    await sql`
      insert into whatsapp_message_outbox (
        company_id, trader_id, order_id, order_status_history_id, connection_id,
        message_type, destination_type, provider_group_id, group_name_snapshot,
        message_language, message_body, status, idempotency_key
      ) values (
        ${input.companyId}::uuid, ${context.traderId}::uuid, ${input.orderId}::uuid,
        ${input.orderStatusHistoryId}::uuid, ${context.connectionId}::uuid,
        'order_status', 'group', ${context.providerGroupId}, ${context.groupNameSnapshot},
        ${context.messageLanguage}, ${body}, 'pending', ${idempotencyKey}
      )
      on conflict (company_id, idempotency_key) do nothing
    `.execute(execute);
  }

  public async createTraderWhatsAppNotification(
    execute: ExecuteContext,
    input: CreateTraderWhatsAppNotificationInput,
  ): Promise<CreateTraderWhatsAppNotificationResult> {
    // Ownership verification: every anchor must belong to the SAME Company,
    // and the status-history event must belong to the exact Order (this is
    // also schema-enforced by the composite FKs, but failing here yields a
    // clear 404 instead of an FK error). The Order must belong to the Trader
    // being notified — a group must never receive another Trader's Order.
    const trader = await sql<{ id: string }>`
      select id from traders
       where id = ${input.traderId}::uuid and company_id = ${input.companyId}::uuid
    `.execute(execute);
    if (trader.rows[0] === undefined) {
      throw new ApplicationException("trader_not_found", "Trader not found", HttpStatus.NOT_FOUND);
    }
    const anchor = await sql<{
      orderTraderId: string;
      historyOrderId: string | null;
    }>`
      select o.trader_id as "orderTraderId",
             (select h.order_id from order_status_history h
               where h.id = ${input.orderStatusHistoryId}::uuid
                 and h.company_id = ${input.companyId}::uuid) as "historyOrderId"
        from orders o
       where o.id = ${input.orderId}::uuid and o.company_id = ${input.companyId}::uuid
    `.execute(execute);
    const row = anchor.rows[0];
    if (row === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    if (row.orderTraderId !== input.traderId) {
      throw new ApplicationException(
        "whatsapp_order_trader_mismatch",
        "The Order does not belong to this Trader",
        HttpStatus.CONFLICT,
      );
    }
    if (row.historyOrderId === null) {
      throw new ApplicationException(
        "order_status_history_not_found",
        "Order status history event not found",
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.historyOrderId !== input.orderId) {
      throw new ApplicationException(
        "whatsapp_status_history_order_mismatch",
        "The status history event does not belong to this Order",
        HttpStatus.CONFLICT,
      );
    }

    const settings = await sql<{
      notificationsEnabled: boolean;
      destinationType: string;
      providerGroupId: string | null;
      groupNameSnapshot: string | null;
      messageLanguage: string;
    }>`
      select notifications_enabled as "notificationsEnabled",
             destination_type as "destinationType",
             provider_group_id as "providerGroupId",
             group_name_snapshot as "groupNameSnapshot",
             message_language as "messageLanguage"
        from trader_whatsapp_settings
       where company_id = ${input.companyId}::uuid and trader_id = ${input.traderId}::uuid
    `.execute(execute);
    const mapping = settings.rows[0];
    if (
      mapping === undefined ||
      !mapping.notificationsEnabled ||
      mapping.providerGroupId === null
    ) {
      return { outcome: "skipped", reason: "not_configured" };
    }

    const connection = await sql<{ id: string }>`
      select id from company_whatsapp_connections
       where company_id = ${input.companyId}::uuid
    `.execute(execute);
    const connectionId = connection.rows[0]?.id;
    if (connectionId === undefined) {
      return { outcome: "skipped", reason: "no_connection" };
    }

    const idempotencyKey = `order:${input.orderId}:status-history:${input.orderStatusHistoryId}:group:${mapping.providerGroupId}`;
    const inserted = await sql<{ id: string }>`
      insert into whatsapp_message_outbox (
        company_id, trader_id, order_id, order_status_history_id, connection_id,
        destination_type, provider_group_id, group_name_snapshot,
        message_language, message_body, status, idempotency_key
      ) values (
        ${input.companyId}::uuid, ${input.traderId}::uuid, ${input.orderId}::uuid,
        ${input.orderStatusHistoryId}::uuid, ${connectionId}::uuid,
        ${mapping.destinationType}, ${mapping.providerGroupId}, ${mapping.groupNameSnapshot},
        ${mapping.messageLanguage}, ${input.messageBody}, 'pending', ${idempotencyKey}
      )
      on conflict (company_id, idempotency_key) do nothing
      returning id
    `.execute(execute);
    const created = inserted.rows[0];
    if (created !== undefined) {
      return { idempotencyKey, messageId: created.id, outcome: "created" };
    }

    const existing = await sql<{ id: string }>`
      select id from whatsapp_message_outbox
       where company_id = ${input.companyId}::uuid and idempotency_key = ${idempotencyKey}
    `.execute(execute);
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      // Unreachable outside a concurrent delete; surfacing it beats guessing.
      throw new Error("whatsapp_outbox_conflict_row_missing");
    }
    return { idempotencyKey, messageId: existingRow.id, outcome: "already_exists" };
  }
}
