import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useLocalePath } from "../routing/locale-routing.js";
import { Link, useParams } from "react-router-dom";

import {
  fetchCategoryProducts,
  fetchCategoryStores,
  fetchMarketplaceCategories,
  fetchMarketplaceCategory,
} from "../api/commerce-client.js";
import type {
  CommerceFailure,
  MarketplaceCategory,
  MarketplaceCategoryDetail,
  MarketplaceProduct,
  Paged,
  PublicStoreSummary,
} from "../api/commerce-types.js";
import { ProductCard, StoreCard } from "../components/Cards.js";
import { LoadingGrid, MessageState } from "../components/States.js";

/**
 * Marketplace Category browsing.
 *
 * ---------------------------------------------------------------------------
 * ARABIC WHERE IT EXISTS, ENGLISH WHERE IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * `taxonomyLabel` picks `name_ar` when the interface is Arabic AND the Platform
 * actually supplied one, otherwise the English name. Nothing is translated at
 * runtime: a missing Arabic name shows the English word rather than a machine
 * rendering, which is both honest and stable. The dev taxonomy deliberately
 * leaves "Electronics" without an Arabic name so this path is exercised rather
 * than assumed.
 *
 * ---------------------------------------------------------------------------
 * A SUBCATEGORY PAGE SHOWS ONLY ITS OWN PRODUCTS
 * ---------------------------------------------------------------------------
 *
 * The Subcategory route asks the API for that Subcategory specifically; it does
 * not fetch the Category and filter in the browser. Sibling Products are absent
 * because the server never sent them, which is the only way that stays true as
 * catalogues grow past one page.
 */

/** The label to show for a taxonomy row in the active language. */
export function taxonomyLabel(
  row: { readonly nameAr: string | null; readonly nameEn: string },
  language: string,
): string {
  if (language.startsWith("ar") && row.nameAr !== null && row.nameAr.trim() !== "") {
    return row.nameAr;
  }
  return row.nameEn;
}

/**
 * Marketplace breadcrumbs.
 *
 * A real `<nav aria-label>` with an ordered list, so the trail is announced as
 * a trail. Direction mirrors from the document `dir` because the list is laid
 * out with logical properties — no separate RTL variant.
 */
