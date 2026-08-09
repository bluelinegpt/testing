import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useLocalePath } from "../routing/locale-routing.js";

import { Money, TraderText } from "./Bidi.js";

import type { PublicProduct, PublicStoreSummary } from "../api/commerce-types.js";

/**
 * Store and Product cards.
 *
 * ---------------------------------------------------------------------------
 * NOTHING ON A CARD IS INVENTED
 * ---------------------------------------------------------------------------
 *
 * There are no star ratings, no "Bestseller" flags, no "New" ribbons pretending
 * to be merchandising. The backend supplies none of them, and a marketplace
 * that decorates cards with fabricated social proof is misleading a customer
 * about a purchase.
 *
 * "New store" IS shown, and is not an invention: it is the honest reading of a
 * shop with no rating data, and it is why the eventual rating work must never
 * render `0.0` — which looks like a terrible rating rather than an absent one.
 *
 * The only other badges are availability and a computed discount, both derived
 * from real Product fields.
 *
 * ---------------------------------------------------------------------------
 * REAL MEDIA IS ALWAYS PREFERRED
 * ---------------------------------------------------------------------------
 *
 * The fallback tile renders ONLY when there is genuinely no media. Earlier the
 * placeholder was showing even where an image existed, so an uploaded Product
 * photo appeared as a flat coloured block — the single most damaging thing a
 * shopping card can do, because it reads as a broken shop rather than a
 * styling bug.
 */

function Thumb({
  alt,
  className,
  url,
}: {
  readonly alt: string;
  readonly className: string;
  readonly url: string | null;
}) {
  if (url === null) {
    return (
      <div aria-hidden="true" className={`${className} store-thumb--empty`}>
        {/* Wordless on purpose: a shop with no photo should read as quiet, not
            as an error the customer is expected to act on. */}
        <ImagePlaceholderIcon />
      </div>
    );
  }
  return (
    <img
      alt={alt}
      className={className}
      /* `object-fit: contain` in CSS, not `cover`: a portrait abaya and a
         square accessory both have to sit in the same tile without being
         cropped through the middle or stretched out of proportion. */
      loading="lazy"
      src={url}
    />
  );
}

export function StoreCard({
  categoryName,
  store,
}: {
  /** Primary Marketplace Category, where the caller has it. Never guessed. */
  readonly categoryName?: string | undefined;
  readonly store: PublicStoreSummary;
}) {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const closed = store.status === "temporarily_closed";
  const headingId = `store-card-${store.slug}`;

  return (
    <article className="store-card store-card--store">
      {/* Labelled BY the heading rather than repeating its text in a hidden
          span: the duplicate made screen readers announce the shop name twice
          and made the name ambiguous to any query that looks it up by text. */}
      <Link
        aria-labelledby={headingId}
        className="store-card__hit"
        to={localePath(`/${store.slug}`)}
      />

      <div className="store-card__logowrap">
        <Thumb alt={store.displayName} className="store-card__logo" url={store.logoUrl} />
      </div>

      <div className="store-card__body">
        <h3 className="store-card__name" dir="auto" id={headingId}>
          {store.displayName}
        </h3>
        {categoryName === undefined ? null : (
          <p className="store-card__eyebrow">{categoryName}</p>
        )}
        {store.storeDescription === null ? null : (
          <TraderText as="p" className="store-card__desc" value={store.storeDescription} />
        )}
        <div className="store-card__foot">
          {closed ? (
            <span className="store-badge store-badge--muted">{t("store.closed")}</span>
          ) : (
            <span className="store-badge store-badge--soft">{t("store.newStore")}</span>
          )}
        </div>
      </div>
    </article>
  );
}

export function ProductCard({
  product,
  storeName,
  storeSlug,
}: {
  readonly product: PublicProduct;
  /** Shown only where marketplace context needs it — not on a Store's own page. */
  readonly storeName?: string;
  readonly storeSlug: string;
}) {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const unavailable = product.availabilityStatus !== "available";
  const headingId = `product-card-${storeSlug}-${product.slug}`;

  return (
    <article className={`store-card store-card--product${unavailable ? " is-unavailable" : ""}`}>
      <Link
        aria-labelledby={headingId}
        className="store-card__hit"
        to={localePath(`/${storeSlug}/products/${product.slug}`)}
      />

      <div className="store-card__media">
        <Thumb
          alt={product.primaryImage?.altText ?? product.name}
          className="store-card__image"
          url={product.primaryImage?.url ?? null}
        />
        {unavailable ? (
          <span className="store-badge store-badge--overlay">
            {t("product.availability.unavailable")}
          </span>
        ) : null}
      </div>

      <div className="store-card__body">
        {storeName === undefined ? null : (
          <TraderText as="p" className="store-card__eyebrow" value={storeName} />
        )}
        <h3 className="store-card__name" dir="auto" id={headingId}>
          {product.name}
        </h3>

        <p className="store-card__pricerow">
          <Money
            amount={product.sellingPrice}
            className="store-price"
            currency={product.currency}
          />
          {product.previousPrice === null ? null : (
            <Money
              amount={product.previousPrice}
              className="store-price store-price--was"
              currency={product.currency}
            />
          )}
        </p>
      </div>
    </article>
  );
}

function ImagePlaceholderIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 48 48">
      <rect
        height="30"
        rx="4"
        stroke="currentColor"
        strokeWidth="2"
        width="36"
        x="6"
        y="9"
      />
      <circle cx="17" cy="19" fill="currentColor" r="3" />
      <path
        d="M9 35l10-10 7 7 5-4 8 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}
