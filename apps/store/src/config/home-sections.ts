/**
 * Marketplace homepage composition.
 *
 * ---------------------------------------------------------------------------
 * THE SECTION ORDER IS DATA, NOT JSX
 * ---------------------------------------------------------------------------
 *
 * The homepage renders by mapping over this array. Nothing in the page
 * component knows that Featured Stores comes before Bestsellers, which means
 * reordering, retitling, capping or switching off a section later is an edit to
 * a typed list — eventually a Platform-admin screen writing the same shape —
 * rather than surgery on a large component.
 *
 * This is intentionally a small typed structure and not a configuration engine.
 * The Platform-admin UI belongs to a later phase; what matters now is that the
 * page cannot harden into an order that is impossible to change.
 *
 * ---------------------------------------------------------------------------
 * A SECTION WITH NO DATA RENDERS NOTHING
 * ---------------------------------------------------------------------------
 *
 * `enabled` says the operator wants the section. Whether it appears is decided
 * by whether real rows came back. There is no sample content anywhere in this
 * application: a marketplace with one Store shows one Store, and a section with
 * nothing in it is hidden rather than padded. A homepage that invents shops is
 * lying to a customer about what they can buy.
 */

export type HomeSectionKind =
  | "app_promotion"
  | "bestsellers"
  | "curated_collections"
  | "customer_account"
  | "featured_stores"
  | "promotional_banner"
  | "quick_categories"
  | "recommended"
  | "track_order";

export interface HomeSection {
  /** Operator intent. Data availability decides actual visibility. */
  readonly enabled: boolean;
  /** Maximum rows to render when the section is data-backed. */
  readonly itemLimit?: number;
  readonly kind: HomeSectionKind;
  /** Ascending. Duplicated values keep declaration order. */
  readonly order: number;
  /** Localization key; a later admin screen may override with literal text. */
  readonly subtitleKey?: string;
  readonly titleKey: string;
}

export const defaultHomeSections: readonly HomeSection[] = [
  {
    enabled: true,
    itemLimit: 12,
    kind: "quick_categories",
    order: 10,
    titleKey: "home.quickCategories.title",
  },
  {
    enabled: true,
    kind: "promotional_banner",
    order: 20,
    titleKey: "home.promotionalBanner.title",
  },
  {
    enabled: true,
    itemLimit: 8,
    kind: "curated_collections",
    order: 30,
    titleKey: "home.curatedCollections.title",
  },
  {
    enabled: true,
    itemLimit: 8,
    kind: "featured_stores",
    order: 40,
    subtitleKey: "home.featuredStores.subtitle",
    titleKey: "home.featuredStores.title",
  },
  {
    enabled: true,
    itemLimit: 8,
    kind: "bestsellers",
    order: 50,
    titleKey: "home.bestsellers.title",
  },
  {
    enabled: true,
    itemLimit: 8,
    kind: "recommended",
    order: 60,
    titleKey: "home.recommended.title",
  },
  { enabled: true, kind: "customer_account", order: 70, titleKey: "home.account.title" },
  { enabled: true, kind: "app_promotion", order: 80, titleKey: "home.app.title" },
  { enabled: true, kind: "track_order", order: 90, titleKey: "home.track.title" },
];

export function orderedHomeSections(
  sections: readonly HomeSection[] = defaultHomeSections,
): readonly HomeSection[] {
  return [...sections].filter((section) => section.enabled).sort((a, b) => a.order - b.order);
}
