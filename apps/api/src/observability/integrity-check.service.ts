import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";

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
    const [missingEvents, stuckEvents, unbalancedJournals] = await Promise.all([
      this.deliveredOrdersMissingAccountingEvent(companyId),
      this.stuckAccountingEvents(companyId),
      this.unbalancedPostedJournals(companyId),
    ]);
    return [...missingEvents, ...stuckEvents, ...unbalancedJournals];
  }

  /**
   * A delivered/closed Order with a real Trader payable that has no
   * `order_delivered` Accounting Event at all -- the capture step never ran.
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
       where e.processing_status not in ('posted', 'reversed', 'ignored_duplicate')
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
}
