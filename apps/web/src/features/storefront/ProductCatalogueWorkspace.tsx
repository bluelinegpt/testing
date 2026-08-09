import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { hasStorefrontPermission } from "./storefront-permissions.js";
import { CategoryManager } from "./CategoryManager.js";
import { ProductEditor, type ProductTemplate } from "./ProductEditor.js";

/**
 * Trader Storefront Product Catalogue workspace.
 *
 * ---------------------------------------------------------------------------
 * THE SERVER DECIDES; THIS SCREEN DISPLAYS
 * ---------------------------------------------------------------------------
 *
 * Activation readiness, slug and code availability, media limits and permitted
 * lifecycle moves are all the API's answers. The screen mirrors the lifecycle
 * table only to decide which BUTTONS to show — the backend re-checks every
 * move, so a stale mirror can hide a legal action but can never authorise an
 * illegal one. No price is ever computed here.
 */

export type ProductLifecycleStatus = "draft" | "active" | "inactive" | "archived";
export type ProductAvailabilityStatus = "available" | "unavailable";

export interface CatalogueProduct {
  readonly availabilityStatus: ProductAvailabilityStatus;
  readonly categoryId: string | null;
  readonly categoryName?: string | null;
  readonly displayOrder: number;
  readonly id: string;
  readonly imageCount?: number;
  readonly lifecycleStatus: ProductLifecycleStatus;
  readonly name: string;
  readonly previousPrice: string | null;
  readonly productCode: string;
  readonly sellingPrice: string;
  readonly slug: string;
  readonly templateAttributes: Readonly<Record<string, string>>;
  readonly version: string;
}

export interface CatalogueCategory {
  readonly id: string;
  readonly isActive: boolean;
  readonly nameEn: string;
  readonly productCount: number;
  readonly slug: string;
  readonly version: string;
}

/** Mirrors the backend transition table; used only to choose what to render. */
function lifecycleActions(status: ProductLifecycleStatus): readonly string[] {
  if (status === "draft") return ["activate", "archive"];
  if (status === "active") return ["deactivate", "archive"];
  if (status === "inactive") return ["activate", "archive"];
  return [];
}

