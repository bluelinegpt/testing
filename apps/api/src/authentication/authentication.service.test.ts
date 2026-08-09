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
