import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  DEFAULT_TEMPLATE_BODY_AR,
  DEFAULT_TEMPLATE_BODY_EN,
  TEMPLATE_PLACEHOLDERS,
  TRADER_NOTIFIABLE_DELIVERY_STATUSES,
} from "../whatsapp/whatsapp-message-templates.js";
import type {
  ListCompanyWhatsAppMessagesQueryDto,
  SetCompanyWhatsAppEnabledDto,
  UpdateCompanyWhatsAppTemplateDto,
} from "./platform-company-whatsapp.dto.js";

interface PlatformActor {
  readonly accountId: string;
  readonly correlationId: string;
}

const notifiableStatuses = new Set<string>(TRADER_NOTIFIABLE_DELIVERY_STATUSES);

/**
 * Platform Administration's per-Company WhatsApp surface. Takes the target
 * `companyId` explicitly (the `CompanyWebsiteService` shape) because the
 * caller is a PLATFORM actor — `identity.companyId` is null and the tenant
 * comes from `PlatformTargetCompanyGuard`, so the identity-scoped WhatsApp
 * services cannot be reused here.
 *
 * Enable/disable semantics: absence of a `company_whatsapp_platform_settings`
 * row means ENABLED. Disabling is a full stop for the Company (no new
 * notifications, no test messages, no connect) but deliberately keeps the
 * paired session, Trader mappings and history so re-enabling restores
 * service without re-pairing.
 *
 * Templates: only OVERRIDES are stored; a status with no row renders the
 * built-in default. Outbox bodies are snapshots — edits here shape future
 * messages only, never history.
 */
@Injectable()
export class PlatformCompanyWhatsAppService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async overview(companyId: string) {
    const settings = (
      await sql<{
        whatsappEnabled: boolean;
        disabledReason: string | null;
        enabledStatuses: string[] | null;
      }>`
        select whatsapp_enabled as "whatsappEnabled", disabled_reason as "disabledReason",
               enabled_statuses as "enabledStatuses"
          from company_whatsapp_platform_settings
         where company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];

    const connection = (
      await sql<{
        status: string;
        connectedPhoneNumber: string | null;
        lastConnectedAt: Date | null;
        lastDisconnectedAt: Date | null;
      }>`
        select status,
               connected_phone_number as "connectedPhoneNumber",
               last_connected_at as "lastConnectedAt",
               last_disconnected_at as "lastDisconnectedAt"
          from company_whatsapp_connections
         where company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];

