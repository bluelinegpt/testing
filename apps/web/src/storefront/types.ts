/**
 * Trader Storefront prototype — static types.
 *
 * PROTOTYPE ONLY. Nothing here maps to a database table, an API contract or an
 * existing Trader record; the shapes exist so the sample data lives in typed
 * files instead of inside components. No persistence of any kind.
 */

export interface StorefrontCategory {
  readonly key: string;
  readonly label: string;
}

/**
 * A sample media entry. The prototype ships no binary assets: every "image" is
 * a locally rendered placeholder described by a tone and a label, and the one
 * "video" is a placeholder player demonstrating the intended behaviour
 * (muted, tap-to-play, never autoplay with sound).
 */
export interface StorefrontMedia {
  readonly kind: "image" | "video";
  readonly label: string;
  readonly tone: string;
  /**
   * A real media reference from the Product Catalogue API. When absent — which
   * is the case for the static sample catalogues — the locally drawn
   * placeholder is used instead, so no page ever renders a broken image.
   */
  readonly url?: string;
  readonly posterUrl?: string;
}

export interface StorefrontProduct {
  /**
   * Template-specific facts (material, warranty, purity, pack size…), rendered
   * by the ONE shared detail page in the shape the template asks for — a spec
   * table for Electronics, a definition list elsewhere. Separate from the core
   * fields so four templates never mean four product models.
   */
  readonly attributes?: readonly { readonly label: string; readonly value: string }[];
  readonly badges: readonly ("featured" | "best_seller" | "new_arrival")[];
  readonly available: boolean;
  readonly category: string;
  /** Human-readable category name; the sample data reuses the key. */
  readonly categoryLabel?: string;
  readonly code: string;
  readonly colors: readonly string[];
  readonly description: string;
  readonly media: readonly StorefrontMedia[];
  readonly name: string;
  /** Option group label per store type — "Size" for Fashion, "Storage" for
   *  Electronics, "Ring Size" for Jewelry. Vocabulary, not behaviour. */
  readonly optionLabel?: string;
  readonly previousPrice?: string;
  readonly price: string;
  readonly sizes: readonly string[];
  readonly slug: string;
}

export type StorefrontThemeKey = "luxury-minimal" | "modern" | "clean-light";
export type StorefrontTemplateKey = "fashion" | "electronics" | "jewelry" | "general";

/**
 * A visual theme is a closed token set — named CSS custom properties applied
 * beneath `.sf-root` only, never on `:root`/`html`/`body`. No free-form CSS,
 * HTML or JavaScript customisation exists or may be added here.
 */
export interface StorefrontTheme {
  readonly key: StorefrontThemeKey;
  readonly label: string;
  /** CSS custom properties, all `--sf-*`, scoped to the storefront root. */
  readonly tokens: Readonly<Record<string, string>>;
}

/**
 * A business template controls vocabulary and presentation of the SHARED
 * screens — which sections appear and what they are called — never a second
 * implementation of listing, cart, checkout, review or confirmation.
 */
export interface StorefrontTemplate {
  readonly attributesHeading: string;
  /** Detail attributes render as a bordered spec table instead of a list. */
  readonly attributesAsTable: boolean;
  /** Extra COD wording for high-value goods (Jewelry). */
  readonly highValueCodNotice?: string;
  readonly key: StorefrontTemplateKey;
  readonly label: string;
  readonly shelves: {
    readonly featured: string;
    readonly bestSellers: string;
    readonly newArrivals: string;
  };
  /** Show a warranty badge when the product carries a Warranty attribute. */
  readonly warrantyBadge: boolean;
}

export interface StorefrontProfile {
  readonly category: string;
  readonly description: string;
  readonly hours: readonly { readonly days: string; readonly time: string }[];
  readonly location: string;
  readonly logoInitial: string;
  readonly mobile: string;
  readonly name: string;
  readonly paymentMethod: string;
  readonly policies: { readonly delivery: string; readonly returns: string };
  readonly slug: string;
  readonly whatsapp: string;
}

/** One store = branding + template + theme + its catalogue. */
export interface StoreConfig {
  readonly categories: readonly StorefrontCategory[];
  readonly delivery: { readonly chargeAed: string; readonly freeOverAed: string };
  readonly products: readonly StorefrontProduct[];
  readonly profile: StorefrontProfile;
  readonly templateKey: StorefrontTemplateKey;
  readonly themeKey: StorefrontThemeKey;
  /**
   * True only for a store built from a REAL persisted Storefront.
   *
   * The static sample stores and the design preview leave it unset. The chrome
   * uses it to decide whether the "design prototype — sample data only"
   * disclaimer applies: on a published Trader's shop that sentence is simply
   * false, and it was being shown to that Trader's customers.
   */
  readonly isPersisted?: boolean;
}

export interface CartLine {
  readonly color: string;
  readonly quantity: number;
  readonly size: string;
  readonly slug: string;
}

export interface CheckoutDetails {
  readonly address: string;
  readonly area: string;
  readonly building: string;
  readonly deliveryNotes: string;
  readonly emirate: string;
  readonly fullName: string;
  readonly mobile: string;
  readonly orderNotes: string;
  readonly preferredDate: string;
  readonly preferredTime: string;
  readonly unit: string;
}

export const emptyCheckout: CheckoutDetails = {
  address: "",
  area: "",
  building: "",
  deliveryNotes: "",
  emirate: "",
  fullName: "",
  mobile: "",
  orderNotes: "",
  preferredDate: "",
  preferredTime: "",
  unit: "",
};
