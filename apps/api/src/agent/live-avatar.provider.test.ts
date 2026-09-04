import { afterEach, describe, expect, it, vi } from "vitest";
import { HeyGenLiveAvatarProvider, createLiveAvatarServerProvider } from "./live-avatar.provider.js";

describe("HeyGenLiveAvatarProvider", () => {
  const originalKey = process.env.HEYGEN_LIVEAVATAR_API_KEY;
  const originalSandbox = process.env.HEYGEN_LIVEAVATAR_SANDBOX;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env.HEYGEN_LIVEAVATAR_API_KEY;
    else process.env.HEYGEN_LIVEAVATAR_API_KEY = originalKey;
    if (originalSandbox === undefined) delete process.env.HEYGEN_LIVEAVATAR_SANDBOX;
    else process.env.HEYGEN_LIVEAVATAR_SANDBOX = originalSandbox;
  });

  it("is provider-independent and reports missing server configuration", () => {
    delete process.env.HEYGEN_LIVEAVATAR_API_KEY;
    expect(createLiveAvatarServerProvider("heygen_live")).toBeInstanceOf(HeyGenLiveAvatarProvider);
    expect(createLiveAvatarServerProvider("tavus_live")).toBeNull();
    expect(new HeyGenLiveAvatarProvider().configured()).toBe(false);
  });

  it("exchanges the secret server-side and returns only a short-lived session token", async () => {
    process.env.HEYGEN_LIVEAVATAR_API_KEY = "test-secret-never-returned";
    process.env.HEYGEN_LIVEAVATAR_SANDBOX = "true";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: { session_token: "short-lived-token" },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await new HeyGenLiveAvatarProvider().createSessionToken("ar", {
      avatarId: "final-yousef",
      voiceAgentId: "arabic-agent",
      voiceId: "arabic-voice",
      idleTimeoutSeconds: 45,
      maxSessionSeconds: 240,
    });

    expect(result).toEqual({ provider: "heygen_live", token: "short-lived-token", sandbox: true, idleTimeoutSeconds: 45 });
    expect(JSON.stringify(result)).not.toContain("test-secret-never-returned");
    expect(fetchMock).toHaveBeenCalledWith("https://api.liveavatar.com/v1/sessions/token", expect.objectContaining({
      headers: expect.objectContaining({ "x-api-key": "test-secret-never-returned" }),
    }));
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      mode: "FULL",
      is_sandbox: true,
      avatar_id: "final-yousef",
      voice_agent: { id: "arabic-agent", language: "ar", voice_id: "arabic-voice" },
    });
    expect(body).not.toHaveProperty("api_key");
  });

  it("fails closed on a provider timeout without exposing the credential", async () => {
    process.env.HEYGEN_LIVEAVATAR_API_KEY = "timeout-secret-never-returned";
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);

    await expect(new HeyGenLiveAvatarProvider().createSessionToken("en", {
      avatarId: "final-yousef",
      voiceAgentId: "english-agent",
      idleTimeoutSeconds: 60,
      maxSessionSeconds: 300,
    })).rejects.toThrow("The operation was aborted");
  });

  it("does not use the sandbox stock identity when sandbox mode is disabled", async () => {
    process.env.HEYGEN_LIVEAVATAR_API_KEY = "production-shaped-test-secret";
    process.env.HEYGEN_LIVEAVATAR_SANDBOX = "false";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(new HeyGenLiveAvatarProvider().createSessionToken("en", {
      idleTimeoutSeconds: 60,
      maxSessionSeconds: 300,
    })).rejects.toThrow("live_avatar_missing_avatar_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
