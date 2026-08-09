import { Link, useNavigate } from "react-router-dom";

import { CartLineRow } from "../components/CartLineRow.js";
import { OrderSummary } from "../components/OrderSummary.js";
import { useStore } from "../StoreContext.js";
import type { CartLine } from "../types.js";

export function CartPage({
  lines,
  onQuantity,
  onRemove,
}: {
  readonly lines: readonly CartLine[];
  readonly onQuantity: (line: CartLine, quantity: number) => void;
  readonly onRemove: (line: CartLine) => void;
}) {
  const navigate = useNavigate();
  const { base } = useStore();
  if (lines.length === 0) {
    return (
      <div className="sf-empty">
        <h1 style={{ fontSize: "1.25rem", marginBottom: 8 }}>Your cart is empty</h1>
        <p style={{ marginBottom: 16 }}>Browse the collection and add something you love.</p>
        <Link className="sf-button" to={`${base}/products`}>
          Continue Shopping
        </Link>
      </div>
    );
  }
  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "6px 0 16px" }}>Your Cart</h1>
      <div className="sf-cart-layout">
        <div style={{ display: "grid", gap: 12 }}>
          {lines.map((line) => (
            <CartLineRow
              key={`${line.slug}:${line.size}:${line.color}`}
              line={line}
              onQuantity={onQuantity}
              onRemove={onRemove}
            />
          ))}
          <Link style={{ color: "var(--sf-gold)" }} to={`${base}/products`}>
            ← Continue shopping
          </Link>
        </div>
        <OrderSummary
          action={
            <button
              className="sf-button sf-button-block"
              onClick={() => navigate(`${base}/checkout`)}
              type="button"
            >
              Proceed to Checkout
            </button>
          }
          lines={lines}
        />
      </div>
    </>
  );
}
