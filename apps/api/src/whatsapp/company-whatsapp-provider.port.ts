/**
 * The per-Company WhatsApp connectivity abstraction, mirroring
 * `PushProvider` (`../push/push-provider.port.ts`): an abstract class bound
 * to a concrete adapter via a one-line `useClass` in `WhatsAppModule`.
 * Nothing outside this module may depend on Baileys (or whichever client
 * Prompt 2 chooses) — business code depends only on this contract, so
 * swapping the underlying client later is a module-wiring change, not a
 * refactor.
 *
 * This is deliberately SEPARATE from `../agent/whatsapp-provider.ts`
 * (`WhatsAppProvider`): that interface is the Platform-level Meta Cloud API
 * client for the public-website Agent (one platform-owned phone number,
 * webhook-driven, individual chats). This port models something structurally
 * different — one WhatsApp account PER Delivery Company, connected by QR,
 * addressing Trader GROUPS. Folding the two together would couple two
 * unrelated lifecycles.
 *
 * No real provider exists in Prompt 1. `UnimplementedCompanyWhatsAppProvider`
 * below is the production binding until Prompt 2: it never fabricates
 * connectivity or group data, and every operation reports plainly that the
 * provider is not implemented yet.
 */

export type CompanyWhatsAppConnectionStatus =
  | "not_connected"
  | "waiting_for_qr_scan"
  | "connecting"
  | "connected"
  | "disconnected"
  | "authentication_failed"
  | "requires_reconnect";

export interface WhatsAppConnectionResult {
  readonly status: CompanyWhatsAppConnectionStatus;
  /** Present only while the provider is waiting for a QR scan (Prompt 2). */
  readonly qrCode?: string;
  readonly failureCode?: string;
}

export interface WhatsAppGroup {
  /** The provider's internal chat id (e.g. `1203...@g.us`) — the ONLY valid
   *  address for a group. The visible name is display data, never identity. */
  readonly providerGroupId: string;
  readonly name: string;
  /** Member count only — participant identities never cross this boundary. */
  readonly participantCount?: number;
}

export interface SendWhatsAppMessageInput {
  readonly companyId: string;
  readonly providerGroupId: string;
  readonly body: string;
}

export type WhatsAppSendResult =
  /** "sent" means the provider accepted the message — never a delivered or
   *  read claim; no provider at this layer gives that evidence. */
  | { readonly outcome: "sent"; readonly providerMessageId: string | null; readonly sentAt?: Date }
  | { readonly outcome: "transient_failure"; readonly failureCode: string }
  | { readonly outcome: "permanent_failure"; readonly failureCode: string };

export abstract class CompanyWhatsAppProvider {
  public abstract connect(companyId: string): Promise<WhatsAppConnectionResult>;
  public abstract disconnect(companyId: string): Promise<void>;
  public abstract getConnectionStatus(companyId: string): Promise<CompanyWhatsAppConnectionStatus>;
  public abstract listGroups(companyId: string): Promise<readonly WhatsAppGroup[]>;
  public abstract sendMessage(input: SendWhatsAppMessageInput): Promise<WhatsAppSendResult>;
}

/**
 * The honest Prompt 1 production binding: no connectivity exists yet, and this
 * says so — it never invents groups, QR codes, or delivery results.
 */
export class UnimplementedCompanyWhatsAppProvider extends CompanyWhatsAppProvider {
  public async connect(): Promise<WhatsAppConnectionResult> {
    return { failureCode: "whatsapp_provider_not_implemented", status: "not_connected" };
  }

  public async disconnect(): Promise<void> {
    // Nothing is ever connected, so there is nothing to tear down.
  }

  public async getConnectionStatus(): Promise<CompanyWhatsAppConnectionStatus> {
    return "not_connected";
  }

  public async listGroups(): Promise<readonly WhatsAppGroup[]> {
    return [];
  }

  public async sendMessage(): Promise<WhatsAppSendResult> {
    return { failureCode: "whatsapp_provider_not_implemented", outcome: "permanent_failure" };
  }
}
