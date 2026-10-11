import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AccountingEventDetails,
  type AccountingHealthPage,
  type AccountingHealthRow,
  type AccountingHealthSummary,
  type AccountingIntegrityRow,
  type AccountingRecoveryPreview,
  type AccountingRecoveryResult,
  platformApi,
  PlatformApiError,
} from "../api/platform-client.js";
import { AccountingHealthPanel } from "./AccountingHealthPanel.js";

const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const eventId = "33333333-2222-4333-8444-555555555555";

function summary(overrides: Partial<AccountingHealthSummary> = {}): AccountingHealthSummary {
  return {
    accountingHealth: "ISSUE",
    accountingMode: { automaticPostingEnabled: true, enabled: true },
    blocked: 1,
    blockedConfiguration: 0,
    byEventType: [{ eventType: "trader_receivable_recognized", unresolved: 4 }],
    companyId,
    failed: 4,
    generatedAt: "2026-10-02T10:00:00.000Z",
    historicalWhileOff: 0,
    manualReview: 1,
    note: "GL Accounting is ON: unresolved events keep the General Ledger incomplete until recovered.",
    pending: 0,
    processing: 0,
    readyCandidates: 2,
    stuck: 0,
    totalEvents: 40,
    ...overrides,
  };
}

const row: AccountingHealthRow = {
  accountingDate: "2026-10-01",
  attempts: 1,
  businessReference: "RCV-000101",
  eventId,
  eventType: "trader_receivable_recognized",
  failedAt: "2026-10-01T10:00:00.000Z",
  failureCode: "accounting_event_mapping_missing",
  finding: "Passes every stored-state check; preview runs the full certified precheck.",
  lastFailure: "A mapping was missing",
  sourceType: "trader_receivable",
  status: "failed",
  triage: "READY_CANDIDATE",
  triageCode: "PRECHECK_REQUIRED",
};

function page(items: readonly AccountingHealthRow[] = [row]): AccountingHealthPage {
  return { generatedAt: "2026-10-02T10:00:00.000Z", items, page: 1, pageSize: 25, total: items.length };
}

const finding = {
  blockers: [],
  classificationCode: "ACCOUNTING_PRECHECK_PASSED",
  current: true,
  detectedState: "Accounting event trader_receivable_recognized is failed (accounting_event_mapping_missing) after 1 attempt(s).",
  domain: "ACCOUNTING" as const,
  entityNumber: "RCV-000101",
  eventId,
  expectedState: "The event posted once through the certified pipeline, owning one balanced Journal.",
  findingId: "fnd_aaaaaaaaaaaaaaaaaaaaaaaa",
  health: "ISSUE" as const,
  recommendedAction: "reprocess_accounting_event",
  repairCapability: "REPROCESS_ACCOUNTING_EVENT",
  repairability: "READY" as const,
  summary: "A mapping was missing",
  title: "Unresolved accounting event",
  warnings: [],
};

const details: AccountingEventDetails = {
  accountingMode: { automaticPostingEnabled: true, enabled: true },
  companyId,
  diagnostics: {
    actorPresent: true,
    areaEnabled: true,
    fiscalPeriod: { status: "open", yearStatus: "open" },
    otherPostedEventsForSource: 0,
    postedJournalsForSource: 0,
    precheck: {
      accountingDate: "2026-10-01",
      expectedCreditTotal: "18.00",
      expectedDebitTotal: "18.00",
      fiscalPeriodStatus: "open",
      resolvedMappings: [
        { accountCode: "1200", accountName: "AR", amount: "18.00", entryIntent: "debit" },
        { accountCode: "4020", accountName: "Fees", amount: "18.00", entryIntent: "credit" },
      ],
    },
  },
  event: {
    accountingDate: "2026-10-01",
    attempts: 1,
    businessReference: "RCV-000101",
    eventType: "trader_receivable_recognized",
    failedAt: "2026-10-01T10:00:00.000Z",
    failureCategory: "configuration",
    failureCode: "accounting_event_mapping_missing",
    failureSummary: "A mapping was missing",
    maxAttempts: 5,
    sourceType: "trader_receivable",
    status: "failed",
  },
  eventId,
  finding,
  generatedAt: "2026-10-02T10:00:00.000Z",
  previewVersion: "rcv1:" + "c".repeat(64),
  sourceOrderId: null,
  support: { reason: "Forward operational event", support: "SUPPORTED" },
};

