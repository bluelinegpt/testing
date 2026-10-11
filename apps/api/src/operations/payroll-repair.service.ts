import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { PlatformAccountingRepairAdapter } from "../accounting/platform-accounting-repair.adapter.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { PayrollOperationalRepository } from "../payroll/payroll-operational.repository.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { canonicalJson, findingIdOf, type RepairIssue } from "./repair-center.model.js";
import { RepairAttemptRecorder } from "./repair-attempt.recorder.js";
import type { RepairExecutionActor, RepairExecutionRequest } from "./repair-execution.service.js";
import { PLATFORM_REPAIR_CENTER_EXECUTE_PERMISSION } from "./repair-preview.service.js";

/**
 * REPAIR CENTER PHASE 5, PROMPT 1 -- PAYROLL HEALTH + SAFE PAYROLL RECOVERY.
 *
 * ONE definition of every Payroll finding (`payrollFindingsSql`), evaluated
 * set-based for Payroll Health (summary / list) and for ONE period by the
 * repair Preview and the execution's re-check -- so the list, the Preview and
 * the executor cannot disagree.
 *
 * What Payroll's own records prove (and therefore what may be repaired):
 *   - Payment ALLOCATIONS are the payment truth (immutable, reversal-only).
 *     A line's paid / outstanding amounts and the line / period settlement
 *     statuses are their derived cache -> RECONCILE_PAYROLL_PAYMENT_STATE
 *     (PayrollOperationalRepository.reconcilePaymentState) for an approved /
 *     partially paid / paid period.
 *   - A DRAFT / CALCULATED line's gross and net are a pure function of the
 *     component snapshots stored on the line and its active adjustments
 *     (PayrollOperationalRepository.recalculateLine, the authoritative gross)
 *     -> REPAIR_PAYROLL_LINE_AMOUNTS; a draft period's header totals are a
 *     pure sum of its lines (recalculatePeriodTotals) ->
 *     REBUILD_PAYROLL_PERIOD_TOTALS.
 * Everything else is history a person must judge -- MANUAL_REVIEW: an
 * approved / closed amount (immutable by trigger), component snapshots that
 * disagree with their sources (only the Company's own Recalculate, run by a
 * Company user, may re-derive them), payment allocations that do not add up,
 * a reversed period with live records, a missing accounting event. Nothing
 * here recalculates Payroll from today's configuration, creates or deletes a
 * Payroll row, touches a payment, an adjustment or a journal, or acts as a
 * Company user (every repair helper used here writes no actor column).
 */

export const PAYROLL_FINDING_CODES = [
  "PAYROLL_LINE_AMOUNTS_INCONSISTENT",
  "PAYROLL_LINE_COMPONENTS_INCONSISTENT",
  "PAYROLL_PERIOD_TOTALS_MISMATCH",
  "PAYROLL_PAYMENT_STATE_INCONSISTENT",
  "PAYROLL_PAYMENT_ALLOCATION_INCONSISTENT",
  "PAYROLL_REVERSED_STILL_ACTIVE",
  "PAYROLL_ACCOUNTING_EVENT_FAILED",
  "PAYROLL_ACCOUNTING_EVENT_MISSING",
  "PAYROLL_LEGACY_HISTORY_REVIEW",
] as const;
export type PayrollFindingCode = (typeof PAYROLL_FINDING_CODES)[number];

export const DRIVER_FEE_FINDING_CODES = [
  "DRIVER_FEE_RATE_OUTSIDE_VERSION",
  "DRIVER_FEE_PAYMENT_STATE_INCONSISTENT",
] as const;
export type DriverFeeFindingCode = (typeof DRIVER_FEE_FINDING_CODES)[number];

export const PAYROLL_CAPABILITIES = [
  "RECONCILE_PAYROLL_PAYMENT_STATE",
  "REPAIR_PAYROLL_LINE_AMOUNTS",
  "REBUILD_PAYROLL_PERIOD_TOTALS",
] as const;
export type PayrollCapabilityCode = (typeof PAYROLL_CAPABILITIES)[number];

export const PAYROLL_HEADLINES = {
  accounting: "ISSUE — Payroll accounting failed.",
  calculation: "ISSUE — Payroll calculation is inconsistent.",
  driverFee: "ISSUE — Driver fee state is inconsistent.",
  payment: "ISSUE — Payroll payment state is inconsistent.",
  review: "REVIEW — Payroll history requires manual review.",
} as const;

type Headline = (typeof PAYROLL_HEADLINES)[keyof typeof PAYROLL_HEADLINES];

export const PAYROLL_FINDINGS: Readonly<
  Record<PayrollFindingCode | DriverFeeFindingCode, { health: "ISSUE" | "REVIEW"; headline: Headline; reason: string }>
> = {
  DRIVER_FEE_PAYMENT_STATE_INCONSISTENT: {
    headline: PAYROLL_HEADLINES.driverFee,
    health: "ISSUE",
    reason: "A driver fee accrual's paid amount does not equal its active payment allocations.",
  },
  DRIVER_FEE_RATE_OUTSIDE_VERSION: {
    headline: PAYROLL_HEADLINES.driverFee,
    health: "ISSUE",
    reason: "A driver fee accrual's business date falls outside the fee-rate version it references.",
  },
  PAYROLL_ACCOUNTING_EVENT_FAILED: {
    headline: PAYROLL_HEADLINES.accounting,
    health: "ISSUE",
    reason: "A Payroll accounting event (approval or payment) failed to post.",
  },
  PAYROLL_ACCOUNTING_EVENT_MISSING: {
    headline: PAYROLL_HEADLINES.accounting,
    health: "ISSUE",
    reason: "Payroll was approved or paid while GL Accounting was ON, but its accounting event was never captured.",
  },
  PAYROLL_LEGACY_HISTORY_REVIEW: {
    headline: PAYROLL_HEADLINES.review,
    health: "REVIEW",
    reason: "A legacy Payroll line's amounts do not follow the current calculation; its original inputs are not provable.",
  },
  PAYROLL_LINE_AMOUNTS_INCONSISTENT: {
    headline: PAYROLL_HEADLINES.calculation,
    health: "ISSUE",
    reason: "A Payroll line's gross / net do not equal its own component snapshots and active adjustments.",
  },
  PAYROLL_LINE_COMPONENTS_INCONSISTENT: {
    headline: PAYROLL_HEADLINES.calculation,
    health: "ISSUE",
    reason:
      "A Payroll line's allowance or commission total does not equal its own snapshot records, or an active adjustment on it belongs to another employee or period.",
  },
  PAYROLL_PAYMENT_ALLOCATION_INCONSISTENT: {
    headline: PAYROLL_HEADLINES.payment,
    health: "ISSUE",
    reason: "Payroll payment allocations do not add up (overpaid line, allocation on a reversed payment, or a payment total that differs from its allocations).",
  },
  PAYROLL_PAYMENT_STATE_INCONSISTENT: {
    headline: PAYROLL_HEADLINES.payment,
    health: "ISSUE",
    reason: "Payroll paid / outstanding amounts or settlement statuses do not match the active payment allocations.",
  },
  PAYROLL_PERIOD_TOTALS_MISMATCH: {
    headline: PAYROLL_HEADLINES.calculation,
    health: "ISSUE",
    reason: "The Payroll period's totals do not equal the sum of its lines.",
  },
  PAYROLL_REVERSED_STILL_ACTIVE: {
    headline: PAYROLL_HEADLINES.payment,
    health: "ISSUE",
    reason: "A reversed Payroll period still has unreversed lines or confirmed payments.",
  },
};

