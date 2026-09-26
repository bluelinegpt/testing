import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useLocalePath } from "../routing/locale-routing.js";
import { Link } from "react-router-dom";

import { fetchMarketplaceCategories, fetchPublicStores } from "../api/commerce-client.js";
import type {
  CommerceFailure,
  MarketplaceCategory,
  PublicStoreSummary,
} from "../api/commerce-types.js";
import { LoadingGrid, MessageState } from "../components/States.js";
import { StoreCard } from "../components/Cards.js";
import { orderedHomeSections, type HomeSection } from "../config/home-sections.js";
import { taxonomyLabel } from "./CategoryPages.js";

/**
 * The marketplace root.
 *
 * ---------------------------------------------------------------------------
 * ONE STORE MEANS ONE CARD
 * ---------------------------------------------------------------------------
 *
 * Every data-backed section renders exactly the rows the API returned. With one
 * published Store the page shows one Store; with none, Featured Stores does not
 * appear at all and the page falls back to a single honest empty state.
 *
 * The temptation with a design like this is to pad it out so the layout reads
 * as intended during development. That would put fabricated shops in front of
 * customers, so there is no sample data anywhere in this application — not even
 * behind a development flag, because development flags reach production.
 *
 * ---------------------------------------------------------------------------
 * SECTIONS THAT HAVE NO BACKEND YET
 * ---------------------------------------------------------------------------
 *
 * Quick Categories is now backed by real Platform Marketplace taxonomy. Curated
 * Collections, Bestsellers, Recommended and the promotional banner still have
 * no API behind them: they are declared in the section config, they take part
 * in ordering, and they render NOTHING until data exists. That is deliberate —
 * the composition is real and later prompts fill it in, rather than the page
 * being rebuilt around each new endpoint.
 */
export function MarketplaceHomePage() {
  const [stores, setStores] = useState<readonly PublicStoreSummary[]>();
  const [categories, setCategories] = useState<readonly MarketplaceCategory[]>([]);
  const [failure, setFailure] = useState<CommerceFailure>();

  const load = useCallback(() => {
    const controller = new AbortController();
    setFailure(undefined);
    void fetchPublicStores(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") setStores(result.value.items);
      else setFailure(result.reason);
    });
    // Quick Categories is Platform taxonomy, not Trader Store Categories. A
    // failure here hides the section rather than failing the page: the
    // marketplace is still usable without its category shortcuts.
    void fetchMarketplaceCategories(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setCategories(result.kind === "ok" ? result.value.items : []);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => load(), [load]);

  const sections = orderedHomeSections();

  if (failure !== undefined) {
    return (
      <>
        <Hero />
        <div className="store-container">
          <MessageState
            bodyKey="errors.apiUnavailable.body"
            onRetry={() => load()}
            titleKey="errors.apiUnavailable.title"
          />
        </div>
      </>
    );
  }

  if (stores === undefined) {
    return (
      <>
        <Hero />
        <div className="store-container store-section">
          <LoadingGrid />
        </div>
      </>
    );
  }

  const hasAnything = stores.length > 0;

  return (
    <>
      <Hero />
      {hasAnything ? null : (
        <div className="store-container">
          <MessageState bodyKey="home.empty.body" titleKey="home.empty.title" />
        </div>
      )}
      {sections.map((section) => (
        <HomeSectionView
          categories={categories}
          key={section.kind}
          section={section}
          stores={stores}
        />
      ))}
    </>
  );
}

/**
 * The marketplace hero.
 *
 * A composed banner rather than a navy block with text in it: eyebrow, title,
 * lead, a real call to action, and an abstract panel that carries the brand
 * without pretending to be a photograph of merchandise nobody has supplied.
 *
 * The CTA points at `/categories`, which exists and is populated. There is no
 * promotional copy, no discount claim and no countdown, because none of that is
 * real -- a hero that announces "50% off" on a marketplace with no promotion is
 * a lie rendered at the largest possible size.
 */
function Hero() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  return (
    <section className="store-hero">
      <div className="store-container store-hero__inner">
        <div className="store-hero__copy">
          <p className="store-hero__eyebrow">{t("footer.rights")}</p>
          <h1 className="store-hero__title">{t("home.hero.title")}</h1>
          <p className="store-hero__lead">{t("home.hero.lead")}</p>
          <Link className="store-button store-button--onnavy" to={localePath("/categories")}>
            {t("home.hero.cta")}
          </Link>
        </div>
        <div aria-hidden="true" className="store-hero__art">
          <span className="store-hero__blob store-hero__blob--a" />
          <span className="store-hero__blob store-hero__blob--b" />
        </div>
      </div>
    </section>
  );
}

