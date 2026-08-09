/**
 * Frontend mirror of `apps/api/src/operations/order-accounting-classification.ts`.
 *
 * The API already computes and returns `accountingRequired`, so nothing here
 * recomputes the money rule — duplicating that arithmetic in the browser is
 * exactly how a UI ends up disagreeing with its own database. What lives here
 * is only the presentation-side derivation the API has no opinion about: which
 * label to show, and whether an empty Accounting panel is a fault or a fact.
 *
 * The single shared source of truth stays the capture trigger; this module is
 * downstream of it, twice removed.
 */

/** Same marker string `resolveServiceFee` persists for a configured zero price. */
const configuredZeroPriceMarker = "Configured Trader/Area price is zero";

export type OrderFeeSource = "configured_price" | "manual_override" | "zero_configured_price";

/**
 * Why the applied Service Fee is what it is.
 *
 * Reads the persisted reason rather than any flag: a zero fee carrying the
 * system marker is ordinary configured pricing, any other reason is a person's
 * decision, and no reason means the configured price was applied unchanged.
 *
 * Orders created before the reason column existed report `configured_price`.
 * That is the honest answer — their origin was never recorded — and it is the
 * one choice that cannot slander a legacy Order as an unjustified override.
 */
export const orderFeeSource = (
  serviceFeeOverrideReason: string | null | undefined,
): OrderFeeSource => {
  const reason = serviceFeeOverrideReason?.trim() ?? "";
  if (reason === configuredZeroPriceMarker) return "zero_configured_price";
  if (reason !== "") return "manual_override";
  return "configured_price";
};

export type OrderAccountingStatus = "not_applicable" | "pending" | "expected";

/**
 * What the Accounting side of the Order screen should claim.
 *
 * `not_applicable` is the important one: it tells the UI that the absence of an
 * Accounting Event is correct and expected, so it must not offer a link to a
 * Journal that will never be created.
 *
 * `accountingRequired` is `undefined` on responses from an older API build. In
 * that case there is no classification to show and callers should render
 * nothing rather than guess — see `orderAccountingStatus` returning null.
 */
export const orderAccountingStatus = (order: {
  readonly accountingRequired?: boolean;
  readonly deliveryStatus: string;
}): OrderAccountingStatus | null => {
  if (order.accountingRequired === undefined) return null;
  if (!order.accountingRequired) return "not_applicable";
  return order.deliveryStatus === "delivered" ? "expected" : "pending";
};

/**
 * Whether the Accounting Related Records panel should be rendered at all.
 *
 * A no-impact Order has no Event and no Journal by design. Showing the panel
 * would present an empty result that reads as "something is missing", and any
 * link it offered would be broken. Suppressing it — with a plain explanation in
 * its place — is the accurate presentation.
 */
export const showsAccountingRelatedRecords = (order: {
  readonly accountingRequired?: boolean;
}): boolean => order.accountingRequired !== false;
