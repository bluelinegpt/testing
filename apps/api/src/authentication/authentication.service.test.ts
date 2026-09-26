import type { ConfigService } from "@nestjs/config";
import { vi } from "vitest";

import type { AppConfiguration } from "../configuration/environment.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { AccountLoginRecord, AuthenticationRepository } from "./authentication.repository.js";
import { AuthenticationService } from "./authentication.service.js";
import type { PasswordHasher } from "./password-hasher.js";
import type { SessionTokenService } from "./session-token.service.js";

const account: AccountLoginRecord = {
  accountStatus: "active",
  companyId: "10000000-0000-4000-8000-000000000001",
  companyStatus: "active",
  failedLoginAttempts: 0,
  id: "20000000-0000-4000-8000-000000000001",
  kind: "company_user",
  lockedUntil: null,
  passwordHash: "stored-hash",
  username: "operator",
  forcePasswordChange: false,
  temporaryPasswordExpiresAt: null,
};

function createService(overrides?: {
  account?: AccountLoginRecord | undefined;
  passwordMatches?: boolean;
}) {
  const resolvedAccount =
    overrides !== undefined && "account" in overrides ? overrides.account : account;
  const repository = {
    createSession: vi.fn().mockResolvedValue("30000000-0000-4000-8000-000000000001"),
    activeProfile: vi.fn().mockResolvedValue(undefined),
    findActiveSession: vi.fn(),
    findCompanyAccount: vi.fn().mockResolvedValue(resolvedAccount),
    findPermissions: vi.fn().mockResolvedValue(new Set(["orders.create"])),
    findPlatformAccount: vi.fn().mockResolvedValue(resolvedAccount),
    recordFailedLogin: vi.fn().mockResolvedValue(undefined),
    resetLoginSecurity: vi.fn().mockResolvedValue(undefined),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    passwordHash: vi.fn().mockResolvedValue("stored-hash"),
    changePassword: vi.fn().mockResolvedValue(undefined),
  };
  const passwordHasher = {
    hash: vi.fn().mockResolvedValue("new-stored-hash"),
    verify: vi.fn().mockResolvedValue(overrides?.passwordMatches ?? true),
  };
  const sessionTokens = {
    create: vi.fn().mockReturnValue({ hash: "a".repeat(64), token: "t".repeat(43) }),
    hash: vi.fn().mockReturnValue("b".repeat(64)),
  };
  const config = {
    get: vi.fn((key: string) => (key === "auth.lockoutMinutes" ? 15 : 720)),
  };
  return {
    passwordHasher,
    repository,
    service: new AuthenticationService(
      repository as unknown as AuthenticationRepository,
      passwordHasher as unknown as PasswordHasher,
      sessionTokens as unknown as SessionTokenService,
      config as unknown as ConfigService<AppConfiguration, true>,
    ),
  };
}

