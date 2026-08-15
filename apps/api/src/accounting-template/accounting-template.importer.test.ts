import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadApprovedTemplate } from "./accounting-template.registry.js";

/**
 * Importer rules that hold without a database.
 *
 * The importer's real behaviour is proved end-to-end against the schema by
 * `platform/platform-company.database.test.ts`. What is asserted here are the
 * decisions that must not drift silently: what it refuses to enable, whose name
 * it writes, and that the fiscal calendar is computed rather than copied.
 */
const source = readFileSync(
  resolve(process.cwd(), "src/accounting-template/accounting-template.importer.ts"),
  "utf8",
);

/** The text of one INSERT statement, taken between plain landmarks. */
function statement(table: string): string {
  const start = source.indexOf(`insert into ${table}`);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf(".execute(transaction)", start));
}

describe("Accounting template importer rules", () => {
  it("never enables automatic posting", () => {
    // The schema requires an accountable COMPANY user to switch it on, and none
    // exists at Company-creation time.
    const insert = statement("accounting_configurations");
    expect(insert).toContain("automatic_posting_enabled");
    expect(insert).not.toContain("defaults.automaticPostingEnabled");
  });

  it("writes no Company-scoped creator", () => {
    // `created_by_account_id` is a composite FK to `accounts(id, company_id)`
    // that a Platform Administrator structurally cannot satisfy.
    expect(source).toContain("const platformCreator = null;");
    expect(source).not.toContain("${input.actorAccountId}::uuid");
  });

  it("creates no opening balance, journal, accounting event or order", () => {
    for (const table of [
      "insert into opening_balance_batches",
      "insert into opening_balance_lines",
      "insert into journal_entries",
      "insert into journal_lines",
      "insert into accounting_events",
      "insert into orders",
    ]) {
      expect(source).not.toContain(table);
    }
  });

  it("starts every reference counter at 1", () => {
    const insert = statement("company_reference_counters");
    expect(insert).toContain("next_value");
    expect(insert).toContain("${prefix.prefix}, 1)");
    expect(insert).not.toContain("nextValue");
  });

  it("derives the fiscal year from the Company's own start date", () => {
    expect(source).toContain("createFiscalCalendar");
    // The fiscal year CONTAINING the Company's start date, never a copied one.
    expect(source).toContain("month >= startMonth ? year : year - 1");
    expect(source).toContain("template.fiscalPolicy.periodsPerYear");
  });

  it("opens only the period covering the Company's own creation date", () => {
    // Opening a period ahead of its own time has a posting consequence;
    // onboarding does not make that decision for periods that have not
    // arrived yet -- but the one period covering "today" is not a decision
    // left open, it is simply when the Company starts.
    expect(source).toContain('input.effectiveFrom >= periodStart && input.effectiveFrom <= periodEnd');
    expect(source).toContain('? "open"');
    expect(source).toContain(': "future"');
  });

  it("lets the Company override the template business-day default", () => {
    expect(statement("company_business_day_configurations")).toContain(
      "input.businessDayStart ?? template.businessDay.startTime",
    );
  });

  it("verifies the fiscal calendar before the caller may commit", () => {
    expect(source).toContain("Expected exactly one fiscal year");
    expect(source).toContain("belong to another Company's fiscal year");
  });
});

describe("Approved template expectations", () => {
  const { template } = loadApprovedTemplate("UAE_DELIVERY_STANDARD", 1);

  it("supplies the fiscal policy the importer needs", () => {
    expect(template.fiscalPolicy.fiscalYearStartMonth).toBe(1);
    expect(template.fiscalPolicy.periodsPerYear).toBe(12);
    expect(template.fiscalPolicy.periodModel).toBe("calendar_month");
  });

  it("still carries no dated fiscal rows", () => {
    expect(template).not.toHaveProperty("fiscalYears");
    expect(template).not.toHaveProperty("accountingPeriods");
  });
});
