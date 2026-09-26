import type { ConfigService } from "@nestjs/config";
import { vi } from "vitest";

import type { AppConfiguration } from "../configuration/environment.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { PlatformAuthController } from "./platform-auth.controller.js";

/**
 * P1 corrective -- Platform Admin login malformed-input 500.
 *
 * Root cause: the failed-login catch block read `input.identifier.slice(...)`
 * unconditionally. `AuthenticationService.loginPlatform` already throws a
 * safe `invalid_credentials` `ApplicationException` for a malformed body
 * (missing/non-string identifier or password) -- but THIS controller's own
 * audit-logging path, reached only in that catch block, then crashed trying
 * to describe the very failure it was recording, turning a clean 401 into an
 * unhandled 500. These tests pin the fix: the failed-login audit record must
 * never be able to throw, for any shape of `identifier`.
 */
function createController(overrides?: { loginPlatformError?: unknown; loginPlatformResult?: unknown }) {
  const invalidCredentials = new ApplicationException(
    "invalid_credentials",
    "The login identifier or password is invalid",
    401,
  );
  const authentication = {
    loginPlatform: vi
      .fn()
      .mockImplementation(() =>
        "loginPlatformResult" in (overrides ?? {})
          ? Promise.resolve(overrides?.loginPlatformResult)
          : Promise.reject(overrides?.loginPlatformError ?? invalidCredentials),
      ),
  };
  const platform = { describeSession: vi.fn() };
  const audit = { recordBestEffort: vi.fn().mockResolvedValue(undefined) };
  const identities = { current: vi.fn() };
  const config = { get: vi.fn().mockReturnValue("development") };
  const controller = new PlatformAuthController(
    authentication as never,
    platform as never,
    audit as never,
    identities as never,
    config as unknown as ConfigService<AppConfiguration, true>,
  );
  return { audit, authentication, controller };
}

function fakeRequest(): { headers: Record<string, string> } {
  return { headers: { "user-agent": "vitest" } };
}

function fakeResponse() {
  return { cookie: vi.fn(), clearCookie: vi.fn() };
}

describe("PlatformAuthController.login -- failed-login audit safety (P1)", () => {
  it.each([
    ["missing identifier entirely", { password: "some-password" }],
    ["identifier is undefined", { identifier: undefined, password: "some-password" }],
    ["identifier is not a string", { identifier: 12345, password: "some-password" }],
    ["both fields missing", {}],
  ])("never throws from the failed-login audit path for %s", async (_label, input) => {
    const { audit, controller } = createController();
    await expect(
      controller.login(input as never, "127.0.0.1", fakeRequest() as never, fakeResponse() as never),
    ).rejects.toMatchObject({ errorCode: "invalid_credentials", status: 401 });
    // The audit write itself must have completed without throwing, and must
    // record a safe null rather than crash trying to `.slice()` it.
    expect(audit.recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "platform.authentication.failed",
        after: { identifier: null },
        result: "failure",
      }),
    );
  });

  it("records the real (truncated) identifier when one was actually provided", async () => {
    const { audit, controller } = createController();
    await expect(
      controller.login(
        { identifier: "platform.admin", password: "wrong-password" } as never,
        "127.0.0.1",
        fakeRequest() as never,
        fakeResponse() as never,
      ),
    ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
    expect(audit.recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ after: { identifier: "platform.admin" } }),
    );
    // The password must never appear anywhere in what was audited.
    expect(JSON.stringify(audit.recordBestEffort.mock.calls)).not.toContain("wrong-password");
  });

  it("propagates a genuine unexpected error unchanged (still reaches the Platform Error Handler upstream)", async () => {
    const boom = new Error("unexpected database outage");
    const { audit, controller } = createController({ loginPlatformError: boom });
    await expect(
      controller.login(
        { identifier: "platform.admin", password: "irrelevant" } as never,
        "127.0.0.1",
        fakeRequest() as never,
        fakeResponse() as never,
      ),
    ).rejects.toBe(boom);
    // Still audited as a failure, still without throwing from the audit path.
    expect(audit.recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ result: "failure" }),
    );
  });

  it("succeeds and records a success audit entry for valid credentials, never logging the accessToken", async () => {
    const { audit, controller } = createController({
      loginPlatformResult: {
        accessToken: "super-secret-token-value",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        identity: {
          displayName: "Platform Admin",
          id: "10000000-0000-4000-8000-000000000099",
          permissions: ["platform.dashboard.view"],
          username: "platform.admin",
        },
      },
    });
    const response = fakeResponse();
    const result = await controller.login(
      { identifier: "platform.admin", password: "correct-horse-battery" } as never,
      "127.0.0.1",
      fakeRequest() as never,
      response as never,
    );
    expect(result.identity.username).toBe("platform.admin");
    expect(result.identity.companyId).toBeNull();
    expect(audit.recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.authentication.succeeded", result: "success" }),
    );
    expect(JSON.stringify(audit.recordBestEffort.mock.calls)).not.toContain(
      "super-secret-token-value",
    );
    expect(response.cookie).toHaveBeenCalled();
  });
});
