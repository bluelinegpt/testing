import type { StorefrontTemplate } from "./storefront.constants.js";

/**
 * Product Catalogue vocabulary, limits and the template attribute schema.
 *
 * Every enumeration here is also a database CHECK, and the media limits are
 * split deliberately: the ones a constraint can hold live in the schema, and
 * the ones it cannot (a COUNT) are named here and enforced transactionally.
 */

export const productLifecycleStatuses = ["draft", "active", "inactive", "archived"] as const;
export type ProductLifecycleStatus = (typeof productLifecycleStatuses)[number];

export const productAvailabilityStatuses = ["available", "unavailable"] as const;
export type ProductAvailabilityStatus = (typeof productAvailabilityStatuses)[number];

export const productMediaTypes = ["image", "video"] as const;
export type ProductMediaType = (typeof productMediaTypes)[number];

/** A COUNT, so no unique index can express it — the service holds this one. */
export const maximumProductImages = 8;
export const maximumProductVideos = 1;
export const maximumOptionGroupsPerProduct = 6;
export const maximumOptionValuesPerGroup = 24;

/**
 * Words a Product slug may not take.
 *
 * The Product slug is the last segment of
 * `/store/<storefront>/products/<product>`, so it must not collide with the
 * sibling sections of that route, and it must not read as a platform page.
 */
export const reservedProductSlugs: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "cart",
  "checkout",
  "confirmation",
  "new",
  "products",
  "review",
  "search",
  "store",
]);

export const productSlugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const productCodePattern = /^[A-Za-z0-9][A-Za-z0-9_/-]*$/;

/**
 * Normalises a Product name into slug shape.
 *
 * Same rules as the Storefront slug, and the same deliberate outcome for a
 * name with no Latin characters: an empty suggestion, so the Trader chooses a
 * slug rather than receiving a machine transliteration inside a permanent
 * public URL.
 */
export function normaliseProductSlug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96)
    .replace(/-$/, "");
}

/**
 * Normalises a Product code WITHOUT changing its identity.
 *
 * Only surrounding whitespace is removed. Case is preserved because a Trader's
 * code is printed on labels and invoices; uniqueness is compared
 * case-insensitively by the index, which is a different question from how the
 * value is stored. Leading zeros survive because nothing numeric happens here.
 */
export function normaliseProductCode(value: string): string {
  return value.trim();
}

/**
 * Normalises an optional inventory identifier — SKU or barcode.
 *
 * Surrounding whitespace is removed and an empty result becomes null, so
 * clearing a field and never setting it are the same stored state. Nothing else
 * happens to the value: no case folding, no padding, and above all no numeric
 * conversion. A barcode like '0012345678905' is a STRING whose leading zero is
 * part of the code; parsing it as a number would silently return a different
 * barcode, and the Product would stop scanning.
 */
export function normaliseInventoryIdentifier(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export type ProductSlugRejection =
  | "product_slug_required"
  | "product_slug_invalid"
  | "product_slug_reserved";

export function rejectProductSlug(slug: string): ProductSlugRejection | null {
  if (slug.length === 0) return "product_slug_required";
  if (!productSlugPattern.test(slug) || slug.length < 2 || slug.length > 96) {
    return "product_slug_invalid";
  }
  if (reservedProductSlugs.has(slug)) return "product_slug_reserved";
  return null;
}

export function rejectProductCode(code: string): "product_code_required" | "product_code_invalid" | null {
  if (code.length === 0) return "product_code_required";
  if (!productCodePattern.test(code) || code.length > 48) return "product_code_invalid";
  return null;
}

/**
 * Media references that may be stored.
 *
 * An internal `fileId` is preferred. When a URL is supplied instead it must be
 * https or storage-relative: `javascript:`, `data:`, `blob:`, `file:` and any
 * private-network host are refused outright, because these values end up in an
 * `src` attribute on a public page. The database carries the same rule as a
 * CHECK, so a service bug cannot get past it either.
 */
const privateHostPattern =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1\]?|172\.(1[6-9]|2\d|3[01])\.)/i;

export type MediaUrlRejection =
  | "product_media_url_invalid"
  | "product_media_url_scheme_denied"
  | "product_media_url_private_host";

export function rejectMediaUrl(value: string): MediaUrlRejection | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "product_media_url_invalid";
  // A storage-relative reference is the safest form and needs no host checks.
  if (trimmed.startsWith("/")) {
    return /^\/[^\s<>"']*$/.test(trimmed) ? null : "product_media_url_invalid";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "product_media_url_invalid";
  }
  if (parsed.protocol !== "https:") return "product_media_url_scheme_denied";
  if (privateHostPattern.test(parsed.hostname)) return "product_media_url_private_host";
  return null;
}