export function ProductCatalogueWorkspace({
  api,
  permissions,
  storefrontId,
}: {
  readonly api: ApiClient;
  readonly permissions: readonly string[];
  readonly storefrontId: string;
}) {
  const { t } = useTranslation();
  const [products, setProducts] = useState<readonly CatalogueProduct[]>();
  const [categories, setCategories] = useState<readonly CatalogueCategory[]>([]);
  const [search, setSearch] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  // One panel at a time: the list stays the spine of the screen and the editor
  // or category manager opens beside it.
  const [panel, setPanel] = useState<"none" | "categories" | "product">("none");
  const [editingId, setEditingId] = useState<string>();
  const [template, setTemplate] = useState<ProductTemplate>("general");

  const canManage = hasStorefrontPermission(permissions, "storefront_products.manage");
  const canPublish = hasStorefrontPermission(permissions, "storefront_products.publish");
  const pageSize = 25;

  const load = useCallback(async () => {
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      storefrontId,
    });
    if (search.trim() !== "") query.set("search", search.trim());
    if (lifecycleFilter !== "") query.set("lifecycleStatus", lifecycleFilter);
    if (categoryFilter !== "") query.set("categoryId", categoryFilter);
    const result = await api.get<{ items: CatalogueProduct[]; total: number }>(
      `operations/trader-storefront-products?${query.toString()}`,
    );
    setProducts(result.items);
    setTotal(result.total);
  }, [api, categoryFilter, lifecycleFilter, page, search, storefrontId]);

  useEffect(() => {
    let active = true;
    setError(undefined);
    Promise.all([
      load(),
      api
        .get<{ items: CatalogueCategory[] }>(
          `operations/trader-storefront-products/storefronts/${storefrontId}/categories`,
        )
        .then((result) => {
          if (active) setCategories(result.items);
        }),
      // The business template decides which attribute inputs the editor shows.
      api
        .get<{ businessTemplate: ProductTemplate }>(
          `operations/trader-storefronts/${storefrontId}`,
        )
        .then((storefront) => {
          if (active) setTemplate(storefront.businessTemplate);
        })
        .catch(() => undefined),
    ]).catch((cause: unknown) => {
      if (!active) return;
      setProducts([]);
      setError(cause instanceof ApiError ? cause.code : "product_load_failed");
    });
    return () => {
      active = false;
    };
  }, [api, load, storefrontId, reload]);

  const runAction = async (product: CatalogueProduct, action: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.post(`operations/trader-storefront-products/${product.id}/${action}`, {
        expectedVersion: Number(product.version),
      });
      setNotice(`productCatalogue.action.${action}`);
      setReload((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "product_action_failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleAvailability = async (product: CatalogueProduct) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.post(`operations/trader-storefront-products/${product.id}/availability`, {
        availabilityStatus:
          product.availabilityStatus === "available" ? "unavailable" : "available",
        expectedVersion: Number(product.version),
      });
      setReload((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "product_action_failed");
    } finally {
      setBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="accounting-page storefront-products-page">
      <header className="page-heading-copy">
        <h1>{t("productCatalogue.title")}</h1>
        <p>{t("productCatalogue.subtitle")}</p>
      </header>

      {error !== undefined ? (
        <div className="alert alert-danger" role="alert">
          {t(`productCatalogue.errors.${error}`, t("common.operationFailed"))}
        </div>
      ) : null}
      {notice !== undefined ? (
        <div className="alert alert-info" role="status">
          {t(notice, t("common.saved"))}
        </div>
      ) : null}

      <div className="accounting-toolbar">
        <button
          disabled={!canManage}
          onClick={() => {
            setEditingId(undefined);
            setPanel(panel === "product" ? "none" : "product");
          }}
          type="button"
        >
          {t("productCatalogue.editor.createTitle")}
        </button>
        <button
          onClick={() => setPanel(panel === "categories" ? "none" : "categories")}
          type="button"
        >
          {t("productCatalogue.categories.title")}
        </button>
      </div>

      {panel === "categories" ? (
        <CategoryManager
          api={api}
          onChanged={() => setReload((current) => current + 1)}
          permissions={permissions}
          storefrontId={storefrontId}
        />
      ) : null}

      {panel === "product" ? (
        <ProductEditor
          api={api}
          categories={categories}
          onClose={() => setPanel("none")}
          onSaved={() => setReload((current) => current + 1)}
          permissions={permissions}
          storefrontId={storefrontId}
          template={template}
          {...(editingId === undefined ? {} : { productId: editingId })}
        />
      ) : null}

      <div className="accounting-filter-bar">
        <label>
          {t("common.search")}
          <input
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            value={search}
          />
        </label>
        <label>
          {t("productCatalogue.fields.lifecycleStatus")}
          <select
            onChange={(event) => {
              setLifecycleFilter(event.target.value);
              setPage(1);
            }}
            value={lifecycleFilter}
          >
            <option value="">{t("common.all")}</option>
            {(["draft", "active", "inactive", "archived"] as const).map((status) => (
              <option key={status} value={status}>
                {t(`productCatalogue.status.${status}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("productCatalogue.fields.category")}
          <select
            onChange={(event) => {
              setCategoryFilter(event.target.value);
              setPage(1);
            }}
            value={categoryFilter}
          >
            <option value="">{t("common.all")}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.nameEn}
              </option>
            ))}
          </select>
        </label>
      </div>

      {products === undefined ? (
        <div className="accounting-state">{t("common.loading")}</div>
      ) : products.length === 0 ? (
        <div className="accounting-empty">{t("productCatalogue.empty")}</div>
      ) : (
        <div className="table-scroll-x">
          <table className="data-table accounting-table">
            <thead>
              <tr>
                <th>{t("productCatalogue.fields.name")}</th>
                <th>{t("productCatalogue.fields.productCode")}</th>
                <th>{t("productCatalogue.fields.category")}</th>
                <th>{t("productCatalogue.fields.sellingPrice")}</th>
                <th>{t("productCatalogue.fields.images")}</th>
                <th>{t("productCatalogue.fields.lifecycleStatus")}</th>
                <th>{t("productCatalogue.fields.availability")}</th>
                <th>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td>{product.name}</td>
                  <td>
                    <bdi>{product.productCode}</bdi>
                  </td>
                  <td>{product.categoryName ?? "—"}</td>
                  <td>
                    <bdi>{`AED ${product.sellingPrice}`}</bdi>
                  </td>
                  <td>
                    <bdi>{String(product.imageCount ?? 0)}</bdi>
                  </td>
                  <td>
                    <span className="status-badge">
                      {t(`productCatalogue.status.${product.lifecycleStatus}`)}
                    </span>
                  </td>
                  <td>
                    <span className="status-badge">
                      {t(`productCatalogue.availability.${product.availabilityStatus}`)}
                    </span>
                  </td>
                  <td>
                    <button
                      onClick={() => {
                        setEditingId(product.id);
                        setPanel("product");
                      }}
                      type="button"
                    >
                      {t("common.edit")}
                    </button>
                    {lifecycleActions(product.lifecycleStatus).map((action) => (
                      <button
                        disabled={!canPublish || busy}
                        key={action}
                        onClick={() => void runAction(product, action)}
                        type="button"
                      >
                        {t(`productCatalogue.actions.${action}`)}
                      </button>
                    ))}
                    {product.lifecycleStatus === "archived" ? null : (
                      <button
                        disabled={!canManage || busy}
                        onClick={() => void toggleAvailability(product)}
                        type="button"
                      >
                        {product.availabilityStatus === "available"
                          ? t("productCatalogue.actions.markUnavailable")
                          : t("productCatalogue.actions.markAvailable")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="accounting-pagination">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)} type="button">
          {t("common.previous")}
        </button>
        <span>
          <bdi>{`${String(page)} / ${String(totalPages)}`}</bdi>
        </span>
        <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} type="button">
          {t("common.next")}
        </button>
      </div>
    </section>
  );
}
