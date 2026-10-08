import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_IDENTITY_KINDS,
  REQUIRED_PERMISSIONS,
} from "../authentication/authentication.decorators.js";
import { PLATFORM_ACCESS, PLATFORM_INTEGRITY_READ } from "../platform/platform-authorization.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { OrderValidationController } from "./order-validation.controller.js";
import { OrderValidationLookup } from "./order-validation.lookup.js";
import { ORDER_VALIDATION_CHECK_CODES } from "./order-validation.service.js";

/**
 * Non-database guarantees of Repair Center Order Validation. The database
 * behaviour (lookup, every check, isolation, read-only proof, HTTP
 * authorization) is in `order-validation.database.test.ts`.
 */
describe("Order Validation routes", () => {
  const prototype = OrderValidationController.prototype as unknown as Record<string, object>;

  it("protects every route with the Platform identity, platform.access and platform.integrity.read", () => {
    const handlers = Object.getOwnPropertyNames(OrderValidationController.prototype).filter(
      (name) => name !== "constructor",
    );
    expect(handlers.sort()).toEqual(["lookupOrder", "validateOrder"]);
    for (const name of handlers) {
      const handler = prototype[name]!;
      expect(Reflect.getMetadata(REQUIRED_IDENTITY_KINDS, handler), name).toEqual([
        "platform_administrator",
      ]);
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as string[];
      expect(permissions, name).toContain(PLATFORM_ACCESS);
      expect(permissions, name).toContain(PLATFORM_INTEGRITY_READ);
    }
  });

  it("is served under the Company-scoped Platform Repair Center path", () => {
    expect(Reflect.getMetadata("path", OrderValidationController)).toBe(
      "platform/companies/:companyId/repair-center/orders",
    );
  });
});

describe("Order Validation lookup input", () => {
  // These inputs are refused before any query runs, so no database is needed.
  const lookup = new OrderValidationLookup(undefined as never);
  const companyId = "00000000-0000-4000-8000-000000000001";

  for (const value of ["1744,2416", "1744\n2416", "1744،2416", "ORD-*", "17%", "", "   "]) {
    it(`refuses ${JSON.stringify(value)} with order_lookup_invalid`, async () => {
      const error = await lookup.resolve(companyId, value).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApplicationException);
      expect((error as ApplicationException).errorCode).toBe("order_lookup_invalid");
      expect((error as ApplicationException).getStatus()).toBe(400);
    });
  }
});

describe("Order Validation copy", () => {
  it("has English and Arabic text in platform-web for every check code", () => {
    const source = readFileSync(
      resolve(process.cwd(), "../platform-web/src/localization/order-validation.ts"),
      "utf8",
    );
    for (const code of [...ORDER_VALIDATION_CHECK_CODES, "V1.strong"]) {
      // One entry per language: `L1: {` (or `"V1.strong": {`) appears exactly twice.
      const escaped = code.replace(".", "\\.");
      const entry = new RegExp(`(^|[\\s{,])"?${escaped}"?:\\s*\\{`, "gmu");
      expect(source.match(entry)?.length ?? 0, code).toBe(2);
    }
  });
});
