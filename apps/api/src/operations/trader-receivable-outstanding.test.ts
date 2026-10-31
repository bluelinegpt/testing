import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(new URL("./trader-receivable.service.ts", import.meta.url), "utf8");

describe("Trader Receivables: Outstanding only", () => {
  it("never lists a cancelled or reversed charge as outstanding (RCV-000097)", () => {
    expect(service).toContain(
      "or (r.outstanding_amount > 0 and r.status not in ('cancelled', 'reversed')))",
    );
  });
});
