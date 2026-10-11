import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { effectiveSettlement } from "./effective-settlement-offsets.js";

/**
 * The dependency graph of ONE Order, read in ONE bounded statement:
 *
 *   Order
 *    -> Trader Receivables (service-charge, by Order number, same Company)
 *       -> Collection allocations -> Trader Collections
 *       -> Settlement offsets -> Settlements (+ the reversal that undid them)
 *       -> Trader Credits
 *    -> Accounting Events (Order, Receivables, Credits, Settlements) -> Journals
 *    -> Driver reconciliation links -> Driver reconciliations
 *
 * Every branch is keyed by the Order's own records, so the statement's cost is
 * bounded by this Order's history, never by the Company's size (no N+1).
 * Allocations and offsets are read by receivable id WITHOUT a Company filter
 * so a cross-Company link -- impossible by foreign key today -- would still be
 * reported rather than silently hidden.
 *
 * CURRENT vs HISTORICAL uses the certified Phase 1 semantics:
 *   receivable    current unless `reversed` / `cancelled`;
 *   offset        current when its Settlement is effective
 *                 (effective-settlement-offsets.ts) AND its receivable is current;
 *   settlement    current when effective; a reversed one and its reversal
 *                 row are history;
 *   allocation    current when its Collection is confirmed AND its
 *                 receivable is current;
 *   credit        current unless cancelled;
 *   reconciliation current when confirmed, not a reversal and not reversed;
 *   accounting    follows the record it belongs to.
 */

export interface GraphOrder {
  readonly id: string;
  readonly orderNumber: string;
  readonly version: string;
  readonly deliveryStatus: string;
  readonly paymentCondition: string;
  readonly codAmount: string;
  readonly serviceFee: string;
  readonly additionalFees: string | null;
  readonly traderId: string;
  readonly traderSettlementStatus: string;
  readonly traderPaidAmount: string;
  readonly traderNetPayable: string;
  readonly driverReconciliationStatus: string;
  readonly isFreeOrder: boolean;
  /**
   * Phase 3 Prompt 3: the Order's OWN VAT snapshot, taken when it was priced.
   * The financial model evaluates the CURRENT Company policy (`graph.vat`); an
   * expected receivable amount is provable only when the two agree.
   */
  readonly vatEnabledSnapshot: boolean | null;
  readonly vatPriceModeSnapshot: string | null;
  readonly vatRateSnapshot: string | null;
  /**
   * Phase 3 Prompt 4: the Order's stored obligation (part of the preview
   * fingerprint: a change to what the Order requires makes a preview stale).
   */
  readonly financialModelVersion: string | null;
  readonly totalDeductions: string | null;
}

export interface GraphReceivable {
  readonly id: string;
  readonly receivableNumber: string;
  readonly status: string;
  readonly amountDue: string;
  readonly amountCollected: string;
  readonly outstanding: string;
  readonly traderId: string;
  readonly createdOrder: number;
  readonly current: boolean;
  /**
   * Display only (Prompt 4, Part Q): NO Company creator AND a Platform repair
   * audit row names this exact receivable. Never inferred from NULL alone.
   * Excluded from the preview fingerprint.
   */
  readonly createdByPlatformRepair: boolean;
}

export interface GraphAllocation {
  readonly id: string;
  readonly receivableId: string;
  readonly amount: string;
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly collectionStatus: string;
  /** Phase 3: the Collection's Trader and its money received vs everything allocated from it. */
  readonly collectionTraderId: string;
  readonly collectionAmountReceived: string;
  readonly collectionAllocatedTotal: string;
  readonly companyMatches: boolean;
  readonly current: boolean;
}

export interface GraphOffset {
  readonly id: string;
  readonly receivableId: string;
  readonly amount: string;
  readonly settlementId: string;
  readonly settlementNumber: string;
  readonly settlementStatus: string;
  readonly effective: boolean;
  readonly reversedBySettlementNumber: string | null;
  /** Phase 3: the Settlement's Trader. */
  readonly settlementTraderId: string;
  readonly companyMatches: boolean;
  readonly current: boolean;
}

export interface GraphCredit {
  readonly id: string;
  readonly creditNumber: string;
  readonly status: string;
  readonly amount: string;
  readonly amountApplied: string;
  readonly sourceReceivableId: string | null;
  readonly current: boolean;
}

export interface GraphEvent {
  readonly id: string;
  readonly eventType: string;
  readonly processingStatus: string;
  readonly sourceEntityType: string;
  readonly sourceEntityId: string;
  readonly journalId: string | null;
  readonly journalNumber: string | null;
  readonly journalStatus: string | null;
}

export interface GraphReconciliation {
  readonly linkId: string;
  readonly reconciliationId: string;
  readonly reconciliationNumber: string;
  readonly status: string;
  readonly isReversal: boolean;
  readonly reversed: boolean;
  readonly current: boolean;
}

