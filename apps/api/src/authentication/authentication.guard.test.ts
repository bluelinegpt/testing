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

  /**
   * Cookie-authenticated requests.
   *
   * The cookie carries the SAME token the header always did and is validated by
   * the same server-side session record, so the only new questions are whether
   * it is accepted at all and whether it can be abused cross-site.
   */
  const cookieContext = (input: {
    readonly cookie?: string;
    readonly csrf?: string;
    readonly method?: string;
  }): ExecutionContext =>
    ({
      getClass: vi.fn(),
      getHandler: vi.fn(),
      switchToHttp: vi.fn().mockReturnValue({
        getRequest: vi.fn().mockReturnValue({
          headers: {
            ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
            ...(input.csrf === undefined ? {} : { "x-blueline-session": input.csrf }),
          },
          method: input.method ?? "GET",
        }),
      }),
    }) as unknown as ExecutionContext;

  const guardFor = (authenticate: unknown) =>
    new AuthenticationGuard(
      { getAllAndOverride: vi.fn().mockReturnValueOnce(false) } as unknown as Reflector,
      { authenticate } as unknown as AuthenticationService,
      { enter: vi.fn() } as unknown as RequestSecurityContextStore,
    );

  const sessionCookie = `blueline_session=${"c".repeat(43)}`;

  it("authenticates a read from the session cookie", async () => {
    const authenticate = vi.fn().mockResolvedValue(identity);
    await expect(
      guardFor(authenticate).canActivate(cookieContext({ cookie: sessionCookie })),
    ).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledWith("c".repeat(43));
  });

  it("refuses a cookie-authenticated mutation without the session header", async () => {
    // A cross-site form can make the browser send the cookie, but it cannot set
    // a custom header — which is what this refusal relies on.
    await expect(
      guardFor(vi.fn().mockResolvedValue(identity)).canActivate(
        cookieContext({ cookie: sessionCookie, method: "POST" }),
      ),
    ).rejects.toMatchObject({ errorCode: "csrf_header_required" });
  });

  it("accepts a cookie-authenticated mutation carrying the session header", async () => {
    await expect(
      guardFor(vi.fn().mockResolvedValue(identity)).canActivate(
        cookieContext({ cookie: sessionCookie, csrf: "cookie", method: "POST" }),
      ),
    ).resolves.toBe(true);
  });

  it("does not require the header when a bearer token is used", async () => {
    // Nothing attaches a bearer token automatically, so there is nothing to forge.
    const context = {
      getClass: vi.fn(),
      getHandler: vi.fn(),
      switchToHttp: vi.fn().mockReturnValue({
        getRequest: vi.fn().mockReturnValue({
          headers: { authorization: `Bearer ${"t".repeat(43)}` },
          method: "POST",
        }),
      }),
    } as unknown as ExecutionContext;
    await expect(
      guardFor(vi.fn().mockResolvedValue(identity)).canActivate(context),
    ).resolves.toBe(true);
  });

  it("refuses when neither transport carries a session", async () => {
    await expect(
      guardFor(vi.fn()).canActivate(cookieContext({})),
    ).rejects.toMatchObject({ errorCode: "authentication_required" });
  });

  it("lets an expired or revoked session fail through the session service", async () => {
    // Expiry and revocation are the session record's decision, not the guard's;
    // the cookie path must not bypass it.
    const authenticate = vi.fn().mockRejectedValue(new Error("invalid_session"));
    await expect(
      guardFor(authenticate).canActivate(cookieContext({ cookie: sessionCookie })),
    ).rejects.toThrow("invalid_session");
  });
});
