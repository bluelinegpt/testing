import { describe, expect, it } from "vitest";

import {
  backupDecision,
  parseArguments,
  rejectionReason,
  type CommandOptions,
} from "./reset-company-test-data.cli.js";
import {
  CONDITIONAL_TABLES,
  CYCLE_BREAKS,
  LEGACY_COMPATIBILITY_EDGES,
  PRESERVE_TABLES,
  PURGE_TABLES,
  collectInboundReferences,
  dependencyOrder,
  isLegacyCompatibilityEdge,
  quoteIdentifier,
  type ForeignKey,
} from "./reset-company-test-data.manifest.js";

const COMPANY = "dd28829b-2b7c-4851-a0be-181b92673e84";
const OTHER = "11111111-2222-3333-4444-555555555555";

function options(overrides: Partial<CommandOptions> = {}): CommandOptions {
  return {
    companyId: COMPANY,
    confirmCompanyId: COMPANY,
    execute: true,
    backup: false,
    allowNoBackup: false,
    listCompanies: false,
    help: false,
    ...overrides,
  };
}

describe("reset command guards", () => {
  it("defaults to a dry run when --execute is absent", () => {
    expect(parseArguments(["--company-id", COMPANY]).execute).toBe(false);
    expect(rejectionReason(options({ execute: false, confirmCompanyId: "" }), "development")).toBe(
      null,
    );
  });

  it("rejects execution without a confirmation identifier", () => {
    expect(rejectionReason(options({ confirmCompanyId: "" }), "development")).toContain(
      "--confirm-company-id",
    );
  });

  it("rejects execution when the confirmation identifier does not match", () => {
    expect(rejectionReason(options({ confirmCompanyId: OTHER }), "development")).toContain(
      "does not match",
    );
  });

  it("rejects execution in production with no bypass", () => {
    expect(rejectionReason(options(), "production")).toContain("production");
    expect(rejectionReason(options({ allowNoBackup: true, backup: true }), "production")).toContain(
      "no bypass",
    );
  });

  it("accepts a matching confirmation outside production", () => {
    expect(rejectionReason(options(), "development")).toBe(null);
    expect(rejectionReason(options(), "test")).toBe(null);
  });

  it("parses both identifiers in either argument form", () => {
    const spaced = parseArguments([
      "--company-id",
      COMPANY,
      "--execute",
      "--confirm-company-id",
      COMPANY,
    ]);
    expect(spaced).toMatchObject({ companyId: COMPANY, confirmCompanyId: COMPANY, execute: true });
    const equals = parseArguments([`--company-id=${COMPANY}`, `--confirm-company-id=${OTHER}`]);
    expect(equals).toMatchObject({ companyId: COMPANY, confirmCompanyId: OTHER });
  });
});

describe("backup behaviour", () => {
  it("backs up when pg_dump is available", () => {
    expect(backupDecision(options(), true).action).toBe("backup");
  });

  it("stops when pg_dump is unavailable and no waiver was given", () => {
    const decision = backupDecision(options(), false);
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("--allow-no-backup");
  });

  it("proceeds without a backup only when explicitly waived", () => {
    expect(backupDecision(options({ allowNoBackup: true }), false).action).toBe("proceed");
  });
});

describe("manifest invariants", () => {
  it("has no table in more than one classification", () => {
    const all = [...PURGE_TABLES, ...PRESERVE_TABLES, ...CONDITIONAL_TABLES];
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps every must-preserve table out of the removal set", () => {
    const mustPreserve = [
      "companies",
      "accounts",
      "roles",
      "permissions",
      "role_permissions",
      "chart_of_accounts",
      "account_mappings",
      "company_cash_accounts",
      "company_bank_accounts",
      "company_business_day_configurations",
      "fiscal_years",
      "accounting_periods",
      "areas",
      "emirates",
      "accounting_configurations",
      "audit_events",
      "balance_override_audits",
      "trader_commerce_profiles",
      "kysely_migration",
    ];
    for (const table of mustPreserve) {
      expect(PURGE_TABLES.has(table), `${table} must never be in the removal set`).toBe(false);
      expect(PRESERVE_TABLES.has(table), `${table} must be preserved`).toBe(true);
    }
  });

  it("includes the approved business masters in the removal set", () => {
    for (const table of ["customers", "customer_addresses", "traders", "drivers", "employees"]) {
      expect(PURGE_TABLES.has(table), `${table} was approved for removal`).toBe(true);
    }
  });

  /*
   * `trader_storefronts` was on the list above until Storefront ownership was rebound from
   * the Delivery Company to Trader Commerce (migration
   * 20260807100000_storefront_commerce_ownership_rebind). That migration states the rule
   * outright -- "nothing may infer 'this Store belongs to the session's Company' from
   * `trader_storefronts.company_id` after this point" -- and keeps `company_id` and
   * `trader_id` only as nullable compatibility references with no ownership meaning. It
   * even ships a probe that builds a whole Storefront tree with both NULL and fails if any
   * constraint still demands a Company.
   *
   * A Storefront is therefore not Company-owned data and a Company reset must not remove
   * it. The earlier approval predates the rebind; this asserts the current rule so the two
   * cannot drift apart again.
   */
  it("keeps the Storefront tree out of the removal set, since it is Trader-Commerce-owned", () => {
    for (const table of [
      "trader_storefronts",
      "trader_storefront_slugs",
      "trader_storefront_categories",
      "trader_storefront_products",
      "trader_storefront_product_media",
      "trader_storefront_product_option_groups",
      "trader_storefront_product_option_values",
      "storefront_marketplace_categories",
    ]) {
      expect(PURGE_TABLES.has(table), `${table} is not Company-owned`).toBe(false);
      expect(PRESERVE_TABLES.has(table), `${table} must be preserved`).toBe(true);
    }
  });

  it("rejects identifiers that are not plain table names", () => {
    expect(() => quoteIdentifier('orders"; something')).toThrow();
    expect(quoteIdentifier("orders")).toBe('"orders"');
  });
});

