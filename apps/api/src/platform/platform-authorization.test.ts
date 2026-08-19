import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PLATFORM_ACCESS,
  PLATFORM_PERMISSIONS,
  PLATFORM_PERMISSION_PREFIX,
  PLATFORM_SUPER_ADMIN_ROLE_CODE,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
import {
  REQUIRED_IDENTITY_KINDS,
  REQUIRED_PERMISSIONS,
} from "../authentication/authentication.decorators.js";
import { PlatformAuthController } from "./platform-auth.controller.js";
import {
  PlatformCompanyController,
  PlatformTargetCompanyController,
} from "./platform-company.controller.js";

/**
 * Nest's own key for the route path a `@Get`/`@Post` decorator writes. Declared
 * here rather than imported from `@nestjs/common/constants`, which is not part
 * of the package's published type surface.
 */
const ROUTE_PATH_METADATA = "path";

const platformControllers = [
  PlatformAuthController,
  PlatformCompanyController,
  PlatformTargetCompanyController,
];

/** Every route handler on a Platform controller, with its metadata. */
function routeHandlers(): { controller: string; method: string; handler: () => unknown }[] {
  const handlers: { controller: string; method: string; handler: () => unknown }[] = [];
  for (const controller of platformControllers) {
    const prototype = controller.prototype as object;
    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method === "constructor") continue;
      // Read the descriptor rather than the property: a controller may define
      // a getter (`secureCookies` does), and reading it here would invoke it
      // against an uninstantiated prototype.
      const handler = Object.getOwnPropertyDescriptor(prototype, method)?.value as unknown;
      if (typeof handler !== "function") continue;
      if (Reflect.getMetadata(ROUTE_PATH_METADATA, handler) === undefined) continue;
      handlers.push({ controller: controller.name, method, handler: handler as () => unknown });
    }
  }
  return handlers;
}