const preview: AccountingRecoveryPreview = {
  accountingMode: { automaticPostingEnabled: true, enabled: true },
  blockers: [],
  businessReference: "RCV-000101",
  companyId,
  currentState: { eventStatus: "failed" },
  domainPermissionEquivalent: "accounting.post",
  eventId,
  execution: {
    available: true,
    reason: "READY: the server re-runs the certified precheck under a lock before reprocessing.",
    requiredPlatformPermission: "platform.companies.repair_center.execute",
  },
  finding,
  generatedAt: "2026-10-02T10:00:00.000Z",
  idempotencyKeyBasis: "x",
  preservedHistory: [
    { description: "The event's prior failures stay in its audit timeline", entityNumber: null, entityType: "accounting_event_history" },
  ],
  previewVersion: "rcv1:" + "c".repeat(64),
  proposedChanges: [
    { action: "update", description: "Event processing state moves failed -> posted", details: {}, entityNumber: null, entityType: "accounting_event" },
    { action: "create", description: "One balanced Journal (debit 18.00 = credit 18.00)", details: {}, entityNumber: null, entityType: "journal_entry" },
  ],
  proposedRepair: {
    candidateOnly: false,
    capabilityCode: "REPROCESS_ACCOUNTING_EVENT",
    executionHandler: "PlatformAccountingRepairAdapter.reprocessInTransaction",
    explanation: "Reprocess the existing accounting event through the certified accounting pipeline.",
    title: "Reprocess Accounting Event",
  },
  repairability: "READY",
  requiredInputs: [{ description: "Mandatory reason", name: "reason", required: true }],
  requiredPermission: "platform.companies.repair_center.execute",
  warnings: [],
};

const result: AccountingRecoveryResult = {
  afterClassification: "posted",
  afterHealth: "HEALTHY",
  afterPreviewVersion: "rcv1:" + "d".repeat(64),
  auditId: "a1",
  beforeClassification: "failed",
  beforeHealth: "ISSUE",
  beforePreviewVersion: preview.previewVersion,
  capabilityCode: "REPROCESS_ACCOUNTING_EVENT",
  companyId,
  eventId,
  eventType: "trader_receivable_recognized",
  executedAt: "2026-10-02T10:05:00.000Z",
  findingId: finding.findingId,
  journalNumber: "JV-000777",
  nextRecommendedAction: "none",
  orderHealthAfter: "HEALTHY",
  orderId: "",
  orderNumber: "",
  reasonCode: "ACCOUNTING_EVENT_UNRESOLVED",
  repairExecutionId: "a1",
  replayed: false,
  status: "succeeded",
};

