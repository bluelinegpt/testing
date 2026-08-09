import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";

/**
 * Platform Marketplace classification controls.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE, EXPLICITLY LABELLED BLOCK
 * ---------------------------------------------------------------------------
 *
 * The Product editor already has a control called "Category" — the Trader's own
 * shelf label. Adding a second unlabelled "Category" dropdown beside it would
 * be genuinely confusing: the two mean different things, are owned by different
 * people, and changing one must not change the other.
 *
 * So this block carries its own legend and its own wording, and the existing
 * Store Category control is left exactly where it was. A Trader should be able
 * to see at a glance that "Eid Collection" and "Fashion → Abayas" are two
 * separate statements about the same Product.
 *
 * ---------------------------------------------------------------------------
 * THE TRADER PICKS FROM THE PLATFORM'S LIST AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * Both controls are `<select>` elements populated from the Platform taxonomy
 * endpoint. There is no free-text input and no "add new category" affordance,
 * because a Trader cannot create Platform taxonomy — the API would refuse it,
 * and offering a control that always fails is worse than not offering one.
 */

export interface TaxonomySubcategory {
  readonly displayOrder: number;
  readonly id: string;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly slug: string;
}

export interface TaxonomyCategory {
  readonly categoryId: string;
  readonly categoryNameAr: string | null;
  readonly categoryNameEn: string;
  readonly categorySlug: string;
  readonly displayOrder: number;
  readonly subcategories: readonly TaxonomySubcategory[];
}

export function useMarketplaceTaxonomy(api: ApiClient) {
  const [taxonomy, setTaxonomy] = useState<readonly TaxonomyCategory[]>([]);
  useEffect(() => {
    let active = true;
    api
      .get<{ items: TaxonomyCategory[] }>("operations/marketplace/taxonomy")
      .then((value) => {
        // Coerced rather than trusted. A response without an `items` array —
        // an older API, a proxy error page, a stubbed client — would otherwise
        // put `undefined` into state and throw on the next render, taking the
        // whole editor down over an optional feature.
        if (active) setTaxonomy(Array.isArray(value?.items) ? value.items : []);
      })
      .catch(() => {
        // A taxonomy that will not load leaves the controls empty rather than
        // breaking the editor. Classification is optional; the Product is not.
        if (active) setTaxonomy([]);
      });
    return () => {
      active = false;
    };
  }, [api]);
  return taxonomy;
}

/**
 * Product marketplace classification.
 *
 * Changing the Category CLEARS a Subcategory that belonged to the old one.
 * Leaving it would produce a pair the server rejects — and, worse, the composite
 * foreign key would reject it too, so the user would see a failure for a
 * combination the screen had shown as selectable.
 */
