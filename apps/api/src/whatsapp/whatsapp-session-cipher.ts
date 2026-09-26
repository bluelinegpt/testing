import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppConfiguration } from "../configuration/environment.js";

/**
 * Encrypts/decrypts provider WhatsApp session material
 * (`company_whatsapp_connections.encrypted_session_state`). Session state is
 * credential material: whoever holds it IS the Company's WhatsApp account, so
 * it is never stored in plaintext, never returned by any API, and never
 * logged.
 *
 * AES-256-GCM with a random 12-byte IV per encryption and the GCM auth tag
 * stored alongside, serialized as `v1:<iv>:<tag>:<ciphertext>` (base64url).
 * The `v1:` prefix exists so a future algorithm/key rotation can coexist with
 * already-stored payloads.
 *
 * The key comes ONLY from the environment (`WHATSAPP_SESSION_ENCRYPTION_KEY`,
 * base64 of exactly 32 random bytes) — it is never stored in the database and
 * never committed; `environment.ts` validates its shape at startup. Until
 * Prompt 2 ships a real provider the key may be absent, in which case
 * `isConfigured()` is false and `encrypt()` refuses rather than silently
 * storing plaintext.
 *
 * Every failure path throws a STABLE error code string and nothing else — no
 * ciphertext, no plaintext, no key material ever rides on an Error message,
 * so central error reporting (`ApiExceptionFilter` -> `client_error_reports`)
 * can never leak session content.
 */
@Injectable()
export class WhatsAppSessionCipher {
  private readonly key: Buffer | undefined;

  public constructor(@Inject(ConfigService) config: ConfigService<AppConfiguration, true>) {
    const encoded = config.get("whatsapp.sessionEncryptionKey", { infer: true });
    this.key = encoded === undefined ? undefined : Buffer.from(encoded, "base64");
  }

  public isConfigured(): boolean {
    return this.key !== undefined;
  }

  public encrypt(plaintext: string): string {
    if (this.key === undefined) {
      throw new Error("whatsapp_session_encryption_not_configured");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
  }

  public decrypt(payload: string): string {
    if (this.key === undefined) {
      throw new Error("whatsapp_session_encryption_not_configured");
    }
    const parts = payload.split(":");
    if (parts.length !== 4 || parts[0] !== "v1") {
      throw new Error("whatsapp_session_cipher_invalid_payload");
    }
    try {
      const iv = Buffer.from(parts[1] as string, "base64url");
      const tag = Buffer.from(parts[2] as string, "base64url");
      const ciphertext = Buffer.from(parts[3] as string, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // GCM authentication failure, truncated fields, wrong key — all collapse
      // to one stable code; the original error may reference buffer contents.
      throw new Error("whatsapp_session_cipher_invalid_payload");
    }
  }
}
