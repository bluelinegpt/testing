import { randomBytes } from "node:crypto";

import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import type { AppConfiguration } from "../../configuration/environment.js";
import { WhatsAppSessionCipher } from "../whatsapp-session-cipher.js";
import { initAuthCreds } from "./baileys-client.js";
import {
  deserializeAuthState,
  serializeAuthState,
  SessionStateCorruptError,
} from "./baileys-session-store.js";

function cipherWithKey(key: string | undefined): WhatsAppSessionCipher {
  const config = {
    get: (name: string) => (name === "whatsapp.sessionEncryptionKey" ? key : undefined),
  } as unknown as ConfigService<AppConfiguration, true>;
  return new WhatsAppSessionCipher(config);
}

describe("Baileys auth-state serialization", () => {
  it("round-trips real credentials, preserving binary key material", () => {
    const creds = initAuthCreds();
    const keyData = {
      "pre-key": { "1": { private: randomBytes(32), public: randomBytes(32) } },
      session: { "971500000001.0": randomBytes(64) },
    };
    const restored = deserializeAuthState(serializeAuthState(creds, keyData));
    // Signal key material is Uint8Array/Buffer — it must survive the JSON
    // round-trip byte-for-byte, or restored sessions silently fail.
    expect(Buffer.from(restored.creds.noiseKey.private)).toEqual(
      Buffer.from(creds.noiseKey.private),
    );
    expect(Buffer.from(restored.creds.signedIdentityKey.public)).toEqual(
      Buffer.from(creds.signedIdentityKey.public),
    );
    expect(restored.creds.registrationId).toBe(creds.registrationId);
    const restoredSession = (restored.keys["session"] as Record<string, unknown>)["971500000001.0"];
    expect(Buffer.from(restoredSession as Uint8Array)).toEqual(keyData.session["971500000001.0"]);
  });

  it("rejects structurally invalid state with a safe error", () => {
    expect(() => deserializeAuthState("null")).toThrowError(SessionStateCorruptError);
    expect(() => deserializeAuthState('"just a string"')).toThrowError(SessionStateCorruptError);
  });

  it("encrypts to ciphertext that leaks nothing and decrypts back to identical state", () => {
    const cipher = cipherWithKey(randomBytes(32).toString("base64"));
    const creds = initAuthCreds();
    const serialized = serializeAuthState(creds, {});
    const encrypted = cipher.encrypt(serialized);
    // No plaintext structure may appear in the stored blob.
    expect(encrypted).not.toContain("noiseKey");
    expect(encrypted).not.toContain("advSecretKey");
    expect(encrypted.startsWith("v1:")).toBe(true);
    const restored = deserializeAuthState(cipher.decrypt(encrypted));
    expect(Buffer.from(restored.creds.noiseKey.public)).toEqual(Buffer.from(creds.noiseKey.public));
  });

  it("fails safely when decrypting with the wrong key", () => {
    const encrypted = cipherWithKey(randomBytes(32).toString("base64")).encrypt(
      serializeAuthState(initAuthCreds(), {}),
    );
    const other = cipherWithKey(randomBytes(32).toString("base64"));
    expect(() => other.decrypt(encrypted)).toThrowError("whatsapp_session_cipher_invalid_payload");
  });
});
