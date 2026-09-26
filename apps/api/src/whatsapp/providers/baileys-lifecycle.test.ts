import { describe, expect, it } from "vitest";

import {
  classifyDisconnect,
  normalizeConnectedPhoneNumber,
  reconnectDelayMs,
} from "./baileys-lifecycle.js";

function boomLike(statusCode: number): Error {
  const error = new Error("closed");
  (error as Error & { output?: { statusCode?: number } }).output = { statusCode };
  return error;
}

describe("classifyDisconnect", () => {
  it.each([
    [401, "logged_out"],
    [403, "logged_out"],
    [500, "bad_session"],
    [440, "replaced"],
    [515, "restart_required"],
  ] as const)("maps provider close code %d to %s", (code, kind) => {
    expect(classifyDisconnect(boomLike(code)).kind).toBe(kind);
  });

  it.each([408, 428, 503, 999])(
    "treats close code %s as a transient, retryable interruption",
    (code) => {
      expect(classifyDisconnect(boomLike(code)).kind).toBe("transient");
    },
  );

  it("treats an error without a status code as transient", () => {
    expect(classifyDisconnect(new Error("plain")).kind).toBe("transient");
  });

  it("treats a missing error as transient", () => {
    expect(classifyDisconnect(undefined).kind).toBe("transient");
  });
});

describe("normalizeConnectedPhoneNumber", () => {
  it("strips the device suffix and server, keeping bare digits with a plus", () => {
    expect(normalizeConnectedPhoneNumber("971501234567:12@s.whatsapp.net")).toBe("+971501234567");
  });

  it("handles ids without a device suffix", () => {
    expect(normalizeConnectedPhoneNumber("971501234567@s.whatsapp.net")).toBe("+971501234567");
  });

  it("returns null for missing or digit-free ids", () => {
    expect(normalizeConnectedPhoneNumber(undefined)).toBeNull();
    expect(normalizeConnectedPhoneNumber("nonsense@s.whatsapp.net")).toBeNull();
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially and caps at 30 seconds", () => {
    expect(reconnectDelayMs(1)).toBe(2_000);
    expect(reconnectDelayMs(2)).toBe(4_000);
    expect(reconnectDelayMs(3)).toBe(8_000);
    expect(reconnectDelayMs(4)).toBe(16_000);
    expect(reconnectDelayMs(5)).toBe(30_000);
    expect(reconnectDelayMs(50)).toBe(30_000);
  });
});