describe("Repair Center -- Accounting Health", () => {
  let summarySpy: ReturnType<typeof vi.spyOn>;
  let listSpy: ReturnType<typeof vi.spyOn>;
  let detailsSpy: ReturnType<typeof vi.spyOn>;
  let previewSpy: ReturnType<typeof vi.spyOn>;
  let executeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    summarySpy = vi.spyOn(platformApi, "accountingHealthSummary").mockResolvedValue(summary());
    listSpy = vi.spyOn(platformApi, "accountingHealthEvents").mockResolvedValue(page());
    detailsSpy = vi.spyOn(platformApi, "accountingEventDetails").mockResolvedValue(details);
    previewSpy = vi.spyOn(platformApi, "accountingRecoveryPreview").mockResolvedValue(preview);
    executeSpy = vi.spyOn(platformApi, "executeAccountingRecovery").mockResolvedValue(result);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows mode-aware counts and actionable events by default, with no payload", async () => {
    render(<AccountingHealthPanel companyId={companyId} />);
    expect(await screen.findByTestId("acc-ready")).toHaveTextContent("2");
    expect(screen.getByTestId("acc-blocked")).toHaveTextContent("1");
    expect(screen.getByTestId("acc-manual")).toHaveTextContent("1");
    expect(screen.getByTestId("accounting-note")).toHaveTextContent("ON");
    expect(listSpy).toHaveBeenCalledWith(companyId, { page: 1, pageSize: 25, status: "attention" });
    const table = await screen.findByRole("table", { name: "Accounting events" });
    expect(within(table).getByText("RCV-000101")).toBeInTheDocument();
    expect(within(table).getByText("Ready candidate · preview required")).toBeInTheDocument();
    // Prompt 5: list/summary readiness is a CANDIDATE; READY only from Preview.
    expect(screen.getByText("Ready candidates (preview required)")).toBeInTheDocument();
    expect(table.textContent).not.toMatch(/READY\b/u);
    expect(screen.queryByRole("button", { name: /Execute/u })).toBeNull();
  });

  it("Accounting OFF: says GL recovery is not required and shows historical events separately", async () => {
    summarySpy.mockResolvedValue(
      summary({
        accountingHealth: "NOT_APPLICABLE",
        accountingMode: { automaticPostingEnabled: false, enabled: false },
        historicalWhileOff: 4,
        note: "GL Accounting is OFF: GL recovery is not required for new operational activity.",
      }),
    );
    render(<AccountingHealthPanel companyId={companyId} />);
    expect(await screen.findByTestId("acc-historical")).toHaveTextContent("4");
    expect(screen.getByTestId("accounting-note")).toHaveTextContent(/not required for new operational activity/u);
  });

  it("filters are sent to the server", async () => {
    render(<AccountingHealthPanel companyId={companyId} />);
    await screen.findByRole("table", { name: "Accounting events" });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });
    fireEvent.change(screen.getByLabelText("Event type"), { target: { value: "trader_receivable_recognized" } });
    fireEvent.change(screen.getByLabelText("Repairability"), { target: { value: "BLOCKED" } });
    fireEvent.change(screen.getByLabelText("Business reference"), { target: { value: " RCV-0001 " } });
    fireEvent.change(screen.getByLabelText("Accounting date from"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Accounting date to"), { target: { value: "2026-09-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(listSpy).toHaveBeenLastCalledWith(companyId, {
        dateFrom: "2026-09-01",
        dateTo: "2026-09-30",
        eventType: "trader_receivable_recognized",
        page: 1,
        pageSize: 25,
        reference: "RCV-0001",
        repairability: "BLOCKED",
        status: "failed",
      }),
    );
  });

  it("Preview Recovery -> confirmation with reason -> Execute once -> Recovery completed -> refresh + verify again", async () => {
    let finish: (value: AccountingRecoveryResult) => void = () => undefined;
    executeSpy.mockImplementation(() => new Promise<AccountingRecoveryResult>((resolve) => (finish = resolve)));
    render(<AccountingHealthPanel companyId={companyId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview Recovery" }));
    const previewPanel = await screen.findByRole("region", { name: "Accounting recovery preview" });
    expect(within(previewPanel).getByRole("list", { name: "Recovery changes" })).toHaveTextContent("One balanced Journal");
    expect(previewPanel).toHaveTextContent("platform.companies.repair_center.execute");
    const confirm = within(previewPanel).getByRole("region", { name: "Confirm recovery" });
    const button = within(confirm).getByRole("button", { name: "Execute Recovery" });
    expect(button).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText(/Reason for this recovery/u), { target: { value: "Mapping fixed" } });
    const summaryCalls = summarySpy.mock.calls.length;
    fireEvent.click(button);
    const running = await within(confirm).findByRole("button", { name: "Recovering…" });
    fireEvent.click(running);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(companyId, eventId, {
      capabilityCode: "REPROCESS_ACCOUNTING_EVENT",
      findingId: finding.findingId,
      idempotencyKey: expect.stringMatching(/^rc-ui-[0-9a-f-]{36}$/u),
      previewVersion: preview.previewVersion,
      reason: "Mapping fixed",
    });
    detailsSpy.mockResolvedValue({ ...details, finding: { ...finding, current: false, repairability: "NOT_REQUIRED" } });
    finish(result);
    const done = await screen.findByRole("status", { name: "Recovery result" });
    expect(done).toHaveTextContent("JV-000777");
    await waitFor(() => expect(summarySpy.mock.calls.length).toBeGreaterThan(summaryCalls));
    await waitFor(() => expect(within(done).getByTestId("acc-verified")).toHaveTextContent("resolved"));
  });

  it("stale: warning, re-diagnosis, fresh preview, no automatic retry, new key next time", async () => {
    executeSpy.mockRejectedValueOnce(
      new PlatformApiError("The accounting event or its configuration changed after the repair preview.", "repair_preview_stale", 409),
    );
    render(<AccountingHealthPanel companyId={companyId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview Recovery" }));
    const confirm = await screen.findByRole("region", { name: "Confirm recovery" });
    fireEvent.change(within(confirm).getByLabelText(/Reason for this recovery/u), { target: { value: "Mapping fixed" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Recovery" }));
    expect(await screen.findByTestId("acc-stale-warning")).toHaveTextContent(/changed after the repair preview/u);
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(2));
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const fresh = await screen.findByRole("region", { name: "Confirm recovery" });
    expect(within(fresh).getByLabelText(/Reason for this recovery/u)).toHaveValue("");
  });

  it("an unknown outcome offers Retry with the SAME idempotency key", async () => {
    executeSpy
      .mockRejectedValueOnce(new PlatformApiError("timed out", "request_timeout", 0))
      .mockResolvedValueOnce({ ...result, replayed: true });
    render(<AccountingHealthPanel companyId={companyId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview Recovery" }));
    const confirm = await screen.findByRole("region", { name: "Confirm recovery" });
    fireEvent.change(within(confirm).getByLabelText(/Reason for this recovery/u), { target: { value: "Mapping fixed" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Recovery" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent(/can never post twice/u);
    fireEvent.click(within(confirm).getByRole("button", { name: "Retry Recovery" }));
    await screen.findByRole("status", { name: "Recovery result" });
    const keys = executeSpy.mock.calls.map((call: unknown[]) => (call[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it("BLOCKED / MANUAL_REVIEW / NOT_REQUIRED never offer Execute; details hide raw payload behind diagnostics", async () => {
    previewSpy.mockResolvedValue({
      ...preview,
      blockers: [{ code: "accounting_event_period_closed", message: "The Fiscal Period is not open" }],
      execution: { ...preview.execution, available: false, reason: "Only a READY event can be recovered (this one is BLOCKED)." },
      repairability: "BLOCKED",
    });
    listSpy.mockResolvedValue(page([{ ...row, triage: "BLOCKED" }, { ...row, eventId: "e2", triage: "MANUAL_REVIEW" }]));
    render(<AccountingHealthPanel companyId={companyId} />);
    const previewButtons = await screen.findAllByRole("button", { name: "Preview Recovery" });
    expect(previewButtons).toHaveLength(1); // the MANUAL_REVIEW row offers only View Details
    fireEvent.click(previewButtons[0]!);
    const panel = await screen.findByRole("region", { name: "Accounting recovery preview" });
    expect(within(panel).getByRole("list", { name: "Recovery blockers" })).toHaveTextContent("accounting_event_period_closed");
    expect(screen.queryByRole("button", { name: /Execute Recovery/u })).toBeNull();
    const detailsPanel = screen.getByRole("region", { name: "Accounting event details" });
    expect(await within(detailsPanel).findByText("Administrative diagnostics")).toBeInTheDocument();
    expect(detailsPanel.textContent).not.toMatch(/supplementary|payload/u);
  });

  it("Prompt 5: View Repair Record after a recovery; every attempt refreshes the landing and History", async () => {
    executeSpy.mockResolvedValueOnce(result);
    const onViewRepairRecord = vi.fn();
    const onRepairAttempted = vi.fn();
    render(
      <AccountingHealthPanel companyId={companyId} onRepairAttempted={onRepairAttempted} onViewRepairRecord={onViewRepairRecord} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Preview Recovery" }));
    const confirm = await screen.findByRole("region", { name: "Confirm recovery" });
    fireEvent.change(within(confirm).getByLabelText(/Reason for this recovery/u), { target: { value: "Mapping fixed" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Recovery" }));
    const done = await screen.findByRole("status", { name: "Recovery result" });
    expect(onRepairAttempted).toHaveBeenCalledTimes(1);
    fireEvent.click(within(done).getByRole("button", { name: "View Repair Record" }));
    expect(onViewRepairRecord).toHaveBeenCalledWith(result.repairExecutionId);
  });

  it("Prompt 5: a refused recovery says nothing was posted or changed", async () => {
    executeSpy.mockRejectedValueOnce(new PlatformApiError("Missing execute permission", "forbidden", 403));
    const onRepairAttempted = vi.fn();
    render(<AccountingHealthPanel companyId={companyId} onRepairAttempted={onRepairAttempted} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview Recovery" }));
    const confirm = await screen.findByRole("region", { name: "Confirm recovery" });
    fireEvent.change(within(confirm).getByLabelText(/Reason for this recovery/u), { target: { value: "Mapping fixed" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Execute Recovery" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent(/Recovery not applied — nothing was posted or changed/u);
    expect(onRepairAttempted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status", { name: "Recovery result" })).toBeNull();
  });

  describe("Phase 4 Prompt 1 -- headlines, journal integrity and missing events", () => {
    const missing: AccountingIntegrityRow = {
      actor: { state: "VALID" },
      businessReference: "ORD-000777",
      certifiedCapture: "COMPANY_HISTORICAL_RECOVERY",
      code: "ACCOUNTING_REQUIRED_EVENT_MISSING",
      decision: "SUPPORTED_READY",
      eventId: null,
      eventStatus: null,
      eventType: "order_delivered",
      headline: "ISSUE — Required accounting event is missing.",
      health: "ISSUE",
      journal: null,
      kind: "MISSING_REQUIRED_EVENT",
      occurredOn: "2026-10-01",
      reason: "The operation happened while GL Accounting was ON, but its accounting event was never captured.",
      reconstructable: true,
      recommendedInvestigation: "Confirm the source still stands as recorded.",
      repairability: "MANUAL_REVIEW",
      sourceId: "77777777-2222-4333-8444-555555555555",
      sourceType: "order",
      whyNotAutomatic: "The Platform does not capture accounting events.",
    };
    const unbalanced: AccountingIntegrityRow = {
      ...missing,
      businessReference: "RCV-000202",
      certifiedCapture: null,
      code: "ACCOUNTING_JOURNAL_UNBALANCED",
      eventId,
      eventStatus: "posted",
      eventType: "trader_receivable_recognized",
      headline: "ISSUE — Accounting journal does not match its event.",
      journal: { credit: "18.00", debit: "19.00", journalNumber: "JV-000042", lines: 2, periodStatus: "open", status: "posted" },
      kind: "JOURNAL_INTEGRITY",
      reason: "The event's Journal is not balanced (or has fewer than two lines).",
      reconstructable: null,
      sourceType: "trader_receivable",
      whyNotAutomatic: "A balancing line is never inserted.",
    };

    it("shows only the simple headlines on the summary", async () => {
      summarySpy.mockResolvedValue(
        summary({
          headlines: ["ISSUE — Accounting event failed.", "REVIEW — Accounting history requires manual review."],
          integrity: { duplicateEffectivePostings: 0, linkageMismatches: 0, postedWithoutJournal: 0, total: 0, unbalancedJournals: 0 },
          missingRequiredEvents: { byEventType: [], total: 0 },
        }),
      );
      const integritySpy = vi.spyOn(platformApi, "accountingHealthIntegrity");
      render(<AccountingHealthPanel companyId={companyId} />);
      const headlines = await screen.findByRole("list", { name: "Accounting Health headlines" });
      expect(headlines).toHaveTextContent("ISSUE — Accounting event failed.");
      expect(headlines).toHaveTextContent("REVIEW — Accounting history requires manual review.");
      expect(screen.getByTestId("acc-missing")).toHaveTextContent("0");
      // No findings -> the integrity list is not even requested.
      expect(integritySpy).not.toHaveBeenCalled();
      expect(screen.queryByTestId("acc-integrity-list")).toBeNull();
    });

    it("lists integrity / missing findings; opening one explains it with NO execute, delete or reset control", async () => {
      summarySpy.mockResolvedValue(
        summary({
          headlines: ["ISSUE — Required accounting event is missing.", "ISSUE — Accounting journal does not match its event."],
          integrity: { duplicateEffectivePostings: 0, linkageMismatches: 0, postedWithoutJournal: 0, total: 1, unbalancedJournals: 1 },
          missingRequiredEvents: { byEventType: [{ eventType: "order_delivered", missing: 1 }], total: 1 },
        }),
      );
      const integritySpy = vi.spyOn(platformApi, "accountingHealthIntegrity").mockResolvedValue({
        generatedAt: "2026-10-02T10:00:00.000Z",
        items: [unbalanced, missing],
        page: 1,
        pageSize: 25,
        total: 2,
      });
      render(<AccountingHealthPanel companyId={companyId} />);
      const section = await screen.findByTestId("acc-integrity-list");
      expect(integritySpy).toHaveBeenCalledWith(companyId, { pageSize: 25 });
      const opens = within(section).getAllByRole("button", { name: "Open" });
      expect(opens).toHaveLength(2);
      fireEvent.click(opens[0]!);
      const explanation = await within(section).findByTestId("acc-integrity-explanation");
      expect(explanation).toHaveTextContent("ACCOUNTING_JOURNAL_UNBALANCED");
      expect(explanation).toHaveTextContent("A balancing line is never inserted.");
      expect(explanation).toHaveTextContent("JV-000042");
      expect(explanation).toHaveTextContent("debit 19.00");
      fireEvent.click(within(section).getByRole("button", { name: "Close" }));
      fireEvent.click(within(section).getAllByRole("button", { name: "Open" })[1]!);
      const second = await within(section).findByTestId("acc-integrity-explanation");
      expect(second).toHaveTextContent("Historical Recovery");
      for (const name of [/Execute/u, /Delete/u, /Reset/u, /Recover/u]) {
        expect(within(section).queryByRole("button", { name })).toBeNull();
      }
    });
  });

  it("Phase 4 Prompt 2: Preview shows the recovery checks; a MANUAL_REVIEW recovery shows the investigation and no Execute", async () => {
    previewSpy.mockResolvedValue({
      ...preview,
      execution: { ...preview.execution, available: false, reason: "No certified Platform recovery applies to this event." },
      proposedRepair: null,
      recovery: {
        blocker: null,
        decision: { condition: null, decision: "SUPPORTED_READY", reason: "Certified forward loader." },
        existingJournals: {
          eventJournal: { balanced: false, credit: "18.00", debit: "19.00", journalNumber: "JRN-000042", lines: 2, status: "posted" },
          linkedToEvent: 1,
          otherPostedEventsForSource: 0,
          postedForSource: 1,
        },
        fiscalPeriod: { matches: 1, status: "open", yearStatus: "open" },
        mappings: { blockerCodes: [], state: "NOT_EVALUATED" },
        originalActor: { accountKind: "company_user", accountStatus: "active", note: "Original operational actor.", state: "VALID" },
        plannedOperation: "None: no recovery is executed for this classification.",
        postRecoveryExpectation: "Nothing changes.",
        recommendedInvestigation: ["A balancing line is never inserted: the Company reverses and reposts."],
        source: { reference: "RCV-000101", state: "PRESENT", type: "trader_receivable" },
      },
      repairability: "MANUAL_REVIEW",
    });
    render(<AccountingHealthPanel companyId={companyId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview Recovery" }));
    const panel = await screen.findByRole("region", { name: "Accounting recovery preview" });
    const checks = await within(panel).findByTestId("acc-recovery-context");
    expect(checks).toHaveTextContent("JRN-000042 posted (NOT balanced)");
    expect(checks).toHaveTextContent("A balancing line is never inserted");
    expect(checks).toHaveTextContent("VALID");
    expect(screen.queryByRole("button", { name: /Execute Recovery/u })).toBeNull();
  });
});
