import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  REQUIRED_IDENTITY_KINDS,
  REQUIRED_PERMISSIONS,
} from "../authentication/authentication.decorators.js";
import { PLATFORM_ACCESS, PLATFORM_PERMISSION_PREFIX } from "./platform-authorization.js";
import { PlatformCompanyUserController } from "./platform-company-user.controller.js";
import { CreateCompanyAdministratorDto } from "./platform-company-user.dto.js";
import { describeUserState } from "./platform-company-user.service.js";

/** Nest's key for the route path a `@Get`/`@Post` decorator writes. */
const ROUTE_PATH_METADATA = "path";

function routeHandlers(): { method: string; handler: () => unknown }[] {
  const prototype = PlatformCompanyUserController.prototype as object;
  const found: { method: string; handler: () => unknown }[] = [];
  for (const method of Object.getOwnPropertyNames(prototype)) {
    if (method === "constructor") continue;
    const handler = Object.getOwnPropertyDescriptor(prototype, method)?.value as unknown;
    if (typeof handler !== "function") continue;
    if (Reflect.getMetadata(ROUTE_PATH_METADATA, handler) === undefined) continue;
    found.push({ method, handler: handler as () => unknown });
  }
  return found;
}

const serviceSource = readFileSync(
  resolve(process.cwd(), "src/platform/platform-company-user.service.ts"),
  "utf8",
);
const setupSource = readFileSync(
  resolve(process.cwd(), "src/authentication/account-setup.service.ts"),
  "utf8",
);
const dtoSource = readFileSync(
  resolve(process.cwd(), "src/platform/platform-company-user.dto.ts"),
  "utf8",
);

describe("Platform Company user route protection", () => {
  it("finds the routes", () => {
    expect(routeHandlers().length).toBeGreaterThanOrEqual(9);
  });

  it("protects every route with the Platform kind and a platform.* permission", () => {
    const unprotected: string[] = [];
    for (const route of routeHandlers()) {
      const kinds = Reflect.getMetadata(REQUIRED_IDENTITY_KINDS, route.handler) as
        string[] | undefined;
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS, route.handler) as
        string[] | undefined;
      const ok =
        kinds?.includes("platform_administrator") === true &&
        permissions?.includes(PLATFORM_ACCESS) === true &&
        permissions.every((code) => code.startsWith(PLATFORM_PERMISSION_PREFIX));
      if (!ok) unprotected.push(route.method);
    }
    expect(unprotected).toEqual([]);
  });

  /**
   * Reading who a Company's users are, and being able to reset their
   * credentials, are different levels of access.
   */
  it("separates read from manage", () => {
    const wrong: string[] = [];
    for (const route of routeHandlers()) {
      const permissions = (Reflect.getMetadata(REQUIRED_PERMISSIONS, route.handler) ??
        []) as string[];
      const readOnly = ["list", "sessions", "deletionEligibility"].includes(route.method);
      const hasManage = permissions.includes("platform.users.manage");
      const hasRead = permissions.includes("platform.users.read");
      if (readOnly && (!hasRead || hasManage)) wrong.push(`${route.method} (read)`);
      if (!readOnly && !hasManage) wrong.push(`${route.method} (manage)`);
    }
    expect(wrong).toEqual([]);
  });

  it("exposes no deletion route", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/platform/platform-company-user.controller.ts"),
      "utf8",
    );
    expect(source).not.toContain("@Delete");
  });
});

describe("Company user request contract", () => {
  /**
   * `forbidNonWhitelisted` rejects anything not declared, so these assertions
   * record the fields that deliberately do not exist.
   */
  it("offers no field for a role, permission, password or identifier", () => {
    for (const forbidden of [
      "roleIds",
      "permissions",
      "password",
      "passwordHash",
      "companyId",
      "accountId",
      "createdBy",
      "tokenHash",
      "lockedUntil",
      "status",
    ]) {
      expect(dtoSource).not.toContain(`public ${forbidden}`);
    }
    expect(new CreateCompanyAdministratorDto()).not.toHaveProperty("roleIds");
  });

  it("normalises the mobile number with the shared decorator", () => {
    // `accounts_mobile_format` accepts only `9715XXXXXXXX`; a Platform-created
    // account must satisfy exactly the rules a Company-created one does.
    expect(dtoSource).toContain("NormalizeUaeMobile");
    expect(dtoSource).toContain("^9715[0-9]{8}$");
  });
});

