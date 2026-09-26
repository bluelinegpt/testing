import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import type {
  ListWhatsAppMessagesDto,
  WhatsAppMessageDetailView,
  WhatsAppMessageListItemView,
  WhatsAppMessagePage,
} from "./whatsapp.dto.js";

/**
 * Company-scoped WhatsApp message operations (Prompt 5): the filterable
 * message table, the message detail with attempt history, and the operator
 * RESOLUTION actions on stuck messages.
 *
 * Retry safety rules are enforced HERE, in the backend — UI button
 * visibility is a convenience, never the guarantee:
 *  - `sent` and `cancelled` can never be retried (also DB-guarded for sent);
 *  - `pending`/`processing` need no retry;
 *  - `failed` may be retried with a normal confirmation;
 *  - `requires_review` may be retried ONLY with an explicit duplicate-risk
 *    confirmation, because the original attempt may have been accepted.
 * Every intervention writes an audit event with safe metadata only.
 */
@Injectable()
export class WhatsAppMessageOperationsService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async list(filters: ListWhatsAppMessagesDto): Promise<WhatsAppMessagePage> {
    const companyId = this.requireCompanyId();
    const page = Math.max(1, Number(filters.page ?? "1") || 1);
    const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize ?? "25") || 25));
    const dateFrom = this.parseDate(filters.dateFrom);
    const dateTo = this.parseDate(filters.dateTo);

    const result = await sql<WhatsAppMessageListItemView & { total: string }>`
      select w.id, w.created_at as "createdAt",
             w.trader_id as "traderId", t.name_en as "traderName",
             w.order_id as "orderId", o.order_number as "orderNumber",
             h.to_status as "orderStatus",
             w.group_name_snapshot as "groupNameSnapshot",
             w.message_type as "messageType", w.message_language as "messageLanguage",
             w.status, w.attempt_count as "attemptCount", w.failure_code as "failureCode",
             w.next_attempt_at as "nextAttemptAt", w.sent_at as "sentAt",
             count(*) over ()::text as total
        from whatsapp_message_outbox w
        left join traders t on t.id = w.trader_id and t.company_id = w.company_id
        left join orders o on o.id = w.order_id and o.company_id = w.company_id
        left join order_status_history h
          on h.id = w.order_status_history_id and h.company_id = w.company_id
       where w.company_id = ${companyId}::uuid
         and (${filters.status ?? null}::text is null or w.status = ${filters.status ?? null})
         and (${filters.messageType ?? null}::text is null or w.message_type = ${filters.messageType ?? null})
         and (${filters.traderId ?? null}::uuid is null or w.trader_id = ${filters.traderId ?? null}::uuid)
         and (${filters.orderNumber ?? null}::text is null
              or o.order_number ilike '%' || ${filters.orderNumber ?? null} || '%')
         and (${dateFrom}::timestamptz is null or w.created_at >= ${dateFrom}::timestamptz)
         and (${dateTo}::timestamptz is null or w.created_at <= ${dateTo}::timestamptz)
       order by w.created_at desc
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);

    const total = Number(result.rows[0]?.total ?? 0);
    const items = result.rows.map((row) => {
      const item: Partial<typeof row> = { ...row };
      delete item.total;
      return item as WhatsAppMessageListItemView;
    });
    return { items, page, pageSize, total };
  }

  public async detail(messageId: string): Promise<WhatsAppMessageDetailView> {
    const companyId = this.requireCompanyId();
    const row = (
      await sql<Omit<WhatsAppMessageDetailView, "attempts">>`
        select w.id, w.created_at as "createdAt",
               w.trader_id as "traderId", t.name_en as "traderName",
               w.order_id as "orderId", o.order_number as "orderNumber",
               h.to_status as "orderStatus",
               w.order_status_history_id as "orderStatusHistoryId",
               h.occurred_at as "statusEventOccurredAt",
               w.group_name_snapshot as "groupNameSnapshot",
               w.provider_group_id as "providerGroupId",
               w.message_type as "messageType", w.message_language as "messageLanguage",
               w.message_body as "messageBody",
               w.status, w.attempt_count as "attemptCount",
               w.failure_code as "failureCode", w.failure_reason as "failureReason",
               w.next_attempt_at as "nextAttemptAt",
               w.provider_message_id as "providerMessageId",
               w.queued_at as "queuedAt", w.processing_at as "processingAt",
               w.sent_at as "sentAt", w.failed_at as "failedAt"
          from whatsapp_message_outbox w
          left join traders t on t.id = w.trader_id and t.company_id = w.company_id
          left join orders o on o.id = w.order_id and o.company_id = w.company_id
          left join order_status_history h
            on h.id = w.order_status_history_id and h.company_id = w.company_id
         where w.id = ${messageId}::uuid and w.company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "whatsapp_message_not_found",
        "WhatsApp message not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const attempts = (
      await sql<WhatsAppMessageDetailView["attempts"][number]>`
        select attempt_number as "attemptNumber", started_at as "startedAt",
               completed_at as "completedAt", result,
               failure_classification as "failureClassification",
               provider_response_summary as "providerResponseSummary"
          from whatsapp_message_attempts
         where message_id = ${messageId}::uuid and company_id = ${companyId}::uuid
         order by attempt_number
      `.execute(this.database)
    ).rows;
    return { ...row, attempts };
  }

  public async retry(
    messageId: string,
    confirmDuplicateRisk: boolean,
    correlationId: string,
  ): Promise<WhatsAppMessageDetailView> {
    const identity = this.identities.current();
    const companyId = this.requireCompanyId();
    const current = await this.detail(messageId);

    if (current.status === "sent" || current.status === "cancelled") {
      throw new ApplicationException(
        "whatsapp_retry_not_allowed",
        "This message can no longer be retried",
        HttpStatus.CONFLICT,
      );
    }
    if (current.status === "pending" || current.status === "processing") {
      throw new ApplicationException(
        "whatsapp_retry_not_needed",
        "This message is already queued for delivery",
        HttpStatus.CONFLICT,
      );
    }
    if (current.status === "requires_review" && !confirmDuplicateRisk) {
      throw new ApplicationException(
        "whatsapp_duplicate_risk_confirmation_required",
        "Retrying an unconfirmed message may deliver a duplicate; explicit confirmation is required",
        HttpStatus.CONFLICT,
      );
    }

    await sql`
      update whatsapp_message_outbox
         set status = 'pending', next_attempt_at = now(), updated_at = now()
       where id = ${messageId}::uuid and company_id = ${companyId}::uuid
         and status in ('failed', 'requires_review')
    `.execute(this.database);
    await this.audit(
      companyId,
      identity.identityId,
      current.status === "requires_review"
        ? "whatsapp.message_uncertain_retry_confirmed"
        : "whatsapp.message_retry_requested",
      messageId,
      correlationId,
      {
        failureCode: current.failureCode,
        newStatus: "pending",
        orderId: current.orderId,
        priorStatus: current.status,
        traderId: current.traderId,
      },
    );
    return this.detail(messageId);
  }

  public async resolve(
    messageId: string,
    action: "mark_resolved" | "cancel",
    correlationId: string,
  ): Promise<WhatsAppMessageDetailView> {
    const identity = this.identities.current();
    const companyId = this.requireCompanyId();
    const current = await this.detail(messageId);

    const resolvable =
      action === "mark_resolved"
        ? ["requires_review", "failed"]
        : ["pending", "failed", "requires_review"];
    if (!resolvable.includes(current.status)) {
      throw new ApplicationException(
        "whatsapp_resolution_not_allowed",
        "This message cannot be resolved from its current state",
        HttpStatus.CONFLICT,
      );
    }

    await sql`
      update whatsapp_message_outbox
         set status = 'cancelled',
             failure_reason = ${action === "mark_resolved" ? "operator_resolved_no_resend" : "operator_cancelled"},
             next_attempt_at = null, updated_at = now()
       where id = ${messageId}::uuid and company_id = ${companyId}::uuid
         and status = ${current.status}
    `.execute(this.database);
    await this.audit(
      companyId,
      identity.identityId,
      action === "mark_resolved"
        ? "whatsapp.message_marked_resolved"
        : "whatsapp.message_cancelled",
      messageId,
      correlationId,
      {
        failureCode: current.failureCode,
        newStatus: "cancelled",
        orderId: current.orderId,
        priorStatus: current.status,
        traderId: current.traderId,
      },
    );
    return this.detail(messageId);
  }

  private async audit(
    companyId: string,
    actorId: string,
    action: string,
    messageId: string,
    correlationId: string,
    after: object,
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id
      ) values (
        ${companyId}::uuid, ${actorId}::uuid, ${action},
        'whatsapp_message_outbox', ${messageId}, ${JSON.stringify(after)}::jsonb, ${correlationId}
      )
    `.execute(this.database);
  }

  private parseDate(value: string | undefined): Date | null {
    if (value === undefined || value.trim() === "") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private requireCompanyId(): string {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new Error("whatsapp_message_operations_requires_company_identity");
    }
    return identity.companyId;
  }
}
