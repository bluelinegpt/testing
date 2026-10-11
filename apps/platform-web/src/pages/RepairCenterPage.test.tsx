import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type CompanyOrderHealthPage,
  type CompanyOrderHealthSummary,
  type OrderHealthRow,
  type OrderRepairFindings,
  type OrderVerification,
  type RepairExecutionResult,
  type RepairFinding,
  type RepairCenterOverview,
  type RepairHistoryDetail,
  type RepairHistoryPage,
  type RepairHistoryRow,
  type RepairPlanPreview,
  platformApi,
  PlatformApiError,
} from "../api/platform-client.js";
import { RepairCenterPage } from "./RepairCenterPage.js";

const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const orderId = "11111111-2222-4333-8444-555555555555";

function summary(overrides: Partial<CompanyOrderHealthSummary> = {}): CompanyOrderHealthSummary {
  return {
    accountingMode: { enabled: false },
    byReason: [
      {
        health: "ISSUE",
        orders: 1,
        reason: "A Trader receivable is required for this order but is missing.",
        reasonCode: "MISSING_RECEIVABLE",
      },
      {
        health: "HEALTHY",
        orders: 9,
        reason: "The Trader receivable was settled by an effective settlement offset.",
        reasonCode: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
      },
    ],
    company: {
      code: "ALF",
      environment: "production",
      id: companyId,
      nameEn: "Al Fahd Delivery",
      status: "active",
    },
    companyHealth: "ISSUE",
    generatedAt: "2026-10-02T10:00:00.000Z",
    healthyOrders: 9,
    issueOrders: 1,
    reviewOrders: 0,
    scope: {
      dateBasis: "order_date",
      dateFrom: "2026-09-03",
      dateTo: "2026-10-02",
      scope: "last30",
      timezone: "Asia/Dubai",
      today: "2026-10-02",
    },
    totalOrders: 10,
    ...overrides,
  };
}

const issueRow: OrderHealthRow = {
  additionalReasonCodes: [],
  classification: "MISSING_RECEIVABLE",
  deliveryStatus: "delivered",
  health: "ISSUE",
  orderDate: "2026-10-01",
  orderId,
  orderNumber: "ORD-000120",
  reason: "A Trader receivable is required for this order but is missing.",
  reasonCode: "MISSING_RECEIVABLE",
  recommendedAction: "repair_trader_receivable",
};

function page(items: readonly OrderHealthRow[], total = items.length, pageNumber = 1): CompanyOrderHealthPage {
  return {
    generatedAt: "2026-10-02T10:00:00.000Z",
    items,
    page: pageNumber,
    pageSize: 25,
    scope: summary().scope,
    total,
  };
}

const verification: OrderVerification = {
  classification: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
  health: "HEALTHY",
  historicalSettlementNumbers: ["SET-000008"],
  historicalSettlementOffsetAmount: "18.00",
  order: { orderNumber: "ORD-000120" },
  physicalCollectionAmount: "0.00",
  reason: "Receivable was settled by settlement offset without a physical Trader collection.",
  receivables: [
    { amount: "18.00", id: "r1", outstanding: "0.00", receivableNumber: "RCV-000060", status: "collected" },
  ],
  // Phase 3 Prompt 2: a healthy offset-only settlement is never reset.
  recommendedAction: "none",
  settlementNumbers: ["SET-000011"],
  settlementOffsetAmount: "18.00",
  settlementOffsets: [
    { amount: "18.00", effective: false, receivableNumber: "RCV-000060", receivableStatus: "collected", settlementNumber: "SET-000008" },
    { amount: "18.00", effective: true, receivableNumber: "RCV-000060", receivableStatus: "collected", settlementNumber: "SET-000011" },
  ],
  traderOwes: "18.00",
};

const readyFinding: RepairFinding = {
  blockers: [],
  companyId,
  detectedAt: "2026-10-02T10:00:00.000Z",
  detectedState: "No current Trader receivable; the Trader owes AED 18.00.",
  domain: "TRADER_RECEIVABLE",
  entityId: orderId,
  entityNumber: "ORD-000120",
  entityType: "order",
  evidence: { traderOwes: "18.00" },
  expectedState: "One current Trader receivable for the fee the Trader owes.",
  findingId: "fnd_0123456789abcdef01234567",
  health: "ISSUE",
  orderId,
  reasonCode: "MISSING_RECEIVABLE",
  recommendedAction: "repair_trader_receivable",
  repairCapability: "REPAIR_TRADER_RECEIVABLE",
  repairability: "READY",
  severity: "high",
  summary: "A Trader receivable is required for this order but is missing.",
  title: "Required Trader receivable missing",
  warnings: [{ code: "ACCOUNTING_OFF_NO_GL_EVENT", message: "GL Accounting is OFF: no accounting event." }],
};

