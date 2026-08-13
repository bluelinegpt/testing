import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PUBLIC_ROUTE,
  REQUIRED_IDENTITY_KINDS,
  REQUIRED_PERMISSIONS,
} from "../authentication/authentication.decorators.js";
import { PlatformAuditController } from "./platform-audit.controller.js";
import { PLATFORM_ACCESS, PLATFORM_PERMISSION_PREFIX } from "./platform-authorization.js";
import { PlatformAuthController } from "./platform-auth.controller.js";
import { PlatformCompanyUserController } from "./platform-company-user.controller.js";
import {
  PlatformCompanyController,
  PlatformCompanyDeletionController,
  PlatformTargetCompanyController,
} from "./platform-company.controller.js";
import { PlatformDashboardController } from "./platform-dashboard.controller.js";

/**
 * The Platform route inventory, enumerated rather than assumed.
 *
 * Phase 1 certification requires proving that EVERY route under
 * `/api/v1/platform` is private unless deliberately public. A hand-written list
 * of routes to check would certify the list, not the application — the one
 * route somebody forgets to add is exactly the one that would be exposed.
 *
 * So the controller set is discovered from the module file, and the routes are
 * discovered from Nest's own metadata. Adding a controller without registering
 * it here fails the first test; adding an unprotected route fails the others.
 */
const ROUTE_PATH_METADATA = "path";
const CONTROLLER_PATH_METADATA = "path";

