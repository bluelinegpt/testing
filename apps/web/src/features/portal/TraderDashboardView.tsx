import { useTranslation } from "react-i18next";

import { formatDate } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

export interface TraderDashboardData {
  readonly commerce: {
    readonly activeProducts: number;
    readonly deliveryCompanyCount: number;
    readonly draftProducts: number;
    readonly hasStore: boolean;
    readonly storeName: string | null;
    readonly storeStatus: string | null;
    readonly storeUrl: string | null;
    readonly totalProducts: number;
  };
  readonly orders: {
    readonly active: number;
    readonly cancelled: number;
    readonly delivered: number;
    readonly newOrders: number;
    readonly returned: number;
    readonly total: number;
  };
  readonly period: {
    readonly monthCodTotal: string;
    readonly monthLabel: string;
  };
  readonly recentOrders: readonly {
    readonly amountDue: string;
    readonly customerName: string;
    readonly deliveryCompanyName: string | null;
    readonly orderDate: string;
    readonly orderNumber: string;
    readonly status: string;
  }[];
}

/**
 * The Trader's landing screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS USES `.dashboard-metrics` / `.kpi-card`, NOT NEW CLASSES
 * ---------------------------------------------------------------------------
 *
 * The first version of this screen invented `.kpi-grid` /
 * `.kpi-card__label` / `.kpi-card__value` — classes that do not exist
 * anywhere in the stylesheet. The cards rendered as bare, unstyled,
 * full-width blocks stacked vertically: exactly the "stretched vertically,
 * wasting space" defect this prompt was written to fix. The Delivery
 * Portal already has an established, responsive KPI grid
 * (`DashboardWorkspace.tsx`'s `.dashboard-metrics` + `.kpi-card`, with a
 * `<span>` label / `<strong>` value / `<small>` helper) — reusing it here
 * is both the fix and the reason the grid is now genuinely responsive
 * (5 → 3 → 2 → 1 columns) without a single new CSS rule.
 *
 * ---------------------------------------------------------------------------
 * WHAT "ORDERS" MEANS HERE
 * ---------------------------------------------------------------------------
 *
 * These are the Trader's existing DELIVERY Orders — the same `orders` table
 * Delivery operations already runs on, filtered to this Trader. There is no
 * Store Order domain yet, so this Dashboard does not invent one.
 *
 * Order counts are lifetime; the COD total is this calendar month only —
 * each card carries its own subtitle rather than one period heading over
 * the whole grid, which would silently imply the counts are monthly too.
 */
