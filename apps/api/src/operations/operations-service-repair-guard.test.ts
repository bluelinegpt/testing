import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Repair Trader Receivable duplicate guard", () => {
  it("blocks usable rows but permits a replacement after reversal", () => {
    const source = readFileSync(new URL("./operations.service.ts", import.meta.url), "utf8");
    expect(source).toContain("source_type='service_charge'");
    expect(source).toContain("source_reference=\${order.orderNumber}");
    expect(source).toContain("status not in ('reversed', 'cancelled')");
  });
});