describe("Credential handling", () => {
  it("never returns a password to the caller", () => {
    // `UserAdministrationService.create` generates a random temporary password;
    // this service must not read it out of the result or return it. The only
    // field taken from that call is the account identifier.
    expect(serviceSource).not.toContain("temporaryPassword");
    const createBlock = serviceSource.slice(
      serviceSource.indexOf("public async createAdministrator"),
      serviceSource.indexOf("private async ensureCompanyAdminRole"),
    );
    expect(createBlock).toContain("as { accountId: string }");
    expect(createBlock).not.toContain("password");
    // The returned shape carries the link and nothing else secret.
    expect(createBlock).toContain("setupUrl: this.setupUrl(");
  });

  it("stores only the token hash, never the raw token", () => {
    expect(setupSource).toContain("token_hash");
    // The raw value is hashed before it reaches any statement.
    expect(setupSource).toContain("this.tokens.hash(rawToken)");
    expect(setupSource).not.toMatch(/insert into password_reset_tokens[\s\S]*?\$\{rawToken\}/);
  });

  it("revokes older live links whenever a new one is issued", () => {
    expect(setupSource).toContain("set revoked_at = now()");
  });

  it("burns the token only after the password is stored", () => {
    const complete = setupSource.slice(setupSource.indexOf("public async complete"));
    expect(complete.indexOf("update accounts")).toBeLessThan(complete.indexOf("used_at = now()"));
  });

  it("ends every existing session on completion", () => {
    const complete = setupSource.slice(setupSource.indexOf("public async complete"));
    expect(complete).toContain("update account_sessions set revoked_at");
  });

  it("reuses the product's own password length rule", () => {
    const controller = readFileSync(
      resolve(process.cwd(), "src/authentication/account-setup.controller.ts"),
      "utf8",
    );
    // The same bound `ChangePasswordDto` and `LoginDto` use; no stricter
    // Platform-only policy that would fail the ordinary change-password screen.
    expect(controller).toContain("@Length(8, 256)");
  });

  it("records that a link was issued, never the link itself", () => {
    const audits = serviceSource.match(/after: \{[^}]*\}/g) ?? [];
    for (const entry of audits) {
      expect(entry).not.toContain("setupUrl");
      expect(entry).not.toContain("token");
    }
    expect(serviceSource).toContain("linkIssued: true");
  });

  it("builds the setup URL server-side, with no caller-supplied destination", () => {
    const url = serviceSource.slice(serviceSource.indexOf("private setupUrl"));
    expect(url).toContain("BLUELINE_TENANT_HOST_SUFFIX");
    // The subdomain comes from the Company row, not the request.
    expect(serviceSource).toContain("select subdomain from companies");
  });
});

describe("Provenance and identity", () => {
  it("records the Platform actor rather than inventing a Company user", () => {
    // `account_roles.assigned_by_account_id` is a PLAIN FK to accounts(id), so
    // the Platform account is a valid and truthful value.
    expect(serviceSource).toContain("PLAIN foreign");
    expect(serviceSource).not.toContain("company_id = null");
    // Nothing fabricates an identifier to satisfy a constraint.
    expect(serviceSource).not.toMatch(/assigned_by_account_id.*randomUUID/);
  });

  it("chooses the Company Administrator role on the server", () => {
    expect(serviceSource).toContain('const COMPANY_ADMIN_ROLE_CODE = "company_admin"');
    expect(serviceSource).toContain("FIRST_ADMIN_PERMISSIONS");
  });

  it("grants no platform.* permission to a Company role", () => {
    const permissions =
      /const FIRST_ADMIN_PERMISSIONS = \[([^\]]*)\]/.exec(serviceSource)?.[1] ?? "";
    expect(permissions).not.toBe("");
    expect(permissions).not.toContain("platform.");
    expect(permissions).toContain("users_roles.manage");
  });
});

