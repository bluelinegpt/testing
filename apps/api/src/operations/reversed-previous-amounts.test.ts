import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A reversed Collection or Settlement shows what earlier, still-active records
 * had paid, never a negative "previously" amount (COL-000014 showed -20.00,
 * SET-000057 showed -80.00).
 */
describe("Previously collected / paid on reversed records", () => {
  const receivables = readFileSync(resolve(process.cwd(), "src/operations/trader-receivable.service.ts"), "utf8");
  const settlements = readFileSync(resolve(process.cwd(), "src/operations/trader-settlement.service.ts"), "utf8");

  it("uses earlier active collections for a reversed Collection", () => {
    expect(receivables).toContain('(cur.status = \'reversed\') as "collectionReversed"');
    expect(receivables).toContain("? new Decimal(row.earlierCollected)");
  });

  it("uses earlier effective settlements for a reversed Settlement, in list and detail", () => {
    expect(settlements).toContain("const previouslyPaidSql = (link: string, settlement: string) =>");
    expect(settlements).toContain('coalesce(sum(${previouslyPaidSql("link", "s")}), 0) as "previouslyPaid"');
    expect(settlements).toContain('(${previouslyPaidSql("link", "cur")})::text as "previouslyPaid"');
    expect(settlements).not.toContain("new Decimal(row.traderPaidAmount).minus(row.allocatedAmount)");
  });
});
