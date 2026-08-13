import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useLocation } from "react-router-dom";

import {
  type CustomerOrderSummary,
  type CustomerOrderSummaryPage,
  fetchCustomerOrders,
} from "../api/customer-orders-client.js";
import { useCustomerSession } from "../auth/customer-session-context.js";
import { CodeText, Money } from "../components/Bidi.js";
import { MessageState } from "../components/States.js";
import { orderStatusLabel, orderStatusTone } from "../localization/order-status.js";
import { useLocalePath } from "../routing/locale-routing.js";

const PAGE_SIZE = 10;

/**
 * §15/§17-19/§21: `/account/orders` -- authenticated Customer only, a
 * Customer-ecommerce card list (never the Delivery Portal's Orders table),
 * server-side paginated, with a safe empty state and no fabricated Orders.
 */
export function MyOrdersPage() {
  const localePath = useLocalePath();
  const location = useLocation();
  const { session } = useCustomerSession();

  if (session.status === "loading") return null;
  if (session.status === "anonymous") {
    const returnTo = encodeURIComponent(location.pathname);
    return <Navigate replace to={`${localePath("/login")}?returnTo=${returnTo}`} />;
  }
  return <MyOrdersContent />;
}

function MyOrdersContent() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const [page, setPage] = useState<CustomerOrderSummaryPage>();
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(true);
  // §26: My Orders is one of the pages that must offer reusable retry --
  // network failures show the same honest, retryable state Store/Product
  // already use, rather than a silent empty list.
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (targetPage: number) => {
    setLoading(true);
    setFailed(false);
    const result = await fetchCustomerOrders({ page: targetPage, pageSize: PAGE_SIZE });
    if (result.kind === "ok") setPage(result.value);
    else if (result.error.errorCode === "network_error") setFailed(true);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(pageNumber);
  }, [load, pageNumber]);

  const totalPages = page === undefined ? 1 : Math.max(1, Math.ceil(page.total / page.pageSize));

  return (
    <div className="store-container">
      <h1>{t("orders.title")}</h1>

      {failed ? (
        <MessageState
          bodyKey="errors.network.body"
          onRetry={() => void load(pageNumber)}
          titleKey="errors.network.title"
          tone="error"
        />
      ) : loading && page === undefined ? (
        <p>{t("common.loading")}</p>
      ) : page !== undefined && page.items.length === 0 ? (
        <div className="store-note">
          <p className="store-note__title">{t("orders.empty.title")}</p>
          <p className="store-note__body">{t("orders.empty.body")}</p>
          <Link className="store-button store-button--onnavy" to={localePath("/")}>
            {t("orders.browseStores")}
          </Link>
        </div>
      ) : (
        <>
          <ul className="store-orders-list">
            {(page?.items ?? []).map((order) => (
              <OrderSummaryCard key={order.id} order={order} />
            ))}
          </ul>
          {totalPages > 1 ? (
            <nav aria-label={t("orders.title")} className="store-orders-pagination">
              <button
                className="store-button store-button--quiet"
                disabled={pageNumber <= 1}
                onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
                type="button"
              >
                {t("common.back")}
              </button>
              <span className="store-note">
                {pageNumber} / {totalPages}
              </span>
              <button
                className="store-button store-button--quiet"
                disabled={pageNumber >= totalPages}
                onClick={() => setPageNumber((current) => Math.min(totalPages, current + 1))}
                type="button"
              >
                {t("common.viewAll")}
              </button>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}

function OrderSummaryCard({ order }: { readonly order: CustomerOrderSummary }) {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const tone = orderStatusTone(order.status);

  return (
    <li className="store-order-card">
      <Link
        className="store-order-card__link"
        to={localePath(`/account/orders/${order.storeOrderNumber}`)}
      >
        <div className="store-order-card__media" aria-hidden="true">
          {order.primaryImageUrl === null ? (
            <div className="store-order-card__media store-thumb--empty" />
          ) : (
            <img alt="" loading="lazy" src={order.primaryImageUrl} />
          )}
        </div>
        <div className="store-order-card__body">
          <div className="store-order-card__row">
            <CodeText className="store-order-card__number" value={order.storeOrderNumber} />
            <span className={`store-badge store-badge--${tone}`}>
              {orderStatusLabel(t, order.status)}
            </span>
          </div>
          <p className="store-order-card__store" dir="auto">
            {order.storeDisplayName}
          </p>
          <p className="store-order-card__meta">
            <span dir="ltr">{new Date(order.createdAt).toLocaleDateString()}</span>
            {" · "}
            {t("orders.itemCount", { count: order.itemCount })}
          </p>
          <p className="store-order-card__total">
            <Money amount={order.codTotal} currency="AED" />
          </p>
        </div>
      </Link>
    </li>
  );
}
