import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { platformApi, type RepairCenterOverview } from "../api/platform-client.js";
import { RepairCenterOverviewPanel } from "./RepairCenterOverviewPanel.js";

const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function overview(overrides: Partial<RepairCenterOverview> = {}): RepairCenterOverview {
  return {
    accountingHealth: {
      accountingHealth: "ISSUE",
      blocked: 0,
      blockedConfiguration: 0,
      failed: 2,
      historicalWhileOff: 0,
      manualReview: 0,
      note: "GL Accounting is ON.",
      pending: 0,
      processing: 0,
      readyCandidateNote: "Ready candidates pass every stored-state check. READY is decided only by Preview Recovery.",
      readyCandidates: 2,
      stuck: 0,
    },
    accountingMode: { automaticPostingEnabled: true, enabled: true },
    company: { code: "ALF", nameEn: "Al Fahd Delivery", status: "active" },
    companyHealth: "ISSUE",
    companyId,
    generatedAt: "2026-10-05T10:00:00.000Z",
    orderHealth: {
      accountingRelatedIssues: 2,
      companyHealth: "ISSUE",
      healthy: 7,
      issue: 3,
      review: 0,
      scope: { dateFrom: "2026-09-05", dateTo: "2026-10-05", scope: "last30" },
      totalOrders: 10,
    },
    payrollHealth: {
      driverFeeFindings: 0,
      headlines: ["ISSUE — Payroll payment state is inconsistent."],
      payrollHealth: "ISSUE",
      periodsWithFindings: 1,
      totalPeriods: 12,
    },
    repairHistory: { failed: 0, lastRepairAt: null, refused: 1, replayed: 0, succeeded: 4 },
    ...overrides,
  };
}

describe("RepairCenterOverviewPanel (Phase 6 landing)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the explicit Company, Accounting mode, overall health and every domain (Orders, Accounting, Payroll, History)", async () => {
    vi.spyOn(platformApi, "repairCenterOverview").mockResolvedValue(overview());
    render(<RepairCenterOverviewPanel companyId={companyId} refreshToken={0} />);
    expect(await screen.findByTestId("ov-company-health")).toHaveProperty("textContent", "ISSUE");
    expect(screen.getByText(/Al Fahd Delivery \(ALF\)/u)).toBeTruthy();
    expect(screen.getByTestId("ov-accounting-mode").textContent).toBe("ON");
    expect(screen.getByText("Order Health · ISSUE")).toBeTruthy();
    expect(screen.getByText("Accounting Health · ISSUE")).toBeTruthy();
    expect(screen.getByText("Payroll Health · ISSUE")).toBeTruthy();
    expect(screen.getByText("Repair History")).toBeTruthy();
    expect(screen.getByTestId("ov-payroll-attention").textContent).toBe("1");
    expect(platformApi.repairCenterOverview).toHaveBeenCalledWith(companyId);
  });

  it("labels Order issues that are accounting findings as the same root cause (one primary, related, never hidden)", async () => {
    vi.spyOn(platformApi, "repairCenterOverview").mockResolvedValue(overview());
    render(<RepairCenterOverviewPanel companyId={companyId} refreshToken={0} />);
    expect((await screen.findByTestId("ov-orders-issue")).textContent).toBe("3");
    expect(screen.getByTestId("ov-orders-accounting-related").textContent).toBe("2");
    expect(screen.getByText(/see Accounting Health/u)).toBeTruthy();
  });

  it("a healthy Company: HEALTHY overall, no accounting-related label", async () => {
    vi.spyOn(platformApi, "repairCenterOverview").mockResolvedValue(
      overview({
        accountingHealth: { ...overview().accountingHealth, accountingHealth: "NOT_APPLICABLE", failed: 0, readyCandidates: 0 },
        accountingMode: { automaticPostingEnabled: false, enabled: false },
        companyHealth: "HEALTHY",
        orderHealth: { ...overview().orderHealth, accountingRelatedIssues: 0, companyHealth: "HEALTHY", healthy: 10, issue: 0 },
        payrollHealth: { driverFeeFindings: 0, headlines: [], payrollHealth: "HEALTHY", periodsWithFindings: 0, totalPeriods: 3 },
      }),
    );
    render(<RepairCenterOverviewPanel companyId={companyId} refreshToken={0} />);
    expect((await screen.findByTestId("ov-company-health")).textContent).toBe("HEALTHY");
    expect(screen.getByTestId("ov-accounting-mode").textContent).toBe("OFF");
    expect(screen.queryByTestId("ov-orders-accounting-related")).toBeNull();
  });

  it("renders an older API response (no Payroll / overall health) without failing", async () => {
    const legacy = overview();
    const { companyHealth: _health, payrollHealth: _payroll, ...rest } = legacy;
    void _health;
    void _payroll;
    vi.spyOn(platformApi, "repairCenterOverview").mockResolvedValue({
      ...rest,
      orderHealth: (({ accountingRelatedIssues: _related, ...order }) => {
        void _related;
        return order;
      })(legacy.orderHealth),
    });
    render(<RepairCenterOverviewPanel companyId={companyId} refreshToken={0} />);
    expect(await screen.findByText("Order Health · ISSUE")).toBeTruthy();
    expect(screen.queryByTestId("ov-company-health")).toBeNull();
    expect(screen.queryByText(/Payroll Health/u)).toBeNull();
  });
});
