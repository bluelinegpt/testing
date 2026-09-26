import { describe, expect, it } from "vitest";
import { COMPANY_WEBSITE_AGENT_EVAL_CASES } from "./company-website-agent.eval-cases.js";

describe("Company Website Agent bilingual evaluation corpus", () => {
  it("contains all 50 ordered English and Arabic scenarios", () => {
    expect(COMPANY_WEBSITE_AGENT_EVAL_CASES).toHaveLength(50);
    expect(COMPANY_WEBSITE_AGENT_EVAL_CASES.map((item) => item.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    for (const item of COMPANY_WEBSITE_AGENT_EVAL_CASES) {
      expect(item.en.trim().length).toBeGreaterThan(10);
      expect(item.ar).toMatch(/[\u0600-\u06ff]/u);
    }
  });

  it("covers every required operational behavior without embedding answers", () => {
    expect(new Set(COMPANY_WEBSITE_AGENT_EVAL_CASES.map((item) => item.category))).toEqual(
      new Set([
        "coverage_service",
        "pricing_quote",
        "cod_finance",
        "tracking_status",
        "complaint_exception",
      ]),
    );
    expect(new Set(COMPANY_WEBSITE_AGENT_EVAL_CASES.map((item) => item.expected))).toEqual(
      new Set([
        "published_facts_only",
        "quote_or_lead",
        "secure_tracking_or_handoff",
        "complaint_handoff",
      ]),
    );
  });
});
