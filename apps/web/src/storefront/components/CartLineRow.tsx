import { Link } from "react-router-dom";

import { formatAed, fromFils, toFils } from "../lib/money.js";
import { useStore } from "../StoreContext.js";
import type { CartLine } from "../types.js";
import { ProductPhoto } from "./ProductPhoto.js";

/** One cart row: image, options, unit price, quantity stepper, line total. */
export function CartLineRow({
  line,
  onQuantity,
  onRemove,
}: {
  readonly line: CartLine;
  readonly onQuantity: (line: CartLine, quantity: number) => void;
  readonly onRemove: (line: CartLine) => void;
}) {
  const { base, productBySlug } = useStore();
  const product = productBySlug(line.slug);
  if (product === undefined) return null;
  const lineTotal = fromFils(toFils(product.price) * line.quantity);
  return (
    <article aria-label={product.name} className="sf-cart-line">
      <Link to={`${base}/products/${product.slug}`}>
        <ProductPhoto className="sf-photo sf-photo-square" media={product.media[0]!} />
      </Link>
      <div>
        <div className="sf-cart-line-head">
          <div>
            <h3 className="sf-card-name">{product.name}</h3>
            <p className="sf-card-code">
              Size {line.size} · {line.color} · <bdi dir="ltr">{formatAed(product.price)}</bdi> each
            </p>
          </div>
          <button className="sf-remove" onClick={() => onRemove(line)} type="button">
            Remove
          </button>
        </div>
        <div className="sf-cart-line-foot">
          <span aria-label={`Quantity of ${product.name}`} className="sf-quantity">
            <button
              aria-label="Decrease quantity"
              onClick={() => onQuantity(line, Math.max(1, line.quantity - 1))}
              type="button"
            >
              −
            </button>
            <span>{line.quantity}</span>
            <button
              aria-label="Increase quantity"
              onClick={() => onQuantity(line, Math.min(9, line.quantity + 1))}
              type="button"
            >
              +
            </button>
          </span>
          <strong>
            <bdi dir="ltr">{formatAed(lineTotal)}</bdi>
          </strong>
        </div>
      </div>
    </article>
  );
}
