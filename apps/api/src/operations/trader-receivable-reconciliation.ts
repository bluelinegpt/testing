import { Decimal } from "decimal.js";
import { type RawBuilder, sql } from "kysely";

import { effectiveOffset } from "./effective-settlement-offsets.js";

/**
 * TRADER RECEIVABLE RECONCILIATION -- THE ONE EQUATION (Repair Center Phase 3,
 * Prompt 1).
 *
 * For one service-charge Trader receivable:
 *
 *   effective physical collections = sum of allocations whose Trader
 *                                    Collection is `confirmed`
 *   effective settlement offsets   = sum of offsets whose Settlement is
 *                                    effective (effective-settlement-offsets.ts)
 *   effectively settled            = physical + offsets
 *   remaining outstanding          = amount due - effectively settled
 *
 * Trader Credits never settle a CURRENT receivable: a credit only compensates
 * a receivable that the certified offset reversal turned `reversed`, which is
 * history. Reversed / cancelled collections and offsets of reversed
 * Settlements are history and never count.
 *
 * The receivable's own cached state must agree with the equation:
 *   amount_collected = effectively settled            (outstanding_amount is
 *                                                      GENERATED from it)
 *   status           = the domain status rule below
 *
 * DOMAIN STATUS RULE -- exactly what every certified writer applies
 * (TraderReceivableService.confirmCollection / reverseCollection,
 * TraderSettlementService confirm / reverse):
 *   collected <= 0          -> outstanding
 *   0 < collected < due     -> partially_collected
 *   collected >= due        -> collected
 *
 * ONE decision for every reader: the SQL CASE built by `receivableAnomalySql`
 * is used by Company / Order Health (set-based), Verify First, the Repair
 * Preview, Repair Execution and post-repair verification (all through the same
 * evaluation). Nothing here writes.
 */

/** Receivable-level anomalies that make the Order an ISSUE (actionable). */
export const RECEIVABLE_ISSUE_ANOMALIES = [
  "COLLECTION_ALLOCATION_MISMATCH",
  "ORPHAN_COLLECTION_ALLOCATION",
  "SETTLEMENT_OFFSET_MISMATCH",
  "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT",
  "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN",
  "RECEIVABLE_PARTIAL_STATE_MISMATCH",
] as const;

/** Receivable-level anomalies that need a person (REVIEW). */
export const RECEIVABLE_REVIEW_ANOMALIES = [
  "MULTIPLE_EFFECTIVE_SETTLEMENTS",
  "RECEIVABLE_OVER_COLLECTED",
  "RECEIVABLE_COLLECTED_AMOUNT_MISMATCH",
] as const;

export type ReceivableIssueAnomaly = (typeof RECEIVABLE_ISSUE_ANOMALIES)[number];
export type ReceivableReviewAnomaly = (typeof RECEIVABLE_REVIEW_ANOMALIES)[number];
export type ReceivableAnomaly = ReceivableIssueAnomaly | ReceivableReviewAnomaly;

/** Status-only inconsistencies: the cached amount agrees, only `status` is wrong. */
export const RECEIVABLE_STATUS_ANOMALIES: readonly ReceivableIssueAnomaly[] = [
  "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT",
  "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN",
  "RECEIVABLE_PARTIAL_STATE_MISMATCH",
];

export type ReceivableStatus = "outstanding" | "partially_collected" | "collected";

/** The domain status rule (see above). */
export function expectedReceivableStatus(collected: Decimal.Value, due: Decimal.Value): ReceivableStatus {
  const amount = new Decimal(collected);
  if (amount.lessThanOrEqualTo(0)) return "outstanding";
  return amount.lessThan(new Decimal(due)) ? "partially_collected" : "collected";
}

/** The inputs of the decision, as SQL fragments over ONE receivable row. */
export interface ReceivableAnomalyInputs {
  readonly status: RawBuilder<unknown>;
  readonly due: RawBuilder<unknown>;
  readonly collected: RawBuilder<unknown>;
  readonly physical: RawBuilder<unknown>;
  readonly offset: RawBuilder<unknown>;
  readonly effectiveSettlements: RawBuilder<unknown>;
  /** Confirmed allocations from a Collection of another Trader, or from an over-allocated Collection. */
  readonly allocationMismatch: RawBuilder<unknown>;
  /** Effective offsets from a Settlement of another Trader. */
  readonly offsetWrongTrader: RawBuilder<unknown>;
  /** A live (not cancelled) Trader Credit compensates this receivable. */
  readonly hasLiveCredit: RawBuilder<unknown>;
}

/**
 * THE decision (most specific first). NULL when the receivable reconciles.
 *
 *   MULTIPLE_EFFECTIVE_SETTLEMENTS  two effective settlements over-offset it
 *   RECEIVABLE_OVER_COLLECTED       physical + offsets > amount due
 *   COLLECTION_ALLOCATION_MISMATCH  a confirmed allocation from another
 *                                   Trader's Collection, or from a Collection
 *                                   allocated beyond the money received
 *   ORPHAN_COLLECTION_ALLOCATION    a confirmed allocation on a cancelled /
 *                                   reversed receivable (no certified path
 *                                   reverses a receivable with one)
 *   SETTLEMENT_OFFSET_MISMATCH      an effective offset from another Trader's
 *                                   Settlement, on a cancelled receivable, or
 *                                   on a reversed receivable with no live
 *                                   compensating Trader Credit
 *   RECEIVABLE_COLLECTED_AMOUNT_MISMATCH  cached amount_collected disagrees
 *   RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT
 *                                   status `collected`, settled < due
 *   FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN
 *                                   status still open, settled >= due
 *   RECEIVABLE_PARTIAL_STATE_MISMATCH  outstanding vs partially_collected wrong
 *
 * A reversed receivable whose effective offset is compensated by a live
 * Trader Credit is the certified offset-reversal history, never an anomaly.
 */