describe("User state mapping", () => {
  const base = {
    status: "active",
    lockedUntil: null,
    passwordChangedAt: new Date(),
    forcePasswordChange: false,
  };

  it("reports an account that has never set a password as invitation pending", () => {
    expect(describeUserState({ ...base, passwordChangedAt: null })).toBe("invitation_pending");
    expect(describeUserState({ ...base, forcePasswordChange: true })).toBe("invitation_pending");
  });

  it("reports a live lock as locked", () => {
    expect(describeUserState({ ...base, lockedUntil: new Date(Date.now() + 60_000) })).toBe(
      "locked",
    );
    // An expired lock is not a lock.
    expect(describeUserState({ ...base, lockedUntil: new Date(Date.now() - 60_000) })).toBe(
      "active",
    );
  });

  /** Deactivation outranks a lock: unlocking must not resurrect the account. */
  it("reports a disabled account as disabled even when locked", () => {
    expect(
      describeUserState({
        ...base,
        status: "disabled",
        lockedUntil: new Date(Date.now() + 60_000),
      }),
    ).toBe("disabled");
  });

  it("reports a credential-ready account as active", () => {
    expect(describeUserState(base)).toBe("active");
  });
});

describe("Readiness derives from source data", () => {
  const readiness = readFileSync(
    resolve(process.cwd(), "src/platform/platform-company.service.ts"),
    "utf8",
  );

  it("requires a credential-ready administrator, not merely a row", () => {
    expect(readiness).toContain("force_password_change = false");
    expect(readiness).toContain("password_changed_at is not null");
    expect(readiness).toContain("lower(r.code) = 'company_admin'");
  });

  it("stores no cached readiness flag", () => {
    // Readiness is calculated from accounts, roles and credential state every
    // time, so it cannot drift from the records it describes.
    expect(readiness).not.toContain("company_admin_ready");
  });

  it("reports an unopened accounting period as a warning, not a blocker", () => {
    expect(readiness).toContain("Accounting period not yet open");
    // Nothing here opens a period.
    expect(readiness).not.toContain("update accounting_periods");
  });
});

describe("Transaction nesting", () => {
  /**
   * `KyselyTransactionManager.execute` calls `database.transaction()`, which
   * takes a NEW connection each time. Calling a service that opens its own
   * transaction from INSIDE one therefore produces two independent
   * transactions, and the inner one cannot see the outer one's uncommitted
   * rows.
   *
   * That is not a theoretical hazard: it broke the first administrator of every
   * new Company. The role was inserted in the outer transaction and
   * `assertRoles` in the inner one could not see it, so creation failed with
   * "Every assigned Role must be active and belong to the authenticated
   * Company".
   *
   * The database suites cannot catch it — they override the transaction manager
   * with a savepoint-based one where the inner call joins the outer
   * transaction, which is exactly the behaviour production does NOT have. So
   * the guard is structural: no call that opens its own transaction may appear
   * inside a `transactions.execute` callback here.
   */
  const createAccount = serviceSource.slice(
    serviceSource.indexOf("private async createAccount("),
    serviceSource.indexOf("private async ensureCompanyAdminRole("),
  );

  it("finds the creation path", () => {
    expect(createAccount).toContain("this.users.create(");
  });

  it("never calls the shared user service inside a transaction it opened", () => {
    // Each `transactions.execute(...)` callback in this method must be a single
    // scoped call. If `users.create` appears between an `execute(` and its
    // matching close, the nesting bug is back.
    const executeBlocks: string[] = [];
    let cursor = createAccount.indexOf("this.transactions.execute(");
    while (cursor !== -1) {
      let depth = 0;
      let index = createAccount.indexOf("(", cursor);
      const start = index;
      do {
        const character = createAccount[index];
        if (character === "(") depth += 1;
        if (character === ")") depth -= 1;
        index += 1;
      } while (depth > 0 && index < createAccount.length);
      executeBlocks.push(createAccount.slice(start, index));
      cursor = createAccount.indexOf("this.transactions.execute(", index);
    }

    expect(executeBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of executeBlocks) {
      expect(block).not.toContain("this.users.create");
    }
  });

  /**
   * Order matters as much as separation: the role has to be COMMITTED before
   * the account that references it is created.
   */
  it("commits the role before creating the account that uses it", () => {
    const role = createAccount.indexOf("ensureCompanyAdminRole");
    const account = createAccount.indexOf("this.users.create");
    const link = createAccount.indexOf("this.setup.issue");
    expect(role).toBeGreaterThan(-1);
    expect(role).toBeLessThan(account);
    expect(account).toBeLessThan(link);
  });
});
