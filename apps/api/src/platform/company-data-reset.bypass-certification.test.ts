import "reflect-metadata";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { RequestMethod } from "@nestjs/common";
import { MODULE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * COMPANY DATA RESET -- bypass certification (Company Data Reset, Prompt 2).
 *
 * There must be ONE Company Data Reset mutation architecture:
 *   request / CLI intent -> CompanyDataResetService (executeAndAuditCompanyDataReset)
 *   -> planner -> versioned plan -> executor -> integrity -> audit.
 *
 * 1. ROUTES. Every HTTP route in the application (all modules reachable from
 *    AppModule) whose method mutates and whose path names a reset / purge /
 *    wipe is classified below. A new one without a classification fails.
 * 2. CLIs. Every package script that resets Company data runs a file that
 *    goes through the shared CLI support (same planner + executor) and holds
 *    no deletion statements and no legacy engine import.
 * 3. CODE. The legacy whole-Company engine (`runReset`) and the legacy
 *    users-only remover (`removeResetCompanyUsers`) are called only from the
 *    pinned places below -- any new caller fails.
 */

type Classification =
  | "PLAN_BASED_RESET"
  | "READ_ONLY"
  | "NORMAL_USER_ADMINISTRATION"
  | "NON_COMPANY_RESET"
  | "NON_COMPANY_DEV_DATABASE_RESET"
  | "RETIRED_NON_MUTATING"
  | "LEGACY_COMPANY_RESET_MUTATION";

/**
 * Legacy Company reset mutations still reachable. MUST be empty for R1 to be
 * FIXED. Kept explicit so it can only shrink (see the dedicated test).
 */
const LEGACY_COMPANY_RESET_ROUTES: readonly string[] = [];

/** Legacy Company reset routes kept only to answer old clients: 410, zero mutation. */
const RETIRED_COMPANY_RESET_ROUTES = [
  "POST platform/companies/:companyId/reset-execute",
  "POST platform/companies/:companyId/users-reset-execute",
] as const;
const LEGACY_ROUTES = (): Record<string, Classification> =>
  Object.fromEntries(LEGACY_COMPANY_RESET_ROUTES.map((route) => [route, "LEGACY_COMPANY_RESET_MUTATION" as const]));

/** Every reset-named mutating route, by "METHOD path". */
const ROUTE_CLASSIFICATION: Readonly<Record<string, Classification>> = {
  "POST platform/companies/:companyId/data-reset/execute": "PLAN_BASED_RESET",
  "POST platform/companies/:companyId/data-reset/preview": "READ_ONLY",
  "POST platform/companies/:companyId/users-reset-preview": "READ_ONLY",
  // One Order's Trader receivable (a Company user's business correction, with
  // its own permission): not a Company data reset.
  "POST operations/orders/:orderId/reset-trader-receivable": "NON_COMPANY_RESET",
  ...Object.fromEntries(RETIRED_COMPANY_RESET_ROUTES.map((route) => [route, "RETIRED_NON_MUTATING" as const])),
  ...LEGACY_ROUTES(),
};


const RESET_WORD = /(^|[/:_-])(reset|purge|wipe|truncate|clear-data)([/_-]|$)/iu;
const NON_COMPANY_RESET_WORD = /password|credential|reset-password|password-reset/iu;

interface Route {
  readonly key: string;
  readonly controller: string;
  readonly handler: object;
}

function modulesFrom(root: unknown, seen = new Set<unknown>()): unknown[] {
  const module = (root as { module?: unknown } | undefined)?.module ?? root;
  if (module === undefined || seen.has(module)) return [];
  seen.add(module);
  const imports = [
    ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, module as object) ?? []) as unknown[]),
    ...(((root as { imports?: unknown[] }).imports ?? []) as unknown[]),
  ];
  return [module, ...imports.flatMap((entry) => modulesFrom(entry, seen))];
}

function allRoutes(AppModule: unknown): Route[] {
  const controllers = new Set<{ name: string; prototype: object }>();
  for (const module of modulesFrom(AppModule)) {
    for (const controller of (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module as object) ?? []) as {
      name: string;
      prototype: object;
    }[]) {
      controllers.add(controller);
    }
  }
  const routes: Route[] = [];
  for (const controller of controllers) {
    const bases = [Reflect.getMetadata(PATH_METADATA, controller) ?? ""].flat() as string[];
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      if (name === "constructor") continue;
      const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)?.value as unknown;
      if (typeof handler !== "function") continue;
      const paths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (paths === undefined) continue;
      const method = RequestMethod[(Reflect.getMetadata(METHOD_METADATA, handler) ?? RequestMethod.GET) as RequestMethod];
      for (const base of bases) {
        for (const path of [paths].flat()) {
          routes.push({
            controller: `${controller.name}.${name}`,
            handler: handler as object,
            key: `${method} ${`${base}/${path}`.replace(/\/+/gu, "/").replace(/^\/|\/$/gu, "")}`,
          });
        }
      }
    }
  }
  return routes;
}

