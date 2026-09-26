import {
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  makeWASocket,
  type AuthenticationCreds,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import pino from "pino";

/**
 * The ONLY file in Tawseelhub that imports `@whiskeysockets/baileys`
 * (7.0.0-rc14, native ESM, prebuilt lib — its skipped `preinstall` is just a
 * Node-version check, acknowledged in the root package.json's
 * `pnpm.ignoredBuiltDependencies`).
 *
 * Everything else in the WhatsApp module works against the minimal
 * structural types below and the `BaileysSocketFactory` seam, so:
 *  - the rest of the codebase never couples to Baileys' full API surface,
 *  - tests drive the connection lifecycle with a fake factory instead of
 *    module-level mocking,
 *  - a future provider swap stays behind `CompanyWhatsAppProvider` exactly
 *    as Prompt 1 designed.
 *
 * This is strictly the Delivery-Company → Trader-group provider. The public
 * Website Agent's Meta Cloud integration (`../../agent/whatsapp-provider.ts`)
 * is a separate architecture and is deliberately untouched.
 */

export { BufferJSON, DisconnectReason, initAuthCreds };
export type { AuthenticationCreds, SignalDataSet, SignalDataTypeMap };

export interface BaileysConnectionUpdate {
  readonly connection?: "close" | "connecting" | "open";
  readonly lastDisconnect?: { readonly error?: Error | undefined };
  readonly qr?: string;
}

export interface BaileysGroupMetadata {
  readonly id: string;
  readonly subject: string;
  readonly participants?: readonly unknown[];
}

export interface BaileysSocketEvents {
  on(event: "connection.update", listener: (update: BaileysConnectionUpdate) => void): void;
  on(event: "creds.update", listener: () => void): void;
}

/** The slice of a Baileys socket the runtime actually uses. */
export interface BaileysSocket {
  readonly ev: BaileysSocketEvents;
  readonly user?: { readonly id: string } | undefined;
  logout(): Promise<void>;
  end(error?: Error): void;
  groupFetchAllParticipating(): Promise<Record<string, BaileysGroupMetadata>>;
  sendMessage(
    jid: string,
    content: { readonly text: string },
  ): Promise<{ readonly key?: { readonly id?: string | null } | null } | undefined>;
}

export interface BaileysAuthInput {
  readonly creds: AuthenticationCreds;
  readonly keys: {
    get<T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[],
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }>;
    set(data: SignalDataSet): Promise<void>;
  };
}

export abstract class BaileysSocketFactory {
  public abstract create(auth: BaileysAuthInput): BaileysSocket;
}

/**
 * Real factory. The logger handed to Baileys is hard-silenced: Baileys logs
 * connection payloads and key material at debug levels, and none of that may
 * ever reach Tawseelhub's structured logs (QR content and session state are
 * credential-grade — see Prompt 1's security rules).
 */
export class RealBaileysSocketFactory extends BaileysSocketFactory {
  public create(auth: BaileysAuthInput): BaileysSocket {
    const socket = makeWASocket({
      auth: auth as never,
      // Not a human chat client: never publish presence, never pull full
      // history — this account exists to post Trader-group notifications.
      logger: pino({ level: "silent" }) as never,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    return socket as unknown as BaileysSocket;
  }
}
