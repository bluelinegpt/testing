import { sql, type RawBuilder } from "kysely";

/**
 * Orders "ready questions" (Aiman, 11 Oct 2026).
 *
 * One line of questions above the Orders list -- "Which Orders are ready to
 * close?", "Which are ready to collect from the Driver?" -- each with a live
 * count. Clicking one filters the list to exactly these Orders. The free-text
 * question box (later step) resolves to the same keys, so a question can never
 * mean something different in the count, the list and the bulk action.
 *
 * Every predicate reads the Order row aliased `o` and is always combined with
 * `o.company_id = <current Company>` by the caller. Nothing here is
 * Company-agnostic.
 */
export const ORDER_QUESTION_KEYS = [
  "ready_to_close",
  "collect_from_driver",
  "pay_trader",
  "confirm_trader_receipt",
  "trader_owes_fees",
  "no_driver",
  "out_not_delivered",
  "on_hold",
] as const;

export type OrderQuestionKey = (typeof ORDER_QUESTION_KEYS)[number];

/** How the list groups the answer: per Driver, per Trader, or not at all. */
export const ORDER_QUESTION_GROUPING: Readonly<Record<OrderQuestionKey, "driver" | "trader" | null>> = {
  collect_from_driver: "driver",
  confirm_trader_receipt: "trader",
  no_driver: null,
  on_hold: null,
  out_not_delivered: "driver",
  pay_trader: "trader",
  ready_to_close: null,
  trader_owes_fees: "trader",
};

export function isOrderQuestionKey(value: unknown): value is OrderQuestionKey {
  return typeof value === "string" && (ORDER_QUESTION_KEYS as readonly string[]).includes(value);
}

const openTraderReceivable = sql<boolean>`
  exists (
    select 1
      from trader_receivables question_receivable
     where question_receivable.company_id = o.company_id
       and question_receivable.source_type = 'service_charge'
       and question_receivable.source_reference = o.order_number
       and question_receivable.status in ('outstanding', 'partially_collected')
       and question_receivable.outstanding_amount > 0
  )
`;

/**
 * The Order close gate (`OperationsService.changeDeliveryStatus`, status
 * `closed`) as SQL: Driver cash done, Trader settlement done (money sent or
 * received, not eligible, or nothing owed -- `closeSettlementComplete`), and a
 * return actually handed back. Plus no open Trader fee receivable, so an Order
 * this question closes does not stay in the Active list as financially pending.
 * Only the statuses the close transition accepts (`CLOSE_PREDECESSOR_STATUSES`),
 * minus Collect Orders that still need a Driver.
 */
const readyToClose = sql<boolean>`
  (o.delivery_status in ('delivered', 'returned_to_trader', 'collect_order')
   and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
   and (o.trader_settlement_status in ('money_sent_to_trader', 'money_received_by_trader', 'not_eligible')
        or o.trader_net_payable <= 0)
   and (o.delivery_status <> 'returned_to_trader' or o.return_status = 'returned_to_trader')
   -- A Collect Order still waiting for a Driver has not been picked up yet,
   -- so it is not finished work (Aiman, 11 Oct 2026).
   and not (o.delivery_status = 'collect_order' and o.assigned_driver_id is null)
   and not ${openTraderReceivable})
`;

const predicates: Readonly<Record<OrderQuestionKey, RawBuilder<boolean>>> = {
  /* Same gate as New Driver Collection's eligible Orders, including Orders
     with nothing to collect (they close the Driver's fee too). */
  collect_from_driver: sql<boolean>`
    (o.delivery_status = 'delivered'
     and o.driver_reconciliation_status = 'pending'
     and o.assigned_driver_id is not null
     and o.order_type <> 'gcc_international')
  `,
  confirm_trader_receipt: sql<boolean>`
    (o.delivery_status in ('delivered', 'closed')
     and o.trader_settlement_status = 'money_sent_to_trader')
  `,
  no_driver: sql<boolean>`
    (o.delivery_status in ('new', 'in_branch')
     and o.assigned_driver_id is null
     and o.order_type <> 'gcc_international')
  `,
  on_hold: sql<boolean>`(o.delivery_status = 'hold')`,
  out_not_delivered: sql<boolean>`
    (o.delivery_status in ('assigned_to_driver', 'out_for_delivery'))
  `,
  /* The `settle_trader` workflow step: cash is in, the Trader is still owed. */
  pay_trader: sql<boolean>`
    (o.delivery_status in ('delivered', 'closed')
     and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
     and o.trader_net_payable > 0
     and o.trader_settlement_status in ('unsettled', 'partially_settled'))
  `,
  ready_to_close: readyToClose,
  trader_owes_fees: openTraderReceivable,
};

export function orderQuestionPredicate(key: OrderQuestionKey): RawBuilder<boolean> {
  return predicates[key];
}
