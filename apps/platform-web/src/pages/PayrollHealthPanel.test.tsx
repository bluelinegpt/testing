import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type PayrollHealthPage,
  type PayrollHealthRow,
  type PayrollHealthSummary,
  type PayrollRepairFinding,
  type PayrollRepairPreview,
  type PayrollRepairResult,
  platformApi,
  PlatformApiError,
} from "../api/platform-client.js";
import { PayrollHealthPanel } from "./PayrollHealthPanel.js";

const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const periodId = "44444444-2222-4333-8444-555555555555";

function summary(overrides: Partial<PayrollHealthSummary> = {}): PayrollHealthSummary {
  return {
    accountingMode: { enabled: true },
    byCode: { PAYROLL_PAYMENT_STATE_INCONSISTENT: 1 },
    companyId,
    driverFeeFindings: 0,
    generatedAt: "2026-10-02T10:00:00.000Z",
    headlines: ["ISSUE — Payroll payment state is inconsistent."],
    payrollHealth: "ISSUE",
    periodsWithFindings: 1,
    totalPeriods: 12,
    ...overrides,
  };
}

const row: PayrollHealthRow = {
  codes: ["PAYROLL_PAYMENT_STATE_INCONSISTENT"],
  entityId: periodId,
  entityType: "payroll_period",
  headline: "ISSUE — Payroll payment state is inconsistent.",
  health: "ISSUE",
  reference: "PAY-2026-09",
  status: "partially_paid",
};

function page(items: readonly PayrollHealthRow[] = [row]): PayrollHealthPage {
  return { generatedAt: "2026-10-02T10:00:00.000Z", items, page: 1, pageSize: 25, total: items.length };
}

function finding(overrides: Partial<PayrollRepairFinding> = {}): PayrollRepairFinding {
  return {
    blockers: [],
    execution: { available: true, requiredPlatformPermission: "platform.companies.repair_center.execute" },
    executionRoute: "payroll",
    expectedResult: "The finding is resolved; no Payroll line, payment, adjustment, allocation or accounting record is created or deleted.",
    findingId: "fnd_payment",
    headline: "ISSUE — Payroll payment state is inconsistent.",
    health: "ISSUE",
    plannedOperation: "Reconcile paid / outstanding / status from the active payment allocations.",
    reason: "Paid and outstanding amounts disagree with the active payment allocations.",
    reasonCode: "PAYROLL_PAYMENT_STATE_INCONSISTENT",
    recommendedAction: "Execute the repair.",
    repairCapability: "RECONCILE_PAYROLL_PAYMENT_STATE",
    repairability: "READY",
    whyNotAutomatic: null,
    ...overrides,
  };
}

function preview(findings: readonly PayrollRepairFinding[] = [finding()]): PayrollRepairPreview {
  return {
    accounting: { enabled: true, events: [] },
    companyId,
    findings,
    generatedAt: "2026-10-02T10:00:00.000Z",
    health: findings.length === 0 ? "HEALTHY" : "ISSUE",
    lines: [],
    payments: [],
    period: {
      approvedAt: "2026-10-01T10:00:00.000Z",
      end: "2026-09-30",
      expectedTotals: { netSalary: "3000.00" },
      start: "2026-09-01",
      status: "partially_paid",
      totals: { netSalary: "3000.00" },
    },
    periodId,
    periodReference: "PAY-2026-09",
    previewVersion: `prv1:${"a".repeat(64)}`,
    requiredPermission: "platform.companies.repair_center.execute",
  };
}

const result: PayrollRepairResult = {
  afterHealth: "HEALTHY",
  afterPreviewVersion: `prv1:${"b".repeat(64)}`,
  beforeHealth: "ISSUE",
  beforePreviewVersion: `prv1:${"a".repeat(64)}`,
  capabilityCode: "RECONCILE_PAYROLL_PAYMENT_STATE",
  companyId,
  executedAt: "2026-10-02T10:01:00.000Z",
  findingId: "fnd_payment",
  periodId,
  periodReference: "PAY-2026-09",
  reasonCode: "PAYROLL_PAYMENT_STATE_INCONSISTENT",
  repairExecutionId: "55555555-2222-4333-8444-555555555555",
  replayed: false,
  status: "succeeded",
};

