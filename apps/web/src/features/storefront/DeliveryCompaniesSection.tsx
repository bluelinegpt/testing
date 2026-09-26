import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";

/**
 * The Delivery Companies connected to this Store.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A COMPANY PICKER
 * ---------------------------------------------------------------------------
 *
 * Only relationships that already exist are listed. There is no "add Delivery
 * Company" control and no global directory: a settings screen that could
 * enumerate every Company on the platform is a discovery surface, and forming a
 * new commercial relationship is not a checkbox.
 *
 * ---------------------------------------------------------------------------
 * TURNING OFF THE LAST ONE IS ALLOWED, AND IS CONFIRMED
 * ---------------------------------------------------------------------------
 *
 * A Store with no Delivery Company enabled for orders is a valid state after
 * 0B-1 — the shop stays published, keeps its URL and keeps its catalogue. It is
 * still worth one confirmation, because the person clicking it is usually
 * adjusting one row and may not realise it was the last one.
 *
 * The default is cleared by the SERVER when a relationship is disabled, not
 * here. This component sends the change and re-renders whatever comes back, so
 * the rule lives in one place and the screen cannot drift from it.
 */

export interface DeliveryRelationship {
  readonly companyId: string;
  readonly companyName: string;
  readonly enabledForStoreOrders: boolean;
  readonly id: string;
  readonly isDefaultForStoreOrders: boolean;
  readonly status: string;
}

export function DeliveryCompaniesSection({
  api,
  canManage,
  storefrontId,
}: {
  readonly api: ApiClient;
  readonly canManage: boolean;
  readonly storefrontId: string;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<readonly DeliveryRelationship[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmDisableId, setConfirmDisableId] = useState<string>();

  const load = useCallback(() => {
    setError(undefined);
    api
      .get<{ items: DeliveryRelationship[] }>(
        `operations/trader-storefronts/${storefrontId}/delivery-companies`,
      )
      .then((value) => setItems(value.items))
      .catch((cause: unknown) =>
        setError(cause instanceof ApiError ? cause.code : "storefront_delivery_load_failed"),
      );
  }, [api, storefrontId]);

  useEffect(() => load(), [load]);

  const apply = async (relationshipId: string, body: Record<string, boolean>) => {
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api.patch<{ items: DeliveryRelationship[] }>(
        `operations/trader-storefronts/${storefrontId}/delivery-companies/${relationshipId}`,
        body,
      );
      setItems(updated.items);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "storefront_delivery_save_failed");
    } finally {
      setBusy(false);
      setConfirmDisableId(undefined);
    }
  };

  const enabledCount = (items ?? []).filter((row) => row.enabledForStoreOrders).length;

  const toggleEnabled = (row: DeliveryRelationship) => {
    // Only the LAST enabled one is confirmed. Disabling one of several changes
    // nothing a customer would notice.
    if (row.enabledForStoreOrders && enabledCount === 1) {
      setConfirmDisableId(row.id);
      return;
    }
    void apply(row.id, { enabledForStoreOrders: !row.enabledForStoreOrders });
  };

  /**
   * A relationship the Company later marked inactive/suspended/terminated is
   * refused everywhere it would actually be USED -- the server rejects
   * enabling it at all. Turning that ON is blocked here too, so the switch
   * never invites a click that only fails with an explanation after the
   * fact. Turning an already-enabled one OFF stays available regardless --
   * that direction is always safe.
   */
  const canToggleOn = (row: DeliveryRelationship) => row.status === "active";

  return (
    <section className="accounting-form" data-testid="storefront-delivery-companies">
      <h2>{t("storefront.delivery.sectionTitle")}</h2>
      <p className="form-hint">{t("storefront.delivery.sectionHint")}</p>

      {error !== undefined ? (
        <div className="alert alert-danger" role="alert">
          {t(`storefront.errors.${error}`, t("common.operationFailed"))}
        </div>
      ) : null}

      {items === undefined ? null : items.length === 0 ? (
        <p className="form-hint" data-testid="storefront-delivery-empty">
          {t("storefront.delivery.noneConnected")}
        </p>
      ) : (
        <ul className="storefront-delivery-list">
          {items.map((row) => (
            <li key={row.id}>
              <label>
                <input
                  checked={row.enabledForStoreOrders}
                  disabled={
                    !canManage || busy || (!row.enabledForStoreOrders && !canToggleOn(row))
                  }
                  onChange={() => toggleEnabled(row)}
                  type="checkbox"
                />
                {row.companyName}
              </label>
              <span className={`badge${row.status === "active" ? "" : " badge-muted"}`}>
                {t(`storefront.delivery.status.${row.status}`, row.status)}
              </span>
              {!row.enabledForStoreOrders && !canToggleOn(row) ? (
                <p className="form-hint">{t("storefront.delivery.ineligibleHint")}</p>
              ) : null}
              {row.isDefaultForStoreOrders ? (
                <span className="badge">{t("storefront.delivery.defaultBadge")}</span>
              ) : row.enabledForStoreOrders ? (
                <button
                  className="button button-secondary"
                  disabled={!canManage || busy}
                  onClick={() => void apply(row.id, { isDefaultForStoreOrders: true })}
                  type="button"
                >
                  {t("storefront.delivery.setDefault")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {items !== undefined && items.length > 0 && enabledCount === 0 ? (
        <p className="form-hint" data-testid="storefront-delivery-none-enabled">
          {t("storefront.delivery.noneEnabled")}
        </p>
      ) : null}

      {confirmDisableId !== undefined ? (
        <div className="alert alert-info" role="alertdialog">
          <p>{t("storefront.delivery.disableLastConfirm")}</p>
          <button
            className="button button-danger"
            disabled={busy}
            onClick={() => void apply(confirmDisableId, { enabledForStoreOrders: false })}
            type="button"
          >
            {t("common.confirm")}
          </button>
          <button
            className="button button-secondary"
            disabled={busy}
            onClick={() => setConfirmDisableId(undefined)}
            type="button"
          >
            {t("common.cancel")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
