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
    return this.page(companyId, sql`and order_id = ${orderId}::uuid`);
  }

  public async listForTrader(traderId: string): Promise<readonly WhatsAppNotificationView[]> {
    const companyId = this.requireCompanyId();
    const trader = await sql<{ id: string }>`
      select id from traders where id = ${traderId}::uuid and company_id = ${companyId}::uuid
    `.execute(this.database);
    if (trader.rows[0] === undefined) {
      throw new ApplicationException("trader_not_found", "Trader not found", HttpStatus.NOT_FOUND);
    }
    return this.page(companyId, sql`and trader_id = ${traderId}::uuid`);
  }

  private async page(
    companyId: string,
    anchorFilter: ReturnType<typeof sql>,
  ): Promise<readonly WhatsAppNotificationView[]> {
    const result = await sql<WhatsAppNotificationView>`
      select id,
             trader_id as "traderId",
             order_id as "orderId",
             order_status_history_id as "orderStatusHistoryId",
             destination_type as "destinationType",
             provider_group_id as "providerGroupId",
             group_name_snapshot as "groupNameSnapshot",
             message_language as "messageLanguage",
             message_body as "messageBody",
             status,
             provider_message_id as "providerMessageId",
             queued_at as "queuedAt",
             sent_at as "sentAt",
             failed_at as "failedAt",
             failure_code as "failureCode",
             failure_reason as "failureReason",
             attempt_count as "attemptCount",
             created_at as "createdAt"
        from whatsapp_message_outbox
       where company_id = ${companyId}::uuid ${anchorFilter}
       order by created_at desc
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
