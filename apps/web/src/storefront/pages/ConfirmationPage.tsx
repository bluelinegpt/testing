import { Link } from "react-router-dom";

import { cartTotals } from "../components/OrderSummary.js";
import { demoOrderNumber } from "../data/media.js";
import { formatAed } from "../lib/money.js";
import { useStore } from "../StoreContext.js";
import type { CartLine, CheckoutDetails } from "../types.js";

/**
 * Static order confirmation. The order number is fixed demo data and the
 * screen says so; Track Order is a static link back to the store, because no
 * real tracking exists in this phase.
 */
export function ConfirmationPage({
  details,
  lines,
}: {
  readonly details: CheckoutDetails;
  readonly lines: readonly CartLine[];
}) {
  const store = useStore();
  const { base } = store;
  const storeProfile = store.config.profile;
  const totals = cartTotals(lines, store);
  return (
    <div className="sf-confirm">
      <span aria-hidden="true" className="sf-confirm-mark">
        ✓
      </span>
      <h1 style={{ fontSize: "1.5rem" }}>Thank you{details.fullName === "" ? "" : `, ${details.fullName}`}!</h1>
      <p style={{ color: "var(--sf-muted)", marginTop: 8 }}>
        Your order has been received. {storeProfile.name} or the delivery company will contact you
        on <bdi dir="ltr">{details.mobile || "your mobile"}</bdi> to confirm delivery.
      </p>
      <div className="sf-review-block" style={{ marginTop: 20, textAlign: "start" }}>
        <dl style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr auto", margin: 0 }}>
          <dt style={{ color: "var(--sf-muted)" }}>Order number</dt>
          <dd style={{ margin: 0, textAlign: "end" }}>
            <bdi dir="ltr">{demoOrderNumber}</bdi>
          </dd>
          <dt style={{ color: "var(--sf-muted)" }}>Amount to pay on delivery</dt>
          <dd style={{ fontWeight: 700, margin: 0, textAlign: "end" }}>
            <bdi dir="ltr">{formatAed(totals.total)}</bdi>
          </dd>
          <dt style={{ color: "var(--sf-muted)" }}>Delivery</dt>
          <dd style={{ margin: 0, textAlign: "end" }}>
            {details.emirate === "" ? "UAE" : `${details.area}, ${details.emirate}`} · 1–3 working
            days
          </dd>
        </dl>
      </div>
      <span className="sf-demo-chip">Prototype demo — no real order was created</span>
      <div style={{ display: "grid", gap: 10, marginTop: 22 }}>
        <Link className="sf-button" to={`${base}/products`}>
          Continue Shopping
        </Link>
        <Link className="sf-button sf-button-dark" to={base}>
          Track Order (coming soon)
        </Link>
      </div>
    </div>
  );
}
