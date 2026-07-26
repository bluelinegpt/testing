import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { LoginResponse, PortalOrder } from "../../api/contracts.js";
import { formatDate } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

export function PortalWorkspace({
  api,
  onLogout,
  session,
}: {
  api: ApiClient;
  onLogout: () => Promise<void>;
  session: LoginResponse;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const isDriver = session.identity.kind === "driver";
  const [orders, setOrders] = useState<readonly PortalOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setOrders(
        await api.get<readonly PortalOrder[]>(
          isDriver ? "portal/driver/orders" : "portal/trader/orders",
        ),
      );
    } catch {
      setError(t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [api, isDriver, t]);

  useEffect(() => void load(), [load]);

  const updateStatus = async (order: PortalOrder, status: string) => {
    setError(undefined);
    try {
      await api.patch<PortalOrder>(`portal/driver/orders/${order.id}/status`, { status });
      await load();
    } catch {
      setError(t("portal.statusFailed"));
    }
  };

  return (
    <main className="admin-layout">
      <aside className="sidebar">
        <div className="sidebar-company">
          <span>{t("workspace.company")}</span>
          <strong>{session.identity.username}</strong>
        </div>
        <nav aria-label={t("workspace.navigation")} className="side-nav">
          <button aria-current="page" type="button">
            {isDriver ? t("portal.driverTitle") : t("portal.traderTitle")}
          </button>
        </nav>
        <button
          className="button button-secondary logout-button"
          onClick={() => void onLogout()}
          type="button"
        >
          {t("auth.logout")}
        </button>
      </aside>
      <section className="admin-content">
        {error === undefined ? null : (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <div className="page-heading">
          <div>
            <p className="eyebrow">{t("portal.area")}</p>
            <h1>{isDriver ? t("portal.driverTitle") : t("portal.traderTitle")}</h1>
          </div>
          <button className="button button-secondary" onClick={() => void load()} type="button">
            {t("common.refresh")}
          </button>
        </div>
        <div className="data-surface">
          <table>
            <thead>
              <tr>
                <th>{t("operations.order")}</th>
                <th>{t("operations.customer")}</th>
                <th>{t("operations.trader")}</th>
                <th>{t("operations.status")}</th>
                <th>{t("operations.customerAmountDue")}</th>
                {isDriver ? (
                  <th>
                    <span className="sr-only">{t("common.actions")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>
                    <strong>{order.orderNumber}</strong>
                    <span className="cell-secondary">{formatDate(order.orderDate, locale)}</span>
                  </td>
                  <td>
                    {order.customerName}
                    <span className="cell-secondary">{order.customerMobileNumber}</span>
                    <span className="cell-secondary">{order.customerAddress}</span>
                  </td>
                  <td>
                    {order.traderName}
                    <span className="cell-secondary">{order.areaName}</span>
                  </td>
                  <td>
                    <span className="status status-neutral">{order.deliveryStatus}</span>
                  </td>
                  <td>{formatMoney(order.customerAmountDue)}</td>
                  {isDriver ? (
                    <td>
                      <div className="row-actions">
                        {driverActions(order.deliveryStatus).map((action) => (
                          <button
                            key={action.status}
                            onClick={() => void updateStatus(order, action.status)}
                            type="button"
                          >
                            {t(`operations.${action.label}`)}
                          </button>
                        ))}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
              {orders.length === 0 ? (
                <tr>
                  <td className="empty-state" colSpan={isDriver ? 6 : 5}>
                    {t("portal.noOrders")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {loading ? <div className="loading-row">{t("common.loading")}</div> : null}
        </div>
      </section>
    </main>
  );
}

function driverActions(
  status: string,
): readonly { readonly label: string; readonly status: string }[] {
  if (status === "assigned") return [{ label: "outForDelivery", status: "out_for_delivery" }];
  if (status === "out_for_delivery") {
    return [
      { label: "markDelivered", status: "delivered" },
      { label: "markReturned", status: "returned" },
    ];
  }
  return [];
}

function formatMoney(value: string | undefined): string {
  return `${Number(value ?? 0).toFixed(2)} AED`;
}