export interface OrderDependencyGraph {
  readonly order: GraphOrder;
  readonly vat: { readonly enabled: boolean; readonly priceMode: string | null; readonly rate: string };
  readonly accountingEnabled: boolean;
  /** Status of the accounting period containing today, null when none. */
  readonly currentPeriodStatus: string | null;
  readonly receivables: readonly GraphReceivable[];
  readonly allocations: readonly GraphAllocation[];
  readonly offsets: readonly GraphOffset[];
  readonly credits: readonly GraphCredit[];
  readonly events: readonly GraphEvent[];
  readonly reconciliations: readonly GraphReconciliation[];
}

export async function loadOrderDependencyGraph(
  db: Kysely<DatabaseSchema>,
  companyId: string,
  orderId: string,
): Promise<OrderDependencyGraph | undefined> {
  const company = sql`${companyId}::uuid`;
  const row = (
    await sql<{ graph: OrderDependencyGraph | null }>`
      with
      o as (
        select o.id, o.order_number, o.version, o.delivery_status, o.payment_condition,
               o.cod_amount, o.service_fee, o.additional_fees, o.trader_id,
               o.trader_settlement_status, o.trader_paid_amount, o.trader_net_payable,
               o.driver_reconciliation_status, o.is_free_order,
               o.vat_enabled_snapshot, o.vat_price_mode_snapshot, o.vat_rate_snapshot,
               o.financial_model_version, o.total_deductions
          from orders o
         where o.company_id = ${company} and o.id = ${orderId}::uuid
      ),
      r as (
        select r.id, r.receivable_number, r.status, r.original_amount_due, r.amount_collected,
               r.outstanding_amount, r.trader_id,
               row_number() over (order by r.created_at, r.receivable_number)::int as created_order,
               r.status not in ('reversed', 'cancelled') as current,
               (r.created_by_account_id is null and exists (
                  select 1 from platform_repair_executions x
                   where x.company_id = r.company_id and x.order_id = (select id from o)
                     and x.capability_code in ('REPAIR_TRADER_RECEIVABLE', 'REPLACE_UNUSED_TRADER_RECEIVABLE')
                     and x.result_summary -> 'domainOutcome' ->> 'receivableId' = r.id::text
               )) as platform_repair
          from trader_receivables r
         where r.company_id = ${company} and r.source_type = 'service_charge'
           and r.source_reference = (select order_number from o)
      ),
      alloc as (
        select a.id, a.receivable_id, a.amount_allocated, c.id as collection_id,
               c.collection_number, c.status as collection_status,
               c.trader_id as collection_trader_id, c.amount_received,
               (select sum(ta.amount_allocated) from trader_collection_allocations ta
                 where ta.company_id = c.company_id and ta.collection_id = c.id) as collection_allocated,
               (a.company_id = ${company} and c.company_id = ${company}) as company_matches,
               (c.status = 'confirmed' and rr.current) as current
          from trader_collection_allocations a
          join trader_collections c on c.id = a.collection_id
          join r rr on rr.id = a.receivable_id
      ),
      offs as (
        select x.id, x.receivable_id, x.amount_allocated, s.id as settlement_id,
               s.settlement_number, s.status as settlement_status, s.trader_id as settlement_trader_id,
               ${effectiveSettlement("s")} as effective,
               (select rv.settlement_number from trader_settlements rv
                 where rv.company_id = s.company_id and rv.reversal_of_id = s.id
                 order by rv.created_at limit 1) as reversed_by,
               (x.company_id = ${company} and s.company_id = ${company}) as company_matches,
               rr.current as receivable_current
          from trader_settlement_receivable_offsets x
          join trader_settlements s on s.id = x.settlement_id
          join r rr on rr.id = x.receivable_id
      ),
      credits as (
        select tc.id, tc.credit_number, tc.status, tc.amount, tc.amount_applied,
               tc.source_receivable_id
          from trader_credits tc
         where tc.company_id = ${company}
           and (tc.source_receivable_id in (select id from r)
                or tc.source_order_id = (select id from o))
      ),
      ev as (
        select e.id, e.event_type, e.processing_status, e.source_entity_type,
               e.source_entity_id, e.journal_id, j.journal_number, j.status as journal_status
          from accounting_events e
          left join journal_entries j on j.id = e.journal_id and j.company_id = e.company_id
         where e.company_id = ${company}
           and ((e.source_entity_type = 'order' and e.source_entity_id = (select id from o))
             or (e.source_entity_type = 'trader_receivable' and e.source_entity_id in (select id from r))
             or (e.source_entity_type = 'trader_credit' and e.source_entity_id in (select id from credits))
             or (e.source_entity_type = 'trader_settlement'
                 and e.source_entity_id in (select settlement_id from offs)))
      ),
      recon as (
        select ro.id as link_id, dr.id as reconciliation_id, dr.reconciliation_number,
               dr.status, dr.reversal_of_id is not null as is_reversal,
               exists (select 1 from driver_reconciliations rv
                        where rv.company_id = dr.company_id and rv.reversal_of_id = dr.id) as reversed
          from driver_reconciliation_orders ro
          join driver_reconciliations dr on dr.id = ro.reconciliation_id and dr.company_id = ro.company_id
         where ro.company_id = ${company} and ro.order_id = (select id from o)
      )
      select case when not exists (select 1 from o) then null else json_build_object(
        'order', (select json_build_object(
            'id', id, 'orderNumber', order_number, 'version', version::text,
            'deliveryStatus', delivery_status, 'paymentCondition', payment_condition,
            'codAmount', cod_amount::text, 'serviceFee', service_fee::text,
            'additionalFees', additional_fees::text, 'traderId', trader_id,
            'traderSettlementStatus', trader_settlement_status,
            'traderPaidAmount', trader_paid_amount::text,
            'traderNetPayable', trader_net_payable::text,
            'driverReconciliationStatus', driver_reconciliation_status,
            'isFreeOrder', is_free_order,
            'vatEnabledSnapshot', vat_enabled_snapshot, 'vatPriceModeSnapshot', vat_price_mode_snapshot,
            'vatRateSnapshot', vat_rate_snapshot::text,
            'financialModelVersion', financial_model_version, 'totalDeductions', total_deductions::text) from o),
        'vat', (select json_build_object(
            'enabled', coalesce(cs.vat_enabled, false), 'priceMode', cs.vat_price_mode,
            'rate', coalesce(cs.vat_rate, 0)::text)
            from (select 1) one left join company_settings cs on cs.company_id = ${company}),
        'accountingEnabled', coalesce((select ac.accounting_enabled from accounting_configurations ac
                                        where ac.company_id = ${company}), false),
        'currentPeriodStatus', (select p.status from accounting_periods p
                                 where p.company_id = ${company} and not p.is_adjustment_period
                                   and current_date between p.period_start and p.period_end
                                 order by p.period_start limit 1),
        'receivables', coalesce((select json_agg(json_build_object(
            'id', id, 'receivableNumber', receivable_number, 'status', status,
            'amountDue', original_amount_due::text, 'amountCollected', amount_collected::text,
            'outstanding', outstanding_amount::text, 'traderId', trader_id,
            'createdOrder', created_order, 'current', current,
            'createdByPlatformRepair', platform_repair) order by created_order) from r), '[]'::json),
        'allocations', coalesce((select json_agg(json_build_object(
            'id', id, 'receivableId', receivable_id, 'amount', amount_allocated::text,
            'collectionId', collection_id, 'collectionNumber', collection_number,
            'collectionStatus', collection_status,
            'collectionTraderId', collection_trader_id, 'collectionAmountReceived', amount_received::text,
            'collectionAllocatedTotal', collection_allocated::text, 'companyMatches', company_matches,
            'current', current) order by collection_number, id) from alloc), '[]'::json),
        'offsets', coalesce((select json_agg(json_build_object(
            'id', id, 'receivableId', receivable_id, 'amount', amount_allocated::text,
            'settlementId', settlement_id, 'settlementNumber', settlement_number,
            'settlementStatus', settlement_status, 'effective', effective,
            'reversedBySettlementNumber', reversed_by, 'settlementTraderId', settlement_trader_id,
            'companyMatches', company_matches,
            'current', effective and receivable_current) order by settlement_number, id) from offs), '[]'::json),
        'credits', coalesce((select json_agg(json_build_object(
            'id', id, 'creditNumber', credit_number, 'status', status, 'amount', amount::text,
            'amountApplied', amount_applied::text, 'sourceReceivableId', source_receivable_id,
            'current', status <> 'cancelled') order by credit_number) from credits), '[]'::json),
        'events', coalesce((select json_agg(json_build_object(
            'id', id, 'eventType', event_type, 'processingStatus', processing_status,
            'sourceEntityType', source_entity_type, 'sourceEntityId', source_entity_id,
            'journalId', journal_id, 'journalNumber', journal_number,
            'journalStatus', journal_status) order by source_entity_type, event_type, id) from ev), '[]'::json),
        'reconciliations', coalesce((select json_agg(json_build_object(
            'linkId', link_id, 'reconciliationId', reconciliation_id,
            'reconciliationNumber', reconciliation_number, 'status', status,
            'isReversal', is_reversal, 'reversed', reversed,
            'current', status = 'confirmed' and not is_reversal and not reversed)
            order by reconciliation_number) from recon), '[]'::json)
      ) end as graph
    `.execute(db)
  ).rows[0];
  return row?.graph ?? undefined;
}

/**
 * The relevant state of a graph for the preview fingerprint: everything a
 * repair decision depends on, and nothing that changes merely because a
 * preview was requested (no timestamps, no derived text).
 */
export function fingerprintState(graph: OrderDependencyGraph): unknown {
  const byId = <T extends { readonly id: string }>(items: readonly T[]) =>
    [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    accountingEnabled: graph.accountingEnabled,
    allocations: byId(graph.allocations),
    credits: byId(graph.credits),
    events: byId(graph.events).map((event) => ({
      id: event.id,
      journalId: event.journalId,
      journalStatus: event.journalStatus,
      processingStatus: event.processingStatus,
    })),
    offsets: byId(graph.offsets),
    order: graph.order,
    receivables: byId(graph.receivables).map(({ createdByPlatformRepair, ...row }) => {
      void createdByPlatformRepair;
      return row;
    }),
    reconciliations: [...graph.reconciliations].sort((a, b) =>
      a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0,
    ),
    vat: graph.vat,
  };
}
