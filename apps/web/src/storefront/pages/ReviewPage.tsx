import { Link, useNavigate } from "react-router-dom";

import { cartTotals } from "../components/OrderSummary.js";
import { formatAed } from "../lib/money.js";
import { useStore } from "../StoreContext.js";
import type { CartLine, CheckoutDetails } from "../types.js";

/**
 * Order review: everything the customer is about to agree to, with edit
 * buttons back into the cart and checkout. Confirm only NAVIGATES to the
 * static confirmation screen — no Order of any kind is created anywhere.
 */
export function ReviewPage({
  details,
  lines,
  onConfirm,
}: {
  readonly details: CheckoutDetails;
  readonly lines: readonly CartLine[];
  readonly onConfirm: () => void;
}) {
  const navigate = useNavigate();
  const store = useStore();
  const { base, productBySlug } = store;
  const totals = cartTotals(lines, store);

  if (lines.length === 0 || details.fullName === "") {
    return (
      <div className="sf-empty">
        <h1 style={{ fontSize: "1.2rem", marginBottom: 8 }}>Nothing to review yet</h1>
        <p>
          <Link to={`${base}/products`}>Browse products</Link> and complete checkout first.
        </p>
      </div>
    );
  }

  return (
    <div style={{ margin: "0 auto", maxWidth: 720 }}>
      <h1 style={{ fontSize: "1.5rem", margin: "6px 0 16px" }}>Review Your Order</h1>

      <section className="sf-review-block">
        <div className="sf-review-block-head">
          <h2 style={{ fontSize: "1.02rem" }}>Customer</h2>
          <button
            className="sf-link-button"
            onClick={() => navigate(`${base}/checkout`)}
            type="button"
          >
            Edit
          </button>
        </div>
        <p style={{ margin: 0 }}>{details.fullName}</p>
        <p style={{ color: "var(--sf-muted)", margin: 0 }}>
          <bdi dir="ltr">{details.mobile}</bdi>
        </p>
      </section>

      <section className="sf-review-block">
        <div className="sf-review-block-head">
          <h2 style={{ fontSize: "1.02rem" }}>Delivery Address</h2>
          <button
            className="sf-link-button"
            onClick={() => navigate(`${base}/checkout`)}
            type="button"
          >
            Edit
          </button>
        </div>
        <p style={{ margin: 0 }}>
          {details.building}
          {details.unit === "" ? "" : `, ${details.unit}`}, {details.area}, {details.emirate}
        </p>
        <p style={{ color: "var(--sf-muted)", margin: 0 }}>{details.address}</p>
        {details.deliveryNotes === "" ? null : (
          <p style={{ color: "var(--sf-muted)", margin: 0 }}>Note: {details.deliveryNotes}</p>
        )}
        {details.preferredDate === "" && details.preferredTime === "" ? null : (
          <p style={{ margin: "6px 0 0" }}>
            Preferred:{" "}
            {details.preferredDate === "" ? "any date" : <bdi dir="ltr">{details.preferredDate}</bdi>}
            {details.preferredTime === "" ? "" : ` · ${details.preferredTime}`}
          </p>
        )}
      </section>

      <section className="sf-review-block">
        <div className="sf-review-block-head">
          <h2 style={{ fontSize: "1.02rem" }}>Products</h2>
          <button className="sf-link-button" onClick={() => navigate(`${base}/cart`)} type="button">
            Edit
          </button>
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {lines.map((line) => {
            const product = productBySlug(line.slug);
            if (product === undefined) return null;
            return (
              <li
                key={`${line.slug}:${line.size}:${line.color}`}
                style={{
                  borderBottom: "1px solid var(--sf-line)",
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "8px 0",
                }}
              >
                <span>
                  {product.name} — {line.size} / {line.color} × {line.quantity}
                </span>
                <bdi dir="ltr">{formatAed(product.price)}</bdi>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="sf-review-block">
        <h2 style={{ fontSize: "1.02rem", marginBottom: 10 }}>Payment</h2>
        <dl style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr auto", margin: 0 }}>
          <dt style={{ color: "var(--sf-muted)" }}>Subtotal</dt>
          <dd style={{ margin: 0, textAlign: "end" }}>
            <bdi dir="ltr">{formatAed(totals.subtotal)}</bdi>
          </dd>
          <dt style={{ color: "var(--sf-muted)" }}>Delivery charge</dt>
          <dd style={{ margin: 0, textAlign: "end" }}>
            {totals.freeDelivery ? "Free" : <bdi dir="ltr">{formatAed(totals.delivery)}</bdi>}
          </dd>
          <dt style={{ fontWeight: 700 }}>Total to pay on delivery</dt>
          <dd style={{ fontWeight: 700, margin: 0, textAlign: "end" }}>
            <bdi dir="ltr">{formatAed(totals.total)}</bdi>
          </dd>
        </dl>
        <p className="sf-cod-chip">
          <span aria-hidden="true">💵</span> Payment method: Cash on Delivery
        </p>
      </section>

      <button
        className="sf-button sf-button-block"
        onClick={() => {
          onConfirm();
          navigate(`${base}/confirmation`);
        }}
        type="button"
      >
        Confirm Order
      </button>
      <p style={{ color: "var(--sf-muted)", fontSize: "0.8rem", marginTop: 10, textAlign: "center" }}>
        Design prototype — confirming does not place a real order.
      </p>
    </div>
  );
}
