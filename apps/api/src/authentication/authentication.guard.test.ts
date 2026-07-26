import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { vi } from "vitest";

import type { RequestSecurityContextStore } from "../security/request-security-context.js";
import type { AuthenticationService } from "./authentication.service.js";
import { AuthenticationGuard } from "./authentication.guard.js";

const identity = {
  companyId: "10000000-0000-4000-8000-000000000001",
  identityId: "20000000-0000-4000-8000-000000000001",
  kind: "company_user" as const,
  permissions: new Set(["orders.create"]),
  sessionId: "30000000-0000-4000-8000-000000000001",
  forcePasswordChange: false,
};

function executionContext(header = `Bearer ${"t".repeat(43)}`): ExecutionContext {
  return {
    getClass: vi.fn(),
    getHandler: vi.fn(),
    switchToHttp: vi.fn().mockReturnValue({
      getRequest: vi.fn().mockReturnValue({ headers: { authorization: header } }),
    }),
  } as unknown as ExecutionContext;
}

describe("AuthenticationGuard", () => {
  it("authenticates and establishes authoritative Company context", async () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValueOnce(false) };
    const authentication = { authenticate: vi.fn().mockResolvedValue(identity) };
    const store = { enter: vi.fn() };
    const guard = new AuthenticationGuard(
      reflector as unknown as Reflector,
      authentication as unknown as AuthenticationService,
      store as unknown as RequestSecurityContextStore,
    );
    await expect(guard.canActivate(executionContext())).resolves.toBe(true);
    expect(store.enter).toHaveBeenCalledWith({
      identity,
      tenant: { companyId: identity.companyId, identityId: identity.identityId },
    });
  });

  it("denies a route when an effective permission is missing", async () => {
    const reflector = {
      getAllAndOverride: vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(["settlements.reverse"]),
    };
    const guard = new AuthenticationGuard(
      reflector as unknown as Reflector,
      { authenticate: vi.fn().mockResolvedValue(identity) } as unknown as AuthenticationService,
      { enter: vi.fn() } as unknown as RequestSecurityContextStore,
    );
    await expect(guard.canActivate(executionContext())).rejects.toMatchObject({
      errorCode: "permission_denied",
    });
  });

  it("denies an authenticated account of the wrong identity kind", async () => {
    const reflector = {
      getAllAndOverride: vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(["platform_administrator"]),
    };
    const guard = new AuthenticationGuard(
      reflector as unknown as Reflector,
      { authenticate: vi.fn().mockResolvedValue(identity) } as unknown as AuthenticationService,
      { enter: vi.fn() } as unknown as RequestSecurityContextStore,
    );
    await expect(guard.canActivate(executionContext())).rejects.toMatchObject({
      errorCode: "identity_kind_denied",
    });
  });

  it("rejects malformed bearer credentials before database access", async () => {
    const authentication = { authenticate: vi.fn() };
    const guard = new AuthenticationGuard(
      { getAllAndOverride: vi.fn().mockReturnValue(false) } as unknown as Reflector,
      authentication as unknown as AuthenticationService,
      { enter: vi.fn() } as unknown as RequestSecurityContextStore,
    );
    await expect(guard.canActivate(executionContext("Bearer short"))).rejects.toMatchObject({
      errorCode: "authentication_required",
    });
    expect(authentication.authenticate).not.toHaveBeenCalled();
  });

  it("blocks normal routes while a password change is required", async () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValueOnce(false) };
    const guard = new AuthenticationGuard(
      reflector as unknown as Reflector,
      {
        authenticate: vi.fn().mockResolvedValue({ ...identity, forcePasswordChange: true }),
      } as unknown as AuthenticationService,
      { enter: vi.fn() } as unknown as RequestSecurityContextStore,
    );
    await expect(guard.canActivate(executionContext())).rejects.toMatchObject({
      errorCode: "password_change_required",
    });
  });
});