export function ProductMarketplaceClassification({
  categoryId,
  disabled,
  onChange,
  subcategoryId,
  taxonomy,
}: {
  readonly categoryId: string | null;
  readonly disabled: boolean;
  readonly onChange: (next: {
    readonly marketplaceCategoryId: string | null;
    readonly marketplaceSubcategoryId: string | null;
  }) => void;
  readonly subcategoryId: string | null;
  readonly taxonomy: readonly TaxonomyCategory[];
}) {
  const { t } = useTranslation();
  const selected = taxonomy.find((entry) => entry.categoryId === categoryId);

  return (
    <fieldset disabled={disabled}>
      <legend>{t("productCatalogue.marketplace.legend")}</legend>
      <p className="form-hint">{t("productCatalogue.marketplace.hint")}</p>

      <label>
        {t("productCatalogue.marketplace.category")}
        <select
          onChange={(event) => {
            const next = event.target.value === "" ? null : event.target.value;
            // A Subcategory belongs to exactly one Category, so switching the
            // parent invalidates it.
            onChange({ marketplaceCategoryId: next, marketplaceSubcategoryId: null });
          }}
          value={categoryId ?? ""}
        >
          <option value="">{t("productCatalogue.marketplace.unclassified")}</option>
          {taxonomy.map((entry) => (
            <option key={entry.categoryId} value={entry.categoryId}>
              {entry.categoryNameEn}
            </option>
          ))}
        </select>
      </label>

      <label>
        {t("productCatalogue.marketplace.subcategory")}
        <select
          // Only the selected Category's children are offered; with no Category
          // chosen there is nothing valid to choose.
          disabled={disabled || selected === undefined}
          onChange={(event) =>
            onChange({
              marketplaceCategoryId: categoryId,
              marketplaceSubcategoryId: event.target.value === "" ? null : event.target.value,
            })
          }
          value={subcategoryId ?? ""}
        >
          <option value="">{t("productCatalogue.marketplace.noSubcategory")}</option>
          {(selected?.subcategories ?? []).map((child) => (
            <option key={child.id} value={child.id}>
              {child.nameEn}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

/**
 * Store marketplace classification.
 *
 * One primary Category plus any number of additional ones. The primary is what
 * marketplace Store listings order by, so it is chosen explicitly rather than
 * inferred from selection order.
 */
export function StoreMarketplaceClassification({
  api,
  canManage,
  storefrontId,
}: {
  readonly api: ApiClient;
  readonly canManage: boolean;
  readonly storefrontId: string;
}) {
  const { t } = useTranslation();
  const taxonomy = useMarketplaceTaxonomy(api);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [primary, setPrimary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    api
      .get<{ items: { isPrimary: boolean; marketplaceCategoryId: string }[] }>(
        `operations/marketplace/storefronts/${storefrontId}/categories`,
      )
      .then((value) => {
        const items = Array.isArray(value?.items) ? value.items : [];
        setSelected(items.map((row) => row.marketplaceCategoryId));
        setPrimary(items.find((row) => row.isPrimary)?.marketplaceCategoryId ?? null);
      })
      .catch(() => setSelected([]));
  }, [api, storefrontId]);

  useEffect(() => load(), [load]);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.put(`operations/marketplace/storefronts/${storefrontId}/categories`, {
        categoryIds: selected,
        primaryCategoryId: primary,
      });
      load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "storefront_marketplace_save_failed");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (categoryId: string) => {
    setSelected((current) => {
      if (current.includes(categoryId)) {
        // Deselecting the primary clears the primary too; a primary that is not
        // among the selected Categories is a state the server rejects.
        if (primary === categoryId) setPrimary(null);
        return current.filter((entry) => entry !== categoryId);
      }
      return [...current, categoryId];
    });
  };

  return (
    <section className="accounting-form" data-testid="storefront-marketplace-categories">
      <h2>{t("storefront.marketplace.title")}</h2>
      <p className="form-hint">{t("storefront.marketplace.hint")}</p>

      {error !== undefined ? (
        <div className="alert alert-danger" role="alert">
          {t(`storefront.errors.${error}`, t("common.operationFailed"))}
        </div>
      ) : null}

      {taxonomy.length === 0 ? (
        <p className="form-hint">{t("storefront.marketplace.none")}</p>
      ) : (
        <>
          <ul className="storefront-marketplace-list">
            {taxonomy.map((entry) => (
              <li key={entry.categoryId}>
                <label>
                  <input
                    checked={selected.includes(entry.categoryId)}
                    disabled={!canManage || busy}
                    onChange={() => toggle(entry.categoryId)}
                    type="checkbox"
                  />
                  {entry.categoryNameEn}
                </label>
                {selected.includes(entry.categoryId) ? (
                  primary === entry.categoryId ? (
                    <span className="badge">{t("storefront.marketplace.primary")}</span>
                  ) : (
                    <button
                      disabled={!canManage || busy}
                      onClick={() => setPrimary(entry.categoryId)}
                      type="button"
                    >
                      {t("storefront.marketplace.setPrimary")}
                    </button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
          <button disabled={!canManage || busy} onClick={() => void save()} type="button">
            {t("common.save")}
          </button>
        </>
      )}
    </section>
  );
}