const WHY_NOT_AUTOMATIC: Readonly<Partial<Record<PayrollFindingCode | DriverFeeFindingCode, string>>> = {
  DRIVER_FEE_PAYMENT_STATE_INCONSISTENT:
    "Driver fee accruals are protected financial history; only the Company's certified fee payment reversal changes them.",
  DRIVER_FEE_RATE_OUTSIDE_VERSION:
    "The earned amount was fixed from a rate snapshot; which rate was intended is not in the records, and only the Company's accrual reversal can correct it.",
  PAYROLL_ACCOUNTING_EVENT_MISSING:
    "The Platform never creates Company accounting events; a new event would be attributed to a Company user on a Platform decision.",
  PAYROLL_LEGACY_HISTORY_REVIEW:
    "Legacy Payroll lines were not produced by the current calculation; their original inputs cannot be proven, so nothing is recomputed.",
  PAYROLL_LINE_COMPONENTS_INCONSISTENT:
    "Component snapshots are re-derived only by the Company's own Payroll Recalculate (run by a Company user, from the period's sources); the Platform never re-derives them.",
  PAYROLL_PAYMENT_ALLOCATION_INCONSISTENT:
    "Allocations are the payment truth; which allocation is wrong is not in the records, and payments are corrected only by the Company's certified payment reversal.",
  PAYROLL_REVERSED_STILL_ACTIVE:
    "A reversed period must have every payment reversed first; the Platform never reverses payments or lines.",
};

const ANY_PERIOD = "00000000-0000-0000-0000-000000000000";

/**
 * Phase 6: the operational Payroll findings (everything except the two
 * accounting findings). While one is open on a period, its Payroll accounting
 * events are BLOCKED (`payroll_repair_first`): the General Ledger never
 * records an inconsistent Payroll state (see RepairOrderingService).
 */
export const PAYROLL_OPERATIONAL_CODES: ReadonlySet<string> = new Set([
  "PAYROLL_LINE_AMOUNTS_INCONSISTENT",
  "PAYROLL_LINE_COMPONENTS_INCONSISTENT",
  "PAYROLL_PERIOD_TOTALS_MISMATCH",
  "PAYROLL_PAYMENT_STATE_INCONSISTENT",
  "PAYROLL_PAYMENT_ALLOCATION_INCONSISTENT",
  "PAYROLL_REVERSED_STILL_ACTIVE",
  "PAYROLL_LEGACY_HISTORY_REVIEW",
]);