describe("Platform permission catalogue", () => {
  it("keeps every code inside the reserved namespace", () => {
    for (const permission of PLATFORM_PERMISSIONS) {
      expect(permission.code.startsWith(PLATFORM_PERMISSION_PREFIX)).toBe(true);
    }
  });

  it("declares no duplicate code", () => {
    const codes = PLATFORM_PERMISSIONS.map((permission) => permission.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("stays the deliberately-scoped set", () => {
    // Codes for billing, Storefront, Mobile and
    // integrity AUTO-FIX are deliberately absent: a permission nothing
    // enforces is a control that appears to exist and does not.
    // `platform.integrity.read` is present -- the Integration Integrity
    // Checker's detector IS implemented, read-only, per the three-tier
    // remediation policy agreed 2026-08-04; only the auto-fix half stays
    // unseeded.
    expect(PLATFORM_PERMISSIONS.map((permission) => permission.code).sort()).toEqual([
      "platform.access",
      "platform.agent.manage",
      "platform.agent.read",
      "platform.agent.whatsapp.manage",
      "platform.agent.whatsapp.read",
      "platform.agent.whatsapp.reply",
      "platform.agent.whatsapp.takeover",
      "platform.audit.read",
      "platform.blog.categories.manage",
      "platform.blog.create",
      "platform.blog.edit",
      "platform.blog.publish",
      "platform.blog.read",
      "platform.companies.delete",
      "platform.companies.manage",
      "platform.companies.read",
      "platform.companies.reset",
      "platform.customer_marketplace.manage",
      "platform.customer_quotes.manage",
      "platform.customer_quotes.read",
      "platform.errors.manage",
      "platform.errors.read",
      "platform.integrity.read",
      "platform.leads.manage",
      "platform.leads.read",
      "platform.public_site_settings.manage",
      "platform.trader_applications.manage",
      "platform.trader_applications.read",
      "platform.users.manage",
      "platform.users.read",
      "platform.website.manage",
      "platform.website.media.manage",
      "platform.website.publish",
      "platform.website.read",
      "platform.website.seo.manage",
    ]);
  });

  /**
   * The namespace IS the isolation boundary — `role.service.ts` excludes
   * `code like 'platform.%'` from everything a Company Administrator can see or
   * assign. A code that fell outside the prefix would silently become
   * assignable by a Company Administrator.
   */
  it("is excluded from Company role management by the role service", () => {
    const roleService = readFileSync(resolve(process.cwd(), "src/roles/role.service.ts"), "utf8");
    expect(roleService).toContain("code not like 'platform.%'");
  });

  it("seeds exactly the declared codes in the migration", () => {
    const foundationMigration = readFileSync(
      resolve(
        process.cwd(),
        "../../database/migrations/20260808100000_platform_administration_foundation.ts",
      ),
      "utf8",
    );
    const deletionMigration = readFileSync(
      resolve(process.cwd(), "../../database/migrations/20260812000000_company_deletion_foundation.ts"),
      "utf8",
    );
    const errorReportsMigration = readFileSync(
      resolve(process.cwd(), "../../database/migrations/20260820000000_client_error_reports.ts"),
      "utf8",
    );
    const integrityMigration = readFileSync(
      resolve(
        process.cwd(),
        "../../database/migrations/20260821000000_integrity_check_permission.ts",
      ),
      "utf8",
    );
    const resetMigration = readFileSync(resolve(process.cwd(), "../../database/migrations/20260822000000_company_reset_permission.ts"), "utf8");
    const leadsMigration = readFileSync(resolve(process.cwd(), "../../database/migrations/20260824000000_platform_demo_requests.ts"), "utf8");
    const traderApplicationsMigration = readFileSync(resolve(process.cwd(), "../../database/migrations/20260825000000_platform_trader_applications.ts"), "utf8");
    const customerQuotesMigration = readFileSync(resolve(process.cwd(), "../../database/migrations/20260826000000_customer_quote_marketplace.ts"), "utf8");
    const blogMigration = readFileSync(resolve(process.cwd(), "../../database/migrations/20260827000000_platform_blog_and_tracking.ts"), "utf8");
    const agentMigration = readFileSync(resolve(process.cwd(), "../../database/migrations/20260828000000_tawseelhub_agent_core.ts"), "utf8");
    const websiteCmsMigration = readFileSync(resolve(process.cwd(), "../../database/migrations/20260905000000_controlled_website_cms.ts"), "utf8");
    const migrations = foundationMigration + deletionMigration + errorReportsMigration + integrityMigration + resetMigration + leadsMigration + traderApplicationsMigration + customerQuotesMigration + blogMigration + agentMigration + websiteCmsMigration;
    for (const permission of PLATFORM_PERMISSIONS) expect(migrations).toContain(`'${permission.code}'`);
    expect(migrations).toContain(`'${PLATFORM_SUPER_ADMIN_ROLE_CODE}'`);
    // Idempotent on an environment that has already been migrated.
    expect(foundationMigration).toContain("on conflict (code) do nothing");
    expect(foundationMigration).toContain("on conflict (role_id, permission_code) do nothing");
    expect(foundationMigration).toContain("on conflict (account_id, role_id) do nothing");
  });
});

describe("RequirePlatformPermissions", () => {
  it("requires the Platform identity kind and platform.access on every route", () => {
    class Probe {
      @RequirePlatformPermissions()
      public handler(): void {}
    }
    const handler = Probe.prototype.handler;
    expect(Reflect.getMetadata(REQUIRED_IDENTITY_KINDS, handler)).toEqual([
      "platform_administrator",
    ]);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual([PLATFORM_ACCESS]);
  });

  it("adds the granular code alongside platform.access, never instead of it", () => {
    class Probe {
      @RequirePlatformPermissions("platform.companies.read")
      public handler(): void {}
    }
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, Probe.prototype.handler)).toEqual([
      PLATFORM_ACCESS,
      "platform.companies.read",
    ]);
  });
});

describe("Platform route protection", () => {
  it("finds the Platform route handlers", () => {
    expect(routeHandlers().length).toBeGreaterThanOrEqual(4);
  });

  /**
   * Deny-by-default already means an un-annotated route requires a valid
   * session. It does NOT mean the route requires a *Platform* session, and a
   * Platform route reachable by a Company user is the single worst outcome this
   * module can produce. So the annotation is asserted mechanically rather than
   * left to review.
   */
  it("protects every Platform route with the Platform kind and a platform.* permission", () => {
    const unprotected: string[] = [];
    for (const route of routeHandlers()) {
      const kinds = Reflect.getMetadata(REQUIRED_IDENTITY_KINDS, route.handler) as
        string[] | undefined;
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS, route.handler) as
        string[] | undefined;
      const isPublic = Reflect.getMetadata("blueline.public-route", route.handler) === true;
      if (isPublic) continue;
      const ok =
        kinds?.includes("platform_administrator") === true &&
        permissions?.includes(PLATFORM_ACCESS) === true &&
        permissions.every((code) => code.startsWith(PLATFORM_PERMISSION_PREFIX));
      if (!ok) unprotected.push(`${route.controller}.${route.method}`);
    }
    expect(unprotected).toEqual([]);
  });

  /**
   * Exactly one Platform route may be public, and it is sign-in. Anything else
   * public would be an unauthenticated Platform surface.
   */
  it("exposes sign-in as the only public Platform route", () => {
    const publicRoutes = routeHandlers()
      .filter((route) => Reflect.getMetadata("blueline.public-route", route.handler) === true)
      .map((route) => `${route.controller}.${route.method}`);
    expect(publicRoutes).toEqual(["PlatformAuthController.login"]);
  });
});
