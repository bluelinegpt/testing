import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { WhatsAppConnectionRuntime } from "./providers/whatsapp-connection-runtime.service.js";
import {
  assertWhatsAppEnabledByPlatform,
  isWhatsAppDisabledByPlatform,
} from "./whatsapp-platform-controls.js";
import type {
  CompanyWhatsAppConnectionView,
  TraderGroupHealthView,
  WhatsAppGroupView,
} from "./whatsapp.dto.js";

/**
 * The Company WhatsApp connection surface: status reads plus the
 * connect/disconnect/reconnect lifecycle, all scoped to the authenticated
 * Company. Persisted state comes from `company_whatsapp_connections`; the
 * live runtime overlays the current in-process status and — only while
 * pairing — the current QR payload.
 *
 * The SELECT below deliberately never touches `encrypted_session_state` or
 * `provider_account_reference`: session material is credential-grade and no
 * read path in this module ever loads it into a response shape.
 */
@Injectable()
export class WhatsAppConnectionService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(WhatsAppConnectionRuntime) private readonly runtime: WhatsAppConnectionRuntime,
  ) {}

  public async getConnection(): Promise<CompanyWhatsAppConnectionView> {
    return this.view(this.requireCompanyId());
  }

  public async connect(correlationId: string): Promise<CompanyWhatsAppConnectionView> {
    const identity = this.identities.current();
    const companyId = this.requireCompanyId();
    await assertWhatsAppEnabledByPlatform(this.database, companyId);
    await this.runtime.connect(companyId, identity.identityId, correlationId);
    return this.view(companyId);
  }

  public async disconnect(correlationId: string): Promise<CompanyWhatsAppConnectionView> {
    const identity = this.identities.current();
    const companyId = this.requireCompanyId();
    await this.runtime.disconnect(companyId, identity.identityId, correlationId);
    return this.view(companyId);
  }

  public async reconnect(correlationId: string): Promise<CompanyWhatsAppConnectionView> {
    const identity = this.identities.current();
    const companyId = this.requireCompanyId();
    await assertWhatsAppEnabledByPlatform(this.database, companyId);
    await this.runtime.reconnect(companyId, identity.identityId, correlationId);
    return this.view(companyId);
  }

  /** Live group discovery from the connected account — provider data, not a
   *  persisted list. Controlled `whatsapp_not_connected` when there is no
   *  live connected runtime; never fabricated groups. */
  public async listGroups(): Promise<readonly WhatsAppGroupView[]> {
    const companyId = this.requireCompanyId();
    const groups = await this.runtime.listGroups(companyId);
    return groups.map((group) => ({
      id: group.providerGroupId,
      name: group.name,
      ...(group.participantCount === undefined ? {} : { participantCount: group.participantCount }),
    }));
  }

  /**
   * Mapping health (Prompt 5 §11): every configured Trader group compared
   * against ONE on-demand live discovery — no per-Trader polling. When
   * WhatsApp is not connected, availability is honestly `null` (unknowable
   * right now), never guessed. Nothing here mutates or removes mappings.
   */
  public async traderGroupHealth(): Promise<TraderGroupHealthView> {
    const companyId = this.requireCompanyId();
    const configured = (
      await sql<{
        traderId: string;
        traderName: string;
        groupNameSnapshot: string | null;
        providerGroupId: string;
        notificationsEnabled: boolean;
      }>`
        select s.trader_id as "traderId", t.name_en as "traderName",
               s.group_name_snapshot as "groupNameSnapshot",
               s.provider_group_id as "providerGroupId",
               s.notifications_enabled as "notificationsEnabled"
          from trader_whatsapp_settings s
          join traders t on t.id = s.trader_id and t.company_id = s.company_id
         where s.company_id = ${companyId}::uuid and s.provider_group_id is not null
         order by t.name_en
      `.execute(this.database)
    ).rows;

    let liveGroupIds: Set<string> | null = null;
    try {
      const groups = await this.runtime.listGroups(companyId);
      liveGroupIds = new Set(groups.map((group) => group.providerGroupId));
    } catch {
      // Not connected (or discovery temporarily unavailable): availability is
      // unknown — report that honestly rather than flagging every mapping.
      liveGroupIds = null;
    }

    const rows = configured.map((mapping) => ({
      ...mapping,
      available: liveGroupIds === null ? null : liveGroupIds.has(mapping.providerGroupId),
    }));
    const availableCount = rows.filter((row) => row.available === true).length;
    return {
      availableCount,
      checkedAt: liveGroupIds === null ? null : new Date(),
      configured: rows.length,
      connected: liveGroupIds !== null,
      needsAttention: liveGroupIds === null ? 0 : rows.length - availableCount,
      rows,
    };
  }

  private async view(companyId: string): Promise<CompanyWhatsAppConnectionView> {
    const result = await sql<{
      status: string;
      providerType: string;
      connectedPhoneNumber: string | null;
      connectedAt: Date | null;
      lastConnectedAt: Date | null;
      lastDisconnectedAt: Date | null;
      disconnectReason: string | null;
      lastHealthCheckAt: Date | null;
    }>`
      select status,
             provider_type as "providerType",
             connected_phone_number as "connectedPhoneNumber",
             connected_at as "connectedAt",
             last_connected_at as "lastConnectedAt",
             last_disconnected_at as "lastDisconnectedAt",
             disconnect_reason as "disconnectReason",
             last_health_check_at as "lastHealthCheckAt"
        from company_whatsapp_connections
       where company_id = ${companyId}::uuid
    `.execute(this.database);
    const row = result.rows[0] ?? {
      connectedAt: null,
      connectedPhoneNumber: null,
      disconnectReason: null,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      lastHealthCheckAt: null,
      providerType: "unconfigured",
      status: "not_connected",
    };
    // The in-process runtime is fresher than the persisted row while a
    // socket is live (and is the only holder of the transient QR payload).
    const live = this.runtime.getLiveState(companyId);
    const status = live?.status ?? row.status;
    const qr = live?.qr ?? null;
    const platformDisabled = await isWhatsAppDisabledByPlatform(this.database, companyId);
    return {
      ...row,
      platformDisabled,
      qr,
      qrAvailable: qr !== null,
      requiresQrScan: status === "waiting_for_qr_scan",
      status,
    };
  }

  private requireCompanyId(): string {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new Error("whatsapp_connection_requires_company_identity");
    }
    return identity.companyId;
  }
}