/**
 * Template attribute schema.
 *
 * The prompt forbids arbitrary unvalidated JSON, so the stored object is an
 * ALLOW-LIST: a key not listed for the Storefront's business template is
 * rejected rather than stored, every value is a bounded string, and nothing is
 * ever rendered as markup. Adding an attribute is a code change, which is the
 * point — it keeps the public page's vocabulary reviewable.
 */
export interface TemplateAttributeDefinition {
  readonly key: string;
  readonly maxLength: number;
  /** Required before the Product may be ACTIVATED, not before it is saved. */
  readonly requiredForActivation?: boolean;
}

const fashionAttributes: readonly TemplateAttributeDefinition[] = [
  { key: "material", maxLength: 120, requiredForActivation: true },
  { key: "gender", maxLength: 40 },
  { key: "style", maxLength: 80 },
  { key: "fit", maxLength: 60 },
  { key: "careInstructions", maxLength: 400 },
];

const electronicsAttributes: readonly TemplateAttributeDefinition[] = [
  { key: "brand", maxLength: 80, requiredForActivation: true },
  { key: "model", maxLength: 80 },
  { key: "warranty", maxLength: 120 },
  { key: "storage", maxLength: 60 },
  { key: "capacity", maxLength: 60 },
  { key: "condition", maxLength: 40 },
  { key: "keySpecifications", maxLength: 600 },
];

const jewelryAttributes: readonly TemplateAttributeDefinition[] = [
  { key: "material", maxLength: 120, requiredForActivation: true },
  { key: "stone", maxLength: 80 },
  { key: "purity", maxLength: 40 },
  // Unit is part of the value and is required by the label, because a weight
  // with no unit is not a weight.
  { key: "weightGrams", maxLength: 20 },
  { key: "certificate", maxLength: 160 },
  { key: "engraving", maxLength: 80 },
];

const generalAttributes: readonly TemplateAttributeDefinition[] = [
  { key: "brand", maxLength: 80 },
  { key: "productType", maxLength: 80 },
  { key: "packSize", maxLength: 60 },
  { key: "dimensions", maxLength: 120 },
  { key: "specifications", maxLength: 600 },
];

export const templateAttributeSchema: Readonly<
  Record<StorefrontTemplate, readonly TemplateAttributeDefinition[]>
> = {
  electronics: electronicsAttributes,
  fashion: fashionAttributes,
  general: generalAttributes,
  jewelry: jewelryAttributes,
};

export interface TemplateAttributeRejection {
  readonly key: string;
  readonly reason: "unknown_key" | "not_a_string" | "too_long";
}

/**
 * Validates a submitted attribute object against one template's allow-list.
 *
 * Returns every problem rather than the first, so a Trader fixes one form
 * rather than discovering the next error on each save.
 */
export function validateTemplateAttributes(
  template: StorefrontTemplate,
  attributes: Readonly<Record<string, unknown>>,
): readonly TemplateAttributeRejection[] {
  const definitions = templateAttributeSchema[template];
  const problems: TemplateAttributeRejection[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    const definition = definitions.find((entry) => entry.key === key);
    if (definition === undefined) {
      problems.push({ key, reason: "unknown_key" });
      continue;
    }
    if (typeof value !== "string") {
      problems.push({ key, reason: "not_a_string" });
      continue;
    }
    if (value.length > definition.maxLength) problems.push({ key, reason: "too_long" });
  }
  return problems;
}

/** Attribute keys that must carry a value before a Product may go active. */
export function missingRequiredAttributes(
  template: StorefrontTemplate,
  attributes: Readonly<Record<string, unknown>>,
): readonly string[] {
  return templateAttributeSchema[template]
    .filter((definition) => definition.requiredForActivation === true)
    .filter((definition) => {
      const value = attributes[definition.key];
      return typeof value !== "string" || value.trim() === "";
    })
    .map((definition) => definition.key);
}

/**
 * Permitted lifecycle moves.
 *
 * `archived` is terminal: nothing leaves it, which is what makes it safe for a
 * future Sales Order to reference. Nothing deletes.
 */
const lifecycleTransitions: Readonly<
  Record<ProductLifecycleStatus, readonly ProductLifecycleStatus[]>
> = {
  active: ["inactive", "archived"],
  archived: [],
  draft: ["active", "archived"],
  inactive: ["active", "archived"],
};

export function canTransitionProduct(
  from: ProductLifecycleStatus,
  to: ProductLifecycleStatus,
): boolean {
  return lifecycleTransitions[from].includes(to);
}

/** Sort columns a caller may name, mapped to SQL. An allow-list, never input. */
export const productSortColumns: Readonly<Record<string, string>> = {
  createdAt: "p.created_at",
  displayOrder: "p.display_order",
  name: "lower(p.name)",
  price: "p.selling_price",
  updatedAt: "p.updated_at",
};

export const publicProductSortColumns: Readonly<Record<string, string>> = {
  displayOrder: "p.display_order",
  name: "lower(p.name)",
  price: "p.selling_price",
};