export function receivableAnomalySql(input: ReceivableAnomalyInputs): RawBuilder<ReceivableAnomaly | null> {
  const { allocationMismatch, collected, due, effectiveSettlements, hasLiveCredit, offset, offsetWrongTrader, physical, status } =
    input;
  const settled = sql`(${physical} + ${offset})`;
  const current = sql`(${status} not in ('reversed', 'cancelled'))`;
  return sql<ReceivableAnomaly | null>`(case
    when ${effectiveSettlements} > 1 and ${offset} > ${due} then 'MULTIPLE_EFFECTIVE_SETTLEMENTS'
    when ${settled} > ${due} then 'RECEIVABLE_OVER_COLLECTED'
    when ${allocationMismatch} then 'COLLECTION_ALLOCATION_MISMATCH'
    when not ${current} and ${physical} > 0 then 'ORPHAN_COLLECTION_ALLOCATION'
    when ${offsetWrongTrader}
      or (${status} = 'cancelled' and ${offset} > 0)
      or (${status} = 'reversed' and ${offset} > 0 and not ${hasLiveCredit})
      then 'SETTLEMENT_OFFSET_MISMATCH'
    when ${status} <> 'cancelled' and abs(${collected} - ${settled}) > 0.004
      then 'RECEIVABLE_COLLECTED_AMOUNT_MISMATCH'
    when ${current} and ${status} = 'collected' and ${settled} < ${due}
      then 'RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT'
    when ${current} and ${status} in ('outstanding', 'partially_collected') and ${settled} >= ${due}
      then 'FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN'
    when ${current} and ((${status} = 'outstanding' and ${settled} > 0)
                         or (${status} = 'partially_collected' and ${settled} <= 0))
      then 'RECEIVABLE_PARTIAL_STATE_MISMATCH'
  end)`;
}

/** SQL list literal of the ISSUE anomalies (for severity ordering). */
export function issueAnomalyListSql(): RawBuilder<unknown> {
  return sql.raw(`array[${RECEIVABLE_ISSUE_ANOMALIES.map((code) => `'${code}'`).join(",")}]::text[]`);
}

function ref(alias: string): RawBuilder<unknown> {
  if (!/^[a-z_][a-z0-9_]*$/u.test(alias)) throw new Error(`Unsafe SQL alias: ${alias}`);
  return sql.raw(alias);
}

/**
 * Per-row (correlated) inputs for ONE receivable aliased `alias` -- used by
 * Verify First and by the receivable reconciliation domain operation. The
 * set-based Company Health builds the same inputs from aggregates.
 */
export function correlatedReceivableInputs(alias = "r"): ReceivableAnomalyInputs & {
  readonly physical: RawBuilder<string>;
  readonly offset: RawBuilder<string>;
} {
  const r = ref(alias);
  return {
    allocationMismatch: sql`exists (
      select 1 from trader_collection_allocations ma
        join trader_collections mc on mc.id = ma.collection_id and mc.company_id = ma.company_id
       where ma.company_id = ${r}.company_id and ma.receivable_id = ${r}.id and mc.status = 'confirmed'
         and (mc.trader_id <> ${r}.trader_id
              or (select sum(ta.amount_allocated) from trader_collection_allocations ta
                   where ta.company_id = mc.company_id and ta.collection_id = mc.id) > mc.amount_received))`,
    collected: sql`${r}.amount_collected`,
    due: sql`${r}.original_amount_due`,
    effectiveSettlements: sql`(select count(distinct es.settlement_id) from trader_settlement_receivable_offsets es
       where es.company_id = ${r}.company_id and es.receivable_id = ${r}.id and ${effectiveOffset("es")})`,
    hasLiveCredit: sql`exists (select 1 from trader_credits lc
       where lc.company_id = ${r}.company_id and lc.source_receivable_id = ${r}.id and lc.status <> 'cancelled')`,
    offset: sql<string>`coalesce((select sum(eo.amount_allocated) from trader_settlement_receivable_offsets eo
       where eo.company_id = ${r}.company_id and eo.receivable_id = ${r}.id and ${effectiveOffset("eo")}), 0)`,
    offsetWrongTrader: sql`exists (
      select 1 from trader_settlement_receivable_offsets wo
        join trader_settlements ws on ws.id = wo.settlement_id and ws.company_id = wo.company_id
       where wo.company_id = ${r}.company_id and wo.receivable_id = ${r}.id and ${effectiveOffset("wo")}
         and ws.trader_id <> ${r}.trader_id)`,
    physical: sql<string>`coalesce((select sum(pa.amount_allocated) from trader_collection_allocations pa
       join trader_collections pc on pc.id = pa.collection_id and pc.company_id = pa.company_id
      where pa.company_id = ${r}.company_id and pa.receivable_id = ${r}.id and pc.status = 'confirmed'), 0)`,
    status: sql`${r}.status`,
  };
}