    const overrides = (
      await sql<{ status: string; bodyAr: string; bodyEn: string; updatedAt: Date }>`
        select status, body_ar as "bodyAr", body_en as "bodyEn", updated_at as "updatedAt"
          from company_whatsapp_message_templates
         where company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows;
    const overrideByStatus = new Map(overrides.map((row) => [row.status, row]));

    // NULL allowlist means every notifiable status sends (the default).
    const enabledStatuses =
      settings?.enabledStatuses === undefined || settings.enabledStatuses === null
        ? null
        : new Set(settings.enabledStatuses);
    return {
      connection: connection ?? null,
      disabledReason: settings?.disabledReason ?? null,
      enabled: settings?.whatsappEnabled ?? true,
      placeholders: TEMPLATE_PLACEHOLDERS,
      templates: TRADER_NOTIFIABLE_DELIVERY_STATUSES.map((status) => {
        const override = overrideByStatus.get(status);
        return {
          bodyAr: override?.bodyAr ?? DEFAULT_TEMPLATE_BODY_AR,
          bodyEn: override?.bodyEn ?? DEFAULT_TEMPLATE_BODY_EN,
          enabled: enabledStatuses === null || enabledStatuses.has(status),
          isCustom: override !== undefined,
          status,
          updatedAt: override?.updatedAt ?? null,
        };
      }),
    };
  }

  /**
   * Replaces the Company's status allowlist with the given set (idempotent —
   * the client always sends the COMPLETE list of statuses that should send).
   * All six statuses are stored as NULL, keeping "unrestricted" the natural
   * default and auto-enabling any status added to the catalogue later.
   */
  public async setEnabledStatuses(
    companyId: string,
    statuses: readonly string[],
    actor: PlatformActor,
  ) {
    const unknown = statuses.filter((status) => !notifiableStatuses.has(status));
    if (unknown.length > 0) {
      throw new ApplicationException(
        "whatsapp_template_status_unknown",
        "This status has no WhatsApp notification template",
        HttpStatus.NOT_FOUND,
        unknown,
      );
    }
    const unique = [...new Set(statuses)];
    const stored =
      unique.length === TRADER_NOTIFIABLE_DELIVERY_STATUSES.length ? null : unique.sort();
    const before = (
      await sql<{ enabledStatuses: string[] | null }>`
        select enabled_statuses as "enabledStatuses"
          from company_whatsapp_platform_settings
         where company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    await sql`
      insert into company_whatsapp_platform_settings (
        company_id, whatsapp_enabled, enabled_statuses, updated_by_account_id
      ) values (
        ${companyId}::uuid, true, ${stored}::text[], ${actor.accountId}::uuid
      )
      on conflict (company_id) do update
        set enabled_statuses = excluded.enabled_statuses,
            updated_by_account_id = excluded.updated_by_account_id,
            updated_at = now(),
            version = company_whatsapp_platform_settings.version + 1
    `.execute(this.database);
    await this.audit(companyId, actor, "platform.company_whatsapp.statuses_changed", companyId, {
      before: { enabledStatuses: before?.enabledStatuses ?? null },
      after: { enabledStatuses: stored },
    });
    return this.overview(companyId);
  }

