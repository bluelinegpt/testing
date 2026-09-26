import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { formatDate } from "../../localization/formatters.js";
import type { SupportedLocale } from "../../localization/locale.js";

/**
 * Customer Commerce Prompt C5 -- the Trader Portal's own Store Order inbox.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE PAGE FROM `TraderOrdersTable`
 * ---------------------------------------------------------------------------
 *
 * `TraderOrdersTable` shows Delivery Orders (`orders`) -- physical
 * deliveries with a Driver, a route, a Company. A Store Order is a
 * Customer's Commerce purchase that has not yet become one, and for a
 * zero-Delivery-Company Store Order, may never become one at all (it is
 * fulfilled externally instead). Folding the two into one table would blur
 * exactly the distinction the Trader most needs to keep straight: "this
 * needs MY confirmation" vs "this is already out for delivery" (§8 of the
 * prompt: "Trader must understand: Store Orders ≠ Delivery Orders").
 *
 * ---------------------------------------------------------------------------
 * WHY ACTIONS ARE PLAIN POST-THEN-RELOAD, NO OPTIMISTIC UPDATE
 * ---------------------------------------------------------------------------
 *
 * Matches `PortalWorkspace`'s own `updateStatus` idiom exactly (see that
 * file's Driver order-status buttons): the server is the only source of
 * truth for whether a transition succeeded (idempotency/race-safety live
 * there, not here), so every action awaits the call, then reloads the
 * current page from the server rather than guessing the new state locally.
 */

type StoreOrderStatus =
  | "awaiting_trader_confirmation"
  | "cancelled"
  | "completed_external"
  | "confirmed"
  | "converted_to_delivery"
  | "draft"
  | "submitted";

interface StoreOrderItem {
  readonly id: string;
  readonly productNameSnapshot: string;
  readonly productCodeSnapshot: string;
  readonly skuSnapshot: string | null;
  readonly brandSnapshot: string | null;
  readonly unitPriceSnapshot: string;
  readonly quantity: number;
  readonly lineTotal: string;
  readonly selectedOptionsSnapshot: readonly { readonly group: string; readonly value: string }[];
}

interface StoreOrderRow {
  readonly id: string;
  readonly storeOrderNumber: string;
  readonly status: StoreOrderStatus;
  readonly customerName: string;
  readonly customerMobile: string;
  readonly deliveryEmirate: string;
  readonly deliveryArea: string;
  readonly deliveryAddress: string;
  readonly deliveryInstructions: string | null;
  readonly deliveryLocationLink: string | null;
  readonly productSubtotal: string;
  readonly customerDeliveryFee: string;
  readonly deliveryCompanyServiceFee: string;
  readonly codTotal: string;
  readonly deliveryCompanyId: string | null;
  readonly items: readonly StoreOrderItem[];
  readonly createdAt: string;
  readonly storeDisplayNameSnapshot: string;
}

interface StoreOrderPage {
  readonly items: readonly StoreOrderRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

const statusFilters = [
  "awaiting_trader_confirmation",
  "confirmed",
  "converted_to_delivery",
  "completed_external",
  "cancelled",
] as const;

const pageSizes = [25, 50, 100] as const;

function formatMoney(value: string | undefined): string {
  return `${Number(value ?? 0).toFixed(2)} AED`;
}

function apiMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message || fallback : fallback;
}