function Breadcrumbs({
  trail,
}: {
  readonly trail: readonly { readonly label: string; readonly to?: string }[];
}) {
  const { t } = useTranslation();
  // Prefixed here rather than at every call site: a breadcrumb built without
  // the prefix drops the shopper out of Arabic on the way back up the trail.
  const localePath = useLocalePath();
  return (
    <nav aria-label={t("categories.breadcrumb")} className="store-breadcrumbs">
      <ol>
        {trail.map((crumb) => (
          <li key={crumb.label}>
            {crumb.to === undefined ? (
              <span aria-current="page">{crumb.label}</span>
            ) : (
              <Link to={localePath(crumb.to)}>{crumb.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ------------------------------------------------------------------ /categories

export function CategoriesPage() {
  const { i18n, t } = useTranslation();
  const localePath = useLocalePath();
  const [categories, setCategories] = useState<readonly MarketplaceCategory[]>();
  const [failure, setFailure] = useState<CommerceFailure>();

  const load = useCallback(() => {
    const controller = new AbortController();
    setFailure(undefined);
    void fetchMarketplaceCategories(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") setCategories(result.value.items);
      else setFailure(result.reason);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => load(), [load]);

  if (failure !== undefined) {
    return (
      <div className="store-container">
        <MessageState
          bodyKey="errors.apiUnavailable.body"
          onRetry={() => load()}
          titleKey="errors.apiUnavailable.title"
        />
      </div>
    );
  }
  if (categories === undefined) {
    return (
      <div className="store-container store-section">
        <LoadingGrid />
      </div>
    );
  }

  return (
    <div className="store-container store-section">
      <Breadcrumbs trail={[{ label: t("categories.home"), to: "/" }, { label: t("categories.title") }]} />
      <h1 className="store-section__title">{t("categories.title")}</h1>
      {categories.length === 0 ? (
        <MessageState bodyKey="categories.empty.body" titleKey="categories.empty.title" />
      ) : (
        <div className="store-grid store-grid--categories" data-testid="marketplace-categories">
          {categories.map((category) => (
            <article className="store-card store-card--category" key={category.slug}>
              <h2 className="store-card__name">
                <Link to={localePath(`/categories/${category.slug}`)}>
                  <span aria-hidden="true" className="store-catcard__icon">
                    {taxonomyLabel(category, i18n.language).trim().charAt(0)}
                  </span>
                  <span dir="auto">{taxonomyLabel(category, i18n.language)}</span>
                </Link>
              </h2>
              {category.descriptionEn === null ? null : (
                <p className="store-card__meta">{category.descriptionEn}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------- /categories/{category-slug}

export function CategoryDetailPage() {
  const { categorySlug = "" } = useParams();
  const { i18n, t } = useTranslation();
  const localePath = useLocalePath();
  const [category, setCategory] = useState<MarketplaceCategoryDetail>();
  const [stores, setStores] = useState<readonly PublicStoreSummary[]>();
  const [products, setProducts] = useState<Paged<MarketplaceProduct>>();
  const [failure, setFailure] = useState<CommerceFailure>();

  const load = useCallback(() => {
    if (categorySlug === "") return undefined;
    const controller = new AbortController();
    setFailure(undefined);
    void fetchMarketplaceCategory(categorySlug, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "error") {
        setFailure(result.reason);
        return;
      }
      setCategory(result.value);
      const [storeResult, productResult] = await Promise.all([
        fetchCategoryStores(categorySlug, controller.signal),
        fetchCategoryProducts(categorySlug, {}, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setStores(storeResult.kind === "ok" ? storeResult.value.items : []);
      if (productResult.kind === "ok") setProducts(productResult.value);
    });
    return () => controller.abort();
  }, [categorySlug]);

  useEffect(() => load(), [load]);

  if (failure === "not_found") {
    return (
      <div className="store-container">
        <MessageState
          bodyKey="categories.notFound.body"
          titleKey="categories.notFound.title"
        />
      </div>
    );
  }
  if (failure === "unavailable") {
    return (
      <div className="store-container">
        <MessageState
          bodyKey="errors.apiUnavailable.body"
          onRetry={() => load()}
          titleKey="errors.apiUnavailable.title"
        />
      </div>
    );
  }
  if (category === undefined) {
    return (
      <div className="store-container store-section">
        <LoadingGrid />
      </div>
    );
  }

  const label = taxonomyLabel(category, i18n.language);

  return (
    <div className="store-container store-section">
      <Breadcrumbs
        trail={[
          { label: t("categories.home"), to: "/" },
          { label: t("categories.title"), to: "/categories" },
          { label },
        ]}
      />
      <h1 className="store-section__title">{label}</h1>
      {category.descriptionEn === null ? null : (
        <p className="store-section__subtitle">{category.descriptionEn}</p>
      )}

      {category.subcategories.length === 0 ? null : (
        <section className="store-section" data-testid="subcategories">
          <h2 className="store-section__title">{t("categories.subcategories")}</h2>
          <div className="store-chips">
            {category.subcategories.map((child) => (
              <Link
                className="store-chip store-chip--link"
                key={child.slug}
                to={localePath(`/categories/${category.slug}/${child.slug}`)}
              >
                {taxonomyLabel(child, i18n.language)}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="store-section">
        <h2 className="store-section__title">{t("categories.stores")}</h2>
        {stores === undefined ? (
          <LoadingGrid />
        ) : stores.length === 0 ? (
          <MessageState bodyKey="categories.noStores.body" titleKey="categories.noStores.title" />
        ) : (
          <div className="store-grid store-grid--stores" data-testid="category-stores">
            {stores.map((store) => (
              <StoreCard key={store.slug} store={store} />
            ))}
          </div>
        )}
      </section>

      <CategoryProducts products={products} />
    </div>
  );
}

// -------------------------------- /categories/{category-slug}/{subcategory-slug}

export function SubcategoryPage() {
  const { categorySlug = "", subcategorySlug = "" } = useParams();
  const { i18n, t } = useTranslation();
  const [category, setCategory] = useState<MarketplaceCategoryDetail>();
  const [products, setProducts] = useState<Paged<MarketplaceProduct>>();
  const [failure, setFailure] = useState<CommerceFailure>();

  const load = useCallback(() => {
    if (categorySlug === "" || subcategorySlug === "") return undefined;
    const controller = new AbortController();
    setFailure(undefined);
    void fetchMarketplaceCategory(categorySlug, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "error") {
        setFailure(result.reason);
        return;
      }
      const child = result.value.subcategories.find((entry) => entry.slug === subcategorySlug);
      if (child === undefined) {
        setFailure("not_found");
        return;
      }
      setCategory(result.value);
      const productResult = await fetchCategoryProducts(
        categorySlug,
        { subcategorySlug },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (productResult.kind === "ok") setProducts(productResult.value);
    });
    return () => controller.abort();
  }, [categorySlug, subcategorySlug]);

  useEffect(() => load(), [load]);

  if (failure === "not_found") {
    return (
      <div className="store-container">
        <MessageState bodyKey="categories.notFound.body" titleKey="categories.notFound.title" />
      </div>
    );
  }
  if (failure === "unavailable") {
    return (
      <div className="store-container">
        <MessageState
          bodyKey="errors.apiUnavailable.body"
          onRetry={() => load()}
          titleKey="errors.apiUnavailable.title"
        />
      </div>
    );
  }
  if (category === undefined) {
    return (
      <div className="store-container store-section">
        <LoadingGrid />
      </div>
    );
  }

  const child = category.subcategories.find((entry) => entry.slug === subcategorySlug)!;
  const categoryLabel = taxonomyLabel(category, i18n.language);
  const childLabel = taxonomyLabel(child, i18n.language);

  return (
    <div className="store-container store-section">
      <Breadcrumbs
        trail={[
          { label: t("categories.home"), to: "/" },
          { label: t("categories.title"), to: "/categories" },
          { label: categoryLabel, to: `/categories/${category.slug}` },
          { label: childLabel },
        ]}
      />
      <h1 className="store-section__title">{childLabel}</h1>
      <CategoryProducts products={products} />
    </div>
  );
}

function CategoryProducts({ products }: { readonly products: Paged<MarketplaceProduct> | undefined }) {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  if (products === undefined) return <LoadingGrid />;
  if (products.items.length === 0) {
    return (
      <MessageState
        // A Subcategory can legitimately be empty. Offering the way back to the
        // full taxonomy turns a dead end into a next step, without inventing
        // any Products to fill the space.
        action={
          <Link className="store-button store-button--quiet" to={localePath("/categories")}>
            {t("categories.browseOthers")}
          </Link>
        }
        bodyKey="categories.noProducts.body"
        titleKey="categories.noProducts.title"
      />
    );
  }
  return (
    <section className="store-section">
      <h2 className="store-section__title">
        {t("categories.products")} ({products.total})
      </h2>
      <div className="store-grid store-grid--products" data-testid="category-products">
        {products.items.map((product) => (
          <ProductCard
            key={`${product.storeSlug}-${product.slug}`}
            product={{ ...product, categoryName: null, categorySlug: null, productCode: null }}
            storeName={product.storeName}
            storeSlug={product.storeSlug}
          />
        ))}
      </div>
    </section>
  );
}