function analysis(finding: RepairFinding = readyFinding): OrderRepairFindings {
  return {
    accountingMode: { enabled: false },
    companyId,
    deliveryStatus: "delivered",
    dependencies: { current: [], historical: [] },
    findings: [finding],
    generatedAt: "2026-10-02T10:00:00.000Z",
    health: finding.health,
    orderId,
    orderNumber: "ORD-000120",
    previewVersion: "rcv1:" + "a".repeat(64),
  };
}

const plan: RepairPlanPreview = {
  accountingMode: { enabled: false },
  blockers: [],
  companyId,
  currentState: { deliveryStatus: "delivered" },
  dependencies: {
    current: [],
    historical: [
      {
        amount: "18.00",
        entityId: "r0",
        entityNumber: "RCV-000059",
        entityType: "trader_receivable",
        relation: "reversed receivable of this order",
        status: "reversed",
      },
    ],
  },
  execution: {
    available: true,
    reason: "READY: the certified repair can be executed; the server re-checks everything first.",
    requiredPlatformPermission: "platform.companies.repair_center.execute",
  },
  finding: readyFinding,
  generatedAt: "2026-10-02T10:00:00.000Z",
  idempotencyKeyBasis: `repair:REPAIR_TRADER_RECEIVABLE:${companyId}:${orderId}:rcv1:${"a".repeat(64)}`,
  orderId,
  orderNumber: "ORD-000120",
  otherFindings: [],
  preservedHistory: [
    { description: "Stays reversed, as history.", entityNumber: "RCV-000059", entityType: "trader_receivable" },
  ],
  previewVersion: "rcv1:" + "a".repeat(64),
  proposedChanges: [
    {
      action: "create",
      description: "One new current Trader receivable for AED 18.00 (status outstanding)",
      details: { amountDue: "18.00" },
      entityNumber: null,
      entityType: "trader_receivable",
    },
    { action: "none", description: "Delivery status unchanged", details: {}, entityNumber: "ORD-000120", entityType: "order" },
  ],
  proposedRepair: {
    candidateOnly: false,
    capabilityCode: "REPAIR_TRADER_RECEIVABLE",
    executionHandler: "OperationsService.repairTraderReceivableInTransaction",
    explanation: "Creates the missing Trader receivable with the certified repair.",
    title: "Repair Trader receivable",
  },
  repairability: "READY",
  requiredInputs: [],
  requiredPermission: "users_roles.manage",
  warnings: [
    { code: "ORDER_STATUS_UNCHANGED", message: "The Order's status does not change." },
    { code: "ACCOUNTING_OFF_NO_GL_EVENT", message: "GL Accounting is OFF: no accounting event." },
  ],
};

const executionResult: RepairExecutionResult = {
  afterClassification: "HEALTHY_ACTIVE_RECEIVABLE",
  afterHealth: "HEALTHY",
  afterPreviewVersion: "rcv1:" + "b".repeat(64),
  auditId: "99999999-2222-4333-8444-555555555555",
  beforeClassification: "MISSING_RECEIVABLE",
  beforeHealth: "ISSUE",
  beforePreviewVersion: "rcv1:" + "a".repeat(64),
  capabilityCode: "REPAIR_TRADER_RECEIVABLE",
  companyId,
  executedAt: "2026-10-02T10:05:00.000Z",
  findingId: readyFinding.findingId,
  nextRecommendedAction: "none",
  orderId,
  orderNumber: "ORD-000120",
  reasonCode: "MISSING_RECEIVABLE",
  repairExecutionId: "99999999-2222-4333-8444-555555555555",
  replayed: false,
  status: "succeeded",
};

const healthyFinding: RepairFinding = {
  ...readyFinding,
  blockers: [],
  findingId: "fnd_fedcba9876543210fedcba98",
  health: "HEALTHY",
  reasonCode: "HEALTHY_ACTIVE_RECEIVABLE",
  recommendedAction: "none",
  repairCapability: null,
  repairability: "NOT_REQUIRED",
  title: "Trader receivable open",
  warnings: [],
};

const overviewFixture: RepairCenterOverview = {
  accountingHealth: {
    accountingHealth: "ISSUE",
    blocked: 1,
    blockedConfiguration: 0,
    failed: 4,
    historicalWhileOff: 0,
    manualReview: 1,
    note: "GL Accounting is ON.",
    pending: 2,
    processing: 0,
    readyCandidateNote:
      "Ready candidates pass every stored-state check. READY is decided only by Preview Recovery, which runs the full certified accounting precheck.",
    readyCandidates: 3,
    stuck: 0,
  },
  accountingMode: { automaticPostingEnabled: true, enabled: true },
  company: { code: "ALF", nameEn: "Al Fahd Delivery", status: "active" },
  companyId,
  generatedAt: "2026-10-02T10:00:00.000Z",
  orderHealth: {
    companyHealth: "ISSUE",
    healthy: 9,
    issue: 1,
    review: 0,
    scope: { dateFrom: "2026-09-02", dateTo: "2026-10-02", scope: "last30" },
    totalOrders: 10,
  },
  repairHistory: { failed: 1, lastRepairAt: "2026-10-02T09:00:00.000Z", refused: 2, replayed: 1, succeeded: 5 },
};

