import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { createHash } from "node:crypto";

import {
  countsInOperationalBalance,
  duplicatePaymentTrail,
  inflowTrail,
} from "../accounting/cash-trail-classification.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import {
  effectiveOffsetTotal,
  effectiveOffset,
  effectiveSettlementCount,
  effectiveSettlement,
} from "../operations/effective-settlement-offsets.js";
import { closeSettlementComplete } from "../operations/order-close-eligibility.js";

export interface IntegrityFinding {
  readonly checkId: string;
  readonly checkLabel: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly severity: "high" | "medium" | "low";
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectReference: string;
  readonly detail: string;
  readonly code?: string;
  readonly accepted?: boolean;
  readonly fingerprint?: string;
}

export interface CompanyIntegrityCheck {
  readonly code: string;
  readonly severity: "critical" | "warning";
  readonly title: string;
  readonly count: number;
  readonly findings: readonly IntegrityFinding[];
}

export interface CompanyIntegrityReport {
  readonly companyId: string;
  readonly criticalCount: number;
  readonly warningCount: number;
  readonly previouslyReviewedCount: number;
  readonly checks: readonly CompanyIntegrityCheck[];
}

/**
 * The Integration Integrity Checker -- read-only, by design, per the
 * decision recorded 2026-08-04: this ships as a DETECTOR first. No check
 * here writes anything. Auto-repair, if it ever comes, is added per check
 * only after real findings have been reviewed, and even then under a strict
 * three-tier policy (safe-to-auto-fix / needs-explicit-approval /
 * never-auto-fix -- posting or adjusting a Journal to force totals to agree
 * is permanently in the last tier: it destroys the audit trail and hides
 * the defect instead of finding it).
 *
 * Every check answers the same underlying question: "did an operation that
 * should have written to two tables together actually write to both, or
 * did one leg silently go missing?" Postgres transactions make a genuine
 * HALF-committed write impossible within one operation -- what actually
 * happens is a code path that never attempted the second write at all, so
 * both sides stay internally consistent while silently disagreeing with
 * each other. That drift is exactly what these queries surface.
 *
 * Each check is a single query across every Company at once (not N+1 per
 * Company), grouped by `company_id` in the result so the Platform screen can
 * show or filter "which Companies have drift" without a second round trip.
 */
