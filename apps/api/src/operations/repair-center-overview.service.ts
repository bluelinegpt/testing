import { Inject, Injectable, Optional } from "@nestjs/common";

import { PlatformAccountingHealthService } from "../accounting/platform-accounting-health.service.js";
import { CompanyOrderHealthService } from "./company-order-health.service.js";
import { PlatformPayrollHealthService } from "./payroll-repair.service.js";
import { type RepairHistoryCounts, RepairHistoryService } from "./repair-history.service.js";

/**
 * REPAIR CENTER LANDING -- consolidated Company health (Phase 2, Prompt 5).
 *
 * High level only, composed from the set-based read paths (no per-order
 * or per-event query): Order Health (default period), Accounting Health
 * (mode-aware; READY appears only as READY CANDIDATES -- authoritative READY
 * needs the per-event preview), Payroll Health (Phase 6) and Repair History
 * counts.
 *
 * Phase 6 -- ONE health contract: `companyHealth` is the worst of the domain
 * healths (ISSUE > REVIEW > HEALTHY; Accounting NOT_APPLICABLE -- GL Accounting
 * OFF -- never raises it). Order issues whose primary finding is an accounting
 * event (`ORDER_MISSING_ACCOUNTING_EVENT` / `ACCOUNTING_EVENT_FAILED`) are the
 * SAME root cause Accounting Health lists: they are reported as
 * `accountingRelatedIssues` so the landing labels them instead of presenting
 * them as independent actionable work (they are not hidden).
 */

export interface RepairCenterOverview {
  readonly companyId: string;
  readonly company: { readonly code: string; readonly nameEn: string; readonly status: string };
  readonly accountingMode: { readonly enabled: boolean; readonly automaticPostingEnabled: boolean };
  readonly orderHealth: {
    readonly companyHealth: string;
    readonly totalOrders: number;
    readonly healthy: number;
    readonly issue: number;
    readonly review: number;
    readonly scope: { readonly scope: string; readonly dateFrom: string | null; readonly dateTo: string | null };
    /** Order issues whose primary finding is accounting (also listed by Accounting Health). */
    readonly accountingRelatedIssues: number;
  };
  readonly accountingHealth: {
    readonly accountingHealth: string;
    readonly failed: number;
    readonly blockedConfiguration: number;
    readonly readyCandidates: number;
    readonly blocked: number;
    readonly manualReview: number;
    readonly pending: number;
    readonly processing: number;
    readonly stuck: number;
    readonly historicalWhileOff: number;
    readonly note: string;
    /** Explicit contract: list/summary readiness is a candidate, never READY. */
    readonly readyCandidateNote: string;
  };
  readonly payrollHealth: {
    readonly payrollHealth: string;
    readonly totalPeriods: number;
    readonly periodsWithFindings: number;
    readonly driverFeeFindings: number;
    readonly headlines: readonly string[];
  } | null;
  /** Worst of the domain healths (Accounting NOT_APPLICABLE ignored). */
  readonly companyHealth: "HEALTHY" | "ISSUE" | "REVIEW";
  readonly repairHistory: RepairHistoryCounts;
  readonly generatedAt: string;
}

const ACCOUNTING_ORDER_REASONS = new Set(["ORDER_MISSING_ACCOUNTING_EVENT", "ACCOUNTING_EVENT_FAILED"]);

/** ONE health contract: the worst domain health wins; NOT_APPLICABLE never counts. */
export function worstHealth(...healths: readonly (string | null | undefined)[]): "HEALTHY" | "ISSUE" | "REVIEW" {
  if (healths.includes("ISSUE")) return "ISSUE";
  if (healths.includes("REVIEW")) return "REVIEW";
  return "HEALTHY";
}

export const READY_CANDIDATE_NOTE =
  "Ready candidates pass every stored-state check. READY is decided only by Preview Recovery, which runs the full certified accounting precheck.";

@Injectable()
export class RepairCenterOverviewService {
  public constructor(
    @Inject(CompanyOrderHealthService) private readonly orders: CompanyOrderHealthService,
    @Inject(PlatformAccountingHealthService) private readonly accounting: PlatformAccountingHealthService,
    @Inject(RepairHistoryService) private readonly history: RepairHistoryService,
    @Optional() @Inject(PlatformPayrollHealthService) private readonly payroll?: PlatformPayrollHealthService,
  ) {}

  public async overview(companyId: string): Promise<RepairCenterOverview> {
    const [orders, accounting, history, payroll] = await Promise.all([
      this.orders.summary(companyId, {}),
      this.accounting.summary(companyId),
      this.history.counts(companyId),
      this.payroll === undefined ? Promise.resolve(null) : this.payroll.summary(companyId),
    ]);
    return {
      accountingHealth: {
        accountingHealth: accounting.accountingHealth,
        blocked: accounting.blocked,
        blockedConfiguration: accounting.blockedConfiguration,
        failed: accounting.failed,
        historicalWhileOff: accounting.historicalWhileOff,
        manualReview: accounting.manualReview,
        note: accounting.note,
        pending: accounting.pending,
        processing: accounting.processing,
        readyCandidateNote: READY_CANDIDATE_NOTE,
        readyCandidates: accounting.readyCandidates,
        stuck: accounting.stuck,
      },
      accountingMode: accounting.accountingMode,
      company: { code: orders.company.code, nameEn: orders.company.nameEn, status: orders.company.status },
      companyHealth: worstHealth(orders.companyHealth, accounting.accountingHealth, payroll?.payrollHealth),
      companyId,
      generatedAt: new Date().toISOString(),
      orderHealth: {
        accountingRelatedIssues: orders.byReason
          .filter((row) => row.health === "ISSUE" && ACCOUNTING_ORDER_REASONS.has(row.reasonCode))
          .reduce((sum, row) => sum + row.orders, 0),
        companyHealth: orders.companyHealth,
        healthy: orders.healthyOrders,
        issue: orders.issueOrders,
        review: orders.reviewOrders,
        scope: { dateFrom: orders.scope.dateFrom, dateTo: orders.scope.dateTo, scope: orders.scope.scope },
        totalOrders: orders.totalOrders,
      },
      payrollHealth:
        payroll === null
          ? null
          : {
              driverFeeFindings: payroll.driverFeeFindings,
              headlines: payroll.headlines,
              payrollHealth: payroll.payrollHealth,
              periodsWithFindings: payroll.periodsWithFindings,
              totalPeriods: payroll.totalPeriods,
            },
      repairHistory: history,
    };
  }
}