/** Per-period finding flags, ONE statement, set-based. `periodId` null = every period. */
export function payrollFindingsSql(companyId: string, periodId: string | null) {
  const pid = periodId ?? ANY_PERIOD;
  return sql`
    per as materialized (
      select p.* from payroll_periods p
       where p.company_id = ${companyId}::uuid
         and (${periodId === null}::boolean or p.id = ${pid}::uuid)
    ),
    ln as materialized (
      select l.id, l.payroll_period_id as pid, per.status as pstatus, l.employee_id, l.status, l.source_marker,
             l.salary_hold_snapshot as held, l.basic_salary_snapshot as basic, l.allowance_total,
             l.employee_driver_commission as comm, l.delivered_order_earnings as delivered,
             l.collection_earnings as collection, l.earning_adjustments_total as earning_adj,
             l.deduction_adjustments_total as deduction_adj, l.advances, l.variable_earnings_already_paid as variable_paid,
             l.salary_advance_recovery as advance_recovery, l.gross_earnings as gross, l.net_salary as net,
             l.amount_paid as paid, l.outstanding_amount as outstanding
        from payroll_entries l
        join per on per.id = l.payroll_period_id
       where l.company_id = ${companyId}::uuid
    ),
    adj as (
      select a.payroll_line_id as id,
             coalesce(sum(a.amount) filter (where a.status = 'active' and a.direction = 'earning'), 0) as e,
             coalesce(sum(a.amount) filter (where a.status = 'active' and a.direction = 'deduction'), 0) as d,
             -- Phase 5 Prompt 2: an active adjustment recorded for another employee or
             -- period than its line is ambiguous: which side is right is not provable.
             coalesce(bool_or(a.status = 'active'
                              and (a.employee_id <> l.employee_id or a.payroll_period_id <> l.pid)), false) as foreign_source
        from payroll_adjustments a
        join ln l on l.id = a.payroll_line_id
       where a.company_id = ${companyId}::uuid
       group by a.payroll_line_id
    ),
    alw as (
      select x.payroll_line_id as id, sum(x.amount) as s from payroll_line_allowances x
       where x.company_id = ${companyId}::uuid and x.payroll_line_id in (select id from ln)
       group by x.payroll_line_id
    ),
    com as (
      select c.payroll_entry_id as id, sum(c.amount) as s from payroll_commission_links c
       where c.company_id = ${companyId}::uuid and c.payroll_entry_id in (select id from ln)
       group by c.payroll_entry_id
    ),
    alc as (
      select a.payroll_line_id as id,
             coalesce(sum(a.allocated_amount) filter (where a.reversed_at is null), 0) as active,
             count(*) filter (where a.reversed_at is null and (
               pm.status <> 'confirmed' or a.employee_id <> l.employee_id
               or pm.payroll_period_id is distinct from l.pid))::int as bad
        from payroll_payment_allocations a
        join payroll_payments pm on pm.id = a.payroll_payment_id and pm.company_id = a.company_id
        join ln l on l.id = a.payroll_line_id
       where a.company_id = ${companyId}::uuid
       group by a.payroll_line_id
    ),
    pay as (
      select pm.id, pm.payroll_period_id as pid, pm.status, pm.total_amount, pm.created_at,
             coalesce(sum(a.allocated_amount) filter (where a.reversed_at is null), 0) as active,
             count(a.id) filter (where a.reversed_at is not null)::int as reversed_allocations
        from payroll_payments pm
        left join payroll_payment_allocations a on a.payroll_payment_id = pm.id and a.company_id = pm.company_id
       where pm.company_id = ${companyId}::uuid and pm.payroll_period_id in (select id from per)
       group by pm.id
    ),
    lc as materialized (
      select ln.*, coalesce(adj.e, 0) as adj_e, coalesce(adj.d, 0) as adj_d,
             coalesce(adj.foreign_source, false) as adj_foreign,
             coalesce(alw.s, 0) as alw_s, coalesce(com.s, 0) as com_s,
             coalesce(alc.active, 0) as active, coalesce(alc.bad, 0) as bad_alloc,
             case when ln.held then 0
                  else ln.basic + ln.allowance_total + ln.comm + ln.delivered + ln.collection + coalesce(adj.e, 0) end
               as exp_gross
        from ln
        left join adj on adj.id = ln.id
        left join alw on alw.id = ln.id
        left join com on com.id = ln.id
        left join alc on alc.id = ln.id
    ),
    lf as materialized (
      select lc.*,
             lc.exp_gross - case when lc.held then 0
                                  else coalesce(lc.adj_d, 0) + lc.advances + lc.variable_paid + lc.advance_recovery end
               as exp_net,
             case when lc.active = 0 then 'approved'
                  when lc.active = lc.net then 'paid' else 'partially_paid' end as exp_status
        from lc
    ),
    lflags as (
      select lf.*,
             lf.status <> 'reversed' and (
               lf.gross <> lf.exp_gross or lf.net <> lf.exp_net
               or lf.earning_adj <> case when lf.held then 0 else lf.adj_e end
               or lf.deduction_adj <> case when lf.held then 0 else lf.adj_d end) as amounts_bad,
             lf.status <> 'reversed' and (
               lf.adj_foreign
               or (not lf.held and lf.source_marker = 'new_payroll'
                   and (lf.allowance_total <> lf.alw_s or lf.comm <> lf.com_s))) as components_bad,
             lf.pstatus in ('approved', 'partially_paid', 'paid', 'closed')
               and lf.status not in ('held', 'reversed') and not lf.held and (
               lf.paid <> lf.active or lf.outstanding <> lf.net - lf.active or lf.status <> lf.exp_status) as pay_bad,
             lf.bad_alloc > 0 or lf.active > lf.net
               or ((lf.held or lf.status in ('held', 'reversed')) and lf.active > 0) as alloc_bad
        from lf
    ),
    pflags as (
      select per.id, per.period_reference, per.status, per.approved_at,
             coalesce(bool_or(f.amounts_bad and f.source_marker = 'new_payroll'), false) as amounts_bad,
             coalesce(bool_or(f.amounts_bad and f.source_marker = 'legacy'), false) as legacy_bad,
             coalesce(bool_or(f.amounts_bad and f.exp_net < 0), false) as negative_net,
             coalesce(bool_or(f.components_bad), false) as components_bad,
             coalesce(bool_or(f.pay_bad), false) as lines_pay_bad,
             coalesce(bool_or(f.alloc_bad), false) as alloc_bad,
             count(*) filter (where f.amounts_bad or f.components_bad or f.pay_bad or f.alloc_bad)::int as affected_lines,
             count(f.id) filter (where f.status <> 'reversed')::int as live_lines,
             count(f.id) filter (where f.status <> 'held' and f.status <> 'reversed')::int as payable,
             count(f.id) filter (where f.status <> 'held' and f.status <> 'reversed' and f.paid > 0)::int as paid_count,
             coalesce(bool_or(f.status <> 'held' and f.status <> 'reversed' and f.outstanding > 0), false) as has_outstanding,
             coalesce(sum(f.basic) filter (where f.status <> 'reversed'), 0) as s_basic,
             coalesce(sum(f.allowance_total) filter (where f.status <> 'reversed'), 0) as s_allowances,
             coalesce(sum(f.comm) filter (where f.status <> 'reversed'), 0) as s_comm,
             coalesce(sum(f.delivered) filter (where f.status <> 'reversed'), 0) as s_delivered,
             coalesce(sum(f.collection) filter (where f.status <> 'reversed'), 0) as s_collection,
             coalesce(sum(f.earning_adj) filter (where f.status <> 'reversed'), 0) as s_earning_adj,
             coalesce(sum(f.deduction_adj + f.advances + f.variable_paid + f.advance_recovery)
                        filter (where f.status <> 'reversed'), 0) as s_deductions,
             coalesce(sum(f.net) filter (where f.status <> 'reversed'), 0) as s_net,
             coalesce(sum(f.paid) filter (where f.status <> 'reversed'), 0) as s_paid,
             coalesce(sum(f.outstanding) filter (where f.status <> 'reversed'), 0) as s_outstanding
        from per
        left join lflags f on f.pid = per.id
       group by per.id, per.period_reference, per.status, per.approved_at
    ),
    pchk as (
      select pf.*,
             pf.status <> 'reversed' and (
               p.total_employees <> pf.live_lines or p.total_basic_salary <> pf.s_basic
               or p.total_allowances <> pf.s_allowances or p.total_employee_driver_commission <> pf.s_comm
               or p.total_delivered_order_earnings <> pf.s_delivered or p.total_collection_earnings <> pf.s_collection
               or p.total_earning_adjustments <> pf.s_earning_adj or p.total_deductions <> pf.s_deductions
               or p.total_net_salary <> pf.s_net) as totals_calc_bad,
             pf.status not in ('reversed', 'draft', 'calculated')
               and (p.total_paid <> pf.s_paid or p.total_outstanding <> pf.s_outstanding) as totals_pay_bad,
             pf.status in ('approved', 'partially_paid', 'paid')
               and pf.status <> case when pf.paid_count = 0 then 'approved'
                                     when pf.has_outstanding then 'partially_paid' else 'paid' end as status_bad,
             pf.status = 'reversed' and (
               exists (select 1 from ln where ln.pid = pf.id and ln.status <> 'reversed')
               or exists (select 1 from pay where pay.pid = pf.id and pay.status = 'confirmed')) as reversed_active,
             exists (select 1 from pay where pay.pid = pf.id and (
               (pay.status = 'confirmed' and (pay.active <> pay.total_amount or pay.reversed_allocations > 0))
               or (pay.status = 'reversed' and pay.active > 0))) as payment_bad,
             coalesce((select c.accounting_enabled from accounting_configurations c
                        where c.company_id = ${companyId}::uuid), false) as accounting_on,
             -- Phase 5 Prompt 2: any payment history on the period (a payment of it, or a
             -- line carrying an active allocation). Unfinalized Payroll never has one
             -- through the application; if it does, its amounts are not repaired.
             exists (select 1 from pay where pay.pid = pf.id)
               or exists (select 1 from lflags f where f.pid = pf.id and f.active > 0) as has_payments,
             (select json_agg(e.id::text order by e.created_at, e.id) from accounting_events e
               where e.company_id = ${companyId}::uuid and e.processing_status in ('failed', 'blocked_configuration')
                 and ((e.event_type = 'employee_payroll_approved' and e.source_entity_type = 'payroll_period'
                       and e.source_entity_id = pf.id)
                   or (e.event_type = 'employee_payroll_paid' and e.source_entity_type = 'payroll_payment'
                       and e.source_entity_id in (select pay.id from pay where pay.pid = pf.id)))) as failed_events,
             (pf.approved_at is not null and pf.status in ('approved', 'partially_paid', 'paid', 'closed')
               and accounting_enabled_at(${companyId}::uuid, pf.approved_at)
               and not exists (select 1 from accounting_events e
                                where e.company_id = ${companyId}::uuid and e.event_type = 'employee_payroll_approved'
                                  and e.source_entity_type = 'payroll_period' and e.source_entity_id = pf.id))
             or exists (select 1 from pay
                         where pay.pid = pf.id and pay.status = 'confirmed'
                           and accounting_enabled_at(${companyId}::uuid, pay.created_at)
                           and not exists (select 1 from accounting_events e
                                            where e.company_id = ${companyId}::uuid
                                              and e.event_type = 'employee_payroll_paid'
                                              and e.source_entity_type = 'payroll_payment'
                                              and e.source_entity_id = pay.id)) as event_missing
        from pflags pf
        join payroll_periods p on p.id = pf.id and p.company_id = ${companyId}::uuid
    ),
    pcodes as (
      select pchk.*, array_remove(array[
        case when amounts_bad then 'PAYROLL_LINE_AMOUNTS_INCONSISTENT' end,
        case when components_bad then 'PAYROLL_LINE_COMPONENTS_INCONSISTENT' end,
        case when totals_calc_bad then 'PAYROLL_PERIOD_TOTALS_MISMATCH' end,
        case when lines_pay_bad or totals_pay_bad or status_bad
                  or (status = 'closed' and has_outstanding) then 'PAYROLL_PAYMENT_STATE_INCONSISTENT' end,
        case when alloc_bad or payment_bad then 'PAYROLL_PAYMENT_ALLOCATION_INCONSISTENT' end,
        case when reversed_active then 'PAYROLL_REVERSED_STILL_ACTIVE' end,
        case when accounting_on and failed_events is not null then 'PAYROLL_ACCOUNTING_EVENT_FAILED' end,
        case when event_missing then 'PAYROLL_ACCOUNTING_EVENT_MISSING' end,
        case when legacy_bad then 'PAYROLL_LEGACY_HISTORY_REVIEW' end
      ]::text[], null) as codes
        from pchk
    )`;
}