  public async setEnabled(
    companyId: string,
    input: SetCompanyWhatsAppEnabledDto,
    actor: PlatformActor,
  ) {
    // The table CHECK requires a null reason on an enabled row; normalizing
    // here keeps enable idempotent even when a client echoes the old reason.
    const reason = input.enabled ? null : input.reason?.trim() || null;
    const before = (
      await sql<{ whatsappEnabled: boolean }>`
        select whatsapp_enabled as "whatsappEnabled"
          from company_whatsapp_platform_settings
         where company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    await sql`
      insert into company_whatsapp_platform_settings (
        company_id, whatsapp_enabled, disabled_reason, updated_by_account_id
      ) values (
        ${companyId}::uuid, ${input.enabled}, ${reason}, ${actor.accountId}::uuid
      )
      on conflict (company_id) do update
        set whatsapp_enabled = excluded.whatsapp_enabled,
            disabled_reason = excluded.disabled_reason,
            updated_by_account_id = excluded.updated_by_account_id,
            updated_at = now(),
            version = company_whatsapp_platform_settings.version + 1
    `.execute(this.database);
    await this.audit(companyId, actor, "platform.company_whatsapp.enabled_changed", companyId, {
      before: { enabled: before?.whatsappEnabled ?? true },
      after: { enabled: input.enabled, reason },
    });
    return this.overview(companyId);
  }

  public async updateTemplate(
    companyId: string,
    status: string,
    input: UpdateCompanyWhatsAppTemplateDto,
    actor: PlatformActor,
  ) {
    this.assertNotifiableStatus(status);
    await sql`
      insert into company_whatsapp_message_templates (
        company_id, status, body_ar, body_en, updated_by_account_id
      ) values (
        ${companyId}::uuid, ${status}, ${input.bodyAr}, ${input.bodyEn}, ${actor.accountId}::uuid
      )
      on conflict (company_id, status) do update
        set body_ar = excluded.body_ar,
            body_en = excluded.body_en,
            updated_by_account_id = excluded.updated_by_account_id,
            updated_at = now(),
            version = company_whatsapp_message_templates.version + 1
    `.execute(this.database);
    await this.audit(companyId, actor, "platform.company_whatsapp.template_updated", companyId, {
      after: { bodyAr: input.bodyAr, bodyEn: input.bodyEn, status },
    });
    return this.overview(companyId);
  }

  public async resetTemplate(companyId: string, status: string, actor: PlatformActor) {
    this.assertNotifiableStatus(status);
    // Removing the override restores the built-in default for FUTURE messages
    // only — sent messages keep their snapshotted bodies. This delete targets
    // exactly one (company, status) wording-override row: Platform-authored
    // configuration, never a Company business record. See the reviewed
    // exemption in platform-security-certification.test.ts.
    await sql`
      delete from company_whatsapp_message_templates
       where company_id = ${companyId}::uuid and status = ${status}
    `.execute(this.database);
    await this.audit(companyId, actor, "platform.company_whatsapp.template_reset", companyId, {
      after: { status },
    });
    return this.overview(companyId);
  }

  public async listMessages(companyId: string, query: ListCompanyWhatsAppMessagesQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const offset = (page - 1) * pageSize;
    // Inclusive [from, to] business dates, evaluated in the operation's own
    // timezone convention (Asia/Dubai) so a message sent at 23:30 Dubai time
    // lands on the day the operator saw it happen.
    const fromFilter = query.from ?? null;
    const toFilter = query.to ?? null;

    const totals = (
      await sql<{ total: number; pending: number; sent: number; failed: number }>`
        select count(*)::int as total,
               count(*) filter (where m.status in ('pending', 'processing'))::int as pending,
               count(*) filter (where m.status = 'sent')::int as sent,
               count(*) filter (where m.status in ('failed', 'requires_review'))::int as failed
          from whatsapp_message_outbox m
         where m.company_id = ${companyId}::uuid
           and (${fromFilter}::date is null
                or (m.created_at at time zone 'Asia/Dubai')::date >= ${fromFilter}::date)
           and (${toFilter}::date is null
                or (m.created_at at time zone 'Asia/Dubai')::date <= ${toFilter}::date)
      `.execute(this.database)
    ).rows[0] ?? { failed: 0, pending: 0, sent: 0, total: 0 };

    const items = (
      await sql<{
        id: string;
        createdAt: Date;
        messageType: string;
        status: string;
        failureCode: string | null;
        messageLanguage: string;
        groupNameSnapshot: string | null;
        traderName: string | null;
        orderNumber: string | null;
        messageBody: string;
      }>`
        select m.id, m.created_at as "createdAt", m.message_type as "messageType",
               m.status, m.failure_code as "failureCode",
               m.message_language as "messageLanguage",
               m.group_name_snapshot as "groupNameSnapshot",
               t.name_en as "traderName",
               o.order_number as "orderNumber",
               m.message_body as "messageBody"
          from whatsapp_message_outbox m
          left join traders t on t.id = m.trader_id and t.company_id = m.company_id
          left join orders o on o.id = m.order_id and o.company_id = m.company_id
         where m.company_id = ${companyId}::uuid
           and (${fromFilter}::date is null
                or (m.created_at at time zone 'Asia/Dubai')::date >= ${fromFilter}::date)
           and (${toFilter}::date is null
                or (m.created_at at time zone 'Asia/Dubai')::date <= ${toFilter}::date)
         order by m.created_at desc
         limit ${pageSize} offset ${offset}
      `.execute(this.database)
    ).rows;

    return { items, page, pageSize, totals };
  }

  private assertNotifiableStatus(status: string): void {
    if (!notifiableStatuses.has(status)) {
      throw new ApplicationException(
        "whatsapp_template_status_unknown",
        "This status has no WhatsApp notification template",
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async audit(
    companyId: string,
    actor: PlatformActor,
    action: string,
    subjectId: string,
    data: { before?: object; after: object },
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        before_data, after_data, correlation_id, actor_role, source, result,
        source_application
      ) values (
        ${companyId}::uuid, ${actor.accountId}::uuid, ${action},
        'company_whatsapp_platform_controls', ${subjectId}::uuid,
        ${data.before === undefined ? null : JSON.stringify(data.before)}::jsonb,
        ${JSON.stringify(data.after)}::jsonb, ${actor.correlationId},
        'platform_administrator', 'platform_portal', 'success', 'platform-web'
      )
    `.execute(this.database);
  }
}
