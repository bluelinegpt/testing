import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import {
  ProductMarketplaceClassification,
  useMarketplaceTaxonomy,
} from "./MarketplaceClassification.js";
import { hasStorefrontPermission } from "./storefront-permissions.js";

/**
 * Product editor — create, edit, media, options, template attributes.
 *
 * ---------------------------------------------------------------------------
 * ONE PRODUCT MODEL, OWNED BY THE SERVER
 * ---------------------------------------------------------------------------
 *
 * This screen holds a form draft and nothing else. There is no second Product
 * model here: prices are strings that travel to the API untouched, activation
 * readiness is the API's verdict, and the attribute allow-list below mirrors
 * the server's schema only to decide which INPUTS to render. Sending a key the
 * template does not declare would be rejected server-side, so the mirror can
 * only ever hide a field — never smuggle one through.
 */

export type ProductTemplate = "fashion" | "electronics" | "jewelry" | "general";

export interface ProductMedia {
  readonly altText: string | null;
  readonly displayOrder: number;
  readonly id: string;
  readonly isActive: boolean;
  readonly isPrimary: boolean;
  readonly mediaType: "image" | "video";
  readonly posterUrl: string | null;
  readonly url: string;
}

export interface ProductOptionGroup {
  readonly displayOrder: number;
  readonly id: string;
  readonly isActive: boolean;
  /** A required group must offer at least one active value before activation. */
  readonly isRequired: boolean;
  readonly name: string;
  readonly values: readonly {
    readonly displayOrder: number;
    readonly id?: string;
    readonly value: string;
  }[];
}

export interface ProductDetail {
  readonly availabilityStatus: "available" | "unavailable";
  readonly barcode: string | null;
  readonly brand: string | null;
  readonly categoryId: string | null;
  /** Platform Marketplace classification — NOT the Trader Store Category above. */
  readonly marketplaceCategoryId: string | null;
  readonly marketplaceSubcategoryId: string | null;
  readonly fullDescription: string | null;
  readonly id: string;
  readonly lifecycleStatus: "draft" | "active" | "inactive" | "archived";
  readonly maximumQuantity: number | null;
  readonly media: readonly ProductMedia[];
  readonly minimumQuantity: number | null;
  readonly name: string;
  readonly options: readonly ProductOptionGroup[];
  readonly previousPrice: string | null;
  readonly productCode: string;
  readonly sellingPrice: string;
  readonly seoDescriptionAr: string | null;
  readonly seoDescriptionEn: string | null;
  readonly seoIndexable: boolean;
  readonly seoTitleAr: string | null;
  readonly seoTitleEn: string | null;
  readonly shortDescription: string | null;
  readonly sku: string | null;
  readonly slug: string;
  readonly templateAttributes: Readonly<Record<string, string>>;
  readonly version: string;
}

export interface EditorCategory {
  readonly id: string;
  readonly isActive: boolean;
  readonly nameEn: string;
}

/**
 * Which attribute inputs each business template renders.
 *
 * A mirror of the server's allow-list. Keys marked required are the ones the
 * API refuses to activate without.
 */
export const templateFields: Readonly<
  Record<ProductTemplate, readonly { readonly key: string; readonly required?: boolean }[]>
> = {
  electronics: [
    { key: "brand", required: true },
    { key: "model" },
    { key: "warranty" },
    { key: "storage" },
    { key: "capacity" },
    { key: "condition" },
    { key: "keySpecifications" },
  ],
  fashion: [
    { key: "material", required: true },
    { key: "gender" },
    { key: "style" },
    { key: "fit" },
    { key: "careInstructions" },
  ],
  general: [
    { key: "brand" },
    { key: "productType" },
    { key: "packSize" },
    { key: "dimensions" },
    { key: "specifications" },
  ],
  jewelry: [
    { key: "material", required: true },
    { key: "stone" },
    { key: "purity" },
    { key: "weightGrams" },
    { key: "certificate" },
    { key: "engraving" },
  ],
};

/** Mirrors the server's slug normalisation so a suggestion matches what is stored. */
export function suggestProductSlug(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96)
    .replace(/-$/, "");
}

const maximumImages = 8;

/**
 * Clearing an SEO override.
 *
 * An emptied text box and an unset override mean the same thing to the Trader
 * but are different values to the server: null restores the derived title,
 * whereas "" is refused so an empty title can never reach a search result.
 */