@Injectable()
export class IntegrityCheckService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async runAll(companyId?: string): Promise<readonly IntegrityFinding[]> {
    const results = await Promise.all([
      this.deliveredOrdersMissingAccountingEvent(companyId),
      this.stuckAccountingEvents(companyId),
      this.unbalancedPostedJournals(companyId),
      // Operational Finance checks. They read operational tables only, so
      // they run identically whether the Company's GL Accounting is ON or OFF.
      this.receivablesCollectedBeyondDue(companyId),
      this.receivableCollectedAmountInconsistent(companyId),
      this.receivablesSettledMoreThanOnce(companyId),
      this.settlementOffsetsWithInvalidReference(companyId),
      this.cashDoubleCountCandidates(companyId),
      this.payrollPaymentCashInconsistent(companyId),
      this.generalExpensePaymentCashInconsistent(companyId),
    ]);
    return results.flat();
  }

  /*
   * -------------------------------------------------------------------------
   * Operational Finance checks (both GL Accounting modes)
   * -------------------------------------------------------------------------
   *
   * Receivable arithmetic uses EFFECTIVE amounts only:
   *   - physical: allocations of Collections that are still `confirmed`;
   *   - offsets:  rows whose Settlement is confirmed, not a reversal and not
   *               reversed (effective-settlement-offsets.ts).
   * A reversed Settlement's offsets are HISTORICAL. They stay in the table
   * and are never counted, so SET-A -> reversal -> SET-B is one settlement,
   * not a duplicate.
   */

  /** 1. Effective collections + effective offsets exceed the amount due. */
  private async receivablesCollectedBeyondDue(
    companyId?: string,
  ): Promise<readonly IntegrityFinding[]> {
    const rows = await sql<ReceivableAmountsRow>`
      select r.company_id as "companyId", c.name_en as "companyName",
             r.id as "receivableId", r.receivable_number as "receivableNumber",
             r.original_amount_due::text as "originalAmountDue",
             r.amount_collected::text as "amountCollected",
             ${effectivePhysical()}::text as "effectivePhysical",
             ${effectiveOffsetTotal("r")}::text as "effectiveOffsets"
        from trader_receivables r
        join companies c on c.id = r.company_id
       where (${companyId ?? null}::uuid is null or r.company_id = ${companyId ?? null}::uuid)
         and (r.amount_collected > r.original_amount_due
              or ${effectivePhysical()} + ${effectiveOffsetTotal("r")} > r.original_amount_due)
       order by r.company_id, r.receivable_number
    `.execute(this.database);
    return rows.rows.map((row) => ({
      checkId: "receivable_collected_beyond_due",
      checkLabel: "Trader Receivable collected beyond the amount due",
      companyId: row.companyId,
      companyName: row.companyName,
      detail: `${row.receivableNumber} is due AED ${row.originalAmountDue} but shows AED ${row.amountCollected} collected (effective collections ${row.effectivePhysical} + effective offsets ${row.effectiveOffsets}).`,
      severity: "high",
      subjectId: row.receivableId,
      subjectReference: row.receivableNumber,
      subjectType: "trader_receivable",
    }));
  }

  /**
   * 2. The stored collected amount (and so the generated outstanding amount)
   * disagrees with effective collections + effective offsets.
   */
  private async receivableCollectedAmountInconsistent(
    companyId?: string,
  ): Promise<readonly IntegrityFinding[]> {
    const rows = await sql<ReceivableAmountsRow & { outstandingAmount: string }>`
      select r.company_id as "companyId", c.name_en as "companyName",
             r.id as "receivableId", r.receivable_number as "receivableNumber",
             r.original_amount_due::text as "originalAmountDue",
             r.amount_collected::text as "amountCollected",
             r.outstanding_amount::text as "outstandingAmount",
             ${effectivePhysical()}::text as "effectivePhysical",
             ${effectiveOffsetTotal("r")}::text as "effectiveOffsets"
        from trader_receivables r
        join companies c on c.id = r.company_id
       where (${companyId ?? null}::uuid is null or r.company_id = ${companyId ?? null}::uuid)
         and r.status <> 'cancelled'
         and r.amount_collected <> ${effectivePhysical()} + ${effectiveOffsetTotal("r")}
       order by r.company_id, r.receivable_number
    `.execute(this.database);
    return rows.rows.map((row) => ({
      checkId: "receivable_outstanding_inconsistent",
      checkLabel: "Trader Receivable outstanding disagrees with its collections and offsets",
      companyId: row.companyId,
      companyName: row.companyName,
      detail: `${row.receivableNumber} records AED ${row.amountCollected} collected (outstanding ${row.outstandingAmount}), but effective collections ${row.effectivePhysical} + effective offsets ${row.effectiveOffsets} say otherwise.`,
      severity: "high",
      subjectId: row.receivableId,
      subjectReference: row.receivableNumber,
      subjectType: "trader_receivable",
    }));
  }

  /**
   * 3. Effectively settled more than once: fully offset by two or more
   * EFFECTIVE Settlements, or reversed on its own (Trader Credit issued)
   * while no effective offset remains -- the Trader compensated twice.
   */
  private async receivablesSettledMoreThanOnce(
    companyId?: string,
  ): Promise<readonly IntegrityFinding[]> {
    const rows = await sql<{
      companyId: string;
      companyName: string;
      receivableId: string;
      receivableNumber: string;
      fullSettlements: number;
      creditNumber: string | null;
      effectiveOffsets: string;
      status: string;
    }>`
      select * from (
        select r.company_id as "companyId", c.name_en as "companyName",
               r.id as "receivableId", r.receivable_number as "receivableNumber",
               r.status,
               (select count(distinct x.settlement_id)::int
                  from trader_settlement_receivable_offsets x
                  join trader_settlements s on s.id = x.settlement_id and s.company_id = x.company_id
                 where x.company_id = r.company_id and x.receivable_id = r.id
                   and x.amount_allocated >= r.original_amount_due
                   and ${effectiveSettlement("s")}) as "fullSettlements",
               (select tc.credit_number from trader_credits tc
                 where tc.company_id = r.company_id and tc.source_receivable_id = r.id
                   and tc.source_type = 'receivable_offset_reversal'
                   and tc.status <> 'cancelled' limit 1) as "creditNumber",
               ${effectiveOffsetTotal("r")}::text as "effectiveOffsets"
          from trader_receivables r
          join companies c on c.id = r.company_id
         where (${companyId ?? null}::uuid is null or r.company_id = ${companyId ?? null}::uuid)
      ) checked
       where checked."fullSettlements" > 1
          or (checked."creditNumber" is not null and checked."effectiveOffsets"::numeric = 0)
       order by checked."companyId", checked."receivableNumber"
    `.execute(this.database);
    return rows.rows.map((row) => ({
      checkId: "receivable_settled_more_than_once",
      checkLabel: "Trader Receivable effectively settled more than once",
      companyId: row.companyId,
      companyName: row.companyName,
      detail:
        row.fullSettlements > 1
          ? `${row.receivableNumber} is fully offset by ${row.fullSettlements} effective Settlements.`
          : `${row.receivableNumber} was compensated by Trader Credit ${row.creditNumber ?? ""} but no effective Settlement offset remains (status ${row.status}).`,
      severity: "high",
      subjectId: row.receivableId,
      subjectReference: row.receivableNumber,
      subjectType: "trader_receivable",
    }));
  }

  /**
   * 4. A Settlement offset that points at a Receivable of another Trader or
   * Company, a cancelled Receivable, a service-charge Receivable whose Order
   * does not exist in the Company, or that sits on a reversal Settlement.
   */
  private async settlementOffsetsWithInvalidReference(
    companyId?: string,
  ): Promise<readonly IntegrityFinding[]> {
    const rows = await sql<{
      companyId: string;
      companyName: string;
      offsetId: string;
      settlementNumber: string | null;
      receivableNumber: string | null;
      problem: string;
    }>`
      select * from (
        select x.company_id as "companyId", c.name_en as "companyName", x.id as "offsetId",
               s.settlement_number as "settlementNumber", r.receivable_number as "receivableNumber",
               case
                 when s.id is null or s.company_id <> x.company_id then 'settlement missing or in another Company'
                 when r.id is null or r.company_id <> x.company_id then 'receivable missing or in another Company'
                 when r.trader_id <> s.trader_id then 'receivable belongs to another Trader'
                 when s.reversal_of_id is not null then 'offset recorded on a reversal Settlement'
                 when r.status = 'cancelled' then 'receivable is cancelled'
                 when r.source_type = 'service_charge' and not exists (
                   select 1 from orders o
                    where o.company_id = r.company_id and o.order_number = r.source_reference
                 ) then 'service-charge receivable has no Order in the Company'
               end as problem
          from trader_settlement_receivable_offsets x
          join companies c on c.id = x.company_id
          left join trader_settlements s on s.id = x.settlement_id
          left join trader_receivables r on r.id = x.receivable_id
         where (${companyId ?? null}::uuid is null or x.company_id = ${companyId ?? null}::uuid)
      ) checked
       where checked.problem is not null
       order by checked."companyId", checked."settlementNumber"
    `.execute(this.database);
    return rows.rows.map((row) => ({
      checkId: "settlement_offset_invalid_reference",
      checkLabel: "Settlement offset references an invalid Receivable",
      companyId: row.companyId,
      companyName: row.companyName,
      detail: `Offset of ${row.receivableNumber ?? "an unknown Receivable"} on ${row.settlementNumber ?? "an unknown Settlement"}: ${row.problem}.`,
      severity: "high",
      subjectId: row.offsetId,
      subjectReference: row.settlementNumber ?? row.offsetId,
      subjectType: "trader_settlement_receivable_offset",
    }));
  }

  /**
   * 5. A Movement the operational balance counts although it is the trail of
   * a payment the balance already counts from its own table, or a second
   * counted trail of the same Collection / Driver Cash reconciliation.
   */
  private async cashDoubleCountCandidates(
    companyId?: string,
  ): Promise<readonly IntegrityFinding[]> {
    const rows = await sql<{
      companyId: string;
      companyName: string;
      movementId: string;
      movementNumber: string;
      amount: string;
      correlationId: string | null;
      duplicateTrail: boolean;
    }>`
      select m.company_id as "companyId", c.name_en as "companyName",
             m.id as "movementId", m.movement_number as "movementNumber",
             m.amount::text as amount, m.correlation_id as "correlationId",
             ${duplicatePaymentTrail("m")} as "duplicateTrail"
        from cash_bank_movements m
        join companies c on c.id = m.company_id
       where (${companyId ?? null}::uuid is null or m.company_id = ${companyId ?? null}::uuid)
         and m.status in ('confirmed', 'reversed') and m.reversal_of_movement_id is null
         and ${countsInOperationalBalance("m")}
         and (
           ${duplicatePaymentTrail("m")}
           or (${inflowTrail("m")} and exists (
                 select 1 from cash_bank_movements m2
                  where m2.company_id = m.company_id and m2.id <> m.id
                    and m2.correlation_id = m.correlation_id
                    and m2.status in ('confirmed', 'reversed')
                    and m2.reversal_of_movement_id is null
                    and ${countsInOperationalBalance("m2")}))
         )
       order by m.company_id, m.movement_number
    `.execute(this.database);
    return rows.rows.map((row) => ({
      checkId: "cash_double_count_candidate",
      checkLabel: "Cash Movement possibly counted twice",
      companyId: row.companyId,
      companyName: row.companyName,
      detail: row.duplicateTrail
        ? `${row.movementNumber} (AED ${row.amount}) is the cash trail of a payment the balance already counts, yet it is counted itself.`
        : `${row.movementNumber} (AED ${row.amount}) is one of several counted cash trails of source ${row.correlationId ?? ""}.`,
      severity: "high",
      subjectId: row.movementId,
      subjectReference: row.movementNumber,
      subjectType: "cash_bank_movement",
    }));
  }

  /**
   * 6. A confirmed Payroll payment the cash balance cannot see (no Cash
   * account), or whose cash trail disagrees with it in amount or count.
   */
  private async payrollPaymentCashInconsistent(
    companyId?: string,
  ): Promise<readonly IntegrityFinding[]> {
    const rows = await sql<{
      companyId: string;
      companyName: string;
      paymentId: string;
      paymentNumber: string;
      totalAmount: string;
      trailCount: number;
      trailAmount: string;
      hasCashAccount: boolean;
    }>`
      select * from (
        select p.company_id as "companyId", c.name_en as "companyName",
               p.id as "paymentId", p.payment_number as "paymentNumber",
               p.total_amount::text as "totalAmount",
               p.company_cash_account_id is not null as "hasCashAccount",
               (select count(*)::int from cash_bank_movements m
                 where m.company_id = p.company_id and m.correlation_id = p.id::text
                   and m.status in ('confirmed', 'reversed')
                   and m.reversal_of_movement_id is null) as "trailCount",
               (select coalesce(sum(m.amount), 0)::text from cash_bank_movements m
                 where m.company_id = p.company_id and m.correlation_id = p.id::text
                   and m.status in ('confirmed', 'reversed')
                   and m.reversal_of_movement_id is null) as "trailAmount"
          from payroll_payments p
          join companies c on c.id = p.company_id
         where p.status = 'confirmed'
           and (${companyId ?? null}::uuid is null or p.company_id = ${companyId ?? null}::uuid)
      ) checked
       where not checked."hasCashAccount"
          or checked."trailCount" > 1
          or (checked."trailCount" = 1 and checked."trailAmount"::numeric <> checked."totalAmount"::numeric)
       order by checked."companyId", checked."paymentNumber"
    `.execute(this.database);
    return rows.rows.map((row) => ({
      checkId: "payroll_payment_cash_inconsistent",
      checkLabel: "Payroll payment cash effect inconsistent",
      companyId: row.companyId,
      companyName: row.companyName,
      detail: !row.hasCashAccount
        ? `${row.paymentNumber} (AED ${row.totalAmount}) is confirmed but names no Cash account, so no balance reflects it.`
        : `${row.paymentNumber} pays AED ${row.totalAmount} but has ${row.trailCount} cash trail(s) totalling AED ${row.trailAmount}.`,
      severity: "high",
      subjectId: row.paymentId,
      subjectReference: row.paymentNumber,
      subjectType: "payroll_payment",
    }));
  }

  /**
   * 7. A confirmed General Expense payment whose account rows do not add up
   * to it, whose cash part names no Cash account, or whose Expense's paid
   * amount disagrees with its confirmed payments.
   */
  private async generalExpensePaymentCashInconsistent(
    companyId?: string,
  ): Promise<readonly IntegrityFinding[]> {
    const rows = await sql<{
      companyId: string;
      companyName: string;
      paymentId: string;
      paymentNumber: string;
      amount: string;
      problem: string;
    }>`
      select * from (
        select g.company_id as "companyId", c.name_en as "companyName",
               g.id as "paymentId", g.payment_number as "paymentNumber", g.amount::text as amount,
               case
                 when g.amount <> coalesce((select sum(gr.amount) from general_expense_payment_rows gr
                         where gr.company_id = g.company_id
                           and gr.general_expense_payment_id = g.id), 0)
                   then 'payment rows do not add up to the payment'
                 when g.cash_amount <> coalesce((select sum(gr.amount) from general_expense_payment_rows gr
                         where gr.company_id = g.company_id
                           and gr.general_expense_payment_id = g.id
                           and gr.payment_method = 'cash'), 0)
                   then 'cash rows do not add up to the cash amount'
                 when exists (select 1 from general_expense_payment_rows gr
                               where gr.company_id = g.company_id
                                 and gr.general_expense_payment_id = g.id
                                 and gr.payment_method = 'cash'
                                 and gr.company_cash_account_id is null)
                   then 'a cash row names no Cash account, so no balance reflects it'
                 when e.paid_amount <> coalesce((select sum(p2.amount) from general_expense_payments p2
                         where p2.company_id = e.company_id and p2.general_expense_id = e.id
                           and p2.status = 'confirmed'), 0)
                   then 'the Expense paid amount disagrees with its confirmed payments'
               end as problem
          from general_expense_payments g
          join general_expenses e on e.id = g.general_expense_id and e.company_id = g.company_id
          join companies c on c.id = g.company_id
         where g.status = 'confirmed'
           and (${companyId ?? null}::uuid is null or g.company_id = ${companyId ?? null}::uuid)
      ) checked
       where checked.problem is not null
       order by checked."companyId", checked."paymentNumber"
    `.execute(this.database);
    return rows.rows.map((row) => ({
      checkId: "general_expense_payment_cash_inconsistent",
      checkLabel: "General Expense payment cash effect inconsistent",
      companyId: row.companyId,
      companyName: row.companyName,
      detail: `${row.paymentNumber} (AED ${row.amount}): ${row.problem}.`,
      severity: "high",
      subjectId: row.paymentId,
      subjectReference: row.paymentNumber,
      subjectType: "general_expense_payment",
    }));
  }

  /**
   * A delivered/closed Order with a real Trader payable that has no
   * `order_delivered` Accounting Event at all -- the capture step never ran.
   * Orders delivered while the Company's GL Accounting was OFF are excluded:
   * for them no Event is the correct, healthy state.
   * Free/zero-value Orders are excluded on purpose: those are deliberately
   * skipped by capture (see `order_capture_skips_zero_value_orders`), not a
   * defect, so including them would just be noise on every healthy Company.
   */
  private async deliveredOrdersMissingAccountingEvent(
    companyId?: string,
  ): Promise<readonly IntegrityFinding[]> {
    const result = await sql<{
      companyId: string;
      companyName: string;
      orderId: string;
      orderNumber: string;
      traderNetPayable: string;
    }>`
      select o.company_id as "companyId", c.name_en as "companyName",
             o.id as "orderId", o.order_number as "orderNumber",
             o.trader_net_payable::text as "traderNetPayable"
        from orders o
        join companies c on c.id = o.company_id
       where o.delivery_status in ('delivered', 'closed')
         and o.is_free_order = false
         and o.trader_net_payable > 0
         and (${companyId ?? null}::uuid is null or o.company_id = ${companyId ?? null}::uuid)
         -- Only an Order delivered while the Company's GL Accounting was ON
         -- should have an Event. Delivered while OFF, no Event is the healthy
         -- state -- and that stays true after Accounting is later enabled, so
         -- the test is the mode AT DELIVERY, read from the configuration
         -- history, not the mode today. A failure that happened while ON is
         -- still reported even if the Company has since been switched OFF.
         and accounting_enabled_at(o.company_id, coalesce(o.delivered_at, o.updated_at))
         and not exists (
           select 1 from accounting_events e
            where e.source_entity_type = 'order' and e.source_entity_id = o.id
              and e.company_id = o.company_id
         )
       order by o.company_id, o.order_number
    `.execute(this.database);
    return result.rows.map((row) => ({
      checkId: "order_missing_accounting_event",
      checkLabel: "Delivered Order with no Accounting Event",
      companyId: row.companyId,
      companyName: row.companyName,
      detail: `${row.orderNumber} has a Trader payable of AED ${row.traderNetPayable} but no Accounting Event was ever captured for it.`,
      severity: "high",
      subjectId: row.orderId,
      subjectReference: row.orderNumber,
      subjectType: "order",
    }));
  }

  /**
   * An Accounting Event that has sat outside its terminal states
   * (`posted`/`reversed`/`ignored_duplicate`) for more than 24 hours --
   * capture started but the walk to a Journal never finished, and the
   * normal retry path has evidently not resolved it either.
   */
  private async stuckAccountingEvents(companyId?: string): Promise<readonly IntegrityFinding[]> {
    const result = await sql<{
      companyId: string;
      companyName: string;
      eventId: string;
      eventType: string;
      processingStatus: string;
      createdAt: string;
    }>`
      select e.company_id as "companyId", c.name_en as "companyName",
             e.id as "eventId", e.event_type as "eventType",
             e.processing_status as "processingStatus", e.created_at::text as "createdAt"
        from accounting_events e
        join companies c on c.id = e.company_id
       where e.processing_status not in ('posted', 'reversed', 'ignored_duplicate', 'ignored_no_accounting_required')
         and e.created_at < now() - interval '24 hours'
         and (${companyId ?? null}::uuid is null or e.company_id = ${companyId ?? null}::uuid)
       order by e.created_at
    `.execute(this.database);
    return result.rows.map((row) => ({
      checkId: "accounting_event_stuck",
      checkLabel: "Accounting Event stuck for over 24 hours",
      companyId: row.companyId,
      companyName: row.companyName,
      detail: `${row.eventType} has been "${row.processingStatus}" since ${row.createdAt} -- never reached a terminal state.`,
      severity: "medium",
      subjectId: row.eventId,
      subjectReference: row.eventType,
      subjectType: "accounting_event",
    }));
  }

  /**
   * A posted Journal Entry whose stored header totals do not match the
   * actual sum of its own lines, or whose debit and credit totals do not
   * equal each other -- the one invariant double-entry accounting can never
   * violate. Nothing in the schema currently enforces this at the database
   * level (checked directly: no CHECK constraint ties `total_debit`/
   * `total_credit` to either the line sums or each other), so this is the
   * only thing that would ever catch it.
   */
  private async unbalancedPostedJournals(companyId?: string): Promise<readonly IntegrityFinding[]> {
    const result = await sql<{
      companyId: string;
      companyName: string;
      journalId: string;
      journalNumber: string;
      totalDebit: string;
      totalCredit: string;
      lineDebit: string;
      lineCredit: string;
    }>`
      select j.company_id as "companyId", c.name_en as "companyName",
             j.id as "journalId", j.journal_number as "journalNumber",
             j.total_debit::text as "totalDebit", j.total_credit::text as "totalCredit",
             coalesce(l.sum_debit, 0)::text as "lineDebit",
             coalesce(l.sum_credit, 0)::text as "lineCredit"
        from journal_entries j
        join companies c on c.id = j.company_id
        left join (
          select journal_entry_id, sum(debit) as sum_debit, sum(credit) as sum_credit
            from journal_lines
           group by journal_entry_id
        ) l on l.journal_entry_id = j.id
       where j.status = 'posted'
         and (${companyId ?? null}::uuid is null or j.company_id = ${companyId ?? null}::uuid)
         and (
           j.total_debit <> j.total_credit
           or j.total_debit <> coalesce(l.sum_debit, 0)
           or j.total_credit <> coalesce(l.sum_credit, 0)
         )
       order by j.company_id, j.journal_number
    `.execute(this.database);
    return result.rows.map((row) => ({
      checkId: "journal_unbalanced",
      checkLabel: "Posted Journal does not balance",
      companyId: row.companyId,
      companyName: row.companyName,
      detail: `${row.journalNumber} header shows debit ${row.totalDebit} / credit ${row.totalCredit}, but its lines sum to debit ${row.lineDebit} / credit ${row.lineCredit}.`,
      severity: "high",
      subjectId: row.journalId,
      subjectReference: row.journalNumber,
      subjectType: "journal_entry",
    }));
  }

  public async verifyCompany(companyId: string, includeAccepted = false, thresholdDays = 7): Promise<CompanyIntegrityReport> {
    const checks = await Promise.all([
      this.receivableBalance(companyId),
      this.receivablePaidEqualsEffectiveOffsets(companyId),
      this.receivableStatus(companyId),
      this.receivableSanity(companyId),
      this.closedOrders(companyId),
      this.settlementHeaderLines(companyId),
      this.settlementPaymentNet(companyId),
      this.referenceCounters(companyId),
      this.lifecycleTimestamps(companyId),
      this.failedAccountingEvents(companyId),
      this.driverCashAging(companyId, thresholdDays),
      this.duplicateAreas(companyId),
    ]);
    const accepted = await sql<{ checkCode: string; subjectType: string; subjectId: string; fingerprint: string }>`
      select check_code as "checkCode", subject_type as "subjectType", subject_id as "subjectId", fingerprint
      from integrity_acceptances where company_id = ${companyId}::uuid
    `.execute(this.database);
    const acceptanceKeys = new Set(accepted.rows.map((row) => `${row.checkCode}:${row.subjectType}:${row.subjectId}:${row.fingerprint}`));
    const enriched = checks.map((check) => {
      const findings = check.findings.map((finding) => {
        const fingerprint = finding.fingerprint ?? fingerprintOf(finding);
        const acceptedFinding = acceptanceKeys.has(`${check.code}:${finding.subjectType}:${finding.subjectId}:${fingerprint}`);
        return { ...finding, code: check.code, fingerprint, accepted: acceptedFinding };
      });
      return { ...check, findings, count: includeAccepted ? findings.length : findings.filter((finding) => !finding.accepted).length };
    });
    const visible = enriched.flatMap((check) => check.findings);
    return {
      companyId,
      criticalCount: enriched.filter((check) => check.severity === "critical").reduce((total, check) => total + check.count, 0),
      warningCount: enriched.filter((check) => check.severity === "warning").reduce((total, check) => total + check.count, 0),
      previouslyReviewedCount: visible.filter((finding) => finding.accepted).length,
      checks: enriched,
    };
  }

  private async closedOrders(companyId: string): Promise<CompanyIntegrityCheck> {
    const rows = await sql<{ subjectId: string; subjectReference: string; status: string; payable: string }>`
      select id as "subjectId", reference_number as "subjectReference", trader_settlement_status as status,
             trader_net_payable::text as payable from orders
       where company_id = ${companyId}::uuid and delivery_status = 'closed'
    `.execute(this.database);
    return this.rows("F4", "critical", "Closed Orders are fully settled", companyId,
      rows.rows.filter((row) => !closeSettlementComplete({ settlementStatus: row.status, traderNetPayable: row.payable }))
        .map((row) => ({ ...row, actual: row.status, expected: "closeSettlementComplete=true" })));
  }

  private async settlementHeaderLines(companyId: string): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select s.id as "subjectId", s.settlement_number as "subjectReference",
             s.gross_payable::text as actual, coalesce(sum(l.gross_payable),0)::text as expected
        from trader_settlements s left join trader_settlement_orders l
          on l.company_id=s.company_id and l.settlement_id=s.id
       where s.company_id=${companyId}::uuid
       group by s.id, s.settlement_number, s.gross_payable
      having s.gross_payable is distinct from coalesce(sum(l.gross_payable),0)
       order by s.settlement_number limit 200
    `.execute(this.database);
    return this.rows("F11", "critical", "Settlement gross total equals allocation lines", companyId, result.rows);
  }

  private async settlementPaymentNet(companyId: string): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select s.id as "subjectId", s.settlement_number as "subjectReference",
             (coalesce(sum(p.amount),0))::text as actual,
             (s.gross_payable - coalesce((select sum(o.amount_allocated) from trader_settlement_receivable_offsets o
               where o.company_id=s.company_id and o.settlement_id=s.id and ${effectiveOffset("o")}),0))::text as expected
        from trader_settlements s left join trader_settlement_payments p
          on p.company_id=s.company_id and p.settlement_id=s.id
       where s.company_id=${companyId}::uuid and s.status='confirmed'
       group by s.id, s.settlement_number, s.gross_payable
      having coalesce(sum(p.amount),0) is distinct from
        s.gross_payable - coalesce((select sum(o.amount_allocated) from trader_settlement_receivable_offsets o
          where o.company_id=s.company_id and o.settlement_id=s.id and ${effectiveOffset("o")}),0)
       order by s.settlement_number limit 200
    `.execute(this.database);
    return this.rows("F12", "critical", "Settlement payment equals effective net", companyId, result.rows);
  }

  private async referenceCounters(companyId: string): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select c.reference_type as "subjectId", c.reference_type as "subjectReference",
             c.next_value::text as actual, (coalesce(max(x.n),0)+1)::text as expected
        from company_reference_counters c
        left join lateral (
          select nullif(regexp_replace(reference_number, '[^0-9]', '', 'g'),'')::bigint n
            from orders where company_id=c.company_id and c.reference_type='order'
          union all select nullif(regexp_replace(settlement_number, '[^0-9]', '', 'g'))::bigint
            from trader_settlements where company_id=c.company_id and c.reference_type='settlement'
        ) x on true
       where c.company_id=${companyId}::uuid
       group by c.reference_type,c.next_value
      having c.next_value < coalesce(max(x.n),0)+1
    `.execute(this.database);
    return this.rows("O1", "warning", "Reference counters are not behind issued references", companyId, result.rows);
  }

  private async lifecycleTimestamps(companyId: string): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select id as "subjectId", reference_number as "subjectReference", delivery_status as actual,
             case when delivery_status='delivered' then 'delivered_at' else 'closed_at' end as expected
        from orders where company_id=${companyId}::uuid
         and ((delivery_status='delivered' and delivered_at is null) or (delivery_status='closed' and closed_at is null))
       order by reference_number limit 200
    `.execute(this.database);
    return this.rows("O2", "warning", "Lifecycle timestamps exist for delivered and closed Orders", companyId, result.rows);
  }

  private async failedAccountingEvents(companyId: string): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select id as "subjectId", coalesce(source_reference, source_entity_id::text) as "subjectReference",
             processing_status || ' / ' || coalesce(error_code,'') || ' / attempts=' || attempt_count as actual,
             coalesce(next_attempt_at::text,'no retry scheduled') as expected
        from accounting_events where company_id=${companyId}::uuid and processing_status='failed'
       order by created_at limit 200
    `.execute(this.database);
    return this.rows("O3", "warning", "Failed Accounting Events", companyId, result.rows);
  }

  private async driverCashAging(companyId: string, thresholdDays: number): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select d.id as "subjectId", coalesce(d.display_name,d.name_en,d.name_ar,d.id::text) as "subjectReference",
             count(*)::text || ' Orders / ' || coalesce(sum(o.amount_collected),0)::text as actual,
             min(o.delivered_at)::text as expected
        from orders o join drivers d on d.id=o.assigned_driver_id and d.company_id=o.company_id
       where o.company_id=${companyId}::uuid and o.delivery_status='delivered'
         and o.driver_reconciliation_status='pending'
       group by d.id, d.display_name, d.name_en, d.name_ar
      having min(o.delivered_at) < now() - (${thresholdDays} || ' days')::interval
       order by min(o.delivered_at) limit 200
    `.execute(this.database);
    return this.rows("O4", "warning", "Driver cash older than the review threshold", companyId, result.rows);
  }

  public async verifyCheck(companyId: string, code: string, includeAccepted = false, thresholdDays = 7): Promise<CompanyIntegrityCheck> {
    const report = await this.verifyCompany(companyId, includeAccepted, thresholdDays);
    const check = report.checks.find((item) => item.code === code);
    if (check === undefined) throw new BadRequestException("Unknown integrity check");
    return check;
  }

  public async accept(companyId: string, input: { checkCode: string; subjectType: string; subjectId: string; fingerprint: string; note: string; acceptedBy: string }) {
    const report = await this.verifyCompany(companyId, true);
    const live = report.checks.flatMap((check) => check.findings).find((finding) =>
      finding.code === input.checkCode && finding.subjectType === input.subjectType &&
      finding.subjectId === input.subjectId && finding.fingerprint === input.fingerprint);
    if (live === undefined) throw new ConflictException("The integrity finding is stale or no longer exists");
    const result = await sql<{ id: string }>`
      insert into integrity_acceptances(company_id, check_code, subject_type, subject_id, fingerprint, accepted_by_platform_user_id, note)
      values (${companyId}::uuid, ${input.checkCode}, ${input.subjectType}, ${input.subjectId}::uuid, ${input.fingerprint}, ${input.acceptedBy}::uuid, ${input.note})
      on conflict (company_id, check_code, subject_type, subject_id, fingerprint) do nothing
      returning id
    `.execute(this.database);
    const acceptance = result.rows[0];
    if (acceptance === undefined) throw new ConflictException("The finding is already accepted");
    return { id: acceptance.id };
  }

  public async unaccept(companyId: string, id: string): Promise<void> {
    const result = await sql`delete from integrity_acceptances where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(this.database);
    if (Number(result.numAffectedRows ?? 0) === 0) throw new NotFoundException("Acceptance not found");
  }

  private async receivableBalance(companyId: string): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select r.id as "subjectId", r.receivable_number as "subjectReference",
             r.balance_amount::text as actual, (r.payable_amount-r.paid_amount)::text as expected
        from trader_receivables r
       where r.company_id = ${companyId}::uuid
         and r.balance_amount is distinct from r.payable_amount-r.paid_amount
       order by r.receivable_number limit 200
    `.execute(this.database);
    return this.rows("F1", "critical", "Receivable balance matches payable less paid", companyId, result.rows);
  }

  private async receivablePaidEqualsEffectiveOffsets(companyId: string): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select r.id as "subjectId", r.receivable_number as "subjectReference",
             r.paid_amount::text as actual, (${effectiveOffsetTotal("r")})::text as expected
        from trader_receivables r
       where r.company_id = ${companyId}::uuid
         and r.paid_amount is distinct from (${effectiveOffsetTotal("r")})
       order by r.receivable_number limit 200
    `.execute(this.database);
    return this.rows("F2", "critical", "Paid amount equals effective Settlement offsets", companyId, result.rows);
  }

  private async receivableStatus(companyId: string): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select r.id as "subjectId", r.receivable_number as "subjectReference",
             r.status as actual, case when r.paid_amount = 0 then 'outstanding' when r.paid_amount < r.payable_amount then 'partially_collected' else 'collected' end as expected
        from trader_receivables r
       where r.company_id = ${companyId}::uuid
         and r.status is distinct from case when r.paid_amount = 0 then 'outstanding' when r.paid_amount < r.payable_amount then 'partially_collected' else 'collected' end
       order by r.receivable_number limit 200
    `.execute(this.database);
    return this.rows("F3", "critical", "Receivable status agrees with amounts", companyId, result.rows);
  }

  private async receivableSanity(companyId: string): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select r.id as "subjectId", r.receivable_number as "subjectReference",
             (r.paid_amount::text || ' / effective settlements ' || (${effectiveSettlementCount("r")})::text) as actual,
             r.payable_amount::text as expected
        from trader_receivables r
       where r.company_id = ${companyId}::uuid
         and (r.paid_amount > r.payable_amount or r.paid_amount < 0 or r.payable_amount < 0 or (${effectiveSettlementCount("r")}) > 1)
       order by r.receivable_number limit 200
    `.execute(this.database);
    return this.rows("F8", "critical", "Receivable amounts and effective settlement count are sane", companyId, result.rows);
  }

  private async duplicateAreas(companyId: string): Promise<CompanyIntegrityCheck> {
    const result = await sql<IntegrityRow>`
      select min(a.id) as "subjectId", min(a.code) as "subjectReference",
             string_agg(a.name_en, ', ' order by a.name_en) as actual, e.code as expected
        from areas a join emirates e on e.id = a.emirate_id and e.company_id = a.company_id
       where a.company_id = ${companyId}::uuid
       group by a.company_id, a.emirate_id, e.code, lower(btrim(a.name_en))
      having count(*) > 1
       order by min(a.code) limit 200
    `.execute(this.database);
    return this.rows("O5", "warning", "Duplicate Areas within an Emirate", companyId, result.rows);
  }

  private rows(code: string, severity: CompanyIntegrityCheck["severity"], title: string, companyId: string, rows: readonly IntegrityRow[]): CompanyIntegrityCheck {
    return { code, severity, title, count: rows.length, findings: rows.map((row) => ({ checkId: code, checkLabel: title, companyId, companyName: "", severity: severity === "critical" ? "high" : "medium", subjectType: code === "O5" ? "area_group" : "trader_receivable", subjectId: row.subjectId, subjectReference: row.subjectReference, detail: `Actual ${row.actual}; expected ${row.expected}.` })) };
  }
}

interface IntegrityRow { subjectId: string; subjectReference: string; actual: string; expected: string; }
function fingerprintOf(finding: IntegrityFinding): string {
  return createHash("sha256").update(JSON.stringify([finding.subjectType, finding.subjectId, finding.detail])).digest("hex");
}

interface ReceivableAmountsRow {
  readonly companyId: string;
  readonly companyName: string;
  readonly receivableId: string;
  readonly receivableNumber: string;
  readonly originalAmountDue: string;
  readonly amountCollected: string;
  readonly effectivePhysical: string;
  readonly effectiveOffsets: string;
}

/** Allocations of still-confirmed Collections to the Receivable aliased `r`. */
function effectivePhysical() {
  return sql<string>`coalesce((
    select sum(alloc.amount_allocated)
      from trader_collection_allocations alloc
      join trader_collections col
        on col.id = alloc.collection_id and col.company_id = alloc.company_id
     where alloc.company_id = r.company_id and alloc.receivable_id = r.id
       and col.status = 'confirmed'
  ), 0)`;
}