describe("Company Data Reset -- bypass certification", () => {
  let routes: Route[] = [];
  let resetMutations: Route[] = [];
  beforeAll(async () => {
    // Module metadata only; nothing connects. Configuration needs a URL to load.
    process.env.DATABASE_URL ??= "postgresql://metadata-only@127.0.0.1:1/none";
    const { AppModule } = await import("../app.module.js");
    routes = allRoutes(AppModule);
    resetMutations = routes.filter(
      (route) => !route.key.startsWith("GET ") && RESET_WORD.test(route.key.split(" ")[1]!) && !NON_COMPANY_RESET_WORD.test(route.key),
    );
  }, 120_000);

  it("finds the application's routes (sanity)", () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.map((route) => route.key)).toContain("POST platform/companies/:companyId/data-reset/execute");
  });

  it("ROUTES: every reset-named mutating route is classified (a new unclassified reset route fails)", () => {
    const unclassified = resetMutations.filter((route) => ROUTE_CLASSIFICATION[route.key] === undefined);
    expect(unclassified.map((route) => `${route.key} (${route.controller})`)).toEqual([]);
    // Every classification still exists (no stale pins).
    expect(Object.keys(ROUTE_CLASSIFICATION).filter((key) => !routes.some((route) => route.key === key))).toEqual([]);
  });

  it("ROUTES: the only plan-based Company reset mutation is data-reset/execute", () => {
    expect(
      resetMutations.filter((route) => ROUTE_CLASSIFICATION[route.key] === "PLAN_BASED_RESET").map((route) => route.key),
    ).toEqual(["POST platform/companies/:companyId/data-reset/execute"]);
  });

  it("ROUTES: legacy Company reset mutations are exactly the pinned list (may only shrink; R1 needs it empty)", () => {
    expect(
      resetMutations
        .filter((route) => ROUTE_CLASSIFICATION[route.key] === "LEGACY_COMPANY_RESET_MUTATION")
        .map((route) => route.key)
        .sort(),
    ).toEqual([...LEGACY_COMPANY_RESET_ROUTES].sort());
  });

  it("ROUTES: no forbidden classification remains -- only PLAN_BASED_RESET / READ_ONLY / RETIRED_NON_MUTATING / NORMAL_USER_ADMINISTRATION / NON_COMPANY_*", () => {
    const allowed = new Set<Classification>([
      "PLAN_BASED_RESET",
      "READ_ONLY",
      "RETIRED_NON_MUTATING",
      "NORMAL_USER_ADMINISTRATION",
      "NON_COMPANY_RESET",
      "NON_COMPANY_DEV_DATABASE_RESET",
    ]);
    expect(resetMutations.filter((route) => !allowed.has(ROUTE_CLASSIFICATION[route.key]!)).map((route) => route.key)).toEqual([]);
  });

  it("ROUTES: the retired legacy handlers change nothing -- they throw 410 company_reset_retired without touching any service", async () => {
    const { PlatformTargetCompanyController, retiredCompanyReset } = await import("./platform-company.controller.js");
    const touched: string[] = [];
    const trap = new Proxy({}, { get: (_target, name) => { touched.push(String(name)); throw new Error(`service touched: ${String(name)}`); } });
    const controller = Object.create(PlatformTargetCompanyController.prototype) as Record<string, unknown>;
    for (const field of ["reset", "companies", "deletion", "deletionBackups", "deletionExecution", "contextStore", "tenants", "identities"]) controller[field] = trap;
    for (const [handler, route] of [["resetExecute", "reset-execute"], ["usersResetExecute", "users-reset-execute"]] as const) {
      const call = () => (controller[handler] as (companyId: string, ...rest: unknown[]) => unknown).call(controller, "company-id", { confirmation: "RESET X", accountIds: ["a"] }, {});
      expect(call).toThrow(retiredCompanyReset("company-id", route).message);
      try {
        call();
      } catch (error) {
        expect(error).toMatchObject({ errorCode: "company_reset_retired" });
        expect((error as { getStatus(): number }).getStatus()).toBe(410);
      }
    }
    expect(touched).toEqual([]);
    const source = readFileSync(resolve(process.cwd(), "src/platform/platform-company.controller.ts"), "utf8");
    expect(source).not.toMatch(/this\.reset\.(execute|executeUsers)\s*\(/u);
  });

  it("PERMISSIONS (Prompt 3): every Company Data Reset route is Platform-administrator only with platform.companies.reset; no Company-portal route resets a Company", async () => {
    const { REQUIRED_IDENTITY_KINDS, REQUIRED_PERMISSIONS } = await import("../authentication/authentication.decorators.js");
    const dataReset = routes.filter((route) =>
      /\/(data-reset\/(preview|execute)|reset-execute|users-reset-(eligible|preview|execute)|reset-preview)$/u.test(route.key),
    );
    expect(dataReset.length).toBeGreaterThanOrEqual(7);
    for (const route of dataReset) {
      expect(route.key, route.controller).toMatch(/^(GET|POST) platform\/companies\/:companyId\//u);
      expect(Reflect.getMetadata(REQUIRED_IDENTITY_KINDS, route.handler), route.key).toEqual(["platform_administrator"]);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, route.handler), route.key).toContain("platform.companies.reset");
    }
    // Outside the Platform API the only reset-named mutation is the per-Order receivable correction.
    expect(resetMutations.filter((route) => !route.key.split(" ")[1]!.startsWith("platform/")).map((route) => route.key)).toEqual([
      "POST operations/orders/:orderId/reset-trader-receivable",
    ]);
  });

  const apiRoot = resolve(process.cwd());
  const read = (path: string) => readFileSync(resolve(apiRoot, path), "utf8");

  it("CLIs: every Company reset package script runs through the shared plan-based CLI support, with no deletion of its own", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    const resetScripts = Object.entries(scripts).filter(([name, command]) => /reset/iu.test(name) && /tsx src\/platform\//u.test(command));
    const files = resetScripts.map(([name, command]) => [name, /tsx (src\/platform\/\S+\.ts)/u.exec(command)![1]!] as const);
    // Platform-administrator password reset is not a Company data reset.
    const companyResetFiles = files.filter(([name]) => !/password/iu.test(name));
    expect(companyResetFiles.map(([name]) => name).sort()).toEqual(["db:reset:dev", "reset:test-data"]);
    for (const [, file] of companyResetFiles) {
      const source = read(file);
      expect(source, file).toContain("./company-data-reset.cli-support.js");
      expect(source, file).not.toMatch(/reset-company-test-data\.engine|runReset|removeResetCompanyUsers/u);
      expect(source, file).not.toMatch(/delete\s+from|truncate\s|disable trigger/iu);
    }
  });

  it("CLIs: the shared CLI support has no deletion of its own -- it calls the single execute-and-audit entry point", () => {
    const source = read("src/platform/company-data-reset.cli-support.ts");
    expect(source).toContain("executeAndAuditCompanyDataReset");
    expect(source).not.toMatch(/delete\s+from|truncate\s|disable trigger|runReset|removeResetCompanyUsers/iu);
  });

  /** Non-test sources calling a function, relative to apps/api. */
  const callers = (pattern: RegExp): string[] => {
    const found: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && !/\.test\.ts$/u.test(path) && pattern.test(readFileSync(path, "utf8"))) {
          found.push(relative(apiRoot, path).replaceAll("\\", "/"));
        }
      }
    };
    walk(resolve(apiRoot, "src"));
    return found.sort();
  };

  it("CODE (Prompt 3): the deprecated whole-Company engine has NO production caller -- only its own module", () => {
    expect(callers(/\brunReset\s*\(/u)).toEqual(["src/platform/reset-company-test-data.engine.ts"]);
    expect(read("src/platform/reset-company-test-data.engine.ts")).toMatch(/@deprecated LEGACY whole-Company reset engine/u);
  });

  it("CODE (Prompt 3): the deprecated users-only remover is called only by the deprecated engine and its own module", () => {
    expect(callers(/\bremoveResetCompanyUsers\s*\(/u)).toEqual([
      "src/platform/reset-company-test-data.engine.ts",
      "src/platform/reset-company-users.ts",
    ]);
    expect(read("src/platform/reset-company-users.ts")).toMatch(/@deprecated LEGACY users-only remover/u);
  });

  it("CODE (Prompt 3): the only production importer of the legacy engine is the planner, for its manifest constant only", () => {
    expect(callers(/from "\.\/reset-company-test-data\.engine\.js"/u)).toEqual(["src/platform/company-data-reset.planner.ts"]);
    expect(read("src/platform/company-data-reset.planner.ts")).toMatch(/import \{ engineManifest \} from "\.\/reset-company-test-data\.engine\.js";/u);
  });

  it("CODE (Prompt 3): the legacy PlatformCompanyResetService is read-only -- no execute / executeUsers, no write statement", () => {
    const source = read("src/platform/platform-company-reset.service.ts");
    expect(source).not.toMatch(/public\s+(async\s+)?execute(Users)?\s*\(/u);
    expect(source).not.toMatch(/insert\s+into|delete\s+from|update\s+\w+\s+set|truncate|pg_dump/iu);
    expect(source).not.toMatch(/\brunReset\s*\(|removeResetCompanyUsers\s*\(/u);
  });

  it("CODE: one plan-based executor -- only the service's execute-and-audit runs it", () => {
    expect(callers(/\bexecuteCompanyDataReset\s*\(/u)).toEqual([
      "src/platform/company-data-reset.executor.ts",
      "src/platform/company-data-reset.service.ts",
    ]);
    expect(callers(/\bexecuteAndAuditCompanyDataReset\s*\(/u)).toEqual([
      "src/platform/company-data-reset.cli-support.ts",
      "src/platform/company-data-reset.service.ts",
    ]);
  });
});
