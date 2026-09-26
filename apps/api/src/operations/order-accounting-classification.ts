import { sql } from "kysely";

/**
 * ONE definition of "does this Order touch the ledger", shared by every reader.
 *
 * The authoritative rule lives in the database trigger
 * `capture_order_accounting_event` (migration
 * `20260805110000_order_capture_skips_zero_value_orders`). That trigger decides
 * whether an Accounting Event is ever raised, so any screen that claims an
 * Order is "No Accounting Required" is really predicting what the trigger did.
 *
 * If the two drift apart the UI starts lying: it either promises a Journal that
 * will never exist, or hides one that does. Keeping the expression here — and
 * importing it everywhere — makes the drift a single-file edit rather than a
 * hunt through query strings.
 *
 * The rule, stated once:
 *
 *   accounting impact = |Customer amount due| + |Trader net payable|
 *   Accounting Required  <=>  that total is not zero
 *
 * `abs()` on each component, not on the sum, so a positive and a negative can
 * never cancel out and disguise real money as nothing. Comparison is a strict
 * numeric `<> 0` against `coalesce(..., 0)`, never a truthy test, so `0`,
 * `0.00` and NULL all behave the same way.
 *
 * NOTE ON SCOPE: classification describes the Order's financial substance, not
 * its lifecycle. An Order that is Accounting Required but not yet delivered
 * simply has no Event yet. Callers that care about that distinction must look
 * at `deliveryStatus` as well — see `orderAccountingStatus` below.
 */
const impactTotalExpression = `(
  abs(coalesce(o.customer_amount_due, 0))
  + abs(coalesce(o.trader_net_payable, 0))
)`

const impactExpression = `${impactTotalExpression} <> 0`;

/**
 * The raw expressions, for callers composing larger fragments with `sql.raw`
 * (the recovery preview builds CASE trees around them). Same single source:
 * the total is the magnitude the predicate tests, and the predicate string is
 * exactly what `orderAccountingRequiredPredicate` wraps.
 */
export const orderAccountingImpactTotalExpression = impactTotalExpression;
export const orderAccountingRequiredExpression = impactExpression;

/**
 * Select-list fragment adding `accountingRequired` and the persisted zero-fee
 * reason to any query that exposes `orders` as `o`.
 *
 * Deliberately a fragment rather than a view: the two Order selects already
 * differ (list vs single row) and a view would force their shapes together.
 */
export const orderAccountingColumns = sql.raw(`
             ${impactExpression} as "accountingRequired",
             o.service_fee_override_reason as "serviceFeeOverrideReason"`);

/** Same predicate, usable in a `where` clause. */
export const orderAccountingRequiredPredicate = sql.raw(impactExpression);

/**
 * Why the applied Service Fee is what it is.
 *
 * - `configured_price` — the Trader/Area price was applied unchanged.
 * - `manual_override`  — somebody deliberately applied a different fee and
 *                        recorded a reason for it.
 * - `zero_configured_price` — the Trader/Area is simply priced at zero. Not an
 *                        override, and specifically NOT something a Trader
 *                        mobile user has to justify.
 */
export type OrderFeeSource = "configured_price" | "manual_override" | "zero_configured_price";

/**
 * The exact text `resolveServiceFee` persists for a configured zero price.
 *
 * Duplicated from `operations.service.ts` on purpose: importing it there would
 * create a cycle (the service already imports this module). The value is a
 * stored marker, so it must never change without a migration deciding what to
 * do with rows already carrying the old text.
 */
export const configuredZeroPriceMarker = "Configured Trader/Area price is zero";

/**
 * Derive the fee source from what was persisted.
 *
 * There is no `fee_source` column and this does not need one. A zero fee whose
 * reason is the system marker is a configured zero; any other recorded reason
 * is a human decision; no reason at all means the configured price was applied
 * as-is. That covers every row the writer can produce.
 *
 * Legacy rows predating `service_fee_override_reason` report
 * `configured_price`, which is the honest answer: their origin was never
 * recorded, and inventing `manual_override` would be worse than saying nothing.
 */
export const orderFeeSource = (
  serviceFee: string | null,
  serviceFeeOverrideReason: string | null,
): OrderFeeSource => {
  const reason = serviceFeeOverrideReason?.trim() ?? "";
  if (reason === configuredZeroPriceMarker) return "zero_configured_price";
  if (reason !== "") return "manual_override";
  return "configured_price";
};

/**
 * What the Accounting section of an Order screen should say.
 *
 * - `not_applicable` — no financial substance; no Event will ever be raised,
 *                      so an empty Accounting panel is correct, not a fault.
 * - `pending`        — real money, but the Order has not reached `delivered`,
 *                      so capture has not fired yet.
 * - `expected`       — real money and delivered: an Event should exist.
 *
 * `expected` is a claim about what SHOULD be there, not proof that it is. The
 * Accounting Event itself remains the source of truth for what actually
 * happened; this only tells the UI whether an absence is normal.
 */
export type OrderAccountingStatus = "not_applicable" | "pending" | "expected";

export const orderAccountingStatus = (
  accountingRequired: boolean,
  deliveryStatus: string,
): OrderAccountingStatus => {
  if (!accountingRequired) return "not_applicable";
  return deliveryStatus === "delivered" ? "expected" : "pending";
};


