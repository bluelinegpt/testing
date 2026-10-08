import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Reverse Money Received locked its Orders with `group by ... for update`,
 * which PostgreSQL rejects ("FOR UPDATE is not allowed with GROUP BY clause"),
 * so every reversal failed with a 500 (XYZ SET-000053, 9 Oct 2026).
 */
describe("Reverse Money Received order lock", () => {
  const service = readFileSync(resolve(process.cwd(), "src/operations/trader-settlement.service.ts"), "utf8");
  const start = service.indexOf("public async reverseMoneyReceived(");
  const body = service.slice(start, service.indexOf("public async reverseInTransaction(", start));

  it("never combines GROUP BY with FOR UPDATE", () => {
    expect(start).toBeGreaterThan(-1);
    const forUpdateQueries = body.split("`").filter((chunk) => /for update/i.test(chunk));
    expect(forUpdateQueries.length).toBeGreaterThan(0);
    for (const query of forUpdateQueries) {
      expect(query).not.toMatch(/group\s+by/i);
    }
  });
});