const historyRow: RepairHistoryRow = {
  actor: "platform.admin",
  capabilityCode: "REPAIR_TRADER_RECEIVABLE",
  correlationId: "corr-1",
  entityId: orderId,
  entityNumber: "ORD-000120",
  entityType: "order",
  errorCode: "repair_preview_stale",
  findingId: "fnd_0123456789abcdef01234567",
  id: "77777777-2222-4333-8444-555555555555",
  kind: "attempt",
  occurredAt: "2026-10-02T09:30:00.000Z",
  outcome: "The order changed after the repair preview.",
  reason: "Legacy order never got its receivable",
  reasonCode: "MISSING_RECEIVABLE",
  repairApplied: false,
  repairExecutionId: null,
  result: "REFUSED",
};

function historyPage(items: readonly RepairHistoryRow[] = []): RepairHistoryPage {
  return { generatedAt: "2026-10-02T10:00:00.000Z", items, page: 1, pageSize: 25, total: items.length };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/companies/${companyId}/repair-center`]}>
      <Routes>
        <Route element={<RepairCenterPage />} path="/companies/:companyId/repair-center" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Repair Center -- Company Order Health (read-only)", () => {
  let summarySpy: ReturnType<typeof vi.spyOn>;
  let listSpy: ReturnType<typeof vi.spyOn>;
  let verifySpy: ReturnType<typeof vi.spyOn>;
  let findingsSpy: ReturnType<typeof vi.spyOn>;
  let previewSpy: ReturnType<typeof vi.spyOn>;
  let executeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    summarySpy = vi.spyOn(platformApi, "orderHealthSummary").mockResolvedValue(summary());
    listSpy = vi.spyOn(platformApi, "orderHealthList").mockResolvedValue(page([issueRow]));
    verifySpy = vi.spyOn(platformApi, "verifyOrder").mockResolvedValue(verification);
    findingsSpy = vi.spyOn(platformApi, "orderFindings").mockResolvedValue(analysis());
    previewSpy = vi.spyOn(platformApi, "repairPreview").mockResolvedValue(plan);
    executeSpy = vi.spyOn(platformApi, "executeRepair").mockResolvedValue(executionResult);
    // Accounting Health (Prompt 4) renders below Order Health; empty here --
    // it has its own suite (AccountingHealthPanel.test.tsx).
    vi.spyOn(platformApi, "accountingHealthSummary").mockResolvedValue({
      accountingHealth: "NOT_APPLICABLE",
      accountingMode: { automaticPostingEnabled: false, enabled: false },
      blocked: 0,
      blockedConfiguration: 0,
      byEventType: [],
      companyId,
      failed: 0,
      generatedAt: "2026-10-02T10:00:00.000Z",
      historicalWhileOff: 0,
      manualReview: 0,
      note: "GL Accounting is OFF: GL recovery is not required for new operational activity.",
      pending: 0,
      processing: 0,
      readyCandidates: 0,
      stuck: 0,
      totalEvents: 0,
    });
    // Landing + Repair History (Prompt 5).
    vi.spyOn(platformApi, "repairCenterOverview").mockResolvedValue(overviewFixture);
    vi.spyOn(platformApi, "repairHistory").mockResolvedValue(historyPage());
    vi.spyOn(platformApi, "accountingHealthEvents").mockResolvedValue({
      generatedAt: "2026-10-02T10:00:00.000Z",
      items: [],
      page: 1,
      pageSize: 25,
      total: 0,
    });
    // Payroll Health (Phase 5 Prompt 1): mounted on the page, healthy here.
    vi.spyOn(platformApi, "payrollHealthSummary").mockResolvedValue({
      accountingMode: { enabled: false },
      byCode: {},
      companyId,
      driverFeeFindings: 0,
      generatedAt: "2026-10-02T10:00:00.000Z",
      headlines: [],
      payrollHealth: "HEALTHY",
      periodsWithFindings: 0,
      totalPeriods: 0,
    });
    vi.spyOn(platformApi, "payrollHealthFindings").mockResolvedValue({
      generatedAt: "2026-10-02T10:00:00.000Z",
      items: [],
      page: 1,
      pageSize: 25,
      total: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the Company, Accounting mode, Company Health, summary and last refresh", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: /Al Fahd Delivery — Order Health/u })).toBeInTheDocument();
    expect(screen.getByTestId("accounting-mode")).toHaveTextContent("OFF");
    expect(screen.getByTestId("total-orders")).toHaveTextContent("10");
    expect(screen.getByTestId("healthy-orders")).toHaveTextContent("9");
    expect(screen.getByTestId("issue-orders")).toHaveTextContent("1");
    expect(screen.getByTestId("review-orders")).toHaveTextContent("0");
    expect(screen.getByText(/Last refreshed/u)).toBeInTheDocument();
    expect(screen.getByText(/Read-only/u)).toBeInTheDocument();
  });

  it("asks for ISSUE + REVIEW, Last 30 days, page 1 by default -- with the explicit Company id", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Orders" });
    expect(summarySpy).toHaveBeenCalledWith(companyId, { scope: "last30" });
    expect(listSpy).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ health: "attention", page: 1, pageSize: 25, scope: "last30" }),
    );
  });

  it("renders simple rows: no settlement, receivable, journal numbers or UUIDs", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Orders" });
    const text = table.textContent ?? "";
    expect(text).toContain("ORD-000120");
    expect(text).toContain("A Trader receivable is required for this order but is missing.");
    expect(within(table).getByText("Issue")).toBeInTheDocument();
    expect(text).not.toMatch(/SET-|RCV-|JRN-/u);
    expect(text).not.toContain(orderId);
  });

  it("offers no mutating action -- only check, filter, page and view controls", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Orders" });
    const labels = screen.getAllByRole("button").map((button) => button.textContent?.trim());
    expect([...new Set(labels)].sort()).toEqual(
      // "Apply filters" belongs to the read-only Accounting Health panel (Prompt 4).
      ["Apply", "Apply filters", "Next", "Previous", "Run Health Check", "View Details"].sort(),
    );
    for (const word of [/repair/iu, /reset/iu, /reverse/iu, /delete/iu, /reprocess/iu, /fix/iu]) {
      expect(screen.queryByRole("button", { name: word })).toBeNull();
    }
  });

  it("View Details re-uses Verify First and shows effective vs historical offsets", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View Details" }));
    await waitFor(() => expect(verifySpy).toHaveBeenCalledWith(companyId, orderId));
    const details = await screen.findByRole("region", { name: "Order details (Verify First)" });
    expect(await within(details).findByText("Trader owes")).toBeInTheDocument();
    const offsets = within(details).getByRole("table", { name: "Settlement offsets" });
    expect(within(offsets).getByText("Historical — Settlement Reversed")).toBeInTheDocument();
    expect(within(offsets).getByText("Effective")).toBeInTheDocument();
  });

  it("empty state when the Company has no problematic orders", async () => {
    summarySpy.mockResolvedValue(
      summary({ byReason: [], companyHealth: "HEALTHY", issueOrders: 0, healthyOrders: 10 }),
    );
    listSpy.mockResolvedValue(page([]));
    renderPage();
    expect(await screen.findByText("No problematic orders in this period.")).toBeInTheDocument();
  });

  it("applies filters server-side and requires both dates for a custom range", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Orders" });
    fireEvent.change(screen.getByLabelText("Health"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "last7" } });
    fireEvent.change(screen.getByLabelText("Order number"), { target: { value: " ORD-0001 " } });
    fireEvent.change(screen.getByLabelText("Delivery status"), { target: { value: "delivered" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "MISSING_RECEIVABLE" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(listSpy).toHaveBeenLastCalledWith(companyId, {
        deliveryStatus: "delivered",
        health: "all",
        page: 1,
        pageSize: 25,
        reasonCode: "MISSING_RECEIVABLE",
        scope: "last7",
        search: "ORD-0001",
      }),
    );
    expect(summarySpy).toHaveBeenLastCalledWith(companyId, { scope: "last7" });

    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "custom" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/start and an end date/u);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(summarySpy).toHaveBeenLastCalledWith(companyId, {
        dateFrom: "2026-09-01",
        dateTo: "2026-09-15",
        scope: "custom",
      }),
    );
  });

  it("paginates through the server", async () => {
    listSpy.mockResolvedValue(page([issueRow], 60));
    renderPage();
    await screen.findByText(/Page 1 of 3/u);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(listSpy).toHaveBeenLastCalledWith(companyId, expect.objectContaining({ page: 2 })),
    );
  });

  it("Run Health Check re-reads live data (nothing cached or stored)", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Orders" });
    const before = summarySpy.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Run Health Check" }));
    await waitFor(() => expect(summarySpy.mock.calls.length).toBe(before + 1));
  });

  it("shows the server's message when the check cannot run", async () => {
    summarySpy.mockRejectedValue(
      new PlatformApiError("You do not have permission to do that.", "forbidden", 403),
    );
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have permission");
  });

  it("View Details shows Finding Details: finding, current and expected state, action, repairability", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View Details" }));
    await waitFor(() => expect(findingsSpy).toHaveBeenCalledWith(companyId, orderId));
    const panel = await screen.findByRole("region", { name: "Finding details" });
    expect(await within(panel).findByText("Required Trader receivable missing")).toBeInTheDocument();
    expect(within(panel).getByText(readyFinding.detectedState)).toBeInTheDocument();
    expect(within(panel).getByText(readyFinding.expectedState)).toBeInTheDocument();
    expect(within(panel).getByText("repair_trader_receivable")).toBeInTheDocument();
    expect(within(panel).getByTestId("repairability")).toHaveTextContent("Ready");
    expect(within(panel).getByText("ACCOUNTING_OFF_NO_GL_EVENT")).toBeInTheDocument();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it("READY: Preview Repair shows what would change, what remains, dependencies, inputs and permission", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview Repair" }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledWith(companyId, orderId, "MISSING_RECEIVABLE"));
    const preview = await screen.findByRole("region", { name: "Repair plan preview" });
    const changes = within(preview).getByRole("list", { name: "Proposed changes" });
    expect(changes).toHaveTextContent("One new current Trader receivable for AED 18.00");
    expect(within(preview).getByRole("list", { name: "Preserved history" })).toHaveTextContent("RCV-000059");
    expect(within(preview).getByRole("table", { name: "Historical dependencies" })).toHaveTextContent(
      "reversed receivable of this order",
    );
    expect(within(preview).getByText("Current dependencies: none.")).toBeInTheDocument();
    expect(within(preview).getByRole("list", { name: "Preview warnings" })).toHaveTextContent(
      "ORDER_STATUS_UNCHANGED",
    );
    expect(within(preview).getByTestId("required-inputs")).toHaveTextContent("None");
    expect(within(preview).getByTestId("required-permission")).toHaveTextContent("users_roles.manage");
    expect(within(preview).getByText(/Preview only/u)).toBeInTheDocument();
    // The only new control is the guarded Execute Repair (disabled until a
    // reason is given); never reset / reverse / reprocess / force / bulk.
    const labels = screen.getAllByRole("button").map((button) => button.textContent?.trim());
    expect([...new Set(labels)].sort()).toEqual(
      ["Apply", "Apply filters", "Close", "Execute Repair", "Next", "Preview Repair", "Previous", "Run Health Check", "View Details"].sort(),
    );
    expect(screen.getByRole("button", { name: "Execute Repair" })).toBeDisabled();
    for (const word of [/confirm/iu, /reset/iu, /reverse/iu, /reprocess/iu, /force/iu, /repair all/iu, /^repair$/iu]) {
      expect(screen.queryByRole("button", { name: word })).toBeNull();
    }
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("BLOCKED, MANUAL_REVIEW and NOT_REQUIRED offer no Preview Repair button", async () => {
    for (const finding of [
      {
        ...readyFinding,
        blockers: [{ code: "REPAIR_AMOUNT_DIFFERS_FROM_FINANCIAL_MODEL", message: "Amounts differ." }],
        repairability: "BLOCKED" as const,
      },
      {
        ...readyFinding,
        reasonCode: "MULTIPLE_EFFECTIVE_SETTLEMENTS",
        repairCapability: null,
        repairability: "MANUAL_REVIEW" as const,
        warnings: [{ code: "NO_CERTIFIED_REPAIR", message: "No certified repair exists." }],
      },
      { ...readyFinding, health: "HEALTHY" as const, repairCapability: null, repairability: "NOT_REQUIRED" as const },
    ]) {
      findingsSpy.mockResolvedValue(analysis(finding));
      const view = renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "View Details" }));
      const panel = await screen.findByRole("region", { name: "Finding details" });
      await within(panel).findByTestId("repairability");
      expect(within(panel).queryByRole("button", { name: "Preview Repair" })).toBeNull();
      for (const issue of [...finding.blockers, ...finding.warnings]) {
        expect(within(panel).getByText(issue.code)).toBeInTheDocument();
      }
      view.unmount();
    }
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it("a stale finding is reported, not previewed", async () => {
    previewSpy.mockRejectedValue(
      new PlatformApiError("That finding no longer applies to this order.", "repair_finding_not_current", 409),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview Repair" }));
    expect(await screen.findByText("That finding no longer applies to this order.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Repair plan preview" })).toBeNull();
  });

  async function openConfirm() {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview Repair" }));
    return screen.findByRole("region", { name: "Confirm repair" });
  }

  it("READY: Execute Repair restates what is repaired and needs a reason before it can run", async () => {
    const confirm = await openConfirm();
    expect(confirm).toHaveTextContent("ORD-000120");
    expect(confirm).toHaveTextContent("Required Trader receivable missing (MISSING_RECEIVABLE)");
    expect(confirm).toHaveTextContent("Repair Trader receivable");
    expect(within(confirm).getByRole("list", { name: "Confirm changes" })).toHaveTextContent(
      "One new current Trader receivable for AED 18.00",
    );
    expect(within(confirm).getByRole("list", { name: "Confirm unchanged" })).toHaveTextContent(
      "Delivery status unchanged",
    );
    expect(within(confirm).getByRole("list", { name: "Confirm unchanged" })).toHaveTextContent("RCV-000059");
    expect(confirm).toHaveTextContent("ORDER_STATUS_UNCHANGED");
    const button = within(confirm).getByRole("button", { name: "Execute Repair" });
    expect(button).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText(/Reason for this repair/u), {
      target: { value: "Legacy order never got its receivable" },
    });
    expect(button).toBeEnabled();
  });

  it("executes once, shows progress, then Repair completed, refreshes Health and verifies again", async () => {
    let finish: (value: RepairExecutionResult) => void = () => undefined;
    executeSpy.mockImplementation(() => new Promise<RepairExecutionResult>((resolve) => (finish = resolve)));
    const confirm = await openConfirm();
    fireEvent.change(within(confirm).getByLabelText(/Reason for this repair/u), {
      target: { value: "Legacy order never got its receivable" },
    });
    const summaryCalls = summarySpy.mock.calls.length;
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Repair" }));
    // Double click while running: still one request.
    const running = await within(confirm).findByRole("button", { name: "Executing repair…" });
    expect(running).toBeDisabled();
    fireEvent.click(running);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(companyId, orderId, {
      capabilityCode: "REPAIR_TRADER_RECEIVABLE",
      findingId: readyFinding.findingId,
      idempotencyKey: expect.stringMatching(/^rc-ui-[0-9a-f-]{36}$/u),
      previewVersion: plan.previewVersion,
      reason: "Legacy order never got its receivable",
    });
    findingsSpy.mockResolvedValue({
      ...analysis(healthyFinding),
      generatedAt: "2026-10-02T10:06:00.000Z",
      health: "HEALTHY",
    });
    finish(executionResult);
    const result = await screen.findByRole("status", { name: "Repair result" });
    expect(result).toHaveTextContent("Repair completed");
    expect(result).toHaveTextContent("MISSING_RECEIVABLE");
    expect(result).toHaveTextContent("HEALTHY_ACTIVE_RECEIVABLE");
    await waitFor(() => expect(summarySpy.mock.calls.length).toBeGreaterThan(summaryCalls));
    await waitFor(() => expect(within(result).getByTestId("verified-health")).toHaveTextContent("Healthy"));
    // Phase 3: the repaired finding is shown RESOLVED after the automatic re-verification.
    await waitFor(() => expect(within(result).getByTestId("finding-resolved")).toHaveTextContent("Resolved"));
    expect(findingsSpy).toHaveBeenCalledTimes(2);
    expect(verifySpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Execute Repair" })).toBeNull();
  });

  it("an unknown outcome (timeout) offers Retry with the SAME idempotency key", async () => {
    executeSpy
      .mockRejectedValueOnce(new PlatformApiError("The request timed out.", "request_timeout", 0))
      .mockResolvedValueOnce({ ...executionResult, replayed: true });
    const confirm = await openConfirm();
    fireEvent.change(within(confirm).getByLabelText(/Reason for this repair/u), {
      target: { value: "Legacy order never got its receivable" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Repair" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent(/may or may not have completed/u);
    fireEvent.click(within(confirm).getByRole("button", { name: "Retry Repair" }));
    await screen.findByRole("status", { name: "Repair result" });
    const keys = executeSpy.mock.calls.map((call: unknown[]) => (call[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("a stale preview is not retried: warning, re-diagnosis, fresh preview, and a new key next time", async () => {
    executeSpy.mockRejectedValueOnce(
      new PlatformApiError(
        "The order changed after the repair preview. Refresh and review the new state before repairing.",
        "repair_preview_stale",
        409,
      ),
    );
    const confirm = await openConfirm();
    fireEvent.change(within(confirm).getByLabelText(/Reason for this repair/u), {
      target: { value: "Legacy order never got its receivable" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Repair" }));
    expect(await screen.findByTestId("stale-warning")).toHaveTextContent(/order changed after the repair preview/u);
    await waitFor(() => expect(findingsSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(2));
    expect(executeSpy).toHaveBeenCalledTimes(1);
    // The user must review again: a fresh confirmation with an empty reason.
    const fresh = await screen.findByRole("region", { name: "Confirm repair" });
    expect(within(fresh).getByLabelText(/Reason for this repair/u)).toHaveValue("");
    fireEvent.change(within(fresh).getByLabelText(/Reason for this repair/u), {
      target: { value: "Reviewed the new state" },
    });
    fireEvent.click(within(fresh).getByRole("button", { name: "Execute Repair" }));
    await waitFor(() => expect(executeSpy).toHaveBeenCalledTimes(2));
    const keys = executeSpy.mock.calls.map((call: unknown[]) => (call[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("a preview that is not executable never shows Execute Repair; MANUAL_REVIEW says so", async () => {
    previewSpy.mockResolvedValue({
      ...plan,
      execution: { ...plan.execution, available: false, reason: "Only a READY finding can be executed." },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview Repair" }));
    await screen.findByRole("region", { name: "Repair plan preview" });
    expect(screen.queryByRole("button", { name: "Execute Repair" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Confirm repair" })).toBeNull();
  });

  it("MANUAL_REVIEW shows 'Manual review required' and no repair controls", async () => {
    findingsSpy.mockResolvedValue(
      analysis({ ...readyFinding, reasonCode: "MULTIPLE_EFFECTIVE_SETTLEMENTS", repairCapability: null, repairability: "MANUAL_REVIEW" }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View Details" }));
    expect(await screen.findByText(/Manual review required/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Preview Repair|Execute Repair/u })).toBeNull();
  });

  it("Phase 3 Prompt 3: a MANUAL_REVIEW finding explains reason, affected records, the financial comparison and why no automatic repair exists -- with no repair or destructive control", async () => {
    findingsSpy.mockResolvedValue(
      analysis({
        ...readyFinding,
        manualReview: {
          affectedRecords: {
            collections: [],
            credits: [],
            settlements: [
              { effective: true, offsetAmount: "25.00", receivableNumber: "RCV-000060", reversedBySettlementNumber: null, sameTraderAsReceivable: true, settlementNumber: "SET-000011", settlementStatus: "confirmed" },
              { effective: true, offsetAmount: "25.00", receivableNumber: "RCV-000060", reversedBySettlementNumber: null, sameTraderAsReceivable: true, settlementNumber: "SET-000012", settlementStatus: "confirmed" },
            ],
          },
          financialComparison: {
            currentReceivables: 1,
            effectivePhysicalCollections: "0.00",
            effectiveSettlementOffsets: "50.00",
            historicalReceivables: 0,
            receivables: [
              { amountDue: "25.00", current: true, effectivePhysicalCollections: "0.00", effectiveSettled: "50.00", effectiveSettlementOffsets: "50.00", receivableNumber: "RCV-000060", recordedCollected: "25.00", status: "collected", unexplainedDifference: "-25.00" },
            ],
            traderOwes: "25.00",
          },
          headline: "Manual review required",
          reason: "The Trader receivable is offset by more than one effective settlement.",
          whyAutomaticRepairIsUnavailable: ["Nothing in the records proves one is an accidental duplicate rather than a real second payment."],
        },
        reasonCode: "MULTIPLE_EFFECTIVE_SETTLEMENTS",
        repairCapability: null,
        repairability: "MANUAL_REVIEW",
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View Details" }));
    const panel = await screen.findByTestId("manual-review");
    expect(panel).toHaveTextContent("Manual review required");
    expect(panel).toHaveTextContent("offset by more than one effective settlement");
    expect(screen.getByTestId("manual-review-why")).toHaveTextContent("accidental duplicate");
    expect(screen.getByTestId("manual-review-receivables")).toHaveTextContent("RCV-000060");
    expect(screen.getByTestId("manual-review-receivables")).toHaveTextContent("50.00");
    expect(screen.getByTestId("manual-review-records")).toHaveTextContent("SET-000011");
    expect(screen.getByTestId("manual-review-records")).toHaveTextContent("SET-000012");
    expect(screen.queryByRole("button", { name: /Preview Repair|Execute Repair|Delete|Reverse|Reset/u })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Prompt 5: landing, READY-candidate wording, Repair History, record link.
  // -------------------------------------------------------------------------
  it("landing shows Order, Accounting and Repair History counts and Accounting Mode -- never 'READY' for counts", async () => {
    renderPage();
    const overview = await screen.findByRole("region", { name: "Company health overview" });
    expect(within(overview).getByTestId("ov-accounting-mode")).toHaveTextContent("ON");
    expect(within(overview).getByTestId("ov-orders-healthy")).toHaveTextContent("9");
    expect(within(overview).getByTestId("ov-orders-issue")).toHaveTextContent("1");
    expect(within(overview).getByTestId("ov-acc-failed")).toHaveTextContent("4");
    expect(within(overview).getByTestId("ov-acc-ready")).toHaveTextContent("3");
    expect(within(overview).getByTestId("ov-acc-blocked")).toHaveTextContent("1");
    expect(within(overview).getByTestId("ov-acc-manual")).toHaveTextContent("1");
    expect(within(overview).getByTestId("ov-acc-pending")).toHaveTextContent("2 / 0");
    expect(within(overview).getByTestId("ov-history-succeeded")).toHaveTextContent("5");
    expect(within(overview).getByTestId("ov-history-failed")).toHaveTextContent("1");
    expect(within(overview).getByTestId("ov-history-refused")).toHaveTextContent("2");
    expect(within(overview).getByText("Ready candidates (preview required)")).toBeInTheDocument();
    const labels = Array.from(overview.querySelectorAll(".platform-summary-card__label")).map((node) => node.textContent);
    expect(labels).not.toContain("Ready");
    expect(labels).not.toContain("READY");
    expect(within(overview).getByTestId("ov-ready-note")).toHaveTextContent(/READY is decided only by Preview/u);
    expect(within(overview).queryAllByRole("button")).toHaveLength(0);
  });

  it("Repair History lists the chronology; a refused attempt's details say no repair was applied", async () => {
    vi.mocked(platformApi.repairHistory).mockResolvedValue(historyPage([historyRow]));
    const record = vi.spyOn(platformApi, "repairHistoryRecord").mockResolvedValue({
      ...historyRow,
      actorAuthority: "platform:super_admin",
      companyId,
      execution: null,
      previewVersion: "rcv1:" + "a".repeat(64),
      repairAppliedStatement: "No repair was applied. Business and financial data were not changed by this attempt.",
    } satisfies RepairHistoryDetail);
    renderPage();
    const table = await screen.findByRole("table", { name: "Repair history" });
    const headers = within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual([
      "Date / Time",
      "Entity",
      "Finding",
      "Capability",
      "Actor",
      "Result",
      "Reason",
      "Error / Outcome",
      "Correlation ID",
      "Action",
    ]);
    expect(table).toHaveTextContent("ORD-000120");
    expect(table).toHaveTextContent("Refused");
    expect(table).toHaveTextContent("repair_preview_stale");
    expect(table).toHaveTextContent("platform.admin");
    expect(platformApi.repairHistory).toHaveBeenCalledWith(companyId, { page: 1, pageSize: 25 });
    fireEvent.click(within(table).getByRole("button", { name: "View Details" }));
    const details = await screen.findByRole("region", { name: "Repair record" });
    expect(await within(details).findByTestId("repair-applied-statement")).toHaveTextContent("No repair was applied");
    expect(record).toHaveBeenCalledWith(companyId, "attempt", historyRow.id);
    expect(details).toHaveTextContent(companyId);
    expect(details).toHaveTextContent("corr-1");
  });

  it("Repair History filters by result on the server", async () => {
    renderPage();
    await screen.findByTestId("repair-history-empty");
    fireEvent.change(screen.getByLabelText("Repair history result"), { target: { value: "FAILED" } });
    await waitFor(() =>
      expect(platformApi.repairHistory).toHaveBeenLastCalledWith(companyId, { page: 1, pageSize: 25, result: "FAILED" }),
    );
  });

  it("after a successful repair, View Repair Record opens the authoritative execution record", async () => {
    const record = vi.spyOn(platformApi, "repairHistoryRecord").mockResolvedValue({
      ...historyRow,
      actorAuthority: "platform:super_admin",
      companyId,
      errorCode: null,
      execution: {
        afterClassification: "HEALTHY_ACTIVE_RECEIVABLE",
        afterFingerprint: "rcv1:" + "b".repeat(64),
        afterHealth: "HEALTHY",
        beforeClassification: "MISSING_RECEIVABLE",
        beforeFingerprint: "rcv1:" + "a".repeat(64),
        beforeHealth: "ISSUE",
        outcome: { receivableNumber: "RCV-000001" },
        replays: 0,
      },
      id: executionResult.repairExecutionId,
      kind: "execution",
      outcome: "MISSING_RECEIVABLE -> HEALTHY_ACTIVE_RECEIVABLE",
      previewVersion: "rcv1:" + "a".repeat(64),
      repairAppliedStatement: "This repair was applied, atomically, with this audit record.",
      repairApplied: true,
      repairExecutionId: executionResult.repairExecutionId,
      result: "SUCCEEDED",
    } satisfies RepairHistoryDetail);
    const confirm = await openConfirm();
    fireEvent.change(within(confirm).getByLabelText(/Reason for this repair/u), {
      target: { value: "Legacy order never got its receivable" },
    });
    const historyCalls = vi.mocked(platformApi.repairHistory).mock.calls.length;
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Repair" }));
    const result = await screen.findByRole("status", { name: "Repair result" });
    await waitFor(() => expect(vi.mocked(platformApi.repairHistory).mock.calls.length).toBeGreaterThan(historyCalls));
    fireEvent.click(within(result).getByRole("button", { name: "View Repair Record" }));
    const details = await screen.findByRole("region", { name: "Repair record" });
    expect(record).toHaveBeenCalledWith(companyId, "execution", executionResult.repairExecutionId);
    expect(await within(details).findByTestId("repair-applied-statement")).toHaveTextContent("This repair was applied");
    expect(details).toHaveTextContent("rcv1:" + "a".repeat(64));
    expect(details).toHaveTextContent("rcv1:" + "b".repeat(64));
  });

  it("a refused or failed repair says plainly that no repair was applied", async () => {
    executeSpy.mockRejectedValueOnce(
      new PlatformApiError("The repair did not verify; everything was rolled back", "repair_verification_failed", 409),
    );
    const confirm = await openConfirm();
    fireEvent.change(within(confirm).getByLabelText(/Reason for this repair/u), {
      target: { value: "Legacy order never got its receivable" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Repair" }));
    const alert = await within(confirm).findByRole("alert");
    expect(alert).toHaveTextContent(/Repair not applied — no data was changed/u);
    expect(alert).toHaveTextContent(/rolled back/u);
    expect(screen.queryByRole("status", { name: "Repair result" })).toBeNull();
  });
});
