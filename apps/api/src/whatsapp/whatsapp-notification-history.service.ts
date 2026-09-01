import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import type { WhatsAppNotificationView } from "./whatsapp.dto.js";

/**
 * Read-only WhatsApp notification history, per Order or per Trader. Both
 * reads verify the anchor entity belongs to the caller's Company first, so a
 * foreign Order/Trader id yields 404 — never an empty page that would confirm
 * the id exists elsewhere.
 */
@Injectable()
export class WhatsAppNotificationHistoryService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async listForOrder(orderId: string): Promise<readonly WhatsAppNotificationView[]> {
    const companyId = this.requireCompanyId();
    const order = await sql<{ id: string }>`
      select id from orders where id = ${orderId}::uuid and company_id = ${companyId}::uuid
    `.execute(this.database);
    if (order.rows[0] === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    return this.page(companyId, sql`and w.order_id = ${orderId}::uuid`);
  }

  public async listForTrader(traderId: string): Promise<readonly WhatsAppNotificationView[]> {
    const companyId = this.requireCompanyId();
    const trader = await sql<{ id: string }>`
      select id from traders where id = ${traderId}::uuid and company_id = ${companyId}::uuid
    `.execute(this.database);
    if (trader.rows[0] === undefined) {
      throw new ApplicationException("trader_not_found", "Trader not found", HttpStatus.NOT_FOUND);
    }
    return this.page(companyId, sql`and w.trader_id = ${traderId}::uuid`);
  }

  private async page(
    companyId: string,
    anchorFilter: ReturnType<typeof sql>,
  ): Promise<readonly WhatsAppNotificationView[]> {
    const result = await sql<WhatsAppNotificationView>`
      select w.id,
             w.trader_id as "traderId",
             w.message_type as "messageType",
             w.order_id as "orderId",
             w.order_status_history_id as "orderStatusHistoryId",
             o.order_number as "orderNumber",
             h.to_status as "orderStatus",
             w.destination_type as "destinationType",
             w.provider_group_id as "providerGroupId",
             w.group_name_snapshot as "groupNameSnapshot",
             w.message_language as "messageLanguage",
             w.message_body as "messageBody",
             w.status,
             w.provider_message_id as "providerMessageId",
             w.queued_at as "queuedAt",
             w.sent_at as "sentAt",
             w.failed_at as "failedAt",
             w.failure_code as "failureCode",
             w.failure_reason as "failureReason",
             w.attempt_count as "attemptCount",
             w.created_at as "createdAt"
        from whatsapp_message_outbox w
        left join orders o on o.id = w.order_id and o.company_id = w.company_id
        left join order_status_history h
          on h.id = w.order_status_history_id and h.company_id = w.company_id
       where w.company_id = ${companyId}::uuid ${anchorFilter}
       order by w.created_at desc
       limit 100
    `.execute(this.database);
    return result.rows;
  }

  private requireCompanyId(): string {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new Error("whatsapp_history_requires_company_identity");
    }
    return identity.companyId;
  }
}
