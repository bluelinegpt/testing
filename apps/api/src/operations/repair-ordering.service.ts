import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import type { AccountingInspection } from "../accounting/platform-accounting-repair.adapter.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { CompanyOrderHealthService, ORDER_HEALTH_REASONS } from "./company-order-health.service.js";
import { PAYROLL_OPERATIONAL_CODES, payrollFindingsSql } from "./payroll-repair.service.js";

/**
 * REPAIR CENTER PHASE 6 -- deterministic repair ORDERING across domains.
 *
 * An accounting event records an operational fact. When that fact is itself
 * inconsistent, recovering the event first would post the inconsistent state
 * to the General Ledger. So a READY accounting recovery becomes BLOCKED (with
 * one precise blocker) while its source's certified operational finding is
 * open:
 *
 *   - `trader_receivable_recognized` / `trader_receivable_payment_received`
 *     whose source Order's Trader-receivable truth is not HEALTHY
 *     -> `operational_finance_repair_first` (repair from Order Health);
 *   - `employee_payroll_approved` / `employee_payroll_paid` whose Payroll
 *     period carries an operational Payroll finding
 *     -> `payroll_repair_first` (repair from Payroll Health).
 *
 * Nothing is chained automatically: the source repair is a separate,
 * separately previewed and audited execution. Preview, details and execution
 * all apply this SAME rule (execution re-evaluates it under the event lock),
 * so Verify / Preview / Execute stay consistent. `order_delivered` posts the
 * Order's own snapshotted amounts and does not depend on the receivable.
 */

export const RECEIVABLE_FAMILY_EVENTS: ReadonlySet<string> = new Set([
  "trader_receivable_recognized",
  "trader_receivable_payment_received",
]);
export const PAYROLL_SOURCE_EVENTS: ReadonlySet<string> = new Set(["employee_payroll_approved", "employee_payroll_paid"]);

export interface OrderingIssue {
  readonly code: "operational_finance_repair_first" | "payroll_repair_first";
  readonly message: string;
}

@Injectable()
export class RepairOrderingService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(CompanyOrderHealthService) private readonly orders: CompanyOrderHealthService,
  ) {}

  /** The open operational finding that must be repaired first, or null. */
  public async blockerFor(
    db: Kysely<DatabaseSchema> | null,
    companyId: string,
    inspection: AccountingInspection,
  ): Promise<OrderingIssue | null> {
    const connection = db ?? this.database;
    const { event } = inspection.state;
    if (RECEIVABLE_FAMILY_EVENTS.has(event.eventType) && inspection.state.sourceOrderId !== null) {
      const evaluation = await this.orders.orderEvaluation(connection, companyId, inspection.state.sourceOrderId);
      if (evaluation !== undefined && ORDER_HEALTH_REASONS[evaluation.financialCode].health !== "HEALTHY") {
        return {
          code: "operational_finance_repair_first",
          message: `Repair Order ${evaluation.orderNumber}'s Trader receivable first (${evaluation.financialCode}, Order Health); recovering this event now would post the receivable's unverified state to the General Ledger.`,
        };
      }
    }
    if (PAYROLL_SOURCE_EVENTS.has(event.eventType)) {
      const period = (
        await sql<{ id: string; reference: string }>`
          select p.id, p.period_reference as reference from payroll_periods p
           where p.company_id = ${companyId}::uuid
             and p.id = case when ${event.sourceEntityType} = 'payroll_period' then ${event.sourceEntityId}::uuid
                             else (select pm.payroll_period_id from payroll_payments pm
                                    where pm.id = ${event.sourceEntityId}::uuid and pm.company_id = ${companyId}::uuid) end`.execute(connection)
      ).rows[0];
      if (period !== undefined) {
        const codes = (
          await sql<{ codes: string[] }>`with ${payrollFindingsSql(companyId, period.id)} select codes from pcodes`.execute(connection)
        ).rows[0]?.codes ?? [];
        const open = codes.filter((code) => PAYROLL_OPERATIONAL_CODES.has(code));
        if (open.length > 0) {
          return {
            code: "payroll_repair_first",
            message: `Resolve Payroll period ${period.reference}'s Payroll finding first (${open.join(", ")}, Payroll Health); recovering this event now would post an inconsistent Payroll state.`,
          };
        }
      }
    }
    return null;
  }

  /** A READY inspection becomes BLOCKED (one more blocker) while the source must be repaired first. */
  public async apply(
    db: Kysely<DatabaseSchema> | null,
    companyId: string,
    inspection: AccountingInspection,
  ): Promise<AccountingInspection> {
    if (inspection.repairability !== "READY") return inspection;
    const blocker = await this.blockerFor(db, companyId, inspection);
    if (blocker === null) return inspection;
    return { ...inspection, blockers: [...inspection.blockers, blocker], repairability: "BLOCKED" };
  }
}
