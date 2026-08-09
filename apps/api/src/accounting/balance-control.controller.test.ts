import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  REQUIRED_ANY_PERMISSIONS,
  REQUIRED_IDENTITY_KINDS,
} from "../authentication/authentication.decorators.js";
import { BalanceControlController } from "./balance-control.controller.js";

/**
 * `users_roles.manage` as the write permission on `POST /balance-control`.
 *
 * A Platform-created Company Administrator is deliberately given a small
 * permission set at onboarding -- `company_profile.manage` and
 * `users_roles.manage` -- specifically so they can finish setting the Company
 * up before granting anyone the narrower operational roles. Every sibling
 * accounting/configuration write route accepts `users_roles.manage` as an
 * alternative to its own manage permission for exactly that reason: cash and
 * bank accounts, VAT, general settings, opening balances, journal entries.
 *
 * This route was the one exception. A first administrator could VIEW the
 * policy (`company_profile.manage` is accepted on the GET) but never SET one,
 * and the failure read as an ordinary permission boundary rather than a gap —
 * there was nothing to tell an operator this was accidental. Reflection
 * against the live decorator metadata, not a description of intent, so a
 * regression here fails loudly rather than silently reopening the same wall
 * for every Company created afterward.
 */
/**
 * Reads a prototype method's own function value via its property descriptor
 * rather than plain property access. A method here can be shadowed by an
 * unrelated getter on the same prototype chain, and bracket/dot access would
 * silently invoke that getter instead of returning the function the decorator
 * metadata is actually attached to.
 */
function handler(method: string): (() => unknown) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(
    BalanceControlController.prototype as object,
    method,
  );
  return descriptor?.value as (() => unknown) | undefined;
}

describe("Balance Control write permission", () => {
  it("accepts the first-administrator bootstrap permission on save", () => {
    const save = handler("save");
    expect(save).toBeDefined();
    const permissions = Reflect.getMetadata(REQUIRED_ANY_PERMISSIONS, save as object) as
      | string[]
      | undefined;
    expect(permissions).toBeDefined();
    expect(permissions).toContain("accounting.manage");
    expect(permissions).toContain("users_roles.manage");
  });

  it("still requires a Company user identity", () => {
    // Set once, on the class, not on individual routes.
    const kinds = Reflect.getMetadata(REQUIRED_IDENTITY_KINDS, BalanceControlController) as
      | string[]
      | undefined;
    expect(kinds).toContain("company_user");
  });

  /**
   * The read side already accepted this permission and is left unchanged.
   * Asserted here so a future edit that narrows it is caught in the same
   * file as the write-side fix, rather than discovered separately.
   */
  it("keeps the read route open to company_profile.manage", () => {
    const permissions = Reflect.getMetadata(REQUIRED_ANY_PERMISSIONS, handler("policies") as object) as
      | string[]
      | undefined;
    expect(permissions).toContain("company_profile.manage");
  });

  /**
   * Every sibling write route in the accounting and configuration modules
   * already follows this pattern. Pinning the source, not just this one
   * route, so the exception this fix closed does not quietly reopen as
   * "well, most routes do it" drifts back to "only some routes do it".
   */
  it("matches the pattern every sibling accounting write route already follows", () => {
    const cashBank = readFileSync(resolve(process.cwd(), "src/accounting/cash-bank.controller.ts"), "utf8");
    expect(cashBank).toContain('RequireAnyPermission("accounting.manage", "users_roles.manage")');
  });
});