/** Strips block and line comments so prose is never mistaken for behaviour. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const platformControllers = [
  PlatformAuditController,
  PlatformAuthController,
  PlatformCompanyController,
  PlatformCompanyDeletionController,
  PlatformDashboardController,
  PlatformTargetCompanyController,
  PlatformCompanyUserController,
];

interface PlatformRoute {
  readonly controller: string;
  readonly method: string;
  readonly path: string;
  readonly isPublic: boolean;
  readonly kinds: readonly string[];
  readonly permissions: readonly string[];
}

function inventory(): PlatformRoute[] {
  const routes: PlatformRoute[] = [];
  for (const controller of platformControllers) {
    const base = (Reflect.getMetadata(CONTROLLER_PATH_METADATA, controller) ?? "") as string;
    const prototype = controller.prototype as object;
    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method === "constructor") continue;
      const handler = Object.getOwnPropertyDescriptor(prototype, method)?.value as unknown;
      if (typeof handler !== "function") continue;
      const path = Reflect.getMetadata(ROUTE_PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue;
      routes.push({
        controller: controller.name,
        method,
        path: `${base}/${path}`.replace(/\/+/g, "/").replace(/\/$/, ""),
        isPublic: Reflect.getMetadata(PUBLIC_ROUTE, handler) === true,
        kinds: (Reflect.getMetadata(REQUIRED_IDENTITY_KINDS, handler) ?? []) as string[],
        permissions: (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) ?? []) as string[],
      });
    }
  }
  return routes;
}

describe("Platform route inventory", () => {
  const routes = inventory();

  /**
   * Every controller registered in the Platform module must appear above.
   * Otherwise a new controller could ship with no route ever inspected.
   */
  it("covers every controller the Platform module registers", () => {
    const moduleSource = readFileSync(
      resolve(process.cwd(), "src/platform/platform.module.ts"),
      "utf8",
    );
    const declared = /controllers:\s*\[([\s\S]*?)\]/.exec(moduleSource)?.[1] ?? "";
    expect(declared).not.toBe("");
    const registered = declared
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    expect(registered.sort()).toEqual(platformControllers.map((c) => c.name).sort());
  });

  it("finds every Platform route", () => {
    expect(routes.length).toBeGreaterThanOrEqual(19);
  });

  /**
   * The default is private. Exactly one Platform route may be public, and it is
   * sign-in — the only one a caller reaches before having a session.
   */
  it("exposes sign-in as the only public Platform route", () => {
    const publicRoutes = routes.filter((route) => route.isPublic);
    expect(publicRoutes.map((route) => `${route.controller}.${route.method}`)).toEqual([
      "PlatformAuthController.login",
    ]);
  });

  it("requires the Platform identity kind and platform.access on every private route", () => {
    const bad: string[] = [];
    for (const route of routes) {
      if (route.isPublic) continue;
      const ok =
        route.kinds.includes("platform_administrator") &&
        route.permissions.includes(PLATFORM_ACCESS) &&
        route.permissions.every((code) => code.startsWith(PLATFORM_PERMISSION_PREFIX));
      if (!ok) bad.push(`${route.controller}.${route.method}`);
    }
    expect(bad).toEqual([]);
  });

  /**
   * Reading and changing are separated so a read-only Platform account can be
   * given real visibility with no ability to act.
   */
  it("requires a manage permission for every mutating route", () => {
    const mutating = [
      "create",
      "update",
      "activate",
      "suspend",
      "reactivate",
      "close",
      "activation",
      "passwordReset",
      "unlock",
      "deactivate",
      "revokeSession",
      "revokeAll",
      "deleteUser",
    ];
    const bad: string[] = [];
    for (const route of routes) {
      if (route.isPublic) continue;
      const shouldManage = mutating.includes(route.method);
      const hasManage = route.permissions.some((code) => code.endsWith(".manage"));
      if (shouldManage !== hasManage) bad.push(`${route.controller}.${route.method}`);
    }
    expect(bad).toEqual([]);
  });

  it("gates Company deletion preview behind the dedicated delete permission", () => {
    const preview = routes.find((route) => route.method === "deletionPreview");
    expect(preview?.permissions).toContain("platform.companies.delete");
    expect(preview?.permissions).not.toContain("platform.companies.manage");
  });

  it("gates audit behind its own permission", () => {
    const audit = routes.find((route) => route.method === "audit");
    expect(audit?.permissions).toContain("platform.audit.read");
    // Company visibility alone must not grant the administrative trail.
    expect(audit?.permissions).not.toContain("platform.companies.manage");
  });

  /**
   * Every route naming a Company must be under the target-Company guard, so the
   * Company is re-resolved server-side rather than trusted from the request.
   */
  it("guards every :companyId route with the target-Company guard", () => {
    const guarded = new Set(["PlatformTargetCompanyController", "PlatformCompanyUserController"]);
    const bad: string[] = [];
    for (const route of routes) {
      if (!route.path.includes(":companyId")) continue;
      if (!guarded.has(route.controller)) bad.push(`${route.controller}.${route.method}`);
    }
    expect(bad).toEqual([]);

    for (const controller of guarded) {
      const source = readFileSync(
        resolve(
          process.cwd(),
          controller === "PlatformCompanyUserController"
            ? "src/platform/platform-company-user.controller.ts"
            : "src/platform/platform-company.controller.ts",
        ),
        "utf8",
      );
      expect(source).toContain("@UseGuards(PlatformTargetCompanyGuard)");
    }
  });

  it("exposes no deletion route anywhere on the Platform surface", () => {
    const directory = resolve(process.cwd(), "src/platform");
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".controller.ts")) continue;
      expect(readFileSync(resolve(directory, file), "utf8")).not.toContain("@Delete");
    }
  });

  /**
   * The Company reset engine lives in the same directory but must never be
   * reachable over HTTP. Registering it would create a destructive surface the
   * Company Maintenance phase has not yet designed controls for.
   */
  it("registers no reset capability in the Platform module", () => {
    // Comments are stripped first: the module's own prose explains WHY the
    // reset tools are not registered, and that explanation must not be read as
    // evidence that they are.
    const moduleSource = withoutComments(
      readFileSync(resolve(process.cwd(), "src/platform/platform.module.ts"), "utf8"),
    );
    expect(moduleSource.toLowerCase()).not.toContain("reset");
    const directory = resolve(process.cwd(), "src/platform");
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".controller.ts")) continue;
      const source = readFileSync(resolve(directory, file), "utf8");
      expect(source).not.toContain("reset-company-test-data");
    }
  });
});

describe("Platform permission catalogue certification", () => {
  it("keeps every Platform permission inside the reserved namespace", () => {
    for (const route of inventory()) {
      for (const code of route.permissions) {
        expect(code.startsWith(PLATFORM_PERMISSION_PREFIX)).toBe(true);
      }
    }
  });

  /**
   * The namespace IS the isolation boundary between Platform and Company
   * authorisation, enforced by the Company role service.
   */
  it("keeps the Company role service excluding the Platform namespace", () => {
    const roleService = readFileSync(resolve(process.cwd(), "src/roles/role.service.ts"), "utf8");
    expect(roleService).toContain("code not like 'platform.%'");
  });

  it("adds no reset, billing or impersonation permission in Phase 1", () => {
    const authorization = readFileSync(
      resolve(process.cwd(), "src/platform/platform-authorization.ts"),
      "utf8",
    );
    for (const forbidden of ["reset", "billing", "impersonat", "maintenance"]) {
      expect(authorization.toLowerCase()).not.toContain(`platform.${forbidden}`);
    }
  });
});