describe("AuthenticationService", () => {
  it("rejects sign-in generically when the host resolves to no Company", async () => {
    const { repository, service } = createService();
    // An unresolved host must be indistinguishable from a wrong password, and
    // must not even reach the account lookup, so nothing can be inferred about
    // which hosts are tenants.
    await expect(
      service.loginCompany({
        companySubdomain: undefined,
        password: "correct-horse-battery",
        identifier: "aisha.admin",
      }),
    ).rejects.toMatchObject({ errorCode: "invalid_credentials", status: 401 });
    expect(repository.findCompanyAccount).not.toHaveBeenCalled();
  });

  it("creates a revocable Company-scoped session after valid credentials", async () => {
    const { repository, service } = createService();
    const result = await service.loginCompany({
      companySubdomain: "acme",
      password: "valid-password",
      identifier: "operator",
    });
    expect(result.identity.companyId).toBe(account.companyId);
    expect(result.identity.permissions).toEqual(["orders.create"]);
    expect(repository.resetLoginSecurity).toHaveBeenCalledWith(account.id);
    expect(repository.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: account.id, companyId: account.companyId }),
    );
  });

  it("normalizes supported UAE mobile formats before account lookup", async () => {
    const { repository, service } = createService();
    await service.loginCompany({
      companySubdomain: "acme",
      identifier: " +971501234567 ",
      password: "valid-password",
    });
    expect(repository.findCompanyAccount).toHaveBeenCalledWith(
      "acme",
      "+971501234567",
      "971501234567",
    );
  });

  it("records a failed attempt and returns a generic credential error", async () => {
    const { repository, service } = createService({ passwordMatches: false });
    await expect(
      service.loginCompany({
        companySubdomain: "acme",
        password: "wrong-password",
        identifier: "operator",
      }),
    ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
    expect(repository.recordFailedLogin).toHaveBeenCalledWith(account.id, 15);
  });

  it("uses the same generic response when the account does not exist", async () => {
    const { service } = createService({ account: undefined, passwordMatches: false });
    await expect(
      service.loginPlatform({ identifier: "unknown", password: "wrong-password" }),
    ).rejects.toBeInstanceOf(ApplicationException);
  });

  it("rejects a correctly authenticated but locked account", async () => {
    const { service } = createService({
      account: { ...account, lockedUntil: new Date(Date.now() + 60_000) },
    });
    await expect(
      service.loginCompany({
        companySubdomain: "acme",
        password: "valid-password",
        identifier: "operator",
      }),
    ).rejects.toMatchObject({ errorCode: "invalid_credentials", status: 401 });
  });

  it("rejects a valid account when its selected Company is disabled", async () => {
    const { service } = createService({
      account: { ...account, companyStatus: "disabled" },
    });
    await expect(
      service.loginCompany({
        companySubdomain: "acme",
        password: "valid-password",
        identifier: "operator",
      }),
    ).rejects.toMatchObject({ errorCode: "invalid_credentials", status: 401 });
  });

  it("rejects an expired temporary password even when the credential is correct", async () => {
    const { service } = createService({
      account: {
        ...account,
        forcePasswordChange: true,
        temporaryPasswordExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    await expect(
      service.loginCompany({
        companySubdomain: "acme",
        password: "valid-password",
        identifier: "operator",
      }),
    ).rejects.toMatchObject({ errorCode: "invalid_credentials", status: 401 });
  });

  it("changes the password without retaining or exposing the temporary credential", async () => {
    const { passwordHasher, repository, service } = createService();
    passwordHasher.verify.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await service.changePassword(
      {
        companyId: account.companyId,
        identityId: account.id,
        kind: account.kind,
        permissions: new Set(),
        sessionId: "30000000-0000-4000-8000-000000000001",
        forcePasswordChange: true,
      },
      "temporary-password",
      "new-secure-password",
      "correlation-1",
    );
    expect(repository.changePassword).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: account.id, passwordHash: "new-stored-hash" }),
    );
    expect(JSON.stringify(repository.changePassword.mock.calls)).not.toContain(
      "temporary-password",
    );
  });

  /**
   * Deployment Blocker 1 -- the exact root cause: `input.identifier`/
   * `input.password` were read (`.trim()`, `normalizeUaeMobile()`,
   * `passwordHasher.verify()`) without ever checking they were real,
   * non-empty strings first. A malformed request that reached this service
   * with `identifier: undefined` (confirmed live: the global `ValidationPipe`
   * did not reliably reject it under the local `tsx watch` dev runtime for
   * this specific multi-parameter-decorator route) threw an unhandled
   * `TypeError` instead of a normal `ApplicationException` -- a 500, not a
   * 401, and consequently a Platform Error Handler crash report for
   * something that is really just a malformed login attempt.
   */
  describe("malformed login input (Deployment Blocker 1)", () => {
    it.each([
      ["identifier missing entirely", { password: "some-password" }],
      ["identifier not a string", { identifier: 12345, password: "some-password" }],
      ["identifier blank after trimming", { identifier: "   ", password: "some-password" }],
      ["password missing entirely", { identifier: "operator" }],
      ["password not a string", { identifier: "operator", password: 12345 }],
      ["password empty string", { identifier: "operator", password: "" }],
      ["both fields missing", {}],
    ])("rejects %s as invalid_credentials, never a TypeError", async (_label, input) => {
      const { repository, service } = createService();
      await expect(
        service.loginCompany({ companySubdomain: "acme", ...input } as never),
      ).rejects.toMatchObject({ errorCode: "invalid_credentials", status: 401 });
      // Never even reaches the account lookup -- a malformed request carries
      // no less risk of enumeration than a wrong password would.
      expect(repository.findCompanyAccount).not.toHaveBeenCalled();
    });

    it("rejects malformed input identically for loginPlatform and loginCustomer", async () => {
      const { repository, service } = createService();
      await expect(
        service.loginPlatform({ identifier: undefined, password: "x" } as never),
      ).rejects.toMatchObject({ errorCode: "invalid_credentials", status: 401 });
      expect(repository.findPlatformAccount).not.toHaveBeenCalled();
      await expect(
        service.loginCustomer({ identifier: "x", password: undefined } as never),
      ).rejects.toMatchObject({ errorCode: "invalid_credentials", status: 401 });
    });
  });

  it("authenticates a Trader account successfully (stable Trader regression)", async () => {
    const { repository, service } = createService({
      account: { ...account, kind: "trader", username: "trader.trd-000013" },
    });
    repository.activeProfile.mockResolvedValueOnce({ id: "trader-profile-1" });
    const result = await service.loginCompany({
      companySubdomain: "dev",
      identifier: "trader.trd-000013",
      password: "correct-password",
    });
    expect(result.identity.kind).toBe("trader");
    expect(result.identity.username).toBe("trader.trd-000013");
  });

  it("authenticates a Trader with no Store/Products/Delivery Company relationship yet -- login and Trader Commerce content are separate concerns (§13)", async () => {
    const { repository, service } = createService({
      account: { ...account, kind: "trader" },
    });
    // `activeProfile` resolving a bare Trader profile record -- no Store,
    // no Product, no Delivery Company relationship attached to it at all --
    // must still be enough to sign in. Only `profile === undefined` (no
    // Trader record whatsoever) is rejected.
    repository.activeProfile.mockResolvedValueOnce({ id: "trader-profile-with-no-store" });
    const result = await service.loginCompany({
      companySubdomain: "acme",
      identifier: "operator",
      password: "valid-password",
    });
    expect(result.identity.kind).toBe("trader");
  });

  it("rejects a Trader/Driver account with no linked profile record at all", async () => {
    const { service } = createService({ account: { ...account, kind: "trader" } });
    // activeProfile defaults to undefined in createService()'s mock.
    await expect(
      service.loginCompany({
        companySubdomain: "acme",
        identifier: "operator",
        password: "valid-password",
      }),
    ).rejects.toMatchObject({ errorCode: "invalid_credentials", status: 401 });
  });

  it("re-resolves account permissions for every active session request", async () => {
    const { repository, service } = createService();
    repository.findActiveSession.mockResolvedValue({
      accountId: account.id,
      companyId: account.companyId,
      kind: account.kind,
      sessionId: "30000000-0000-4000-8000-000000000001",
      forcePasswordChange: false,
    });
    const identity = await service.authenticate("token");
    expect(identity.permissions).toEqual(new Set(["orders.create"]));
    expect(repository.findPermissions).toHaveBeenCalledWith(account.id);
  });
});
