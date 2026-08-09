import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  REQUIRED_IDENTITY_KINDS,
  REQUIRED_PERMISSIONS,
} from "../authentication/authentication.decorators.js";
import { PLATFORM_ACCESS, PLATFORM_PERMISSION_PREFIX } from "./platform-authorization.js";
import {
  PlatformCompanyController,
  PlatformTargetCompanyController,
} from "./platform-company.controller.js";
import { CreateCompanyDto, UpdateCompanyProfileDto } from "./platform-company.dto.js";

/**
 * Nest's own key for the route path a `@Get`/`@Post` decorator writes. Declared
 * here rather than imported from `@nestjs/common/constants`, which is not part
 * of the package's published type surface.
 */
const ROUTE_PATH_METADATA = "path";

const controllers = [PlatformCompanyController, PlatformTargetCompanyController];

function routeHandlers(): { controller: string; method: string; handler: () => unknown }[] {
  const found: { controller: string; method: string; handler: () => unknown }[] = [];
  for (const controller of controllers) {
    const prototype = controller.prototype as object;
    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method === "constructor") continue;
      const handler = Object.getOwnPropertyDescriptor(prototype, method)?.value as unknown;
      if (typeof handler !== "function") continue;
      if (Reflect.getMetadata(ROUTE_PATH_METADATA, handler) === undefined) continue;
      found.push({ controller: controller.name, method, handler: handler as () => unknown });
    }
  }
  return found;
}

describe("Platform Company route protection", () => {
  it("finds the Company routes", () => {
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
      if (!ok) unprotected.push(`${route.controller}.${route.method}`);
    }
    expect(unprotected).toEqual([]);
  });

  /**
   * Reading is separated from changing so a read-only Platform account can be
   * given real visibility without any ability to create or govern a tenant.
   */
  /**
   * Audit is a separate permission from `companies.read`: seeing that a Company
   * exists and seeing every administrative action taken against it are
   * different levels of access.
   */
  it("gates the audit summary behind platform.audit.read", () => {
    const route = routeHandlers().find((entry) => entry.method === "audit");
    expect(route).toBeDefined();
    const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS, route!.handler) as string[];
    expect(permissions).toContain("platform.audit.read");
    expect(permissions).not.toContain("platform.companies.manage");
  });

  it("requires the manage permission for every mutating route", () => {
    const wrong: string[] = [];
    for (const route of routeHandlers()) {
      const method = Reflect.getMetadata("method", route.handler) as number | undefined;
      const permissions = (Reflect.getMetadata(REQUIRED_PERMISSIONS, route.handler) ??
        []) as string[];
      const mutating = [
        "create",
        "update",
        "activate",
        "suspend",
        "reactivate",
        "disable",
      ].includes(route.method);
      const hasManage = permissions.includes("platform.companies.manage");
      if (mutating !== hasManage) wrong.push(`${route.controller}.${route.method} (${method})`);
    }
    expect(wrong).toEqual([]);
  });

  /**
   * A Company's history must survive the Company being closed, so closure is a
   * lifecycle transition and never a delete.
   */
  it("exposes no deletion route", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/platform/platform-company.controller.ts"),
      "utf8",
    );
    expect(source).not.toContain("@Delete");
  });

  it("exposes no generic status mutation", () => {
    // Lifecycle is a set of explicit commands. A writable status field would put
    // every illegal transition one typo away and leave nowhere to demand a
    // reason.
    const dto = readFileSync(
      resolve(process.cwd(), "src/platform/platform-company.dto.ts"),
      "utf8",
    );
    expect(new UpdateCompanyProfileDto()).not.toHaveProperty("status");
    expect(dto).not.toMatch(/class UpdateCompanyProfileDto[\s\S]*?public status/);
  });
});

describe("Company request contracts", () => {
  const propertiesOf = (dto: object): string[] => {
    const keys = Reflect.getMetadata("design:type", dto) as unknown;
    void keys;
    return Object.getOwnPropertyNames(dto);
  };

  /**
   * The global pipe runs with `forbidNonWhitelisted`, so a field that is not
   * declared is REJECTED rather than stripped. These assertions record which
   * fields deliberately do not exist.
   */
  it("offers no field for a client-supplied identifier or lifecycle value", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/platform/platform-company.dto.ts"),
      "utf8",
    );
    for (const forbidden of [
      "companyId",
      "createdBy",
      "createdAt",
      "activatedAt",
      "accountId",
      "chartOfAccounts",
      "templatePath",
      "templateUrl",
      "templateContent",
    ]) {
      expect(source).not.toContain(`public ${forbidden}`);
    }
    void propertiesOf(new CreateCompanyDto());
  });

  /**
   * Environment is a safety property a future Company reset will depend on, and
   * `code`/`subdomain` are references other systems resolve by. None may move
   * through an ordinary profile edit.
   */
  it("keeps environment, code and subdomain out of the profile edit contract", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/platform/platform-company.dto.ts"),
      "utf8",
    );
    const editContract = source.slice(source.indexOf("class UpdateCompanyProfileDto"));
    expect(editContract).not.toContain("public environment");
    expect(editContract).not.toContain("public code");
    expect(editContract).not.toContain("public subdomain");
  });

  it("declares the template by code and version only", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/platform/platform-company.dto.ts"),
      "utf8",
    );
    expect(source).toContain("public accountingTemplateCode");
    expect(source).toContain("public accountingTemplateVersion");
  });
});

describe("Company lifecycle rules", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/platform/platform-company.service.ts"),
    "utf8",
  );

  it("declares the legal transitions as one table", () => {
    expect(source).toContain("const legalTransitions");
    // Disabled is terminal.
    expect(source).toMatch(/disabled:\s*\[\]/);
  });

  it("creates every Company in draft", () => {
    // The whole INSERT, up to its RETURNING clause. An earlier attempt stopped
    // at the first closing parenthesis, which fell inside `input.name.trim()`
    // and cut the statement short before the status value.
    const insert = /insert into companies[\s\S]*?returning id/.exec(source)?.[0] ?? "";
    expect(insert).not.toBe("");
    expect(insert).toContain("'draft'");
    // A Company is never born active: activation is a separate, checked action.
    expect(insert).not.toContain("'active'");
  });

  it("shares one reserved-subdomain list with the host resolver", () => {
    expect(source).toContain("isReservedCompanySubdomain");
    expect(source).not.toContain('"platform"');
  });

  it("runs creation through the shared transaction manager", () => {
    expect(source).toContain("this.transactions.execute");
    expect(source).not.toContain("this.database.transaction()");
  });
});