describe("PayrollHealthPanel", () => {
  beforeEach(() => {
    vi.spyOn(platformApi, "payrollHealthSummary").mockResolvedValue(summary());
    vi.spyOn(platformApi, "payrollHealthFindings").mockResolvedValue(page());
    vi.spyOn(platformApi, "payrollRepairPreview").mockResolvedValue(preview());
    vi.spyOn(platformApi, "executePayrollRepair").mockResolvedValue(result);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows simple headlines and the attention list by default", async () => {
    render(<PayrollHealthPanel companyId={companyId} />);
    expect(await screen.findByText("ISSUE — Payroll payment state is inconsistent.", { selector: "li" })).toBeTruthy();
    expect(screen.getByText("PAY-2026-09")).toBeTruthy();
    expect(platformApi.payrollHealthFindings).toHaveBeenCalledWith(companyId, { page: 1, pageSize: 25, status: "attention" });
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(platformApi.payrollHealthFindings).toHaveBeenLastCalledWith(companyId, { page: 1, pageSize: 25, status: "all" }),
    );
  });

  it("healthy Company: no headlines, nothing to repair", async () => {
    vi.mocked(platformApi.payrollHealthSummary).mockResolvedValue(
      summary({ byCode: {}, headlines: [], payrollHealth: "HEALTHY", periodsWithFindings: 0 }),
    );
    vi.mocked(platformApi.payrollHealthFindings).mockResolvedValue(page([]));
    render(<PayrollHealthPanel companyId={companyId} />);
    expect(await screen.findByText("Payroll is consistent.")).toBeTruthy();
    expect(screen.getByText("No Payroll period needs attention.")).toBeTruthy();
  });

  it("READY: preview, confirm with a reason, execute once, verify again", async () => {
    const attempted = vi.fn();
    render(<PayrollHealthPanel companyId={companyId} onRepairAttempted={attempted} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const confirm = await screen.findByRole("region", { name: "Confirm repair" });
    const button = within(confirm).getByRole("button", { name: "Execute Repair" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(confirm).getByRole("textbox"), { target: { value: "Allocations disagree" } });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    vi.mocked(platformApi.payrollRepairPreview).mockResolvedValue(preview([]));
    fireEvent.click(button);
    await screen.findByText(/Repaired: RECONCILE_PAYROLL_PAYMENT_STATE/u);
    expect(platformApi.executePayrollRepair).toHaveBeenCalledTimes(1);
    const body = vi.mocked(platformApi.executePayrollRepair).mock.calls[0]![2];
    expect(body).toMatchObject({
      capabilityCode: "RECONCILE_PAYROLL_PAYMENT_STATE",
      findingId: "fnd_payment",
      previewVersion: `prv1:${"a".repeat(64)}`,
      reason: "Allocations disagree",
    });
    expect(body.idempotencyKey).toMatch(/^rc-ui-/u);
    expect(attempted).toHaveBeenCalled();
    expect(await screen.findByText("This Payroll period is consistent. Nothing to repair.")).toBeTruthy();
  });

  it("MANUAL_REVIEW: explanation and recommended action, no execute / delete / reset / recalculate control", async () => {
    vi.mocked(platformApi.payrollRepairPreview).mockResolvedValue(
      preview([
        finding({
          execution: { available: false, requiredPlatformPermission: "platform.companies.repair_center.execute" },
          executionRoute: null,
          findingId: "fnd_amounts",
          headline: "ISSUE — Payroll calculation is inconsistent.",
          reasonCode: "PAYROLL_LINE_AMOUNTS_INCONSISTENT",
          recommendedAction: "Reverse the period in the Company Payroll workflow and recalculate.",
          repairCapability: null,
          repairability: "MANUAL_REVIEW",
          whyNotAutomatic: "The period is finalized: approved amounts are history and are never rewritten.",
        }),
      ]),
    );
    render(<PayrollHealthPanel companyId={companyId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/approved amounts are history/u)).toBeTruthy();
    expect(screen.getByText(/Reverse the period in the Company Payroll workflow/u)).toBeTruthy();
    for (const name of [/execute/iu, /delete/iu, /reset/iu, /recalculate/iu, /retry/iu]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("accounting failure points to Accounting Health; never executed from the Payroll route", async () => {
    vi.mocked(platformApi.payrollRepairPreview).mockResolvedValue(
      preview([
        finding({
          execution: { available: false, requiredPlatformPermission: "platform.companies.repair_center.execute" },
          executionRoute: "accounting_event",
          findingId: "fnd_acc",
          headline: "ISSUE — Payroll accounting failed.",
          reasonCode: "PAYROLL_ACCOUNTING_EVENT_FAILED",
          repairCapability: "REPROCESS_ACCOUNTING_EVENT",
        }),
      ]),
    );
    render(<PayrollHealthPanel companyId={companyId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/from Accounting Health/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Execute/u })).toBeNull();
  });

  it("stale preview: refused, the preview is refreshed, never retried automatically", async () => {
    vi.mocked(platformApi.executePayrollRepair).mockRejectedValue(
      new PlatformApiError("The preview is out of date. Refresh it and review again.", "repair_preview_stale", 409),
    );
    render(<PayrollHealthPanel companyId={companyId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const confirm = await screen.findByRole("region", { name: "Confirm repair" });
    fireEvent.change(within(confirm).getByRole("textbox"), { target: { value: "Allocations disagree" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Repair" }));
    expect(await screen.findByText(/The preview was refreshed/u)).toBeTruthy();
    expect(platformApi.executePayrollRepair).toHaveBeenCalledTimes(1);
    expect(platformApi.payrollRepairPreview).toHaveBeenCalledTimes(2);
  });

  it("unknown outcome: Retry reuses the same idempotency key", async () => {
    vi.mocked(platformApi.executePayrollRepair)
      .mockRejectedValueOnce(new PlatformApiError("Network error", "network_error", 0))
      .mockResolvedValueOnce({ ...result, replayed: true });
    render(<PayrollHealthPanel companyId={companyId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const confirm = await screen.findByRole("region", { name: "Confirm repair" });
    fireEvent.change(within(confirm).getByRole("textbox"), { target: { value: "Allocations disagree" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Repair" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry Repair" }));
    await screen.findByText(/Repaired:/u);
    const calls = vi.mocked(platformApi.executePayrollRepair).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![2].idempotencyKey).toBe(calls[0]![2].idempotencyKey);
  });

  // -------------------------------------------------------------------------
  // Phase 5 Prompt 2 -- finding detail and manual-review UX certification.
  // -------------------------------------------------------------------------
  const flaggedLine = {
    components: {
      activeDeductionAdjustments: "0.00",
      activeEarningAdjustments: "0.00",
      allowanceRecords: "0.00",
      allowances: "250.00",
      basicSalary: "1000.00",
      commissionRecords: "0.00",
      deductionAdjustments: "0.00",
      driverCommission: "0.00",
      earningAdjustments: "0.00",
    },
    current: { gross: "1250.00", net: "1250.00", outstanding: "1250.00", paid: "0.00" },
    employeeActive: false,
    employeeName: "Employee 1000",
    employeeNumber: "PE-0001",
    expected: { gross: "1250.00", net: "1250.00", outstanding: "1250.00", paid: "0.00", status: "approved" },
    flags: { allocation: false, amounts: false, components: true, payment: false },
    held: false,
    lineId: "line-1",
    payrollNumber: "PR-1",
    sourceMarker: "new_payroll",
    status: "calculated",
  };

  it("the list shows headlines only; the opened finding shows lines, current vs expected, components, payments and accounting", async () => {
    vi.mocked(platformApi.payrollRepairPreview).mockResolvedValue({
      ...preview([
        finding({
          execution: { available: false, requiredPlatformPermission: "platform.companies.repair_center.execute" },
          findingId: "fnd_components",
          headline: "ISSUE — Payroll calculation is inconsistent.",
          reasonCode: "PAYROLL_LINE_COMPONENTS_INCONSISTENT",
          repairCapability: null,
          repairability: "MANUAL_REVIEW",
          whyNotAutomatic: "Component snapshots are re-derived only by the Company's own Payroll Recalculate.",
        }),
      ]),
      accounting: {
        enabled: true,
        events: [{ classificationCode: null, eventId: "ev-1", eventType: "employee_payroll_approved", recovery: null, status: "posted" }],
      },
      lines: [flaggedLine],
      payments: [{ activeAllocated: "1000.00", paymentId: "pay-1", paymentNumber: "PP-0001", status: "confirmed", totalAmount: "1000.00" }],
    });
    render(<PayrollHealthPanel companyId={companyId} />);
    const list = await screen.findByRole("table", { name: "Payroll findings" });
    // No formula, amount or component in the list itself.
    expect(within(list).queryByText(/gross|net|allowance|1250/iu)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const lines = await screen.findByRole("table", { name: "Lines needing attention" });
    expect(within(lines).getByText(/PE-0001 · Employee 1000 \(inactive today\)/u)).toBeTruthy();
    expect(within(lines).getAllByText("1250.00 / 1250.00").length).toBeGreaterThan(0);
    expect(within(lines).getByText("components")).toBeTruthy();
    const components = screen.getByRole("table", { name: "Component differences" });
    expect(within(components).getByText("Allowances")).toBeTruthy();
    expect(within(components).getByText("250.00")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Payroll payments" })).getByText("PP-0001")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Payroll accounting events" })).getByText("employee_payroll_approved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Execute/u })).toBeNull();
  });

  const MANUAL: readonly (readonly [string, string, string])[] = [
    ["finalized amount mismatch", "PAYROLL_LINE_AMOUNTS_INCONSISTENT", "Approved, paid and closed Payroll is immutable financial history."],
    ["component ambiguity", "PAYROLL_LINE_COMPONENTS_INCONSISTENT", "Component snapshots are re-derived only by the Company's own Payroll Recalculate."],
    ["allocation inconsistency", "PAYROLL_PAYMENT_ALLOCATION_INCONSISTENT", "Allocations are the payment truth; payments are corrected only by the certified reversal."],
    ["closed period", "PAYROLL_PAYMENT_STATE_INCONSISTENT", "A closed period is never reopened automatically."],
    ["reversed-active anomaly", "PAYROLL_REVERSED_STILL_ACTIVE", "A reversed period must have every payment reversed first."],
    ["legacy insufficient history", "PAYROLL_LEGACY_HISTORY_REVIEW", "Legacy Payroll lines were not produced by the current calculation."],
    ["missing Payroll accounting event", "PAYROLL_ACCOUNTING_EVENT_MISSING", "No accounting event is fabricated for Company Payroll."],
  ];
  for (const [label, reasonCode, why] of MANUAL) {
    it(`manual review -- ${label}: explains why, recommends an investigation, offers no Execute`, async () => {
      vi.mocked(platformApi.payrollRepairPreview).mockResolvedValue(
        preview([
          finding({
            execution: { available: false, requiredPlatformPermission: "platform.companies.repair_center.execute" },
            executionRoute: null,
            findingId: `fnd_${reasonCode}`,
            reasonCode,
            recommendedAction: "manual_review",
            repairCapability: null,
            repairability: "MANUAL_REVIEW",
            whyNotAutomatic: why,
          }),
        ]),
      );
      render(<PayrollHealthPanel companyId={companyId} />);
      fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
      expect(await screen.findByText(why)).toBeTruthy();
      expect(screen.getByText("Why this is not automatic")).toBeTruthy();
      expect(screen.getByText("manual_review")).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Confirm repair" })).toBeNull();
      for (const name of [/execute/iu, /delete/iu, /reset/iu, /recalculate/iu, /reverse/iu]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }
    });
  }

  it("manual review -- driver-fee inconsistency: explanation, no preview, no Execute", async () => {
    vi.mocked(platformApi.payrollHealthFindings).mockResolvedValue(
      page([
        {
          codes: ["DRIVER_FEE_PAYMENT_STATE_INCONSISTENT"],
          entityId: "acc-1",
          entityType: "outsourced_driver_fee_accrual",
          headline: "ISSUE — Driver fee state is inconsistent.",
          health: "ISSUE",
          reference: "ACR-0001",
          status: null,
        },
      ]),
    );
    render(<PayrollHealthPanel companyId={companyId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findByText(/never re-priced or re-allocated automatically/u)).toBeTruthy();
    expect(platformApi.payrollRepairPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Execute/u })).toBeNull();
  });
});
