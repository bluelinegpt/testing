import { Fragment, useState } from "react";
import { Link } from "react-router-dom";

import { ProductGallery } from "../components/ProductGallery.js";
import { formatAed } from "../lib/money.js";
import { useStore } from "../StoreContext.js";

/**
 * Product details: full gallery, options, quantity, add to cart, COD promise
 * and the returns summary. No inventory quantity is shown or calculated —
 * availability is a plain yes/no, which is all the sample data carries.
 */
export function ProductDetailPage({
  onAdd,
  slug,
}: {
  readonly onAdd: (slug: string, size: string, color: string, quantity: number) => void;
  readonly slug: string;
}) {
  const { base, config, productBySlug, template } = useStore();
  const storeProfile = config.profile;
  const product = productBySlug(slug);
  const [size, setSize] = useState(product?.sizes[0] ?? "");
  const [color, setColor] = useState(product?.colors[0] ?? "");
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);

  if (product === undefined) {
    return (
      <div className="sf-empty">
        <h1 style={{ fontSize: "1.2rem", marginBottom: 8 }}>Product not found</h1>
        <p>
          <Link to={`${base}/products`}>Browse all products</Link>
        </p>
      </div>
    );
  }

  return (
    <article className="sf-detail">
      <ProductGallery media={product.media} />
      <div className="sf-detail-info">
        <h1>{product.name}</h1>
        <span className="sf-card-code">
          Code: <bdi dir="ltr">{product.code}</bdi>
        </span>
        <div className="sf-price-row" style={{ marginTop: 0 }}>
          <span className="sf-price" style={{ fontSize: "1.35rem" }}>
            <bdi dir="ltr">{formatAed(product.price)}</bdi>
          </span>
          {product.previousPrice === undefined ? null : (
            <s className="sf-price-was">
              <bdi dir="ltr">{formatAed(product.previousPrice)}</bdi>
            </s>
          )}
        </div>
        {product.available ? null : (
          <p className="sf-field-error" role="status" style={{ marginTop: 10 }}>
            This item is currently unavailable. Message us on WhatsApp to be notified.
          </p>
        )}
        <p style={{ color: "var(--sf-muted)", lineHeight: 1.65, marginTop: 14 }}>
          {product.description}
        </p>

        <fieldset className="sf-option-group" style={{ border: 0, margin: 0, padding: 0 }}>
          <span>{product.optionLabel ?? "Size"}</span>
          <div
            aria-label={`Choose ${(product.optionLabel ?? "Size").toLowerCase()}`}
            className="sf-choice-row"
            role="group"
          >
            {product.sizes.map((option) => (
              <button
                aria-pressed={size === option}
                className={`sf-choice${size === option ? " sf-active" : ""}`}
                key={option}
                onClick={() => setSize(option)}
                type="button"
              >
                {option}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="sf-option-group" style={{ border: 0, margin: 0, padding: 0 }}>
          <span>Colour</span>
          <div className="sf-choice-row" role="group" aria-label="Choose a colour">
            {product.colors.map((option) => (
              <button
                aria-pressed={color === option}
                className={`sf-choice${color === option ? " sf-active" : ""}`}
                key={option}
                onClick={() => setColor(option)}
                type="button"
              >
                {option}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="sf-option-group">
          <span>Quantity</span>
          <span aria-label="Quantity" className="sf-quantity">
            <button
              aria-label="Decrease quantity"
              onClick={() => setQuantity((current) => Math.max(1, current - 1))}
              type="button"
            >
              −
            </button>
            <span>{quantity}</span>
            <button
              aria-label="Increase quantity"
              onClick={() => setQuantity((current) => Math.min(9, current + 1))}
              type="button"
            >
              +
            </button>
          </span>
        </div>

        <div className="sf-option-group" style={{ display: "grid", gap: 10 }}>
          <button
            className="sf-button sf-button-block"
            disabled={!product.available}
            onClick={() => {
              onAdd(product.slug, size, color, quantity);
              setAdded(true);
            }}
            type="button"
          >
            {product.available ? "Add to Cart" : "Currently Unavailable"}
          </button>
          {added ? (
            <p role="status" style={{ color: "var(--sf-success)", margin: 0 }}>
              Added to your cart.{" "}
              <Link to={`${base}/cart`}>View cart</Link>
            </p>
          ) : null}
        </div>

        {template.warrantyBadge &&
        product.attributes?.some((attribute) => attribute.label === "Warranty") ? (
          <p className="sf-warranty-badge">
            <span aria-hidden="true">🛡</span>{" "}
            {product.attributes.find((attribute) => attribute.label === "Warranty")!.value}
          </p>
        ) : null}

        {product.attributes === undefined || product.attributes.length === 0 ? null : (
          <div className="sf-info-card" style={{ marginTop: 16 }}>
            <h3>{template.attributesHeading}</h3>
            {/* The TEMPLATE chooses the shape — a spec table for Electronics,
                a definition list elsewhere — over the SAME attribute data. */}
            {template.attributesAsTable ? (
              <table className="sf-spec-table">
                <tbody>
                  {product.attributes.map((attribute) => (
                    <tr key={attribute.label}>
                      <th scope="row">{attribute.label}</th>
                      <td>{attribute.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <dl className="sf-attribute-list">
                {product.attributes.map((attribute) => (
                  <Fragment key={attribute.label}>
                    <dt>{attribute.label}</dt>
                    <dd>{attribute.value}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
          </div>
        )}

        <p className="sf-cod-chip">
          <span aria-hidden="true">💵</span> Cash on Delivery — pay when your order arrives.
        </p>
        {template.highValueCodNotice === undefined ? null : (
          <div className="sf-info-card" style={{ marginTop: 14 }}>
            <h3>Cash on Delivery for High-Value Items</h3>
            <p>{template.highValueCodNotice}</p>
          </div>
        )}
        <div className="sf-info-card" style={{ marginTop: 14 }}>
          <h3>Returns</h3>
          <p>{storeProfile.policies.returns}</p>
        </div>
      </div>
    </article>
  );
}
