import { fromFils, formatAed, toFils } from "../lib/money.js";
import { useStore, type ActiveStore } from "../StoreContext.js";
import type { CartLine } from "../types.js";

/**
 * The one place cart arithmetic lives, so every screen shows the same totals.
 * Local demo math only — integer fils, flat delivery charge, free over the
 * threshold. Nothing here is a financial record.
 */
export function cartTotals(lines: readonly CartLine[], store: ActiveStore) {
  const subtotalFils = lines.reduce((sum, line) => {
    const product = store.productBySlug(line.slug);
    return product === undefined ? sum : sum + toFils(product.price) * line.quantity;
  }, 0);
  const deliveryFils =
    subtotalFils === 0 || subtotalFils >= toFils(store.config.delivery.freeOverAed)
      ? 0
      : toFils(store.config.delivery.chargeAed);
  return {
    delivery: fromFils(deliveryFils),
    freeDelivery: deliveryFils === 0 && subtotalFils > 0,
    subtotal: fromFils(subtotalFils),
    total: fromFils(subtotalFils + deliveryFils),
  };
}

export function OrderSummary({
  action,
  lines,
}: {
  readonly action?: React.ReactNode;
  readonly lines: readonly CartLine[];
}) {
  const store = useStore();
  const totals = cartTotals(lines, store);
  return (
    <aside aria-label="Order summary" className="sf-summary">
      <dl>
        <dt>Subtotal</dt>
        <dd>
          <bdi dir="ltr">{formatAed(totals.subtotal)}</bdi>
        </dd>
        <dt>Delivery charge</dt>
        <dd>
          {totals.freeDelivery ? "Free" : <bdi dir="ltr">{formatAed(totals.delivery)}</bdi>}
        </dd>
        <dt className="sf-total">Total — Cash on Delivery</dt>
        <dd className="sf-total">
          <bdi dir="ltr">{formatAed(totals.total)}</bdi>
        </dd>
      </dl>
      {action}
    </aside>
  );
}
