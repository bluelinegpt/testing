import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { CompanyWhatsAppProvider } from "./company-whatsapp-provider.port.js";
import type { WhatsAppTestMessageResult } from "./whatsapp.dto.js";

/**
 * The explicit, user-triggered Trader test message (Prompt 3). NOT an Order
 * notification: it creates a `message_type = 'test'` outbox row with no
 * Order references (schema-enforced), sends through the same
 * `CompanyWhatsAppProvider` the future Order dispatcher will use, and
 * records the outcome plus a per-attempt audit row.
 *
 * Duplicate semantics are deliberately different from Order events: each
 * deliberate click IS a new message. The only dedupe is the per-request
 * `clientRequestId` (idempotency key `test:<id>`), which collapses a retried
 * or double-submitted request for the SAME click onto one row. An uncertain
 * provider outcome is never auto-resent — the row keeps its honest state.
 */
@Injectable()
export class WhatsAppTestMessageService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(CompanyWhatsAppProvider) private readonly provider: CompanyWhatsAppProvider,
  ) {}

  public async send(
    traderId: string,
    correlationId: string,
    clientRequestId: string | undefined,
  ): Promise<WhatsAppTestMessageResult> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new Error("whatsapp_test_message_requires_company_identity");
    }
    const companyId = identity.companyId;

    const trader = (
      await sql<{ id: string; nameEn: string; nameAr: string | null }>`
        select id, name_en as "nameEn", name_ar as "nameAr"
          from traders
         where id = ${traderId}::uuid and company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (trader === undefined) {
      throw new ApplicationException("trader_not_found", "Trader not found", HttpStatus.NOT_FOUND);
    }

    const settings = (
      await sql<{
        providerGroupId: string | null;
        groupNameSnapshot: string | null;
        messageLanguage: "both" | "ar" | "en";
      }>`
        select provider_group_id as "providerGroupId",
               group_name_snapshot as "groupNameSnapshot",
               message_language as "messageLanguage"
          from trader_whatsapp_settings
         where company_id = ${companyId}::uuid and trader_id = ${traderId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (settings === undefined || settings.providerGroupId === null) {
      throw new ApplicationException(
        "whatsapp_group_required",
        "Select a WhatsApp group for this Trader before sending a test message",
        HttpStatus.CONFLICT,
      );
    }

    const connection = (
      await sql<{ id: string }>`
        select id from company_whatsapp_connections where company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    const liveStatus = await this.provider.getConnectionStatus(companyId);
    if (connection === undefined || liveStatus !== "connected") {
      throw new ApplicationException(
        "whatsapp_not_connected",
        "WhatsApp is not connected",
        HttpStatus.CONFLICT,
      );
    }

    const body = buildTestMessageBody(settings.messageLanguage, trader.nameEn, trader.nameAr);
    const idempotencyKey = `test:${clientRequestId ?? randomUUID()}`;
    const inserted = await sql<{ id: string }>`
      insert into whatsapp_message_outbox (
        company_id, trader_id, connection_id, message_type, destination_type,
        provider_group_id, group_name_snapshot, message_language, message_body,
        status, processing_at, idempotency_key
      ) values (
        ${companyId}::uuid, ${traderId}::uuid, ${connection.id}::uuid, 'test', 'group',
        ${settings.providerGroupId}, ${settings.groupNameSnapshot}, ${settings.messageLanguage},
        ${body}, 'processing', now(), ${idempotencyKey}
      )
      on conflict (company_id, idempotency_key) do nothing
      returning id
    `.execute(this.database);
    const created = inserted.rows[0];
    if (created === undefined) {
      // The same click already reached the backend (double-submit / retried
      // request): return the existing record's state — never a second send.
      const existing = (
        await sql<WhatsAppTestMessageResult>`
          select id as "messageId", status, provider_message_id as "providerMessageId",
                 failure_code as "failureCode"
            from whatsapp_message_outbox
           where company_id = ${companyId}::uuid and idempotency_key = ${idempotencyKey}
        `.execute(this.database)
      ).rows[0];
      if (existing === undefined) throw new Error("whatsapp_test_message_conflict_row_missing");
      return { ...existing, duplicate: true };
    }

    const result = await this.provider.sendMessage({
      body,
      companyId,
      providerGroupId: settings.providerGroupId,
    });

    if (result.outcome === "sent") {
      await sql`
        update whatsapp_message_outbox
           set status = 'sent', sent_at = now(), provider_message_id = ${result.providerMessageId},
               attempt_count = 1, updated_at = now()
         where id = ${created.id}::uuid and company_id = ${companyId}::uuid
      `.execute(this.database);
    } else {
      await sql`
        update whatsapp_message_outbox
           set status = 'failed', failed_at = now(), failure_code = ${result.failureCode},
               failure_reason = 'test_message_send_failed', attempt_count = 1, updated_at = now()
         where id = ${created.id}::uuid and company_id = ${companyId}::uuid
      `.execute(this.database);
    }

    await sql`
      insert into whatsapp_message_attempts (
        company_id, message_id, attempt_number, completed_at, result,
        provider_response_code, provider_response_summary, failure_classification
      ) values (
        ${companyId}::uuid, ${created.id}::uuid, 1, now(),
        ${result.outcome === "sent" ? "sent" : "failed"},
        ${result.outcome === "sent" ? null : result.failureCode},
        ${result.outcome === "sent" ? "accepted_by_provider" : "send_failed"},
        ${
          result.outcome === "sent"
            ? null
            : result.outcome === "transient_failure"
              ? "transient"
              : "permanent"
        }
      )
    `.execute(this.database);

    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id
      ) values (
        ${companyId}::uuid, ${identity.identityId}::uuid, 'whatsapp.trader_test_message_sent',
        'whatsapp_message_outbox', ${created.id},
        ${JSON.stringify({
          groupNameSnapshot: settings.groupNameSnapshot,
          providerGroupId: settings.providerGroupId,
          result: result.outcome,
          traderId,
        })}::jsonb, ${correlationId}
      )
    `.execute(this.database);

    if (result.outcome === "sent") {
      return {
        failureCode: null,
        messageId: created.id,
        providerMessageId: result.providerMessageId,
        status: "sent",
      };
    }
    return {
      failureCode: result.failureCode,
      messageId: created.id,
      providerMessageId: null,
      status: "failed",
    };
  }
}

/** Interim wording only — the production Order-notification template is a
 *  later decision. Bilingual for `both`; the Trader's Arabic name is used in
 *  the Arabic text when available. No Customer data, ever. */
export function buildTestMessageBody(
  language: "both" | "ar" | "en",
  traderNameEn: string,
  traderNameAr: string | null,
): string {
  const arabicName = traderNameAr ?? traderNameEn;
  const arabic = `اختبار واتساب من توصيل هب\n\nهذه رسالة اختبار للتأكد من ربط إشعارات التاجر بنجاح.\n\nالتاجر: ${arabicName}`;
  const english = `Tawseelhub WhatsApp Test\n\nThis is a test message confirming the Trader WhatsApp notification connection.\n\nTrader: ${traderNameEn}`;
  if (language === "ar") return arabic;
  if (language === "en") return english;
  return `${arabic}\n\n${english}`;
}
