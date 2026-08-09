import { Link } from "react-router-dom";

import { formatAed } from "../lib/money.js";
import { useStore } from "../StoreContext.js";
import type { StorefrontProduct } from "../types.js";
import { ProductPhoto } from "./ProductPhoto.js";

const badgeLabels: Readonly<Record<string, string>> = {
  best_seller: "Best Seller",
  featured: "Featured",
  new_arrival: "New",
};

/**
 * One product tile. The whole image is the details link; Add to Cart is a
 * separate large-tap-target button that enrols the product with its default
 * options — details is where a customer chooses size and colour deliberately.
 * Unavailable products keep their card (hiding them would make the catalogue
 * look thinner than it is) but lose the action.
 */
export function ProductCard({
  onAdd,
  product,
}: {
  readonly onAdd: (product: StorefrontProduct) => void;
  readonly product: StorefrontProduct;
}) {
  const { base } = useStore();
  const href = `${base}/products/${product.slug}`;
  const primary = product.media[0]!;
  return (
    <article className="sf-card">
      <Link aria-label={`View ${product.name}`} className="sf-card-media" to={href}>
        <ProductPhoto media={primary} />
        <span className="sf-card-badges">
          {product.badges.map((badge) => (
            <span
              className={`sf-badge${badge === "featured" ? " sf-badge-gold" : ""}`}
              key={badge}
            >
              {badgeLabels[badge]}
            </span>
          ))}
        </span>
        {product.available ? null : (
          <span className="sf-unavailable-cover">Currently Unavailable</span>
        )}
      </Link>
      <div className="sf-card-body">
        <h3 className="sf-card-name">
          <Link to={href}>{product.name}</Link>
        </h3>
        <span className="sf-card-code">
          <bdi dir="ltr">{product.code}</bdi>
        </span>
        <div className="sf-price-row">
          <span className="sf-price">
            <bdi dir="ltr">{formatAed(product.price)}</bdi>
          </span>
          {product.previousPrice === undefined ? null : (
            <s className="sf-price-was">
              <bdi dir="ltr">{formatAed(product.previousPrice)}</bdi>
            </s>
          )}
        </div>
        <button
          className="sf-button"
          disabled={!product.available}
          onClick={() => onAdd(product)}
          type="button"
        >
          {product.available ? "Add to Cart" : "Unavailable"}
        </button>
      </div>
    </article>
  );
}