/** Driver fee findings of ONE Company (accrual level), one CTE ending in `dfee`. */
function driverFeeFindingsSql(companyId: string) {
  return sql`
    dfee as (
      select a.id, a.source_reference as reference, a.accrual_business_date::text as occurred_on,
             'DRIVER_FEE_RATE_OUTSIDE_VERSION'::text as code
        from outsourced_driver_fee_accruals a
        join outsourced_driver_fee_versions v on v.id = a.fee_rate_version_id and v.company_id = a.company_id
       where a.company_id = ${companyId}::uuid and a.status not in ('reversed', 'recovery_required')
         and not (v.effective_from <= a.accrual_business_date
                  and coalesce(v.effective_to, 'infinity'::date) >= a.accrual_business_date)
      union all
      select a.id, a.source_reference, a.accrual_business_date::text, 'DRIVER_FEE_PAYMENT_STATE_INCONSISTENT'
        from outsourced_driver_fee_accruals a
        left join lateral (
          select coalesce(sum(x.allocated_amount) filter (where x.reversed_at is null), 0) as active
            from outsourced_driver_fee_payment_allocations x
           where x.company_id = a.company_id and x.accrual_id = a.id) paid on true
       where a.company_id = ${companyId}::uuid and a.status not in ('reversed', 'recovery_required')
         and a.paid_amount <> paid.active
    )`;
}

export type PayrollRepairability = "NOT_REQUIRED" | "READY" | "BLOCKED" | "MANUAL_REVIEW";

interface PeriodFlags {
  readonly id: string;
  readonly period_reference: string;
  readonly status: string;
  readonly codes: string[];
  readonly negative_net: boolean;
  readonly amounts_bad: boolean;
  readonly components_bad: boolean;
  readonly totals_calc_bad: boolean;
  readonly alloc_bad: boolean;
  readonly payment_bad: boolean;
  readonly legacy_bad: boolean;
  readonly affected_lines: number;
  readonly failed_events: string[] | null;
  readonly has_payments: boolean;
}

export interface PayrollFinding {
  readonly findingId: string;
  readonly reasonCode: PayrollFindingCode;
  readonly health: "ISSUE" | "REVIEW";
  readonly headline: string;
  readonly reason: string;
  readonly repairability: PayrollRepairability;
  readonly repairCapability: PayrollCapabilityCode | "REPROCESS_ACCOUNTING_EVENT" | null;
  /** Where the capability executes: this Payroll route, or Accounting event recovery. */
  readonly executionRoute: "payroll" | "accounting_event" | null;
  readonly blockers: readonly RepairIssue[];
  readonly whyNotAutomatic: string | null;
  readonly recommendedAction: string;
}

const DRAFT = new Set(["draft", "calculated"]);
const UNFINALIZED_WITH_PAYMENTS =
  "This unfinalized period already carries payment history (a payment or an active allocation), which the application never produces before approval; its amounts are not rewritten automatically.";
const SETTLEMENT = new Set(["approved", "partially_paid", "paid"]);

/** The repairability of every finding of ONE period, from its flags -- the ONE decision table. */
export function classifyPeriod(companyId: string, flags: PeriodFlags): PayrollFinding[] {
  const findings: PayrollFinding[] = [];
  const issue = (code: string, message: string): RepairIssue => ({ code, message });
  for (const raw of flags.codes) {
    const code = raw as PayrollFindingCode;
    const meta = PAYROLL_FINDINGS[code];
    let repairability: PayrollRepairability = "MANUAL_REVIEW";
    let capability: PayrollFinding["repairCapability"] = null;
    let route: PayrollFinding["executionRoute"] = null;
    const blockers: RepairIssue[] = [];
    let recommended = "manual_review";
    let why: string | null = null;
    switch (code) {
      case "PAYROLL_LINE_AMOUNTS_INCONSISTENT":
        if (DRAFT.has(flags.status)) {
          capability = "REPAIR_PAYROLL_LINE_AMOUNTS";
          route = "payroll";
          if (flags.has_payments) {
            repairability = "MANUAL_REVIEW";
            why = UNFINALIZED_WITH_PAYMENTS;
          } else if (flags.components_bad) {
            repairability = "MANUAL_REVIEW";
            recommended = "company_payroll_recalculate";
          } else if (flags.negative_net) {
            repairability = "BLOCKED";
            blockers.push(issue("payroll_line_negative_net_salary", "The line's own components would make Net Salary negative."));
            recommended = "resolve_blockers";
          } else {
            repairability = "READY";
            recommended = "repair_payroll_line_amounts";
          }
        }
        break;
      case "PAYROLL_PERIOD_TOTALS_MISMATCH":
        if (DRAFT.has(flags.status)) {
          capability = "REBUILD_PAYROLL_PERIOD_TOTALS";
          route = "payroll";
          if (flags.has_payments) {
            repairability = "MANUAL_REVIEW";
            why = UNFINALIZED_WITH_PAYMENTS;
          } else if (flags.amounts_bad || flags.components_bad || flags.legacy_bad) {
            repairability = "BLOCKED";
            blockers.push(
              issue("payroll_line_amounts_first", "Line amounts are inconsistent; repair the lines first (that repair also rebuilds the totals)."),
            );
            recommended = "resolve_blockers";
          } else {
            repairability = "READY";
            recommended = "rebuild_payroll_period_totals";
          }
        }
        break;
      case "PAYROLL_PAYMENT_STATE_INCONSISTENT":
        if (SETTLEMENT.has(flags.status)) {
          capability = "RECONCILE_PAYROLL_PAYMENT_STATE";
          route = "payroll";
          if (flags.alloc_bad || flags.payment_bad) {
            repairability = "MANUAL_REVIEW";
          } else if (flags.amounts_bad || flags.components_bad || flags.legacy_bad || flags.totals_calc_bad) {
            repairability = "MANUAL_REVIEW";
          } else {
            repairability = "READY";
            recommended = "reconcile_payroll_payment_state";
          }
        }
        break;
      case "PAYROLL_ACCOUNTING_EVENT_FAILED":
        capability = "REPROCESS_ACCOUNTING_EVENT";
        route = "accounting_event";
        // Decided per event by the Phase 4 accounting adapter (Preview).
        repairability = "MANUAL_REVIEW";
        recommended = "recover_from_accounting_health";
        break;
      default:
        break;
    }
    findings.push({
      blockers,
      executionRoute: route,
      findingId: findingIdOf(companyId, flags.id, code),
      headline: meta.headline,
      health: meta.health,
      reason: meta.reason,
      reasonCode: code,
      recommendedAction: recommended,
      repairCapability: capability,
      repairability,
      whyNotAutomatic:
        repairability === "MANUAL_REVIEW"
          ? (why ?? WHY_NOT_AUTOMATIC[code] ??
            (DRAFT.has(flags.status)
              ? "This draft line's component snapshots disagree with their records; only the Company's Recalculate re-derives them."
              : "Approved, paid and closed Payroll is immutable financial history (enforced by the Payroll trigger); it is corrected only through the Company's certified reversal."))
          : null,
    });
  }
  return findings;
}

// =============================================================================
// Payroll Health (summary + list), set-based.
// =============================================================================

export interface PayrollHealthSummary {
  readonly companyId: string;
  readonly payrollHealth: "HEALTHY" | "ISSUE" | "REVIEW";
  readonly accountingMode: { readonly enabled: boolean };
  readonly totalPeriods: number;
  readonly periodsWithFindings: number;
  readonly byCode: Readonly<Record<string, number>>;
  readonly driverFeeFindings: number;
  readonly headlines: readonly string[];
  readonly generatedAt: string;
}

