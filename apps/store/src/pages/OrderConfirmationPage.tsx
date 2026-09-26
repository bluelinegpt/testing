import { useTranslation } from "react-i18next";
import { Link, useLocation, useParams } from "react-router-dom";

import type { PlaceStoreOrderResult } from "../api/checkout-client.js";
import { CodeText, LabelledValue, Money, TraderText } from "../components/Bidi.js";
import { MessageState } from "../components/States.js";
import { useCustomerSession } from "../auth/customer-session-context.js";
import { orderStatusLabel, orderStatusTone } from "../localization/order-status.js";
import type { StoreOrderStatus } from "../api/customer-orders-client.js";
import { useLocalePath } from "../routing/locale-routing.js";

/**
 * `/order-confirmation/:storeOrderNumber` — Customer Commerce Prompt C3,
 * Part R.
 *
 * Reads the just-created Store Order from router navigation state ONLY
 * (`CheckoutPage` passes it via `navigate(path, {state: {order}})`
 * immediately after a successful `POST commerce/store-orders`) -- there is
 * deliberately no re-fetch here. A guest has no session to re-fetch through,
 * and the raw tracking token is never put in the URL or persistent storage
 * (§58/§60), so it only ever exists in this one navigation's state. A
 * reload or a direct visit to this URL (no state) shows a safe, generic
 * fallback rather than an error -- the Store Order itself is not lost: it
 * is in My Orders (logged in) or reachable via Track Order (guest) either
 * way.
 */
export function OrderConfirmationPage() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const { storeOrderNumber } = useParams();
  const location = useLocation();
  const { session } = useCustomerSession();
  const order = (location.state as { readonly order?: PlaceStoreOrderResult } | null)?.order;

  if (order === undefined) {
    return (
      <div className="store-container store-section">
        <MessageState
          action={
            <Link className="store-button store-button--onnavy" to={localePath("/track")}>
              {t("checkout.confirmation.trackOrder")}
            </Link>
          }
          bodyKey="checkout.confirmation.noStateBody"
          titleKey="checkout.confirmation.noStateTitle"
        />
      </div>
    );
  }

  const currency = "AED";
  const status = order.status as StoreOrderStatus;

  return (
    <div className="store-container store-section store-checkout__review">
      <h1>{t("checkout.confirmation.title")}</h1>
      <p>{t("checkout.confirmation.lead", { number: order.storeOrderNumber })}</p>

      <div className="store-order-card__row">
        <h2>
          <CodeText value={order.storeOrderNumber ?? storeOrderNumber ?? ""} />
        </h2>
        <span className={`store-badge store-badge--${orderStatusTone(status)}`}>
          {orderStatusLabel(t, status)}
        </span>
      </div>

      <Link to={localePath(`/${order.storeSlug}`)}>
        <TraderText value={order.storeDisplayName} />
      </Link>

      <ul className="store-checkout__reviewlines">
        {order.items.map((item) => (
          <li className="store-checkout__reviewline" key={item.id}>
            <TraderText as="span" value={item.productNameSnapshot} />
            {item.selectedOptionsSnapshot.length === 0 ? null : (
              <span className="store-cart__lineoptions">
                {" "}
                {item.selectedOptionsSnapshot.map((option) => `${option.group}: ${option.value}`).join(" · ")}
              </span>
            )}
            <Money amount={item.lineTotal} className="store-price" currency={currency} />
          </li>
        ))}
      </ul>

      <div className="store-checkout__reviewrow">
        <span>{t("checkout.review.productSubtotal")}</span>
        <Money amount={order.productSubtotal} className="store-price" currency={currency} />
      </div>
      <div className="store-checkout__reviewrow">
        <span>{t("checkout.review.deliveryFee")}</span>
        <Money amount={order.customerDeliveryFee} className="store-price" currency={currency} />
      </div>
      <div className="store-checkout__reviewrow store-checkout__reviewrow--total">
        <span>{t("checkout.review.codTotal")}</span>
        <Money amount={order.codTotal} className="store-price store-price--lg" currency={currency} />
      </div>

      <dl className="store-facts">
        <LabelledValue
          label={t("checkout.address.title")}
          value={`${order.deliveryAddress}, ${order.deliveryArea}, ${order.deliveryEmirate}`}
        />
        {order.deliveryCompanyName === null ? (
          <LabelledValue label={t("orders.deliveryCompany")} value={t("checkout.confirmation.storeWillConfirm")} />
        ) : (
          <LabelledValue label={t("orders.deliveryCompany")} value={order.deliveryCompanyName} />
        )}
      </dl>

      {/* C3 corrective, §36: a replay never pretends to have a token it
       * does not have -- the confirmation still shows the real Store Order
       * above, but the tracking handoff below only offers a prefilled
       * token when one actually exists. */}
      {order.trackingToken === null && session.status !== "authenticated" ? (
        <p className="store-note">{t("checkout.confirmation.trackingUnavailableNote")}</p>
      ) : null}

      <div className="store-cart__actions">
        <Link
          className="store-button store-button--onnavy"
          state={
            order.trackingToken === null
              ? { storeOrderNumber: order.storeOrderNumber }
              : { storeOrderNumber: order.storeOrderNumber, trackingToken: order.trackingToken }
          }
          to={localePath("/track")}
        >
          {t("checkout.confirmation.trackOrder")}
        </Link>
        {session.status === "authenticated" ? (
          <Link to={localePath("/account/orders")}>{t("checkout.confirmation.viewMyOrders")}</Link>
        ) : null}
        <Link to={localePath("/")}>{t("cart.continueShopping")}</Link>
      </div>
    </div>
  );
}
