import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";

import {
  fetchPublicStore,
  fetchStoreCategories,
  fetchStoreProducts,
} from "../api/commerce-client.js";
import type {
  CommerceFailure,
  PublicProduct,
  PublicStore,
  StoreCategory,
} from "../api/commerce-types.js";
import { TraderText } from "../components/Bidi.js";
import { ProductCard } from "../components/Cards.js";
import { LoadingGrid, MessageState } from "../components/States.js";
import { isReservedStoreSlug } from "../routing/reserved-slugs.js";

/**
 * A public Store at `/{store-slug}`.
 *
 * The slug is checked against the reserved marketplace words before any request
 * is made. `/cart` must never become a lookup for a shop called "cart", both
 * because it would be wrong and because a 404 from the API is a slower and
 * noisier way to reach the same answer.
 *
 * A closed shop still renders: its name, policies and hours are shown with a
 * closed notice rather than being replaced by an error, because "this shop
 * exists and is shut right now" is different information from "there is no such
 * shop", and a customer deserves the first when it is true.
 *
 * ---------------------------------------------------------------------------
 * STRUCTURE
 * ---------------------------------------------------------------------------
 *
 * A banner carrying the cover and logo, then Products, then the shop's own
 * information in a sidebar. Policies used to render as consecutive walls of
 * unlabelled prose; they are now discrete titled panels, because "delivery
 * information" and "returns" answer different questions and a customer scans
 * for the one they need.
 *
 * Sections with no data are omitted entirely rather than rendered empty. A
 * heading over nothing reads as a shop that failed to load.
 */
export function StorePage() {
  const { storeSlug = "" } = useParams();
  const { t } = useTranslation();
  const [store, setStore] = useState<PublicStore>();
  const [products, setProducts] = useState<readonly PublicProduct[]>();
  const [categories, setCategories] = useState<readonly StoreCategory[]>();
  const [failure, setFailure] = useState<CommerceFailure>();

  const reserved = isReservedStoreSlug(storeSlug);

  const load = useCallback(() => {
    if (reserved || storeSlug === "") return undefined;
    const controller = new AbortController();
    setFailure(undefined);
    void fetchPublicStore(storeSlug, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "error") {
        setFailure(result.reason);
        return;
      }
      setStore(result.value);
      const [productResult, categoryResult] = await Promise.all([
        fetchStoreProducts(storeSlug, controller.signal),
        fetchStoreCategories(storeSlug, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setProducts(productResult.kind === "ok" ? productResult.value.items : []);
      setCategories(categoryResult.kind === "ok" ? categoryResult.value.items : []);
    });
    return () => controller.abort();
  }, [reserved, storeSlug]);

  useEffect(() => load(), [load]);

  if (reserved || failure === "not_found") {
    return (
      <div className="store-container store-section">
        <MessageState bodyKey="errors.storeNotFound.body" titleKey="errors.storeNotFound.title" />
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

  if (store === undefined) {
    return (
      <div className="store-container store-section">
        <div className="store-skeleton" />
      </div>
    );
  }

  const closed = store.status === "temporarily_closed";
  const panels = [
    { body: store.deliveryInformation, key: "delivery", title: t("store.delivery") },
    { body: store.returnPolicy, key: "returns", title: t("store.returns") },
    { body: store.customerSupport, key: "support", title: t("store.support") },
    { body: store.terms, key: "terms", title: t("store.terms") },
  ].filter((panel) => panel.body !== null);

  const contacts = [
    { key: "mobile", label: t("store.mobile"), value: store.publicMobile },
    { key: "whatsapp", label: t("store.whatsapp"), value: store.publicWhatsapp },
    { key: "email", label: t("store.email"), value: store.publicEmail },
  ].filter((contact) => contact.value !== null);

  return (
    <>
      <header className="store-hero-banner">
        {store.coverUrl === null ? (
          <div aria-hidden="true" className="store-hero-banner__cover store-hero-banner__cover--empty" />
        ) : (
          <img alt="" className="store-hero-banner__cover" src={store.coverUrl} />
        )}

        <div className="store-container store-hero-banner__inner">
          <div className="store-identity">
            <div className="store-identity__logo">
              {store.logoUrl === null ? (
                <span aria-hidden="true" className="store-identity__initial">
                  {store.displayName.trim().charAt(0)}
                </span>
              ) : (
                <img alt={store.displayName} src={store.logoUrl} />
              )}
            </div>
            <div className="store-identity__text">
              <TraderText as="h1" className="store-identity__name" value={store.displayName} />
              <p className="store-identity__status">
                <span
                  className={`store-badge ${closed ? "store-badge--muted" : "store-badge--success"}`}
                >
                  {closed ? t("store.closed") : t("store.open")}
                </span>
              </p>
              {store.storeDescription === null ? null : (
                <TraderText
                  as="p"
                  className="store-identity__desc"
                  value={store.storeDescription}
                />
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="store-container store-section store-storelayout">
        <div className="store-storelayout__main">
          {categories !== undefined && categories.length > 0 ? (
            <section className="store-block">
              <h2 className="store-block__title">{t("store.categories")}</h2>
              <ul className="store-chips">
                {categories.map((category) => (
                  <li key={category.slug}>
                    <span className="store-chip" dir="auto">
                      {category.name}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="store-block">
            <h2 className="store-block__title">{t("store.products")}</h2>
            {products === undefined ? (
              <LoadingGrid />
            ) : products.length === 0 ? (
              <MessageState
                bodyKey="store.noProducts.body"
                titleKey="store.noProducts.title"
              />
            ) : (
              <div className="store-grid store-grid--products">
                {products.map((product) => (
                  <ProductCard key={product.slug} product={product} storeSlug={storeSlug} />
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="store-storelayout__side">
          {store.businessHours.length === 0 ? null : (
            <section className="store-panel">
              <h2 className="store-panel__title">{t("store.businessHours")}</h2>
              <dl className="store-facts">
                {store.businessHours.map((entry) => (
                  <div className="store-fact" key={`${entry.days}-${entry.time}`}>
                    <dt className="store-fact__label" dir="auto">
                      {entry.days}
                    </dt>
                    <dd className="store-fact__value">
                      <bdi dir="ltr">{entry.time}</bdi>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {contacts.length === 0 ? null : (
            <section className="store-panel">
              <h2 className="store-panel__title">{t("store.contact")}</h2>
              <dl className="store-facts">
                {contacts.map((contact) => (
                  <div className="store-fact" key={contact.key}>
                    <dt className="store-fact__label">{contact.label}</dt>
                    <dd className="store-fact__value">
                      {/* Phone numbers and addresses are LTR regardless of the
                          page language; a reordered number is unusable. */}
                      <bdi dir="ltr">{contact.value}</bdi>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {panels.map((panel) => (
            <section className="store-panel" key={panel.key}>
              <h2 className="store-panel__title">{panel.title}</h2>
              <TraderText as="p" className="store-panel__body" value={panel.body!} />
            </section>
          ))}
        </aside>
      </div>
    </>
  );
}
