import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Order Maintenance verify-first UI contract", () => {
  const source = readFileSync(resolve(process.cwd(), "src/features/configuration/OrderMaintenanceWorkspace.tsx"), "utf8");

  it("renders the financial verification panel and all classifications", () => {
    expect(source).toContain("Financial Verification");
    expect(source).toContain("verification.classification");
  });

  it("requests verification after selecting an order and refreshes after actions", () => {
    expect(source).toContain("financial-verification");
    expect(source).toContain("await verify(selectedId)");
    expect(source).toContain("verification.recommendedAction");
  });
});