function HomeSectionView({
  categories,
  section,
  stores,
}: {
  readonly categories: readonly MarketplaceCategory[];
  readonly section: HomeSection;
  readonly stores: readonly PublicStoreSummary[];
}) {
  const { i18n, t } = useTranslation();
  const localePath = useLocalePath();

  // Real Platform Categories, ordered by the API, capped by section config.
  // Zero Categories hides the section entirely rather than showing a grid of
  // invented tiles.
  if (section.kind === "quick_categories") {
    if (categories.length === 0) return null;
    return (
      <section className="store-container store-section" data-testid="section-quick_categories">
        <header className="store-section__head">
          <h2 className="store-section__title">{t(section.titleKey)}</h2>
          <Link className="store-section__more" to={localePath("/categories")}>
            {t("common.viewAll")}
          </Link>
        </header>
        {/* Exactly the Categories the Platform published. Two real Categories
            render two tiles; the grid is never padded to fill a row. */}
        <div className="store-grid store-grid--categories">
          {categories.slice(0, section.itemLimit ?? categories.length).map((category) => (
            <Link
              className="store-catcard"
              key={category.slug}
              to={localePath(`/categories/${category.slug}`)}
            >
              <span aria-hidden="true" className="store-catcard__icon">
                {taxonomyLabel(category, i18n.language).trim().charAt(0)}
              </span>
              <span className="store-catcard__name" dir="auto">
                {taxonomyLabel(category, i18n.language)}
              </span>
              {category.subcategoryCount > 0 ? (
                <span className="store-catcard__meta">
                  {category.subcategoryCount} {t("categories.subcategories")}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      </section>
    );
  }

  // Data-backed sections. Absent data hides the whole section.
  if (section.kind === "featured_stores") {
    if (stores.length === 0) return null;
    const shown = stores.slice(0, section.itemLimit ?? stores.length);
    return (
      <section className="store-container store-section" data-testid="section-featured_stores">
        <header className="store-section__head">
          <h2 className="store-section__title">{t(section.titleKey)}</h2>
          {section.subtitleKey === undefined ? null : (
            <p className="store-section__subtitle">{t(section.subtitleKey)}</p>
          )}
        </header>
        <div className="store-grid store-grid--stores">
          {shown.map((store) => (
            <StoreCard key={store.slug} store={store} />
          ))}
        </div>
      </section>
    );
  }

  // Informational sections carry their own copy and are always safe to show.
  if (section.kind === "customer_account" || section.kind === "app_promotion") {
    const bodyKey = section.kind === "customer_account" ? "home.account.body" : "home.app.body";
    return (
      <section className="store-container store-section" data-testid={`section-${section.kind}`}>
        <div className="store-note">
          <h2 className="store-note__title">{t(section.titleKey)}</h2>
          <p className="store-note__body">{t(bodyKey)}</p>
          {section.kind === "customer_account" ? (
            <Link className="store-button store-button--quiet" to={localePath("/login")}>
              {t("auth.login")}
            </Link>
          ) : null}
        </div>
      </section>
    );
  }

  if (section.kind === "track_order") {
    return (
      <section className="store-container store-section" data-testid="section-track_order">
        <div className="store-note store-note--action">
          <div>
            <h2 className="store-note__title">{t(section.titleKey)}</h2>
            <p className="store-note__body">{t("home.track.body")}</p>
          </div>
          <Link className="store-button store-button--quiet" to={localePath("/track")}>
            {t("footer.track")}
          </Link>
        </div>
      </section>
    );
  }

  // Curated Collections, Bestsellers, Recommended and the promotional banner
  // still have no data source. They stay in the ordering and render nothing
  // rather than showing invented content.
  return null;
}