function blankSeoToNull(draft: Record<string, unknown>): Record<string, unknown> {
  const seoTextFields = [
    "seoDescriptionAr",
    "seoDescriptionEn",
    "seoTitleAr",
    "seoTitleEn",
  ] as const;
  const next: Record<string, unknown> = { ...draft };
  for (const field of seoTextFields) {
    const current = next[field];
    if (typeof current === "string" && current.trim() === "") next[field] = null;
  }
  return next;
}

export function ProductEditor({
  api,
  categories,
  onClose,
  onSaved,
  permissions,
  productId,
  storefrontId,
  template,
}: {
  readonly api: ApiClient;
  readonly categories: readonly EditorCategory[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly permissions: readonly string[];
  readonly productId?: string | undefined;
  readonly storefrontId: string;
  readonly template: ProductTemplate;
}) {
  const { t } = useTranslation();
  const [product, setProduct] = useState<ProductDetail>();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaType, setMediaType] = useState<"image" | "video">("image");
  const [mediaAlt, setMediaAlt] = useState("");
  const [posterUrl, setPosterUrl] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupRequired, setGroupRequired] = useState(false);
  const [valueDraft, setValueDraft] = useState<Record<string, string>>({});

  const canManage = hasStorefrontPermission(permissions, "storefront_products.manage");
  const taxonomy = useMarketplaceTaxonomy(api);
  /** True only until the Product exists; the load effect still keys off the prop. */
  const isNew = productId === undefined;
  /**
   * The Product this editor is acting on.
   *
   * After a create, the `productId` PROP is still undefined but the Product
   * exists — so deriving "is it saved yet?" from the prop alone left the media
   * and options sections hidden behind "Save the Product first" until the user
   * closed and reopened it. Falling back to the loaded record closes that gap
   * and is what every media/option request below addresses.
   */
  const activeId = productId ?? product?.id;

  useEffect(() => {
    if (isNew) return;
    let active = true;
    api
      .get<ProductDetail>(`operations/trader-storefront-products/${productId}`)
      .then((value) => {
        if (!active) return;
        setProduct(value);
        setAttributes({ ...value.templateAttributes });
        setDraft({});
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof ApiError ? cause.code : "product_load_failed");
      });
    return () => {
      active = false;
    };
  }, [api, isNew, productId, reload]);

  const value = useCallback(
    (key: keyof ProductDetail): string => {
      const drafted = draft[key];
      if (drafted !== undefined) return String(drafted);
      const stored = product?.[key];
      return stored === null || stored === undefined ? "" : String(stored);
    },
    [draft, product],
  );

  const archived = product?.lifecycleStatus === "archived";
  const editable = canManage && !archived;

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (activeId === undefined) {
        const created = await api.post<ProductDetail>("operations/trader-storefront-products", {
          ...draft,
          storefrontId,
        });
        setProduct(created);
        onSaved();
      } else {
        // Marketplace classification lives on its own endpoint, because it is
        // Platform-scoped rather than part of the Product document. Stripped
        // from the Product payload so the Product API is not asked to validate
        // a taxonomy it does not own.
        const {
          marketplaceCategoryId,
          marketplaceSubcategoryId,
          ...productDraft
        } = draft as Record<string, unknown>;
        await api.patch(`operations/trader-storefront-products/${activeId}`, {
          // Blank SEO text is "no override", which is null. The database
          // rejects a blank override outright, so clearing a field the Trader
          // no longer wants must not surface as a validation error.
          ...blankSeoToNull(productDraft),
          expectedVersion: Number(product?.version ?? 1),
          templateAttributes: attributes,
        });
        if (marketplaceCategoryId !== undefined || marketplaceSubcategoryId !== undefined) {
          await api.patch(`operations/marketplace/products/${activeId}/classification`, {
            marketplaceCategoryId:
              (marketplaceCategoryId as string | null | undefined) ??
              product?.marketplaceCategoryId ??
              null,
            marketplaceSubcategoryId:
              (marketplaceSubcategoryId as string | null | undefined) ?? null,
          });
        }
        setReload((current) => current + 1);
        onSaved();
      }
      setDraft({});
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "product_save_failed");
    } finally {
      setBusy(false);
    }
  };

  const call = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.post(path, body ?? {});
      setReload((current) => current + 1);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "product_action_failed");
    } finally {
      setBusy(false);
    }
  };

  const images = (product?.media ?? []).filter(
    (entry) => entry.mediaType === "image" && entry.isActive,
  );
  const video = (product?.media ?? []).find(
    (entry) => entry.mediaType === "video" && entry.isActive,
  );

  return (
    <section className="accounting-form product-editor" role="region">
      <header className="page-heading-copy">
        <h2>{isNew ? t("productCatalogue.editor.createTitle") : t("productCatalogue.editor.editTitle")}</h2>
      </header>

      {error !== undefined ? (
        <div className="alert alert-danger" role="alert">
          {t(`productCatalogue.errors.${error}`, t("common.operationFailed"))}
        </div>
      ) : null}
      {archived ? (
        <div className="alert alert-info" role="status">
          {t("productCatalogue.errors.product_archived_readonly")}
        </div>
      ) : null}

      {/* 1. Basic information */}
      <fieldset disabled={!editable || busy}>
        <legend>{t("productCatalogue.editor.sections.basic")}</legend>
        <label>
          {t("productCatalogue.fields.name")}
          <input
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            value={value("name")}
          />
        </label>
        <label>
          {t("productCatalogue.fields.productCode")}
          <input
            onChange={(event) => setDraft({ ...draft, productCode: event.target.value })}
            value={value("productCode")}
          />
        </label>
        {/*
          Optional inventory identifiers. Both are plain text inputs on purpose:
          type="number" would strip the leading zero from a barcode such as
          0012345678905 in the browser, before the value ever reached the API.
        */}
        <label>
          {t("productCatalogue.fields.sku")}
          <input
            inputMode="text"
            onChange={(event) => setDraft({ ...draft, sku: event.target.value })}
            value={value("sku")}
          />
        </label>
        <label>
          {t("productCatalogue.fields.barcode")}
          <input
            inputMode="text"
            onChange={(event) => setDraft({ ...draft, barcode: event.target.value })}
            value={value("barcode")}
          />
        </label>
        <label>
          {t("productCatalogue.fields.brand")}
          <input
            onChange={(event) => setDraft({ ...draft, brand: event.target.value })}
            value={value("brand")}
          />
        </label>
        <label>
          {t("productCatalogue.fields.slug")}
          <input
            onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
            value={value("slug")}
          />
        </label>
        <button
          onClick={() => setDraft({ ...draft, slug: suggestProductSlug(value("name")) })}
          type="button"
        >
          {t("productCatalogue.editor.suggestSlug")}
        </button>
        <label>
          {t("productCatalogue.fields.shortDescription")}
          <input
            onChange={(event) => setDraft({ ...draft, shortDescription: event.target.value })}
            value={value("shortDescription")}
          />
        </label>
        <label>
          {t("productCatalogue.fields.fullDescription")}
          <textarea
            onChange={(event) => setDraft({ ...draft, fullDescription: event.target.value })}
            rows={4}
            value={value("fullDescription")}
          />
        </label>
      </fieldset>

      {/* Search and social metadata.
          Overrides only. A Product with none still gets a correct title and
          description derived from its own name, its Store and its short
          description, so the placeholders show what will actually be published
          rather than leaving the Trader guessing whether blank means broken. */}
      <fieldset disabled={!editable || busy}>
        <legend>{t("productCatalogue.seo.legend")}</legend>
        <p className="accounting-hint">{t("productCatalogue.seo.hint")}</p>
        <label>
          {t("productCatalogue.seo.titleEn")}
          <input
            maxLength={160}
            onChange={(event) => setDraft({ ...draft, seoTitleEn: event.target.value })}
            placeholder={value("name")}
            value={value("seoTitleEn")}
          />
        </label>
        <label>
          {t("productCatalogue.seo.titleAr")}
          <input
            dir="rtl"
            maxLength={160}
            onChange={(event) => setDraft({ ...draft, seoTitleAr: event.target.value })}
            value={value("seoTitleAr")}
          />
        </label>
        <label>
          {t("productCatalogue.seo.descriptionEn")}
          <textarea
            maxLength={320}
            onChange={(event) => setDraft({ ...draft, seoDescriptionEn: event.target.value })}
            placeholder={value("shortDescription")}
            rows={2}
            value={value("seoDescriptionEn")}
          />
        </label>
        <label>
          {t("productCatalogue.seo.descriptionAr")}
          <textarea
            dir="rtl"
            maxLength={320}
            onChange={(event) => setDraft({ ...draft, seoDescriptionAr: event.target.value })}
            rows={2}
            value={value("seoDescriptionAr")}
          />
        </label>
        {/* Opt-OUT wording: a checkbox labelled "indexable" that is already on
            reads as something the Trader chose, which they did not. */}
        <label className="accounting-checkbox">
          <input
            checked={product?.seoIndexable === false || draft.seoIndexable === false}
            onChange={(event) => setDraft({ ...draft, seoIndexable: !event.target.checked })}
            type="checkbox"
          />
          {t("productCatalogue.seo.hideFromSearch")}
        </label>
      </fieldset>

      {/* 2. Category */}
      <fieldset disabled={!editable || busy}>
        <legend>{t("productCatalogue.editor.sections.category")}</legend>
        <label>
          {t("productCatalogue.fields.category")}
          <select
            onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}
            value={value("categoryId")}
          >
            <option value="">{t("productCatalogue.editor.noCategory")}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.nameEn}
                {category.isActive ? "" : ` (${t("productCatalogue.editor.inactiveCategory")})`}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      {/* 2b. Platform Marketplace classification — deliberately its own block,
          so the two different meanings of "category" are never adjacent and
          unlabelled. */}
      <ProductMarketplaceClassification
        categoryId={(draft["marketplaceCategoryId"] as string | null | undefined) ??
          product?.marketplaceCategoryId ??
          null}
        disabled={!editable || busy}
        onChange={(next) =>
          setDraft({
            ...draft,
            marketplaceCategoryId: next.marketplaceCategoryId,
            marketplaceSubcategoryId: next.marketplaceSubcategoryId,
          })
        }
        subcategoryId={(draft["marketplaceSubcategoryId"] as string | null | undefined) ??
          product?.marketplaceSubcategoryId ??
          null}
        taxonomy={taxonomy}
      />

      {/* 3. Pricing */}
      <fieldset disabled={!editable || busy}>
        <legend>{t("productCatalogue.editor.sections.pricing")}</legend>
        <label>
          {t("productCatalogue.fields.sellingPrice")}
          <input
            inputMode="decimal"
            onChange={(event) => setDraft({ ...draft, sellingPrice: event.target.value })}
            value={value("sellingPrice")}
          />
        </label>
        <label>
          {t("productCatalogue.fields.previousPrice")}
          <input
            inputMode="decimal"
            onChange={(event) => setDraft({ ...draft, previousPrice: event.target.value })}
            value={value("previousPrice")}
          />
        </label>
        <label>
          {t("productCatalogue.fields.minimumQuantity")}
          <input
            onChange={(event) =>
              setDraft({ ...draft, minimumQuantity: Number(event.target.value) || null })
            }
            type="number"
            value={value("minimumQuantity")}
          />
        </label>
        <label>
          {t("productCatalogue.fields.maximumQuantity")}
          <input
            onChange={(event) =>
              setDraft({ ...draft, maximumQuantity: Number(event.target.value) || null })
            }
            type="number"
            value={value("maximumQuantity")}
          />
        </label>
      </fieldset>

      {/* 6. Template-specific attributes */}
      <fieldset disabled={!editable || busy}>
        <legend>{t("productCatalogue.editor.sections.attributes")}</legend>
        <p className="form-hint">{t(`productCatalogue.template.${template}`)}</p>
        {templateFields[template].map((field) => (
          <label key={field.key}>
            {t(`productCatalogue.attributes.${field.key}`, field.key)}
            {field.required === true ? ` *` : ""}
            <input
              onChange={(event) =>
                setAttributes({ ...attributes, [field.key]: event.target.value })
              }
              value={attributes[field.key] ?? ""}
            />
          </label>
        ))}
      </fieldset>

      <button
        className="button button-primary"
        disabled={!editable || busy}
        onClick={() => void save()}
        type="button"
      >
        {t("common.save")}
      </button>

      {activeId === undefined ? (
        <p className="form-hint">{t("productCatalogue.editor.saveFirst")}</p>
      ) : (
        <>
          {/* 4. Media */}
          <fieldset disabled={!editable || busy}>
            <legend>{t("productCatalogue.editor.sections.media")}</legend>
            {/* No upload infrastructure exists, so this is explicitly a
                REFERENCE workflow: an https or storage-relative address the
                server validates. Nothing here uploads a file. */}
            <p className="form-hint">{t("productCatalogue.editor.mediaReferenceOnly")}</p>
            <p className="form-hint">
              {t("productCatalogue.editor.imageCount", {
                count: images.length,
                max: maximumImages,
              })}
            </p>
            <label>
              {t("productCatalogue.editor.mediaType")}
              <select
                onChange={(event) => setMediaType(event.target.value as "image" | "video")}
                value={mediaType}
              >
                <option value="image">{t("productCatalogue.editor.image")}</option>
                <option value="video">{t("productCatalogue.editor.video")}</option>
              </select>
            </label>
            <label>
              {t("productCatalogue.editor.mediaUrl")}
              <input onChange={(event) => setMediaUrl(event.target.value)} value={mediaUrl} />
            </label>
            <label>
              {t("productCatalogue.editor.altText")}
              <input onChange={(event) => setMediaAlt(event.target.value)} value={mediaAlt} />
            </label>
            {mediaType === "video" ? (
              <label>
                {t("productCatalogue.editor.posterUrl")}
                <input onChange={(event) => setPosterUrl(event.target.value)} value={posterUrl} />
              </label>
            ) : null}
            <button
              disabled={
                mediaUrl.trim() === "" ||
                (mediaType === "image" && images.length >= maximumImages) ||
                (mediaType === "video" && video !== undefined)
              }
              onClick={() =>
                void call(`operations/trader-storefront-products/${activeId}/media`, {
                  ...(mediaAlt === "" ? {} : { altText: mediaAlt }),
                  mediaType,
                  mediaUrl,
                  ...(mediaType === "video" && posterUrl !== "" ? { posterUrl } : {}),
                }).then(() => {
                  setMediaUrl("");
                  setMediaAlt("");
                  setPosterUrl("");
                })
              }
              type="button"
            >
              {t("productCatalogue.editor.addMedia")}
            </button>
            {images.length >= maximumImages ? (
              <p className="form-field-error" role="status">
                {t("productCatalogue.errors.product_media_image_limit")}
              </p>
            ) : null}
            {mediaType === "video" && video !== undefined ? (
              <p className="form-field-error" role="status">
                {t("productCatalogue.errors.product_media_video_limit")}
              </p>
            ) : null}

            <ul className="product-media-list">
              {(product?.media ?? [])
                .filter((entry) => entry.isActive)
                .map((entry) => (
                  <li key={entry.id}>
                    {entry.mediaType === "image" ? (
                      <img alt={entry.altText ?? ""} height={64} src={entry.url} />
                    ) : (
                      <video controls muted poster={entry.posterUrl ?? undefined} width={120}>
                        <source src={entry.url} />
                      </video>
                    )}
                    <span>{entry.isPrimary ? t("productCatalogue.editor.primary") : ""}</span>
                    {/* Move controls are ordinary buttons, so keyboard and
                        screen-reader users get the same capability a
                        drag-and-drop surface would otherwise withhold. */}
                    <button
                      aria-label={t("productCatalogue.editor.moveMediaUp", {
                        name: entry.altText ?? entry.mediaType,
                      })}
                      onClick={() =>
                        void call(
                          `operations/trader-storefront-products/${activeId}/media/reorder`,
                          {
                            entries: [
                              {
                                displayOrder: Math.max(0, entry.displayOrder - 1),
                                id: entry.id,
                              },
                            ],
                          },
                        )
                      }
                      type="button"
                    >
                      {t("productCatalogue.editor.moveUp")}
                    </button>
                    <button
                      aria-label={t("productCatalogue.editor.moveMediaDown", {
                        name: entry.altText ?? entry.mediaType,
                      })}
                      onClick={() =>
                        void call(
                          `operations/trader-storefront-products/${activeId}/media/reorder`,
                          { entries: [{ displayOrder: entry.displayOrder + 1, id: entry.id }] },
                        )
                      }
                      type="button"
                    >
                      {t("productCatalogue.editor.moveDown")}
                    </button>
                    {entry.mediaType === "image" && !entry.isPrimary ? (
                      <button
                        onClick={() =>
                          void call(
                            `operations/trader-storefront-products/media/${entry.id}/primary`,
                          )
                        }
                        type="button"
                      >
                        {t("productCatalogue.editor.setPrimary")}
                      </button>
                    ) : null}
                    <button
                      onClick={() =>
                        void call(`operations/trader-storefront-products/media/${entry.id}/remove`)
                      }
                      type="button"
                    >
                      {t("productCatalogue.editor.removeMedia")}
                    </button>
                  </li>
                ))}
            </ul>
          </fieldset>

          {/* 5. Options */}
          <fieldset disabled={!editable || busy}>
            <legend>{t("productCatalogue.editor.sections.options")}</legend>
            <p className="form-hint">{t(`productCatalogue.editor.optionHint.${template}`)}</p>
            <label>
              {t("productCatalogue.editor.optionGroup")}
              <input onChange={(event) => setGroupName(event.target.value)} value={groupName} />
            </label>
            <label>
              <input
                checked={groupRequired}
                onChange={(event) => setGroupRequired(event.target.checked)}
                type="checkbox"
              />
              {t("productCatalogue.editor.optionRequired")}
            </label>
            <p className="form-hint">{t("productCatalogue.editor.optionRequiredHint")}</p>
            <button
              disabled={groupName.trim() === ""}
              onClick={() =>
                void call(
                  `operations/trader-storefront-products/${activeId}/option-groups`,
                  { isRequired: groupRequired, name: groupName },
                ).then(() => {
                  setGroupName("");
                  setGroupRequired(false);
                })
              }
              type="button"
            >
              {t("productCatalogue.editor.addOptionGroup")}
            </button>
            <ul className="product-option-list">
              {(product?.options ?? []).map((group) => (
                <li key={group.id}>
                  <strong>{group.name}</strong>
                  <span>
                    {group.isRequired
                      ? t("productCatalogue.editor.required")
                      : t("productCatalogue.editor.optional")}
                  </span>
                  <span>{group.values.map((entry) => entry.value).join(", ")}</span>
                  <button
                    aria-label={t("productCatalogue.editor.moveGroupUp", { name: group.name })}
                    onClick={() =>
                      void call(
                        `operations/trader-storefront-products/${activeId}/option-groups/reorder`,
                        {
                          entries: [
                            {
                              displayOrder: Math.max(0, group.displayOrder - 1),
                              id: group.id,
                            },
                          ],
                        },
                      )
                    }
                    type="button"
                  >
                    {t("productCatalogue.editor.moveUp")}
                  </button>
                  <button
                    aria-label={t("productCatalogue.editor.moveGroupDown", { name: group.name })}
                    onClick={() =>
                      void call(
                        `operations/trader-storefront-products/${activeId}/option-groups/reorder`,
                        { entries: [{ displayOrder: group.displayOrder + 1, id: group.id }] },
                      )
                    }
                    type="button"
                  >
                    {t("productCatalogue.editor.moveDown")}
                  </button>

                  <label>
                    {t("productCatalogue.editor.optionValue")}
                    <input
                      onChange={(event) =>
                        setValueDraft({ ...valueDraft, [group.id]: event.target.value })
                      }
                      value={valueDraft[group.id] ?? ""}
                    />
                  </label>
                  <button
                    disabled={(valueDraft[group.id] ?? "").trim() === ""}
                    onClick={() =>
                      void call(
                        `operations/trader-storefront-products/option-groups/${group.id}/values`,
                        { value: valueDraft[group.id] },
                      ).then(() => setValueDraft({ ...valueDraft, [group.id]: "" }))
                    }
                    type="button"
                  >
                    {t("productCatalogue.editor.addOptionValue")}
                  </button>
                  <button
                    onClick={() =>
                      void call(
                        `operations/trader-storefront-products/option-groups/${group.id}/active`,
                        { isActive: !group.isActive },
                      )
                    }
                    type="button"
                  >
                    {group.isActive
                      ? t("productCatalogue.editor.deactivateGroup")
                      : t("productCatalogue.editor.activateGroup")}
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>
        </>
      )}

      <button onClick={onClose} type="button">
        {t("common.close")}
      </button>
    </section>
  );
}