export interface PayrollHealthRow {
  readonly entityType: "payroll_period" | "outsourced_driver_fee_accrual";
  readonly entityId: string;
  readonly reference: string;
  readonly status: string | null;
  readonly health: "ISSUE" | "REVIEW";
  readonly codes: readonly string[];
  readonly headline: string;
}

export interface PayrollHealthPage {
  readonly items: readonly PayrollHealthRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly generatedAt: string;
}

export const PAYROLL_HEALTH_MAX_PAGE_SIZE = 100;

function headlinesOf(codes: Iterable<string>): string[] {
  const order: Headline[] = [
    PAYROLL_HEADLINES.calculation,
    PAYROLL_HEADLINES.payment,
    PAYROLL_HEADLINES.accounting,
    PAYROLL_HEADLINES.driverFee,
    PAYROLL_HEADLINES.review,
  ];
  const present = new Set<string>();
  for (const code of codes) {
    const meta = PAYROLL_FINDINGS[code as PayrollFindingCode];
    if (meta !== undefined) present.add(meta.headline);
  }
  return order.filter((headline) => present.has(headline));
}

@Injectable()
export class PlatformPayrollHealthService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  private readOnly<T>(work: (db: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`set transaction read only`.execute(transaction);
      await sql`select set_config('statement_timeout', '30s', true), set_config('jit', 'off', true)`.execute(transaction);
      return work(transaction);
    });
  }

  public summary(companyId: string): Promise<PayrollHealthSummary> {
    return this.readOnly(async (db) => {
      const row = (
        await sql<{ total: number; withFindings: number; codes: string[] | null; fees: string[] | null; on: boolean }>`
          with ${payrollFindingsSql(companyId, null)}, ${driverFeeFindingsSql(companyId)}
          select count(*)::int as total,
                 count(*) filter (where cardinality(codes) > 0)::int as "withFindings",
                 (select array_agg(c) from pcodes, unnest(codes) c) as codes,
                 (select array_agg(code) from dfee) as fees,
                 coalesce((select accounting_enabled from accounting_configurations
                            where company_id = ${companyId}::uuid), false) as on
            from pcodes`.execute(db)
      ).rows[0]!;
      const byCode: Record<string, number> = {};
      for (const code of [...(row.codes ?? []), ...(row.fees ?? [])]) byCode[code] = (byCode[code] ?? 0) + 1;
      const all = Object.keys(byCode);
      const issue = all.some((code) => PAYROLL_FINDINGS[code as PayrollFindingCode]?.health === "ISSUE");
      return {
        accountingMode: { enabled: row.on },
        byCode,
        companyId,
        driverFeeFindings: (row.fees ?? []).length,
        generatedAt: new Date().toISOString(),
        headlines: headlinesOf(all),
        payrollHealth: issue ? "ISSUE" : all.length > 0 ? "REVIEW" : "HEALTHY",
        periodsWithFindings: row.withFindings,
        totalPeriods: row.total,
      };
    });
  }

  public list(
    companyId: string,
    query: { readonly page?: number | undefined; readonly pageSize?: number | undefined; readonly status?: "attention" | "all" | undefined },
  ): Promise<PayrollHealthPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(PAYROLL_HEALTH_MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 25));
    const all = query.status === "all";
    return this.readOnly(async (db) => {
      const result = await sql<{
        entityType: PayrollHealthRow["entityType"];
        entityId: string;
        reference: string;
        status: string | null;
        codes: string[];
        sortKey: string;
        total: number;
      }>`
        with ${payrollFindingsSql(companyId, null)}, ${driverFeeFindingsSql(companyId)},
        rows as (
          select 'payroll_period'::text as "entityType", id::text as "entityId", period_reference as reference,
                 status, codes, period_reference as "sortKey"
            from pcodes where ${all} or cardinality(codes) > 0
          union all
          select 'outsourced_driver_fee_accrual', id::text, coalesce(reference, id::text), null,
                 array_agg(code), max(occurred_on)
            from dfee group by id, reference
        )
        select rows.*, count(*) over ()::int as total from rows
         order by case when cardinality(codes) > 0 then 0 else 1 end, "entityType" desc, "sortKey" desc, "entityId"
         limit ${pageSize} offset ${(page - 1) * pageSize}`.execute(db);
      return {
        generatedAt: new Date().toISOString(),
        items: result.rows.map((row) => {
          const metas = row.codes.map((code) => PAYROLL_FINDINGS[code as PayrollFindingCode]).filter((m) => m !== undefined);
          return {
            codes: row.codes,
            entityId: row.entityId,
            entityType: row.entityType,
            headline: headlinesOf(row.codes)[0] ?? "HEALTHY",
            health: metas.some((meta) => meta.health === "ISSUE") ? "ISSUE" : "REVIEW",
            reference: row.reference,
            status: row.status,
          };
        }),
        page,
        pageSize,
        total: result.rows[0]?.total ?? 0,
      };
    });
  }
}

// =============================================================================
// Repair Preview + Execution for ONE Payroll period.
// =============================================================================

export interface PayrollLineState {
  readonly lineId: string;
  readonly payrollNumber: string;
  readonly employeeId: string;
  readonly employeeNumber: string | null;
  readonly employeeName: string | null;
  readonly employeeActive: boolean | null;
  readonly status: string;
  readonly sourceMarker: string;
  readonly held: boolean;
  readonly components: Readonly<Record<string, string>>;
  readonly current: { readonly gross: string; readonly net: string; readonly paid: string; readonly outstanding: string };
  readonly expected: { readonly gross: string; readonly net: string; readonly paid: string; readonly outstanding: string; readonly status: string };
  readonly flags: {
    readonly amounts: boolean;
    readonly components: boolean;
    readonly payment: boolean;
    readonly allocation: boolean;
  };
}

export interface PayrollPeriodInspection {
  readonly companyId: string;
  readonly periodId: string;
  readonly periodReference: string;
  readonly period: {
    readonly status: string;
    readonly start: string;
    readonly end: string;
    readonly approvedAt: string | null;
    readonly totals: Readonly<Record<string, string>>;
    readonly expectedTotals: Readonly<Record<string, string>>;
  };
  readonly lines: readonly PayrollLineState[];
  readonly payments: readonly {
    readonly paymentId: string;
    readonly paymentNumber: string;
    readonly status: string;
    readonly totalAmount: string;
    readonly activeAllocated: string;
  }[];
  readonly accounting: {
    readonly enabled: boolean;
    readonly events: readonly {
      readonly eventId: string;
      readonly eventType: string;
      readonly status: string;
      readonly recovery: PayrollRepairability | null;
      readonly classificationCode: string | null;
    }[];
  };
  readonly findings: readonly PayrollFinding[];
  readonly health: "HEALTHY" | "ISSUE" | "REVIEW";
  readonly previewVersion: string;
}

const money = (value: Decimal.Value) => new Decimal(value).toFixed(2);

export interface PayrollExecutionResult {
  readonly repairExecutionId: string;
  readonly companyId: string;
  readonly periodId: string;
  readonly periodReference: string;
  readonly findingId: string;
  readonly reasonCode: string;
  readonly capabilityCode: PayrollCapabilityCode;
  readonly status: "succeeded";
  readonly beforeHealth: string;
  readonly afterHealth: string;
  readonly beforePreviewVersion: string;
  readonly afterPreviewVersion: string;
  readonly executedAt: string;
  readonly replayed: boolean;
}

