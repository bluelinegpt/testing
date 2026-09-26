import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";

import { type CustomerOrderDetail, fetchCustomerOrderDetail } from "../api/customer-orders-client.js";
import { useCustomerSession } from "../auth/customer-session-context.js";
import { CodeText, LabelledValue, Money, TraderText } from "../components/Bidi.js";
import { MessageState } from "../components/States.js";
import { orderStatusLabel, orderStatusTone } from "../localization/order-status.js";
import { useLocalePath } from "../routing/locale-routing.js";

/**
 * §19-21: `/account/orders/{storeOrderNumber}` -- authenticated Customer
 * only, organised into Status/Items/Delivery/Summary/Store-link exactly as
 * §20 specifies, entirely from the frozen snapshot fields the API already
 * refuses to rehydrate from live Product/Customer data (§10).
 */
export function OrderDetailPage() {
  const localePath = useLocalePath();
  const location = useLocation();
  const { session } = useCustomerSession();

  if (session.status === "loading") return null;
  if (session.status === "anonymous") {
    const returnTo = encodeURIComponent(location.pathname);
    return <Navigate replace to={`${localePath("/login")}?returnTo=${returnTo}`} />;
  }
  return <OrderDetailContent />;
}

function OrderDetailContent() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const { storeOrderNumber } = useParams<{ storeOrderNumber: string }>();
  const [order, setOrder] = useState<CustomerOrderDetail>();
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (storeOrderNumber === undefined) return;
    const result = await fetchCustomerOrderDetail(storeOrderNumber);
    if (result.kind === "ok") setOrder(result.value);
    else setNotFound(true);
  }, [storeOrderNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  if (notFound) {
    return (
      <div className="store-container">
        <MessageState bodyKey="orders.notFound.body" titleKey="orders.notFound.title" />
      </div>
    );
  }
  if (order === undefined) {
    return (
      <div className="store-container">
        <p>{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="store-container store-order-detail">
      <Link className="store-note store-note--action" to={localePath("/account/orders")}>
        {t("orders.backToOrders")}
      </Link>

      <header className="store-order-detail__header">
        <div>
          <h1>
            <CodeText value={order.storeOrderNumber} />
          </h1>
          <p className="store-order-card__meta" dir="ltr">
            {new Date(order.createdAt).toLocaleString()}
          </p>
        </div>
        <span className={`store-badge store-badge--${orderStatusTone(order.status)}`}>
          {orderStatusLabel(t, order.status)}
        </span>
      </header>

      {order.status === "cancelled" ? (
        <p className="store-note store-note__body">{t("orders.cancelledNote")}</p>
      ) : null}

      {order.deliverySummary === null ? null : (
        <section className="store-account-section">
          <h2>{t("orders.deliveryStatus")}</h2>
          <p dir="auto">{order.deliverySummary.deliveryStatus}</p>
          {order.deliverySummary.deliveryCompanyName === null ? null : (
            <p dir="auto">
              {t("orders.deliveredBy", { company: order.deliverySummary.deliveryCompanyName })}
            </p>
          )}
        </section>
      )}

      <section className="store-account-section">
        <h2>{t("orders.store")}</h2>
        <Link to={localePath(`/${order.storeSlug}`)}>
          <TraderText value={order.storeDisplayName} />
        </Link>
      </section>

      <section className="store-account-section">
        <h2>{t("orders.items")}</h2>
        <ul className="store-order-items">
          {order.items.map((item) => (
            <li className="store-order-item" key={item.id}>
              <div className="store-order-item__media" aria-hidden="true">
                {item.imageUrl === null ? (
                  <div className="store-thumb--empty" />
                ) : (
                  <img alt="" loading="lazy" src={item.imageUrl} />
                )}
              </div>
              <div className="store-order-item__body">
                <TraderText as="p" className="store-order-item__name" value={item.productNameSnapshot} />
                <p className="store-order-card__meta">
                  <CodeText value={item.productCodeSnapshot} />
                  {item.skuSnapshot === null ? null : (
                    <>
                      {" · "}
                      <CodeText value={item.skuSnapshot} />
                    </>
                  )}
                </p>
                {item.selectedOptionsSnapshot.length === 0 ? null : (
                  <p className="store-order-card__meta" dir="auto">
                    {item.selectedOptionsSnapshot.map((option) => `${option.group}: ${option.value}`).join(", ")}
                  </p>
                )}
                <p className="store-order-card__meta">
                  <Money amount={item.unitPriceSnapshot} currency="AED" /> × {item.quantity}
                </p>
              </div>
              <div className="store-order-item__total">
                <Money amount={item.lineTotal} currency="AED" />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="store-account-section">
        <h2>{t("orders.delivery")}</h2>
        <dl className="store-facts">
          <LabelledValue label={t("auth.account.name")} value={<span dir="auto">{order.customerName}</span>} />
          <LabelledValue label={t("auth.account.mobile")} value={<span dir="ltr">{order.customerMobile}</span>} />
          <LabelledValue
            label={t("orders.address")}
            value={
              <span dir="auto">
                {order.deliveryAddress}, {order.deliveryArea}, {order.deliveryEmirate}
              </span>
            }
          />
          {order.deliveryInstructions === null ? null : (
            <LabelledValue
              label={t("auth.address.deliveryInstructions")}
              value={<span dir="auto">{order.deliveryInstructions}</span>}
            />
          )}
          {order.deliveryCompanyName === null ? null : (
            <LabelledValue
              label={t("orders.deliveryCompany")}
              value={<span dir="auto">{order.deliveryCompanyName}</span>}
            />
          )}
        </dl>
      </section>

      <section className="store-account-section">
        <h2>{t("orders.summary")}</h2>
        <dl className="store-facts">
          <LabelledValue
            label={t("orders.productSubtotal")}
            value={<Money amount={order.productSubtotal} currency="AED" />}
          />
          <LabelledValue
            label={t("orders.deliveryFee")}
            value={<Money amount={order.customerDeliveryFee} currency="AED" />}
          />
          <LabelledValue
            label={t("orders.codTotal")}
            value={<Money amount={order.codTotal} currency="AED" />}
          />
        </dl>
      </section>
    </div>
  );
}
