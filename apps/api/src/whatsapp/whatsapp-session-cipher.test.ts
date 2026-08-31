import { randomBytes } from "node:crypto";

import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import type { AppConfiguration } from "../configuration/environment.js";
import { WhatsAppSessionCipher } from "./whatsapp-session-cipher.js";

function configWithKey(key: string | undefined): ConfigService<AppConfiguration, true> {
  return {
    get: (name: string) => (name === "whatsapp.sessionEncryptionKey" ? key : undefined),
  } as unknown as ConfigService<AppConfiguration, true>;
}

const validKey = randomBytes(32).toString("base64");

describe("WhatsAppSessionCipher", () => {
  it("round-trips arbitrary session payloads", () => {
    const cipher = new WhatsAppSessionCipher(configWithKey(validKey));
    const payload = JSON.stringify({ creds: { noiseKey: "secret-noise", registered: true } });
    const encrypted = cipher.encrypt(payload);
    expect(encrypted.startsWith("v1:")).toBe(true);
    // Ciphertext must not contain the plaintext.
    expect(encrypted).not.toContain("secret-noise");
    expect(cipher.decrypt(encrypted)).toBe(payload);
  });

  it("produces a different ciphertext per call (random IV) that still decrypts", () => {
    const cipher = new WhatsAppSessionCipher(configWithKey(validKey));
    const first = cipher.encrypt("same-input");
    const second = cipher.encrypt("same-input");
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe("same-input");
    expect(cipher.decrypt(second)).toBe("same-input");
  });

  it("refuses to encrypt or decrypt when no key is configured", () => {
    const cipher = new WhatsAppSessionCipher(configWithKey(undefined));
    expect(cipher.isConfigured()).toBe(false);
    expect(() => cipher.encrypt("anything")).toThrowError(
      "whatsapp_session_encryption_not_configured",
    );
    expect(() => cipher.decrypt("v1:a:b:c")).toThrowError(
      "whatsapp_session_encryption_not_configured",
    );
  });

  it("fails safely on tampered ciphertext without echoing the payload", () => {
    const cipher = new WhatsAppSessionCipher(configWithKey(validKey));
    const encrypted = cipher.encrypt("confidential-session-material");
    const parts = encrypted.split(":");
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${(parts[3] as string).slice(0, -4)}AAAA`;
    let caught: Error | undefined;
    try {
      cipher.decrypt(tampered);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe("whatsapp_session_cipher_invalid_payload");
    expect(caught?.message).not.toContain("confidential");
  });

  it("fails safely when decrypting with a different key", () => {
    const encryptedElsewhere = new WhatsAppSessionCipher(configWithKey(validKey)).encrypt(
      "session-state",
    );
    const otherKey = randomBytes(32).toString("base64");
    const cipher = new WhatsAppSessionCipher(configWithKey(otherKey));
    expect(() => cipher.decrypt(encryptedElsewhere)).toThrowError(
      "whatsapp_session_cipher_invalid_payload",
    );
  });

  it.each(["", "v1:only-two:parts", "v2:a:b:c", "not-a-payload"])(
    "rejects the malformed payload %j with a stable error code",
    (payload) => {
      const cipher = new WhatsAppSessionCipher(configWithKey(validKey));
      expect(() => cipher.decrypt(payload)).toThrowError("whatsapp_session_cipher_invalid_payload");
    },
  );
});