@Injectable()
export class RepairPayrollService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(PayrollOperationalRepository) private readonly payroll: PayrollOperationalRepository,
    @Inject(PlatformAccountingRepairAdapter) private readonly accounting: PlatformAccountingRepairAdapter,
    @Inject(RepairAttemptRecorder) private readonly attempts: RepairAttemptRecorder,
  ) {}

  /** Everything about ONE period, recomputed (no write). `undefined` when not in the Company. */
  public async inspect(db: Kysely<DatabaseSchema>, companyId: string, periodId: string): Promise<PayrollPeriodInspection | undefined> {
    const flags = (
      await sql<PeriodFlags & Record<string, unknown>>`
        with ${payrollFindingsSql(companyId, periodId)}
        select * from pcodes`.execute(db)
    ).rows[0];
    if (flags === undefined) return undefined;
    const detail = (
      await sql<{ state: Omit<PayrollPeriodInspection, "findings" | "health" | "previewVersion" | "companyId" | "periodId" | "accounting"> & {
        accounting: { enabled: boolean; events: { eventId: string; eventType: string; status: string }[] };
        digest: unknown;
      } }>`
        with ${payrollFindingsSql(companyId, periodId)}
        select json_build_object(
          'periodReference', p.period_reference,
          'period', json_build_object(
            'status', p.status, 'start', p.period_start::text, 'end', p.period_end::text,
            'approvedAt', p.approved_at::text,
            'totals', json_build_object(
              'employees', p.total_employees::text, 'basicSalary', p.total_basic_salary::text,
              'allowances', p.total_allowances::text, 'driverCommission', p.total_employee_driver_commission::text,
              'deliveredOrderEarnings', p.total_delivered_order_earnings::text,
              'collectionEarnings', p.total_collection_earnings::text,
              'earningAdjustments', p.total_earning_adjustments::text, 'deductions', p.total_deductions::text,
              'netSalary', p.total_net_salary::text, 'paid', p.total_paid::text, 'outstanding', p.total_outstanding::text),
            'expectedTotals', (select json_build_object(
              'employees', live_lines::text, 'basicSalary', round(s_basic, 2)::text, 'allowances', round(s_allowances, 2)::text,
              'driverCommission', round(s_comm, 2)::text, 'deliveredOrderEarnings', round(s_delivered, 2)::text,
              'collectionEarnings', round(s_collection, 2)::text, 'earningAdjustments', round(s_earning_adj, 2)::text,
              'deductions', round(s_deductions, 2)::text, 'netSalary', round(s_net, 2)::text, 'paid', round(s_paid, 2)::text,
              'outstanding', round(s_outstanding, 2)::text) from pflags)),
          'lines', coalesce((select json_agg(json_build_object(
              'lineId', f.id, 'payrollNumber', e.payroll_number, 'employeeId', f.employee_id,
              'employeeNumber', e.employee_number_snapshot, 'employeeName', e.employee_name_snapshot,
              'employeeActive', emp.is_active, 'status', f.status, 'sourceMarker', f.source_marker, 'held', f.held,
              'components', json_build_object(
                'basicSalary', f.basic::text, 'allowances', f.allowance_total::text, 'allowanceRecords', round(f.alw_s, 2)::text,
                'driverCommission', f.comm::text, 'commissionRecords', round(f.com_s, 2)::text,
                'deliveredOrderEarnings', f.delivered::text, 'collectionEarnings', f.collection::text,
                'earningAdjustments', f.earning_adj::text, 'activeEarningAdjustments', round(f.adj_e, 2)::text,
                'deductionAdjustments', f.deduction_adj::text, 'activeDeductionAdjustments', round(f.adj_d, 2)::text,
                'advances', f.advances::text, 'variableAlreadyPaid', f.variable_paid::text,
                'salaryAdvanceRecovery', f.advance_recovery::text),
              'current', json_build_object('gross', f.gross::text, 'net', f.net::text, 'paid', f.paid::text,
                                           'outstanding', f.outstanding::text),
              'expected', json_build_object('gross', round(f.exp_gross, 2)::text, 'net', round(f.exp_net, 2)::text,
                                            'paid', round(f.active, 2)::text,
                                            'outstanding', round(f.exp_net - f.active, 2)::text, 'status', f.exp_status),
              'flags', json_build_object('amounts', f.amounts_bad, 'components', f.components_bad,
                                         'payment', f.pay_bad, 'allocation', f.alloc_bad))
              order by e.payroll_number) from lflags f
              join payroll_entries e on e.id = f.id and e.company_id = ${companyId}::uuid
              left join employees emp on emp.id = f.employee_id and emp.company_id = ${companyId}::uuid), '[]'::json),
          'payments', coalesce((select json_agg(json_build_object(
              'paymentId', pay.id, 'paymentNumber', pm.payment_number, 'status', pay.status,
              'totalAmount', pay.total_amount::text, 'activeAllocated', round(pay.active, 2)::text) order by pm.payment_number)
              from pay join payroll_payments pm on pm.id = pay.id), '[]'::json),
          'accounting', json_build_object(
            'enabled', coalesce((select c.accounting_enabled from accounting_configurations c
                                  where c.company_id = ${companyId}::uuid), false),
            'events', coalesce((select json_agg(json_build_object('eventId', ae.id, 'eventType', ae.event_type,
                                  'status', ae.processing_status) order by ae.created_at, ae.id)
                from accounting_events ae
               where ae.company_id = ${companyId}::uuid
                 and ((ae.source_entity_type = 'payroll_period' and ae.source_entity_id = p.id)
                   or (ae.source_entity_type = 'payroll_payment' and ae.source_entity_id in (select id from pay)))),
               '[]'::json)),
          -- The fingerprint: every record a Payroll repair depends on.
          'digest', json_build_object(
            'period', (select md5(to_jsonb(x)::text) from payroll_periods x where x.id = p.id),
            'lines', (select md5(string_agg(to_jsonb(x)::text, '|' order by x.id)) from payroll_entries x
                       where x.company_id = ${companyId}::uuid and x.payroll_period_id = p.id),
            'adjustments', (select md5(string_agg(x.id::text || ':' || x.status || ':' || x.version::text || ':' || x.amount::text, '|' order by x.id))
                              from payroll_adjustments x where x.company_id = ${companyId}::uuid and x.payroll_period_id = p.id),
            'allowances', (select md5(string_agg(x.id::text || ':' || x.amount::text, '|' order by x.id))
                             from payroll_line_allowances x where x.company_id = ${companyId}::uuid
                              and x.payroll_line_id in (select id from ln)),
            'commissions', (select md5(string_agg(x.id::text || ':' || x.amount::text, '|' order by x.id))
                              from payroll_commission_links x where x.company_id = ${companyId}::uuid
                               and x.payroll_entry_id in (select id from ln)),
            'payments', (select md5(string_agg(x.id::text || ':' || x.status || ':' || x.version::text, '|' order by x.id))
                           from payroll_payments x where x.company_id = ${companyId}::uuid and x.payroll_period_id = p.id),
            'allocations', (select md5(string_agg(x.id::text || ':' || coalesce(x.reversed_at::text, '-'), '|' order by x.id))
                              from payroll_payment_allocations x where x.company_id = ${companyId}::uuid
                               and x.payroll_line_id in (select id from ln)),
            'employees', (select md5(string_agg(x.id::text || ':' || x.is_active::text, '|' order by x.id))
                            from employees x where x.company_id = ${companyId}::uuid
                             and x.id in (select employee_id from ln)),
            'events', (select md5(string_agg(x.id::text || ':' || x.processing_status || ':' || x.attempt_count::text
                                             || ':' || coalesce(x.journal_id::text, '-'), '|' order by x.id))
                         from accounting_events x where x.company_id = ${companyId}::uuid
                          and ((x.source_entity_type = 'payroll_period' and x.source_entity_id = p.id)
                            or (x.source_entity_type = 'payroll_payment' and x.source_entity_id in (select id from pay)))),
            'configuration', (select c.version::text || ':' || c.accounting_enabled::text from accounting_configurations c
                                where c.company_id = ${companyId}::uuid))
        ) as state
          from payroll_periods p
         where p.id = ${periodId}::uuid and p.company_id = ${companyId}::uuid`.execute(db)
    ).rows[0]!.state;
    const findings = classifyPeriod(companyId, flags);
    // Accounting events: the Phase 4 adapter decides recovery (never a second system).
    const events = await Promise.all(
      detail.accounting.events.map(async (event) => {
        if (!["failed", "blocked_configuration"].includes(event.status)) {
          return { ...event, classificationCode: null, recovery: null };
        }
        const inspection = await this.accounting.inspect(db === this.database ? null : db, companyId, event.eventId);
        return {
          ...event,
          classificationCode: inspection?.classificationCode ?? null,
          recovery: inspection?.repairability ?? null,
        };
      }),
    );
    const accountingFinding = findings.find((finding) => finding.reasonCode === "PAYROLL_ACCOUNTING_EVENT_FAILED");
    // Phase 6 ordering: operational Payroll findings are repaired before the accounting recovery.
    const operationalFirst = flags.codes.filter((code) => PAYROLL_OPERATIONAL_CODES.has(code));
    if (operationalFirst.length > 0) {
      for (const [index, event] of events.entries()) {
        if (event.recovery === "READY") events[index] = { ...event, recovery: "BLOCKED" };
      }
    }
    const adjusted = findings.map((finding) => {
      if (finding !== accountingFinding) return finding;
      const states = events.map((event) => event.recovery).filter((state) => state !== null);
      const repairability: PayrollRepairability = states.includes("READY")
        ? "READY"
        : states.includes("BLOCKED")
          ? "BLOCKED"
          : "MANUAL_REVIEW";
      const ordering =
        operationalFirst.length > 0 && repairability === "BLOCKED"
          ? [
              {
                code: "payroll_repair_first",
                message: `Resolve this period's Payroll finding first (${operationalFirst.join(", ")}); the accounting recovery would otherwise post an inconsistent Payroll state.`,
              },
            ]
          : [];
      return {
        ...finding,
        blockers: [...finding.blockers, ...ordering],
        recommendedAction: ordering.length > 0 ? "repair_payroll_first" : finding.recommendedAction,
        repairability,
        whyNotAutomatic:
          repairability === "MANUAL_REVIEW"
            ? "Accounting Health classifies the failed event MANUAL_REVIEW (see each event's classification); no certified recovery applies."
            : null,
      };
    });
    const { digest, ...rest } = detail;
    const health: PayrollPeriodInspection["health"] = adjusted.some((finding) => finding.health === "ISSUE")
      ? "ISSUE"
      : adjusted.length > 0
        ? "REVIEW"
        : "HEALTHY";
    return {
      ...rest,
      accounting: { enabled: detail.accounting.enabled, events },
      companyId,
      findings: adjusted,
      health,
      periodId,
      previewVersion: `prv1:${createHash("sha256").update(canonicalJson({ digest, flags })).digest("hex")}`,
    };
  }

  /** Read-only Preview (the details view): recomputed, no write. */
  public async preview(companyId: string, periodId: string) {
    const inspection = await this.inspect(this.database, companyId, periodId);
    if (inspection === undefined) {
      throw new ApplicationException("payroll_period_not_found", "The Payroll period was not found", HttpStatus.NOT_FOUND);
    }
    return {
      ...inspection,
      findings: inspection.findings.map((finding) => ({
        ...finding,
        execution:
          finding.repairability === "READY" && finding.executionRoute === "payroll"
            ? { available: true, requiredPlatformPermission: PLATFORM_REPAIR_CENTER_EXECUTE_PERMISSION }
            : { available: false, requiredPlatformPermission: PLATFORM_REPAIR_CENTER_EXECUTE_PERMISSION },
        plannedOperation: plannedOperationOf(finding),
        expectedResult:
          finding.repairability === "READY" && finding.executionRoute === "payroll"
            ? "The finding is resolved; no Payroll line, payment, adjustment, allocation or accounting record is created or deleted."
            : "Nothing changes.",
      })),
      generatedAt: new Date().toISOString(),
      requiredPermission: PLATFORM_REPAIR_CENTER_EXECUTE_PERMISSION,
    };
  }

  public async execute(
    companyId: string,
    periodId: string,
    request: RepairExecutionRequest,
    actor: RepairExecutionActor,
  ): Promise<PayrollExecutionResult> {
    const progress = { entityNumber: null as string | null, reasonCode: null as string | null, stage: "checking" as "checking" | "executing" };
    const record = (result: "REFUSED" | "FAILED" | "REPLAYED", error?: unknown, executionId?: string) =>
      this.attempts.record({
        actorAccountId: actor.accountId,
        actorAuthority: actor.authority,
        capabilityCode: typeof request.capabilityCode === "string" ? request.capabilityCode : null,
        companyId,
        correlationId: actor.correlationId,
        entityId: periodId,
        entityNumber: progress.entityNumber,
        entityType: "payroll_period",
        error,
        findingId: typeof request.findingId === "string" ? request.findingId : null,
        idempotencyKey: typeof request.idempotencyKey === "string" ? request.idempotencyKey : null,
        previewVersion: typeof request.previewVersion === "string" ? request.previewVersion : null,
        reason: typeof request.reason === "string" ? request.reason : null,
        reasonCode: progress.reasonCode,
        repairExecutionId: executionId ?? null,
        result,
      });
    try {
      const result = await this.run(companyId, periodId, request, actor, progress);
      if (result.replayed) {
        progress.entityNumber = result.periodReference;
        progress.reasonCode = result.reasonCode;
        await record("REPLAYED", undefined, result.repairExecutionId);
      }
      return result;
    } catch (error) {
      await record(progress.stage === "executing" ? "FAILED" : "REFUSED", error);
      throw error;
    }
  }

  private async run(
    companyId: string,
    periodId: string,
    request: RepairExecutionRequest,
    actor: RepairExecutionActor,
    progress: { entityNumber: string | null; reasonCode: string | null; stage: "checking" | "executing" },
  ): Promise<PayrollExecutionResult> {
    const reason = typeof request.reason === "string" ? request.reason.trim() : "";
    if (reason === "") throw new ApplicationException("repair_reason_required", "A reason is required", HttpStatus.BAD_REQUEST);
    if (!(PAYROLL_CAPABILITIES as readonly string[]).includes(request.capabilityCode)) {
      throw new ApplicationException(
        "repair_capability_not_applicable",
        request.capabilityCode === "REPROCESS_ACCOUNTING_EVENT"
          ? "Payroll accounting events are recovered from Accounting Health (the Phase 4 accounting recovery), not from the Payroll route"
          : "This capability does not apply to a Payroll period",
        HttpStatus.CONFLICT,
      );
    }
    const inputs = request.inputs ?? {};
    if (Object.keys(inputs).some((name) => name !== "reason")) {
      throw new ApplicationException("repair_inputs_invalid", "The repair inputs do not match what this repair requires", HttpStatus.BAD_REQUEST);
    }
    const capability = request.capabilityCode as PayrollCapabilityCode;
    const requestHash = createHash("sha256")
      .update(canonicalJson({ capabilityCode: capability, findingId: request.findingId, inputs, periodId, previewVersion: request.previewVersion, reason }))
      .digest("hex");
    return this.database.transaction().execute(async (transaction) => {
      await sql`select set_config('statement_timeout', '60s', true), set_config('jit', 'off', true)`.execute(transaction);
      // 1. Lock the period inside its Company (every Payroll writer locks it too).
      const locked = await sql<{ reference: string }>`
        select period_reference as reference from payroll_periods
         where id = ${periodId}::uuid and company_id = ${companyId}::uuid for update`.execute(transaction);
      if (locked.rows[0] === undefined) {
        throw new ApplicationException("payroll_period_not_found", "The Payroll period was not found", HttpStatus.NOT_FOUND);
      }
      progress.entityNumber = locked.rows[0].reference;
      // 2. Idempotency, scoped to (Company, capability, period, key).
      const prior = await sql<{ requestHash: string; resultSummary: PayrollExecutionResult }>`
        select request_hash as "requestHash", result_summary as "resultSummary" from platform_repair_executions
         where company_id = ${companyId}::uuid and capability_code = ${capability}
           and entity_id = ${periodId}::uuid and idempotency_key = ${request.idempotencyKey}`.execute(transaction);
      if (prior.rows[0] !== undefined) {
        if (prior.rows[0].requestHash !== requestHash) {
          throw new ApplicationException(
            "repair_idempotency_conflict",
            "This idempotency key was already used for a different repair request",
            HttpStatus.CONFLICT,
          );
        }
        return { ...prior.rows[0].resultSummary, replayed: true };
      }
      // 3. Recompute under the lock and compare with the Preview.
      const before = (await this.inspect(transaction, companyId, periodId))!;
      const finding = before.findings.find((item) => item.findingId === request.findingId);
      if (finding === undefined) {
        throw new ApplicationException(
          "repair_finding_not_current",
          "That finding is not current for this Payroll period any more; refresh the Preview",
          HttpStatus.CONFLICT,
        );
      }
      progress.reasonCode = finding.reasonCode;
      if (finding.repairCapability !== capability || finding.executionRoute !== "payroll") {
        throw new ApplicationException(
          "repair_capability_not_applicable",
          "No certified Payroll repair applies to this finding",
          HttpStatus.CONFLICT,
        );
      }
      if (before.previewVersion !== request.previewVersion) {
        throw new ApplicationException(
          "repair_preview_stale",
          "The Payroll period changed after the repair preview. Refresh and review the new state before repairing.",
          HttpStatus.CONFLICT,
        );
      }
      if (finding.repairability !== "READY") {
        throw new ApplicationException(
          "repair_not_ready",
          `This repair is ${finding.repairability}; only a READY repair can be executed`,
          HttpStatus.CONFLICT,
          finding.blockers.map((blocker) => blocker.code),
        );
      }
      // 4. The certified Payroll operation (failures from here on are FAILED).
      progress.stage = "executing";
      await this.apply(transaction, companyId, periodId, capability, before);
      // 5. Verify in the same transaction: the finding is gone and nothing new appeared.
      const after = (await this.inspect(transaction, companyId, periodId))!;
      const failures: string[] = [];
      if (after.findings.some((item) => item.reasonCode === finding.reasonCode)) {
        failures.push(`${finding.reasonCode} is still present`);
      }
      const beforeCodes = new Set(before.findings.map((item) => item.reasonCode));
      for (const item of after.findings) {
        if (!beforeCodes.has(item.reasonCode)) failures.push(`new finding ${item.reasonCode}`);
      }
      if (failures.length > 0) {
        throw new ApplicationException(
          "repair_verification_failed",
          "The Payroll repair did not verify; everything was rolled back",
          HttpStatus.CONFLICT,
          failures,
        );
      }
      // 6. Immutable audit + idempotency record.
      const id = randomUUID();
      const executedAt = new Date().toISOString();
      const result: PayrollExecutionResult = {
        afterHealth: after.health,
        afterPreviewVersion: after.previewVersion,
        beforeHealth: before.health,
        beforePreviewVersion: before.previewVersion,
        capabilityCode: capability,
        companyId,
        executedAt,
        findingId: finding.findingId,
        periodId,
        periodReference: before.periodReference,
        reasonCode: finding.reasonCode,
        repairExecutionId: id,
        replayed: false,
        status: "succeeded",
      };
      await sql`
        insert into platform_repair_executions (
          id, company_id, order_id, entity_type, entity_id, entity_number, finding_id, reason_code,
          capability_code, preview_version, actor_account_id, actor_authority, reason, requested_inputs,
          before_state_fingerprint, after_state_fingerprint, before_health, after_health,
          before_classification, after_classification, result, result_summary, idempotency_key,
          request_hash, correlation_id, created_at
        ) values (
          ${id}::uuid, ${companyId}::uuid, null, 'payroll_period', ${periodId}::uuid, ${before.periodReference},
          ${finding.findingId}, ${finding.reasonCode}, ${capability}, ${request.previewVersion},
          ${actor.accountId}::uuid, ${actor.authority}, ${reason}, '{}'::jsonb,
          ${before.previewVersion}, ${after.previewVersion}, ${before.health}, ${after.health},
          ${before.period.status}, ${after.period.status}, 'succeeded', ${JSON.stringify(result)}::jsonb,
          ${request.idempotencyKey}, ${requestHash}, ${actor.correlationId}, ${executedAt}::timestamptz
        )`.execute(transaction);
      return result;
    });
  }

  /** The certified Payroll domain operations; no other write. */
  protected async apply(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
    periodId: string,
    capability: PayrollCapabilityCode,
    before: PayrollPeriodInspection,
  ): Promise<void> {
    switch (capability) {
      case "RECONCILE_PAYROLL_PAYMENT_STATE":
        await this.payroll.reconcilePaymentState(transaction, companyId, periodId);
        return;
      case "REPAIR_PAYROLL_LINE_AMOUNTS":
        // Only lines the current calculation produced: a legacy line's inputs
        // are not provable, so it is never recomputed (it stays REVIEW).
        for (const line of before.lines.filter(
          (item) => item.flags.amounts && item.status !== "reversed" && item.sourceMarker === "new_payroll",
        )) {
          await this.payroll.recalculateLine(transaction, companyId, line.lineId);
        }
        await this.payroll.recalculatePeriodTotals(transaction, companyId, periodId);
        return;
      case "REBUILD_PAYROLL_PERIOD_TOTALS":
        await this.payroll.recalculatePeriodTotals(transaction, companyId, periodId);
        return;
    }
  }
}

function plannedOperationOf(finding: PayrollFinding): string {
  switch (finding.repairCapability) {
    case "RECONCILE_PAYROLL_PAYMENT_STATE":
      return "PayrollOperationalRepository.reconcilePaymentState: paid / outstanding from the active payment allocations, then the period totals and the line / period settlement statuses (the steps a payment reversal runs).";
    case "REPAIR_PAYROLL_LINE_AMOUNTS":
      return "PayrollOperationalRepository.recalculateLine for each inconsistent line (the authoritative gross / net from the line's own snapshots and active adjustments), then recalculatePeriodTotals.";
    case "REBUILD_PAYROLL_PERIOD_TOTALS":
      return "PayrollOperationalRepository.recalculatePeriodTotals: the header totals as the sum of the period's lines.";
    case "REPROCESS_ACCOUNTING_EVENT":
      return "Recover the failed event from Accounting Health (Phase 4 accounting recovery: certified precheck, same posting core, one balanced Journal).";
    default:
      return "None: no automatic repair applies.";
  }
}

export { money as payrollMoney };