/*
 * The inbound-reference check is what stops a removal-set table being deleted while
 * something outside the set still points at it. LEGACY_COMPATIBILITY_EDGES is the only way
 * to opt an edge out of it, so these cases exist to keep that hole exactly one edge wide.
 */
describe("legacy compatibility edges", () => {
  const fk = (child: string, parent: string, childColumns: string[]): ForeignKey => ({
    child,
    parent,
    childColumns,
    parentColumns: ["company_id", "id"],
  });

  it("declares only the reviewed Storefront compatibility edges", () => {
    expect(
      LEGACY_COMPATIBILITY_EDGES.map((entry) => `${entry.child}.${entry.columns.join("+")}`),
    ).toEqual([
      "trader_storefronts.company_id+trader_id",
      "store_orders.delivery_order_id",
      "store_orders.delivery_company_relationship_id",
      "store_orders.delivery_company_relationship_id+trader_commerce_id+delivery_company_id",
    ]);
    // Every entry must say why, so the next reader is not left guessing.
    for (const entry of LEGACY_COMPATIBILITY_EDGES) {
      expect(entry.reason.length, `${entry.child} needs a recorded reason`).toBeGreaterThan(40);
    }
  });

  it("matches the declared edge", () => {
    expect(
      isLegacyCompatibilityEdge(fk("trader_storefronts", "traders", ["company_id", "trader_id"])),
    ).toBe(true);
  });

  it("does not match a different edge between the same two tables", () => {
    // A real foreign key added to this pair later must still be reported.
    expect(
      isLegacyCompatibilityEdge(fk("trader_storefronts", "traders", ["owner_trader_id"])),
    ).toBe(false);
    expect(
      isLegacyCompatibilityEdge(fk("trader_storefronts", "traders", ["company_id"])),
      "a subset of the declared columns is a different constraint",
    ).toBe(false);
    expect(
      isLegacyCompatibilityEdge(
        fk("trader_storefronts", "traders", ["company_id", "trader_id", "extra_id"]),
      ),
    ).toBe(false);
  });

  it("does not match the same columns between other tables", () => {
    expect(isLegacyCompatibilityEdge(fk("orders", "traders", ["company_id", "trader_id"]))).toBe(
      false,
    );
    expect(
      isLegacyCompatibilityEdge(fk("trader_storefronts", "customers", ["company_id", "trader_id"])),
    ).toBe(false);
  });

  it("suppresses only that edge in the inbound-reference check", () => {
    const purgeSet = new Set(["traders", "customers"]);
    const inbound = collectInboundReferences(
      [
        fk("trader_storefronts", "traders", ["company_id", "trader_id"]),
        fk("trader_storefronts", "customers", ["company_id", "customer_id"]),
      ],
      purgeSet,
    );
    // The declared edge is gone; the undeclared one from the very same table is not.
    expect(inbound.has("traders")).toBe(false);
    expect([...(inbound.get("customers") ?? [])]).toEqual(["trader_storefronts"]);
  });

  it("still reports a real reference into the removal set", () => {
    const inbound = collectInboundReferences(
      [fk("some_new_table", "traders", ["company_id", "trader_id"])],
      new Set(["traders"]),
    );
    expect([...(inbound.get("traders") ?? [])]).toEqual(["some_new_table"]);
  });
});

describe("cycle breaking", () => {
  const key = (child: string, parent: string, childColumns: string[]): ForeignKey => ({
    child,
    parent,
    childColumns,
    parentColumns: ["id", "company_id"],
  });

  it("leaves a cycle unresolved when nothing breaks it", () => {
    const result = dependencyOrder(
      ["alpha", "beta"],
      [key("alpha", "beta", ["beta_id"]), key("beta", "alpha", ["alpha_id"])],
    );
    expect(result.cycle).toEqual(["alpha", "beta"]);
    expect(result.order).toEqual([]);
  });

  it("resolves the accounting cycle through the declared break", () => {
    const result = dependencyOrder(
      ["accounting_events", "journal_entries"],
      [
        key("journal_entries", "accounting_events", ["accounting_event_id", "company_id"]),
        key("accounting_events", "journal_entries", ["journal_id", "company_id"]),
      ],
    );
    expect(result.cycle).toEqual([]);
    expect(result.order).toEqual(["accounting_events", "journal_entries"]);
  });

  it("resolves the communication cycle through the declared break", () => {
    const result = dependencyOrder(
      ["conversations", "messages"],
      [
        key("conversations", "messages", ["last_message_id", "company_id"]),
        key("messages", "conversations", ["conversation_id", "company_id"]),
      ],
    );
    expect(result.cycle).toEqual([]);
    expect(result.order).toEqual(["messages", "conversations"]);
  });

  it("declares breaks only on the two known cycles", () => {
    expect(CYCLE_BREAKS.map((entry) => entry.table).sort()).toEqual([
      "conversations",
      "journal_entries",
    ]);
  });
});
