import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";

import { fetchPublicStore, fetchStoreProduct } from "../api/commerce-client.js";
import type {
  CommerceFailure,
  PublicProductDetail,
  PublicStore,
} from "../api/commerce-types.js";
import { CodeText, Money, TraderText } from "../components/Bidi.js";
import { ShareControl } from "../components/ShareControl.js";
import { MessageState } from "../components/States.js";
import { useLocalePath } from "../routing/locale-routing.js";
import { isReservedStoreSlug } from "../routing/reserved-slugs.js";

/**
 * A public Product at `/{store-slug}/products/{product-slug}`.
 *
 * Both segments are slugs, which is what the backend already exposes — the
 * public Product endpoint resolves by Product slug within a Store slug, so no
 * frontend-only identity had to be invented and no id appears in a customer's
 * address bar.
 *
 * An unavailable Product still renders in full. It is a real listing the
 * customer may have followed a link to; replacing it with "not found" would
 * both lose the information and imply the shop never sold it.
 *
 * ---------------------------------------------------------------------------
 * LAYOUT
 * ---------------------------------------------------------------------------
 *
 * Gallery and information are two columns on desktop and stacked on a phone —
 * the standard ecommerce arrangement, used here because shoppers already know
 * where to look in it, not because it is decorative.
 *
 * The gallery is built for up to eight images with a primary and thumbnails,
 * which is the model the Product media API already enforces. With exactly one
 * image the thumbnail strip is omitted rather than rendered as a single lonely
 * square, so a one-image Product looks deliberate instead of unfinished.
 */
