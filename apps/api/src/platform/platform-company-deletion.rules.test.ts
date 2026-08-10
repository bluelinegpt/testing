import { describe, expect, it } from "vitest";

import { calculateCompanyDeletionEligibility } from "./platform-company-deletion.service.js";

const closedAt = new Date("2026-08-09T00:00:00.000Z");
const atHours = (hours: number) => new Date(closedAt.getTime() + hours * 60 * 60 * 1000);

describe("Company deletion eligibility", () => {
  it.each(["development", "demo", "sandbox", "trial"])(
    "makes a closed %s Company immediately time-eligible",
    (environment) => {
      expect(
        calculateCompanyDeletionEligibility({ status: "closed", environment, closedAt, now: closedAt }),
      ).toMatchObject({ eligible: true, remainingSeconds: 0, requiresWaitingPeriod: false });
    },
  );

  it.each([
    [0, false],
    [1, false],
    [47 + 59 / 60, false],
    [48, true],
    [49, true],
  ])("enforces the Production wait at %s hours", (hours, eligible) => {
    expect(
      calculateCompanyDeletionEligibility({
        status: "closed",
        environment: "production",
        closedAt,
        now: atHours(hours),
      }).eligible,
    ).toBe(eligible);
  });

  it("fails closed for unknown environments", () => {
    const result = calculateCompanyDeletionEligibility({
      status: "closed",
      environment: "unknown",
      closedAt,
      now: closedAt,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("Unsupported or missing Company environment");
  });

  it("never starts eligibility from suspension", () => {
    expect(
      calculateCompanyDeletionEligibility({
        status: "suspended",
        environment: "development",
        closedAt: null,
        now: closedAt,
      }).eligible,
    ).toBe(false);
  });
});
