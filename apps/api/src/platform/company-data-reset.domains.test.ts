import { describe, expect, it } from "vitest";

import {
  AUTO_DEPENDENCY_DOMAINS,
  DOMAIN_TABLES,
  domainCoverageProblems,
  domainOf,
  normalizeResetRequest,
  PROTECTED_DOMAINS,
  USER_ACCESS_TABLES,
} from "./company-data-reset.domains.js";
import { PRESERVE_TABLES, PURGE_TABLES } from "./reset-company-test-data.manifest.js";

/** Company Data Reset, Prompt 1 -- domain map and preset rules (static). */
describe("Company Data Reset domains and presets", () => {
  it("every PURGE table is in exactly one domain; no domain touches a PRESERVE table", () => {
    expect(domainCoverageProblems()).toEqual([]);
    for (const tables of Object.values(DOMAIN_TABLES)) {
      for (const table of tables) expect(PRESERVE_TABLES.has(table), table).toBe(false);
    }
    expect([...USER_ACCESS_TABLES].every((table) => PURGE_TABLES.has(table))).toBe(true);
  });

  it("identity, configuration and Platform audit are in no domain", () => {
    for (const table of ["accounts", "company_users", "account_roles", "roles", "company_settings", "areas", "chart_of_accounts",
      "accounting_configurations", "platform_repair_executions", "platform_repair_attempts", "audit_events"]) {
      expect(domainOf(table), table).toBeNull();
    }
  });

  it("masters are protected domains; only Operational / Financial are ever pulled in as a shown dependency", () => {
    expect([...AUTO_DEPENDENCY_DOMAINS].sort()).toEqual(["FINANCIAL", "OPERATIONAL"]);
    expect([...PROTECTED_DOMAINS].sort()).toEqual(["INTEGRATIONS", "TRADERS_CUSTOMERS", "WORKFORCE"]);
    expect(domainOf("employees")).toBe("WORKFORCE");
    expect(domainOf("drivers")).toBe("WORKFORCE");
    expect(domainOf("traders")).toBe("TRADERS_CUSTOMERS");
    expect(domainOf("customers")).toBe("TRADERS_CUSTOMERS");
    expect(domainOf("orders")).toBe("OPERATIONAL");
  });

  it("parents of the engine's parent-total guards share their children's domain (the guard is only suspended when the parent is cleared)", () => {
    for (const [parent, child] of [
      ["journal_entries", "journal_lines"],
      ["opening_balance_batches", "opening_balance_lines"],
      ["employee_variable_earning_payments", "employee_variable_earning_payment_allocations"],
    ]) {
      expect(domainOf(parent!)).toBe(domainOf(child!));
    }
  });

  it("presets expand deterministically and never imply user, workforce or master deletion", () => {
    expect(normalizeResetRequest({ preset: "OPERATIONAL_DATA" })).toMatchObject({ selectedDomains: ["OPERATIONAL"], userMode: "KEEP_ALL_USERS" });
    expect(normalizeResetRequest({ preset: "FINANCIAL_DATA" })).toMatchObject({ selectedDomains: ["FINANCIAL"], userMode: "KEEP_ALL_USERS" });
    expect(normalizeResetRequest({ preset: "USERS_WORKFORCE", userMode: "KEEP_ALL_USERS" }).selectedDomains).toEqual([]);
    expect(normalizeResetRequest({ preset: "FULL_COMPANY_DATA_KEEP_COMPANY", userMode: "KEEP_ALL_USERS" }).selectedDomains).toEqual(["OPERATIONAL", "FINANCIAL"]);
    expect(
      normalizeResetRequest({ preset: "FULL_COMPANY_DATA_KEEP_COMPANY", tradersCustomers: "RESET", userMode: "KEEP_ALL_USERS", workforce: "RESET" }).selectedDomains,
    ).toEqual(["OPERATIONAL", "FINANCIAL", "TRADERS_CUSTOMERS", "WORKFORCE"]);
    expect(normalizeResetRequest({ domains: ["TRADERS_CUSTOMERS"], preset: "CUSTOM" })).toMatchObject({ selectedDomains: ["TRADERS_CUSTOMERS"], userMode: "KEEP_ALL_USERS" });
    expect(normalizeResetRequest({ preset: "USERS_WORKFORCE", selectedAccountIds: ["b", "a", "a"], userMode: "DELETE_SELECTED_USERS" }).selectedAccountIds).toEqual(["a", "b"]);
  });

  it("refuses contradictory or implicit requests", () => {
    expect(() => normalizeResetRequest({ preset: "OPERATIONAL_DATA", userMode: "DELETE_SELECTED_USERS", selectedAccountIds: ["a"] })).toThrow();
    expect(() => normalizeResetRequest({ preset: "FINANCIAL_DATA", workforce: "RESET" })).toThrow();
    expect(() => normalizeResetRequest({ preset: "USERS_WORKFORCE" })).toThrow(/explicit user mode/u);
    expect(() => normalizeResetRequest({ preset: "FULL_COMPANY_DATA_KEEP_COMPANY" })).toThrow(/explicit user mode/u);
    expect(() => normalizeResetRequest({ preset: "USERS_WORKFORCE", userMode: "DELETE_SELECTED_USERS" })).toThrow(/at least one/u);
    expect(() => normalizeResetRequest({ preset: "USERS_WORKFORCE", selectedAccountIds: ["a"], userMode: "DELETE_ALL_ELIGIBLE_USERS" })).toThrow();
    expect(() => normalizeResetRequest({ deleteAdminAccountIds: ["a"], preset: "USERS_WORKFORCE", userMode: "KEEP_ALL_USERS" })).toThrow();
    expect(() => normalizeResetRequest({ preset: "CUSTOM" })).toThrow();
  });
});