export function ProductPage() {
  const { productSlug = "", storeSlug = "" } = useParams();
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const [product, setProduct] = useState<PublicProductDetail>();
  // Fetched only for the shop's display name. The Product endpoint returns the
  // Store SLUG, and showing a customer `dev-commerce-store` where the seller's
  // name belongs is an internal identifier leaking into the storefront copy.
  const [store, setStore] = useState<PublicStore>();
  const [failure, setFailure] = useState<CommerceFailure>();
  const [activeImage, setActiveImage] = useState(0);

  const reserved = isReservedStoreSlug(storeSlug);

  const load = useCallback(() => {
    if (reserved || storeSlug === "" || productSlug === "") return undefined;
    const controller = new AbortController();
    setFailure(undefined);
    void fetchPublicStore(storeSlug, controller.signal).then((result) => {
      if (controller.signal.aborted || result.kind !== "ok") return;
      setStore(result.value);
    });
    void fetchStoreProduct(storeSlug, productSlug, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setProduct(result.value);
        // Reset when navigating between Products: keeping index 3 from the
        // previous Product would open the next one on a blank frame.
        setActiveImage(0);
      } else setFailure(result.reason);
    });
    return () => controller.abort();
  }, [productSlug, reserved, storeSlug]);

  useEffect(() => load(), [load]);

  if (reserved || failure === "not_found") {
    return (
      <div className="store-container store-section">
        <MessageState
          bodyKey="errors.productNotFound.body"
          titleKey="errors.productNotFound.title"
        />
      </div>
    );
  }

  if (failure === "unavailable") {
    return (
      <div className="store-container store-section">
        <MessageState
          bodyKey="errors.apiUnavailable.body"
          onRetry={() => load()}
          titleKey="errors.apiUnavailable.title"
        />
      </div>
    );
  }

  if (product === undefined) {
    return (
      <div className="store-container store-section">
        <div className="store-skeleton" />
      </div>
    );
  }

  const images = product.media.filter((entry) => entry.mediaType === "image");
  const current = images[Math.min(activeImage, Math.max(images.length - 1, 0))];
  const unavailable = product.availabilityStatus !== "available";

  return (
    <div className="store-container store-section">
      <nav aria-label={t("categories.breadcrumb")} className="store-breadcrumbs">
        <ol>
          <li>
            <Link to={localePath("/")}>{t("categories.home")}</Link>
          </li>
          <li>
            <Link to={localePath(`/${storeSlug}`)}>
              {store?.displayName ?? t("product.backToStore")}
            </Link>
          </li>
          <li>
            <span aria-current="page" dir="auto">
              {product.name}
            </span>
          </li>
        </ol>
      </nav>

      <div className="store-product">
        <section aria-label={t("product.gallery")} className="store-gallery">
          <div className="store-gallery__main">
            {current === undefined ? (
              <div className="store-gallery__empty">{t("product.noImage")}</div>
            ) : (
              <img
                alt={current.altText ?? product.name}
                className="store-gallery__image"
                src={current.url}
              />
            )}
          </div>

          {/* One image needs no picker. */}
          {images.length > 1 ? (
            <ul className="store-gallery__thumbs">
              {images.map((entry, index) => (
                <li key={entry.url}>
                  <button
                    aria-current={index === activeImage}
                    aria-label={t("product.imageOf", {
                      index: index + 1,
                      total: images.length,
                    })}
                    className={`store-gallery__thumb${index === activeImage ? " is-active" : ""}`}
                    onClick={() => {
                      setActiveImage(index);
                    }}
                    type="button"
                  >
                    <img alt="" loading="lazy" src={entry.url} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="store-productinfo">
          <TraderText as="h1" className="store-productinfo__name" value={product.name} />

          <p className="store-productinfo__soldby">
            {t("product.soldBy")}{" "}
            <Link dir="auto" to={localePath(`/${storeSlug}`)}>
              {store?.displayName ?? storeSlug}
            </Link>
          </p>

          <div className="store-productinfo__pricing">
            <Money
              amount={product.sellingPrice}
              className="store-price store-price--lg"
              currency={product.currency}
            />
            {product.previousPrice === null ? null : (
              <Money
                amount={product.previousPrice}
                className="store-price store-price--was"
                currency={product.currency}
              />
            )}
          </div>

          <p
            className={`store-badge ${
              unavailable ? "store-badge--muted" : "store-badge--success"
            }`}
          >
            {t(`product.availability.${product.availabilityStatus}`)}
          </p>

          {/*
            Brand and code are a definition list, and each VALUE is isolated.
            `DEV-ABAYA-0001` beside an Arabic label reorders its hyphenated
            groups without this, showing the customer a code that is not the
            code — plausible enough that nobody catches it until support does.
          */}
          {product.brand === null && product.productCode === null ? null : (
            <dl className="store-facts">
              {product.brand === null ? null : (
                <div className="store-fact">
                  <dt className="store-fact__label">{t("product.brand")}</dt>
                  <dd className="store-fact__value">
                    <TraderText value={product.brand} />
                  </dd>
                </div>
              )}
              {product.productCode === null ? null : (
                <div className="store-fact">
                  <dt className="store-fact__label">{t("product.code")}</dt>
                  <dd className="store-fact__value">
                    <CodeText className="store-code" value={product.productCode} />
                  </dd>
                </div>
              )}
            </dl>
          )}

          {product.shortDescription === null ? null : (
            <TraderText
              as="p"
              className="store-productinfo__lead"
              value={product.shortDescription}
            />
          )}

          {product.options.length === 0 ? null : (
            <div className="store-options">
              {product.options.map((group) => (
                <fieldset className="store-optiongroup" key={group.name}>
                  <legend className="store-optiongroup__legend">
                    {/*
                      The group NAME is Trader-entered ("Size"), so it is
                      isolated and left as written. The "Required" marker is a
                      system label and is translated — the previous
                      `Size * مطلوب` was one of each jammed together with an
                      asterisk doing the work of a word.
                    */}
                    <TraderText value={group.name} />
                    {group.isRequired ? (
                      <span className="store-optiongroup__required">
                        {t("product.optionRequired")}
                      </span>
                    ) : null}
                  </legend>
                  <ul className="store-optionvalues">
                    {group.values.map((value) => (
                      <li key={value.value}>
                        {/* Values like S/M/L stay Latin and stay isolated. Not
                            selectable yet: selection belongs to the cart. */}
                        <span className="store-optionvalue" dir="auto">
                          {value.value}
                        </span>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              ))}
            </div>
          )}

          <div className="store-productinfo__actions">
            <ShareControl
              text={product.shortDescription ?? undefined}
              title={product.name}
            />
          </div>

          {product.fullDescription === null ? null : (
            <section className="store-panel">
              <h2 className="store-panel__title">{t("product.details")}</h2>
              <TraderText as="p" className="store-panel__body" value={product.fullDescription} />
            </section>
          )}
        </section>
      </div>
    </div>
  );
}