export function TraderDashboardView({
  data,
  onAddProduct,
  onCreateBulkOrder,
  onCreateOrder,
  onManageDeliveryCompanies,
  onManageStore,
  onViewAllOrders,
}: {
  readonly data: TraderDashboardData;
  readonly onAddProduct: () => void;
  readonly onCreateBulkOrder: () => void;
  readonly onCreateOrder: () => void;
  readonly onManageDeliveryCompanies: () => void;
  readonly onManageStore: () => void;
  readonly onViewAllOrders: () => void;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const { commerce, orders, period, recentOrders } = data;

  const kpis: readonly { readonly context?: string; readonly label: string; readonly value: string }[] = [
    { label: t("portal.dashboard.totalOrders"), value: String(orders.total) },
    { label: t("portal.dashboard.newOrders"), value: String(orders.newOrders) },
    { label: t("portal.dashboard.activeOrders"), value: String(orders.active) },
    { label: t("portal.dashboard.deliveredOrders"), value: String(orders.delivered) },
    { label: t("portal.dashboard.cancelledOrders"), value: String(orders.cancelled) },
    { label: t("portal.dashboard.returnedOrders"), value: String(orders.returned) },
    {
      context: t("portal.dashboard.thisMonth"),
      label: t("portal.dashboard.monthCodTotal"),
      value: formatMoney(period.monthCodTotal),
    },
    {
      label: t("portal.dashboard.storeStatus"),
      value: commerce.hasStore
        ? t(`storefront.status.${commerce.storeStatus}`, commerce.storeStatus ?? "—")
        : t("portal.dashboard.noStoreShort"),
    },
  ];

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t("portal.area")}</p>
          <h1>{t("portal.dashboard.title")}</h1>
        </div>
        <div className="heading-actions">
          <button className="button button-primary" onClick={onCreateOrder} type="button">
            {t("portal.createOrder")}
          </button>
          <button className="button button-secondary" onClick={onCreateBulkOrder} type="button">
            {t("portal.bulk.createMultiple")}
          </button>
          <button className="button button-secondary" onClick={onManageStore} type="button">
            {commerce.hasStore
              ? t("portal.dashboard.manageStore")
              : t("portal.dashboard.createStoreAction")}
          </button>
          <button
            className="button button-secondary"
            disabled={!commerce.hasStore}
            onClick={onAddProduct}
            title={commerce.hasStore ? undefined : t("portal.dashboard.createStorePrompt")}
            type="button"
          >
            {t("portal.dashboard.addProduct")}
          </button>
          {commerce.storeUrl === null ? null : (
            <a
              className="button button-secondary"
              href={commerce.storeUrl}
              rel="noreferrer"
              target="_blank"
            >
              {t("portal.dashboard.viewStore")}
            </a>
          )}
        </div>
      </div>

      <div className="dashboard-metrics">
        {kpis.map((kpi) => (
          <article className="kpi-card" key={kpi.label}>
            <span>{kpi.label}</span>
            <strong>
              <bdi dir="ltr">{kpi.value}</bdi>
            </strong>
            {kpi.context === undefined ? null : <small>{kpi.context}</small>}
          </article>
        ))}
      </div>

      <section className="data-surface">
        <div className="page-heading-copy">
          <h2>{t("portal.dashboard.commerceSection")}</h2>
        </div>
        {commerce.hasStore ? (
          <dl className="detail-grid">
            <div>
              <dt>{t("portal.profile.storeName")}</dt>
              <dd dir="auto">{commerce.storeName}</dd>
            </div>
            <div>
              <dt>{t("portal.dashboard.totalProducts")}</dt>
              <dd>{commerce.totalProducts}</dd>
            </div>
            <div>
              <dt>{t("portal.dashboard.activeProducts")}</dt>
              <dd>{commerce.activeProducts}</dd>
            </div>
            <div>
              <dt>{t("portal.dashboard.draftProducts")}</dt>
              <dd>{commerce.draftProducts}</dd>
            </div>
          </dl>
        ) : (
          <p>{t("portal.dashboard.createStorePrompt")}</p>
        )}
      </section>

      <section className="data-surface">
        <div className="page-heading-copy">
          <h2>{t("portal.dashboard.deliveryCompaniesSection")}</h2>
        </div>
        {commerce.deliveryCompanyCount === 0 ? (
          <p>{t("portal.deliveryCompanies.noneShort")}</p>
        ) : (
          <p>
            {t("portal.dashboard.connectedDeliveryCompanies")}: {commerce.deliveryCompanyCount}
          </p>
        )}
        <div className="heading-actions">
          <button className="button button-secondary" onClick={onManageDeliveryCompanies} type="button">
            {t("portal.nav.deliveryCompanies")}
          </button>
        </div>
      </section>

      <section className="data-surface">
        <div className="page-heading-copy">
          <h2>{t("portal.dashboard.recentOrdersSection")}</h2>
        </div>
        {recentOrders.length === 0 ? (
          <div className="accounting-empty">{t("portal.noOrders")}</div>
        ) : (
          <div className="table-scroll-x">
            <table className="data-table accounting-table">
              <thead>
                <tr>
                  <th>{t("operations.order")}</th>
                  <th>{t("operations.customer")}</th>
                  <th>{t("operations.status")}</th>
                  <th>{t("operations.customerAmountDue")}</th>
                </tr>
              </thead>
              <tbody>
                {recentOrders.map((order) => (
                  <tr key={order.orderNumber}>
                    <td>
                      <strong>
                        <bdi>{order.orderNumber}</bdi>
                      </strong>
                      <span className="cell-secondary">{formatDate(order.orderDate, locale)}</span>
                    </td>
                    <td>{order.customerName}</td>
                    <td>
                      <span className="status status-neutral">
                        {t(`statuses.${order.status}`)}
                      </span>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatMoney(order.amountDue)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="heading-actions">
          <button className="button button-secondary" onClick={onViewAllOrders} type="button">
            {t("portal.dashboard.viewAllOrders")}
          </button>
        </div>
      </section>
    </>
  );
}

function formatMoney(value: string): string {
  return `${Number(value).toFixed(2)} AED`;
}
