import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../../infrastructure/database/database.types.js";
import { WhatsAppSessionCipher } from "../whatsapp-session-cipher.js";
import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationCreds,
  type BaileysAuthInput,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "./baileys-client.js";

/** Thrown when stored ciphertext cannot be decrypted/parsed. Deliberately
 *  carries no payload content — the caller marks the connection as needing a
 *  fresh QR pairing; the ciphertext itself is left in place (never silently
 *  discarded) until a successful new pairing overwrites it. */
export class SessionStateCorruptError extends Error {
  public constructor() {
    super("whatsapp_session_state_corrupt");
  }
}

interface SerializedAuthState {
  readonly creds: AuthenticationCreds;
  readonly keys: Record<string, Record<string, unknown>>;
}

/** Serialize with Baileys' BufferJSON so Uint8Array/Buffer key material
 *  survives the JSON round-trip. Exported for direct unit testing. */
export function serializeAuthState(creds: AuthenticationCreds, keyData: KeyData): string {
  return JSON.stringify({ creds, keys: keyData }, BufferJSON.replacer);
}

export function deserializeAuthState(serialized: string): SerializedAuthState {
  const parsed = JSON.parse(serialized, BufferJSON.reviver) as SerializedAuthState;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.creds !== "object") {
    throw new SessionStateCorruptError();
  }
  return { creds: parsed.creds, keys: parsed.keys ?? {} };
}

type KeyData = Record<string, Record<string, unknown>>;

export interface RuntimeAuthState {
  readonly auth: BaileysAuthInput;
  /** Encrypt the current creds+keys and persist them on the Company's
   *  connection row. Serialized through a per-state promise chain so
   *  concurrent Baileys auth updates can never interleave writes. */
  readonly persist: () => Promise<void>;
}

/**
 * Database-backed Baileys authentication state, replacing the library's
 * file-based `useMultiFileAuthState` (which must never be the persisted
 * architecture in production — Render disks are ephemeral and files bypass
 * encryption). The single source of truth is
 * `company_whatsapp_connections.encrypted_session_state`: one AES-256-GCM
 * blob per Company holding `{creds, keys}` in BufferJSON form. Signal keys
 * are held in memory for the lifetime of one socket and flushed to the
 * encrypted blob whenever Baileys updates them.
 */
@Injectable()
export class BaileysSessionStore {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(WhatsAppSessionCipher) private readonly cipher: WhatsAppSessionCipher,
  ) {}

  public isEncryptionConfigured(): boolean {
    return this.cipher.isConfigured();
  }

  /** Load the stored auth state, or undefined when none exists. Throws
   *  SessionStateCorruptError when ciphertext exists but cannot be used. */
  public async load(companyId: string): Promise<SerializedAuthState | undefined> {
    const result = await sql<{ encrypted: string | null }>`
      select encrypted_session_state as encrypted
        from company_whatsapp_connections
       where company_id = ${companyId}::uuid
    `.execute(this.database);
    const encrypted = result.rows[0]?.encrypted;
    if (encrypted === undefined || encrypted === null) return undefined;
    let serialized: string;
    try {
      serialized = this.cipher.decrypt(encrypted);
    } catch {
      throw new SessionStateCorruptError();
    }
    return deserializeAuthState(serialized);
  }

  /** Build the live auth state a socket runs on, from a stored snapshot or
   *  fresh credentials for a brand-new QR pairing. */
  public createRuntimeAuthState(companyId: string, stored?: SerializedAuthState): RuntimeAuthState {
    const creds = stored?.creds ?? initAuthCreds();
    const keyData: KeyData = stored?.keys ?? {};
    let chain: Promise<void> = Promise.resolve();

    const persist = (): Promise<void> => {
      chain = chain.then(() => this.write(companyId, serializeAuthState(creds, keyData)));
      return chain;
    };

    const auth: BaileysAuthInput = {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const bucket = keyData[type] ?? {};
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            const value = bucket[id];
            if (value !== undefined && value !== null) {
              result[id] = value as SignalDataTypeMap[T];
            }
          }
          return result;
        },
        set: async (data: SignalDataSet) => {
          for (const [type, entries] of Object.entries(data)) {
            const bucket = (keyData[type] ??= {});
            for (const [id, value] of Object.entries(entries ?? {})) {
              if (value === null || value === undefined) {
                delete bucket[id];
              } else {
                bucket[id] = value;
              }
            }
          }
          await persist();
        },
      },
    };

    return { auth, persist };
  }

  /** Remove stored auth material (confirmed logout / unusable credentials). */
  public async clear(companyId: string): Promise<void> {
    await sql`
      update company_whatsapp_connections
         set encrypted_session_state = null, updated_at = now()
       where company_id = ${companyId}::uuid
    `.execute(this.database);
  }

  private async write(companyId: string, serialized: string): Promise<void> {
    const encrypted = this.cipher.encrypt(serialized);
    await sql`
      update company_whatsapp_connections
         set encrypted_session_state = ${encrypted}, updated_at = now()
       where company_id = ${companyId}::uuid
    `.execute(this.database);
  }
}
