import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { hasStorefrontPermission } from "./storefront-permissions.js";

/**
 * Storefront Category management.
 *
 * Authenticated only — there is no public path into this screen, and the
 * public catalogue reads categories through the read-only public endpoint.
 *
 * Deactivating a category that still holds ACTIVE Products is refused by the
 * API, so this screen surfaces that refusal rather than pre-empting it: the
 * server counts the Products, and a count computed here could disagree with
 * the one the server acts on.
 */

export interface ManagedCategory {
  readonly description: string | null;
  readonly displayOrder: number;
  readonly id: string;
  readonly isActive: boolean;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly productCount: number;
  readonly slug: string;
  readonly version: string;
}

/** Mirrors the server's slug normalisation. */
export function suggestCategorySlug(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/, "");
}

export function CategoryManager({
  api,
  onChanged,
  permissions,
  storefrontId,
}: {
  readonly api: ApiClient;
  readonly onChanged?: (() => void) | undefined;
  readonly permissions: readonly string[];
  readonly storefrontId: string;
}) {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<readonly ManagedCategory[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [editing, setEditing] = useState<ManagedCategory>();

  const canManage = hasStorefrontPermission(permissions, "storefront_products.manage");
  const base = `operations/trader-storefront-products`;

  useEffect(() => {
    let active = true;
    api
      .get<{ items: ManagedCategory[] }>(`${base}/storefronts/${storefrontId}/categories`)
      .then((result) => {
        if (active) setCategories(result.items);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setCategories([]);
        setError(cause instanceof ApiError ? cause.code : "product_load_failed");
      });
    return () => {
      active = false;
    };
  }, [api, base, storefrontId, reload]);

  const refresh = () => {
    setReload((current) => current + 1);
    onChanged?.();
  };

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      refresh();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "product_action_failed");
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    void run(async () => {
      const body = {
        ...(description === "" ? {} : { description }),
        ...(nameAr === "" ? {} : { nameAr }),
        nameEn,
        ...(slug === "" ? {} : { slug }),
      };
      if (editing === undefined) {
        await api.post(`${base}/storefronts/${storefrontId}/categories`, body);
      } else {
        await api.patch(`${base}/categories/${editing.id}`, {
          ...body,
          expectedVersion: Number(editing.version),
        });
      }
      setNameEn("");
      setNameAr("");
      setSlug("");
      setDescription("");
      setEditing(undefined);
    });

  /**
   * Move a Category up or down.
   *
   * Newly-created Categories all share `displayOrder: 0` -- there is nothing
   * to increment relative to, since every row starts tied. Swapping ONE row's
   * raw value against that shared default was a no-op in exactly the case a
   * Trader is most likely to hit it: right after creating a fresh set. Moving
   * the row within the CURRENTLY DISPLAYED order and renumbering every row
   * sequentially guarantees the move is visible regardless of the values the
   * rows started with.
   */
  const move = (category: ManagedCategory, delta: number) => {
    if (categories === undefined) return;
    const from = categories.findIndex((entry) => entry.id === category.id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= categories.length) return;
    const reordered = [...categories];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved!);
    void run(() =>
      api.post(`${base}/storefronts/${storefrontId}/categories/reorder`, {
        entries: reordered.map((entry, index) => ({ displayOrder: index, id: entry.id })),
      }),
    );
  };

  return (
    <section className="accounting-form category-manager" role="region">
      <header className="page-heading-copy">
        <h2>{t("productCatalogue.categories.title")}</h2>
        <p>{t("productCatalogue.categories.subtitle")}</p>
      </header>

      {error !== undefined ? (
        <div className="alert alert-danger" role="alert">
          {t(`productCatalogue.errors.${error}`, t("common.operationFailed"))}
        </div>
      ) : null}

      <fieldset disabled={!canManage || busy}>
        <legend>
          {editing === undefined
            ? t("productCatalogue.categories.create")
            : t("productCatalogue.categories.edit")}
        </legend>
        <label>
          {t("productCatalogue.categories.nameEn")}
          <input
            onChange={(event) => {
              setNameEn(event.target.value);
              if (editing === undefined) setSlug(suggestCategorySlug(event.target.value));
            }}
            value={nameEn}
          />
        </label>
        <label>
          {t("productCatalogue.categories.nameAr")}
          <input onChange={(event) => setNameAr(event.target.value)} value={nameAr} />
        </label>
        <label>
          {t("productCatalogue.categories.slug")}
          <input onChange={(event) => setSlug(event.target.value)} value={slug} />
        </label>
        <label>
          {t("productCatalogue.categories.description")}
          <textarea
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            value={description}
          />
        </label>
        <button
          className="button button-primary"
          disabled={nameEn.trim() === ""}
          onClick={submit}
          type="button"
        >
          {editing === undefined ? t("common.create") : t("common.save")}
        </button>
        {editing === undefined ? null : (
          <button
            className="button button-secondary"
            onClick={() => {
              setEditing(undefined);
              setNameEn("");
              setNameAr("");
              setSlug("");
              setDescription("");
            }}
            type="button"
          >
            {t("common.cancel")}
          </button>
        )}
      </fieldset>

      {categories === undefined ? (
        <div className="accounting-state">{t("common.loading")}</div>
      ) : categories.length === 0 ? (
        <div className="accounting-empty">{t("productCatalogue.categories.empty")}</div>
      ) : (
        <div className="table-scroll-x">
          <table className="data-table accounting-table">
            <thead>
              <tr>
                <th>{t("productCatalogue.categories.nameEn")}</th>
                <th>{t("productCatalogue.categories.slug")}</th>
                <th>{t("productCatalogue.categories.products")}</th>
                <th>{t("productCatalogue.fields.lifecycleStatus")}</th>
                <th>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category, index) => (
                <tr key={category.id}>
                  <td>{category.nameEn}</td>
                  <td>
                    <bdi>{category.slug}</bdi>
                  </td>
                  <td>
                    <bdi>{String(category.productCount)}</bdi>
                  </td>
                  <td>
                    {category.isActive
                      ? t("productCatalogue.categories.active")
                      : t("productCatalogue.categories.inactive")}
                  </td>
                  <td>
                    <button
                      className="button button-secondary"
                      disabled={!canManage || busy}
                      onClick={() => {
                        setEditing(category);
                        setNameEn(category.nameEn);
                        setNameAr(category.nameAr ?? "");
                        setSlug(category.slug);
                        setDescription(category.description ?? "");
                      }}
                      type="button"
                    >
                      {t("common.edit")}
                    </button>
                    <button
                      className={
                        category.isActive
                          ? "button button-danger"
                          : "button button-secondary"
                      }
                      disabled={!canManage || busy}
                      onClick={() =>
                        void run(() =>
                          api.post(`${base}/categories/${category.id}/active`, {
                            expectedVersion: Number(category.version),
                            isActive: !category.isActive,
                          }),
                        )
                      }
                      type="button"
                    >
                      {category.isActive
                        ? t("productCatalogue.categories.deactivate")
                        : t("productCatalogue.categories.activate")}
                    </button>
                    <button
                      className="button button-secondary"
                      disabled={!canManage || busy || index === 0}
                      onClick={() => move(category, -1)}
                      type="button"
                    >
                      {t("productCatalogue.categories.moveUp")}
                    </button>
                    <button
                      className="button button-secondary"
                      disabled={!canManage || busy || index === categories.length - 1}
                      onClick={() => move(category, 1)}
                      type="button"
                    >
                      {t("productCatalogue.categories.moveDown")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