export function StoreOrdersView({ api, locale }: { readonly api: ApiClient; readonly locale: SupportedLocale }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<(typeof statusFilters)[number] | "">("awaiting_trader_confirmation");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(25);
  const [result, setResult] = useState<StoreOrderPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<StoreOrderRow>();
  const [actionError, setActionError] = useState<string>();
  const [actionPending, setActionPending] = useState(false);

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search.trim() !== "") query.set("search", search.trim());
      if (status !== "") query.set("status", status);
      setResult(await api.get<StoreOrderPage>(`portal/trader/store-orders?${query}`));
    } catch (cause) {
      setError(apiMessage(cause, t("common.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [api, page, pageSize, search, status, t]);

  useEffect(() => void runSearch(), [runSearch]);
  useEffect(() => {
    setPage(1);
  }, [search, status, pageSize]);

  const totalPages = result === undefined ? 1 : Math.max(1, Math.ceil(result.total / pageSize));

  const runAction = async (
    order: StoreOrderRow,
    action: "accept" | "cancel" | "complete-external",
    confirmMessage?: string,
  ) => {
    if (confirmMessage !== undefined && !window.confirm(confirmMessage)) return;
    setActionError(undefined);
    setActionPending(true);
    try {
      const updated = await api.post<StoreOrderRow>(`portal/trader/store-orders/${order.id}/${action}`);
      setSelected(updated);
      await runSearch();
    } catch (cause) {
      setActionError(apiMessage(cause, t("portal.storeOrders.actionFailed")));
    } finally {
      setActionPending(false);
    }
  };

  return (
    <>
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t("portal.area")}</p>
          <h1>{t("portal.storeOrders.title")}</h1>
        </div>
        <div className="heading-actions">
          <button className="icon-button" onClick={() => void runSearch()} title={t("common.refresh")} type="button">
            <RefreshCw aria-hidden="true" size={16} />
          </button>
        </div>
      </div>

      <label className="orders-search">
        <Search aria-hidden="true" size={17} />
        <span className="sr-only">{t("common.search")}</span>
        <input
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void runSearch();
          }}
          placeholder={t("portal.storeOrders.searchPlaceholder")}
          type="search"
          value={search}
        />
      </label>

      <div aria-label={t("portal.statusFilter")} className="orders-quick-views" role="tablist">
        <button
          aria-selected={status === ""}
          className={status === "" ? "active" : undefined}
          onClick={() => setStatus("")}
          role="tab"
          type="button"
        >
          {t("portal.storeOrders.filterAll")}
        </button>
        {statusFilters.map((candidate) => (
          <button
            aria-selected={status === candidate}
            className={status === candidate ? "active" : undefined}
            key={candidate}
            onClick={() => setStatus(candidate)}
            role="tab"
            type="button"
          >
            {t(`portal.storeOrders.statusLabels.${candidate}`)}
          </button>
        ))}
      </div>

      <div className="data-surface">
        <div className="table-scroll-x">
          <table>
            <thead>
              <tr>
                <th>{t("portal.storeOrders.number")}</th>
                <th>{t("operations.customer")}</th>
                <th>{t("portal.storeOrders.items")}</th>
                <th>{t("portal.storeOrders.codTotal")}</th>
                <th>{t("operations.status")}</th>
                <th>
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(result?.items ?? []).map((order) => (
                <tr key={order.id}>
                  <td>
                    <strong>
                      <bdi>{order.storeOrderNumber}</bdi>
                    </strong>
                    <span className="cell-secondary">{formatDate(order.createdAt, locale)}</span>
                  </td>
                  <td>
                    {order.customerName}
                    <span className="cell-secondary">
                      <bdi>{order.customerMobile}</bdi>
                    </span>
                  </td>
                  <td>{t("portal.storeOrders.itemCount", { count: order.items.length })}</td>
                  <td>
                    <bdi dir="ltr">{formatMoney(order.codTotal)}</bdi>
                  </td>
                  <td>
                    <span className="status status-neutral">
                      {t(`portal.storeOrders.statusLabels.${order.status}`)}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button onClick={() => setSelected(order)} type="button">
                        {t("common.view")}
                      </button>
                      {order.status === "awaiting_trader_confirmation" ? (
                        <>
                          <button onClick={() => void runAction(order, "accept")} type="button">
                            {t("portal.storeOrders.accept")}
                          </button>
                          <button
                            onClick={() =>
                              void runAction(order, "cancel", t("portal.storeOrders.confirmCancel"))
                            }
                            type="button"
                          >
                            {t("portal.storeOrders.cancel")}
                          </button>
                        </>
                      ) : null}
                      {order.status === "confirmed" ? (
                        <button onClick={() => void runAction(order, "complete-external")} type="button">
                          {t("portal.storeOrders.completeExternal")}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && (result?.items.length ?? 0) === 0 ? (
                <tr>
                  <td className="empty-state" colSpan={6}>
                    {t("portal.storeOrders.empty")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {loading ? <div className="loading-row">{t("common.loading")}</div> : null}
        </div>
      </div>

      <div className="pagination">
        <span>{t("common.pageOf", { page, pageCount: totalPages })}</span>
        <button disabled={page <= 1} onClick={() => setPage((current) => current - 1)} type="button">
          {t("common.previous")}
        </button>
        <button
          disabled={page >= totalPages}
          onClick={() => setPage((current) => current + 1)}
          type="button"
        >
          {t("common.next")}
        </button>
        <select
          onChange={(event) => setPageSize(Number(event.target.value) as (typeof pageSizes)[number])}
          value={pageSize}
        >
          {pageSizes.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      {selected ? (
        <StoreOrderDetailModal
          error={actionError}
          onAccept={() => void runAction(selected, "accept")}
          onCancel={() => void runAction(selected, "cancel", t("portal.storeOrders.confirmCancel"))}
          onClose={() => {
            setSelected(undefined);
            setActionError(undefined);
          }}
          onCompleteExternal={() => void runAction(selected, "complete-external")}
          order={selected}
          pending={actionPending}
        />
      ) : null}
    </>
  );
}

function StoreOrderDetailModal({
  error,
  onAccept,
  onCancel,
  onClose,
  onCompleteExternal,
  order,
  pending,
}: {
  readonly error: string | undefined;
  readonly onAccept: () => void;
  readonly onCancel: () => void;
  readonly onClose: () => void;
  readonly onCompleteExternal: () => void;
  readonly order: StoreOrderRow;
  readonly pending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={order.storeOrderNumber}
      titleId="store-order-detail-title"
    >
      <div className="modal-body">
          <span className="status status-neutral">{t(`portal.storeOrders.statusLabels.${order.status}`)}</span>

          <h3>{t("operations.customer")}</h3>
          <p>{order.customerName}</p>
          <p dir="ltr">{order.customerMobile}</p>

          <h3>{t("portal.storeOrders.deliveryAddress")}</h3>
          <p>
            {order.deliveryAddress}, {order.deliveryArea}, {order.deliveryEmirate}
          </p>
          {order.deliveryInstructions === null ? null : <p>{order.deliveryInstructions}</p>}

          <h3>{t("portal.storeOrders.items")}</h3>
          <ul>
            {order.items.map((item) => (
              <li key={item.id}>
                {item.productNameSnapshot}
                {item.selectedOptionsSnapshot.length === 0 ? null : (
                  <span className="cell-secondary">
                    {" "}
                    {item.selectedOptionsSnapshot.map((option) => `${option.group}: ${option.value}`).join(" · ")}
                  </span>
                )}{" "}
                × {item.quantity} — <bdi dir="ltr">{formatMoney(item.lineTotal)}</bdi>
              </li>
            ))}
          </ul>

          <dl className="facts">
            <div>
              <dt>{t("portal.storeOrders.productSubtotal")}</dt>
              <dd>
                <bdi dir="ltr">{formatMoney(order.productSubtotal)}</bdi>
              </dd>
            </div>
            <div>
              <dt>{t("operations.deliveryFee")}</dt>
              <dd>
                <bdi dir="ltr">{formatMoney(order.customerDeliveryFee)}</bdi>
              </dd>
            </div>
            <div>
              <dt>{t("portal.storeOrders.companyServiceFee")}</dt>
              <dd>
                <bdi dir="ltr">{formatMoney(order.deliveryCompanyServiceFee)}</bdi>
              </dd>
            </div>
            <div>
              <dt>{t("portal.storeOrders.codTotal")}</dt>
              <dd>
                <strong>
                  <bdi dir="ltr">{formatMoney(order.codTotal)}</bdi>
                </strong>
              </dd>
            </div>
          </dl>

          {error ? (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <div className="modal-footer">
          {order.status === "awaiting_trader_confirmation" ? (
            <>
              <button
                className="button button-primary"
                disabled={pending}
                onClick={onAccept}
                type="button"
              >
                {t("portal.storeOrders.accept")}
              </button>
              <button
                className="button button-secondary"
                disabled={pending}
                onClick={onCancel}
                type="button"
              >
                {t("portal.storeOrders.cancel")}
              </button>
            </>
          ) : null}
          {order.status === "confirmed" ? (
            <button
              className="button button-primary"
              disabled={pending}
              onClick={onCompleteExternal}
              type="button"
            >
              {t("portal.storeOrders.completeExternal")}
            </button>
          ) : null}
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.close")}
          </button>
        </div>
    </Modal>
  );
}
