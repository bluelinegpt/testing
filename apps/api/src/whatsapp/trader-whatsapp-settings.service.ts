import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import type {
  TraderWhatsAppSettingsView,
  UpdateTraderWhatsAppSettingsDto,
  WhatsAppMessageLanguage,
} from "./whatsapp.dto.js";

interface SettingsRow {
  readonly id: string;
  readonly notificationsEnabled: boolean;
  readonly destinationType: "group";
  readonly providerGroupId: string | null;
  readonly groupNameSnapshot: string | null;
  readonly messageLanguage: WhatsAppMessageLanguage;
  readonly configuredAt: Date;
}

/**
 * Trader WhatsApp notification configuration — one row per (Company, Trader),
 * enforced by the `unique (company_id, trader_id)` constraint the upsert
 * below targets. Every read and write derives `companyId` from
 * `IdentityContextAccessor.current()`; a Trader belonging to another Company
 * is indistinguishable from a Trader that does not exist (404, never 403 —
 * the same cross-tenant discipline as every operations service).
 *
 * Disabling notifications or removing the group mapping only changes THIS
 * configuration row — historical `whatsapp_message_outbox` records are audit
 * data and are never touched from here.
 */
@Injectable()
export class TraderWhatsAppSettingsService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async getForTrader(traderId: string): Promise<TraderWhatsAppSettingsView> {
    const companyId = this.requireCompanyId();
    await this.requireTrader(this.database, companyId, traderId);
    const row = await this.loadSettings(this.database, companyId, traderId);
    return this.toView(traderId, row);
  }

  public async update(
    traderId: string,
    input: UpdateTraderWhatsAppSettingsDto,
    correlationId: string,
  ): Promise<TraderWhatsAppSettingsView> {
    const identity = this.identities.current();
    const companyId = this.requireCompanyId();
    return this.transactions.execute(async (transaction) => {
      await this.requireTrader(transaction, companyId, traderId, { lock: true });
      const existing = await this.loadSettings(transaction, companyId, traderId);

      // `undefined` means "field not sent, keep the stored value"; an empty
      // string means "explicitly cleared" and must NOT fall back to the old
      // value — hence the explicit undefined checks instead of `??` chains.
      const sentGroupId = this.normalized(input.providerGroupId);
      const providerGroupId =
        sentGroupId !== undefined ? sentGroupId : (existing?.providerGroupId ?? null);
      const sentGroupName = this.normalized(input.groupNameSnapshot);
      const groupNameSnapshot =
        sentGroupName !== undefined ? sentGroupName : (existing?.groupNameSnapshot ?? null);
      const messageLanguage = input.messageLanguage ?? existing?.messageLanguage ?? "both";
      const destinationType = input.destinationType ?? existing?.destinationType ?? "group";
      if (input.notificationsEnabled && providerGroupId === null) {
        throw new ApplicationException(
          "whatsapp_group_required",
          "A WhatsApp group must be selected before notifications can be enabled",
          HttpStatus.BAD_REQUEST,
        );
      }

      const upserted = await sql<{ id: string; configuredAt: Date }>`
        insert into trader_whatsapp_settings (
          company_id, trader_id, notifications_enabled, destination_type,
          provider_group_id, group_name_snapshot, message_language,
          configured_at, configured_by_account_id
        ) values (
          ${companyId}::uuid, ${traderId}::uuid, ${input.notificationsEnabled}, ${destinationType},
          ${providerGroupId}, ${groupNameSnapshot}, ${messageLanguage},
          now(), ${identity.identityId}::uuid
        )
        on conflict (company_id, trader_id) do update set
          notifications_enabled = excluded.notifications_enabled,
          destination_type = excluded.destination_type,
          provider_group_id = excluded.provider_group_id,
          group_name_snapshot = excluded.group_name_snapshot,
          message_language = excluded.message_language,
          configured_at = now(),
          configured_by_account_id = excluded.configured_by_account_id,
          updated_at = now(),
          version = trader_whatsapp_settings.version + 1
        returning id, configured_at as "configuredAt"
      `.execute(transaction);
      const row = upserted.rows[0];
      if (row === undefined) throw new Error("trader_whatsapp_settings_upsert_failed");

      await this.auditChanges(transaction, {
        actorId: identity.identityId,
        after: {
          destinationType,
          groupNameSnapshot,
          messageLanguage,
          notificationsEnabled: input.notificationsEnabled,
          providerGroupId,
        },
        companyId,
        correlationId,
        existing,
        subjectId: row.id,
        traderId,
      });

      return this.toView(traderId, {
        configuredAt: row.configuredAt,
        destinationType,
        groupNameSnapshot,
        id: row.id,
        messageLanguage,
        notificationsEnabled: input.notificationsEnabled,
        providerGroupId,
      });
    });
  }

  /** Clears the group mapping and disables notifications; a Trader with no
   *  configuration row is already in that state, so this is then a no-op. */
  public async removeGroupMapping(
    traderId: string,
    correlationId: string,
  ): Promise<TraderWhatsAppSettingsView> {
    const identity = this.identities.current();
    const companyId = this.requireCompanyId();
    return this.transactions.execute(async (transaction) => {
      await this.requireTrader(transaction, companyId, traderId, { lock: true });
      const existing = await this.loadSettings(transaction, companyId, traderId);
      if (existing === undefined || existing.providerGroupId === null) {
        return this.toView(traderId, existing);
      }
      await sql`
        update trader_whatsapp_settings
           set notifications_enabled = false,
               provider_group_id = null,
               group_name_snapshot = null,
               configured_at = now(),
               configured_by_account_id = ${identity.identityId}::uuid,
               updated_at = now(),
               version = version + 1
         where id = ${existing.id}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await this.audit(transaction, {
        action: "whatsapp.trader_group_removed",
        actorId: identity.identityId,
        after: {
          previousGroupId: existing.providerGroupId,
          previousGroupName: existing.groupNameSnapshot,
          traderId,
        },
        companyId,
        correlationId,
        subjectId: existing.id,
      });
      if (existing.notificationsEnabled) {
        await this.audit(transaction, {
          action: "whatsapp.trader_notifications_disabled",
          actorId: identity.identityId,
          after: { reason: "group_mapping_removed", traderId },
          companyId,
          correlationId,
          subjectId: existing.id,
        });
      }
      return this.toView(traderId, {
        ...existing,
        groupNameSnapshot: null,
        notificationsEnabled: false,
        providerGroupId: null,
      });
    });
  }

  private requireCompanyId(): string {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new Error("trader_whatsapp_settings_requires_company_identity");
    }
    return identity.companyId;
  }

  private async requireTrader(
    execute: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    traderId: string,
    options: { readonly lock?: boolean } = {},
  ): Promise<void> {
    const query =
      options.lock === true
        ? sql<{ id: string }>`
            select id from traders
             where id = ${traderId}::uuid and company_id = ${companyId}::uuid
             for update
          `
        : sql<{ id: string }>`
            select id from traders
             where id = ${traderId}::uuid and company_id = ${companyId}::uuid
          `;
    const result = await query.execute(execute);
    if (result.rows[0] === undefined) {
      throw new ApplicationException("trader_not_found", "Trader not found", HttpStatus.NOT_FOUND);
    }
  }

  private async loadSettings(
    execute: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    traderId: string,
  ): Promise<SettingsRow | undefined> {
    const result = await sql<SettingsRow>`
      select id,
             notifications_enabled as "notificationsEnabled",
             destination_type as "destinationType",
             provider_group_id as "providerGroupId",
             group_name_snapshot as "groupNameSnapshot",
             message_language as "messageLanguage",
             configured_at as "configuredAt"
        from trader_whatsapp_settings
       where company_id = ${companyId}::uuid and trader_id = ${traderId}::uuid
    `.execute(execute);
    return result.rows[0];
  }

  private toView(traderId: string, row: SettingsRow | undefined): TraderWhatsAppSettingsView {
    if (row === undefined) {
      return {
        configured: false,
        configuredAt: null,
        destinationType: "group",
        groupNameSnapshot: null,
        messageLanguage: "both",
        notificationsEnabled: false,
        providerGroupId: null,
        traderId,
      };
    }
    return {
      configured: true,
      configuredAt: row.configuredAt,
      destinationType: row.destinationType,
      groupNameSnapshot: row.groupNameSnapshot,
      messageLanguage: row.messageLanguage,
      notificationsEnabled: row.notificationsEnabled,
      providerGroupId: row.providerGroupId,
      traderId,
    };
  }

  /** One audit event per meaningful change, mirroring the append-only
   *  `audit_events` shape used by `OperationsHistoryWriter.audit`. Safe
   *  snapshots only — nothing in this configuration is secret, and session
   *  material never passes through this service at all. */
  private async auditChanges(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly actorId: string;
      readonly companyId: string;
      readonly correlationId: string;
      readonly existing: SettingsRow | undefined;
      readonly subjectId: string;
      readonly traderId: string;
      readonly after: {
        readonly notificationsEnabled: boolean;
        readonly destinationType: string;
        readonly providerGroupId: string | null;
        readonly groupNameSnapshot: string | null;
        readonly messageLanguage: string;
      };
    },
  ): Promise<void> {
    const base = {
      actorId: input.actorId,
      companyId: input.companyId,
      correlationId: input.correlationId,
      subjectId: input.subjectId,
    };
    const wasEnabled = input.existing?.notificationsEnabled ?? false;
    if (input.after.notificationsEnabled !== wasEnabled) {
      await this.audit(transaction, {
        ...base,
        action: input.after.notificationsEnabled
          ? "whatsapp.trader_notifications_enabled"
          : "whatsapp.trader_notifications_disabled",
        after: {
          groupNameSnapshot: input.after.groupNameSnapshot,
          providerGroupId: input.after.providerGroupId,
          traderId: input.traderId,
        },
      });
    }
    const previousGroupId = input.existing?.providerGroupId ?? null;
    if (input.after.providerGroupId !== previousGroupId) {
      await this.audit(transaction, {
        ...base,
        action: "whatsapp.trader_group_changed",
        after: {
          from: previousGroupId,
          fromName: input.existing?.groupNameSnapshot ?? null,
          to: input.after.providerGroupId,
          toName: input.after.groupNameSnapshot,
          traderId: input.traderId,
        },
      });
    }
    const previousLanguage = input.existing?.messageLanguage ?? null;
    if (previousLanguage !== null && input.after.messageLanguage !== previousLanguage) {
      await this.audit(transaction, {
        ...base,
        action: "whatsapp.trader_language_changed",
        after: {
          from: previousLanguage,
          to: input.after.messageLanguage,
          traderId: input.traderId,
        },
      });
    }
  }

  private async audit(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly action: string;
      readonly actorId: string;
      readonly after: object;
      readonly companyId: string;
      readonly correlationId: string;
      readonly subjectId: string;
    },
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id
      ) values (
        ${input.companyId}::uuid, ${input.actorId}::uuid, ${input.action},
        'trader_whatsapp_settings', ${input.subjectId},
        ${JSON.stringify(input.after)}::jsonb, ${input.correlationId}
      )
    `.execute(transaction);
  }

  private normalized(value: string | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
}
