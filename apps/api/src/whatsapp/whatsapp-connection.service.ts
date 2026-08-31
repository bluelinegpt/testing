import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import type { CompanyWhatsAppConnectionView } from "./whatsapp.dto.js";

/**
 * Read side of the Company WhatsApp connection. Creating/driving a real
 * connection (QR flow, provider session) is Prompt 2 — until then a Company
 * with no row simply reads back as `not_connected`, which is the truth.
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
  ) {}

  public async getConnection(): Promise<CompanyWhatsAppConnectionView> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new Error("whatsapp_connection_requires_company_identity");
    }
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
       where company_id = ${identity.companyId}::uuid
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      return {
        connectedAt: null,
        connectedPhoneNumber: null,
        disconnectReason: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastHealthCheckAt: null,
        providerType: "unconfigured",
        status: "not_connected",
      };
    }
    return row;
  }
}
