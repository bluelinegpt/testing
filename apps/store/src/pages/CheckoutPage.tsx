import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import { type CheckoutResult, placeStoreOrder, validateCheckout } from "../api/checkout-client.js";
import {
  type CustomerAddress,
  fetchCustomerAddresses,
  fetchCustomerProfile,
} from "../api/customer-auth-client.js";
import { useCustomerSession } from "../auth/customer-session-context.js";
import { useCart } from "../cart/cart-context.js";
import { Money, TraderText } from "../components/Bidi.js";
import { MessageState } from "../components/States.js";
import { useLocalePath } from "../routing/locale-routing.js";

/**
 * `/checkout` — Customer Commerce Prompts C2 (Review) and C3 (Place Order).
 *
 * "Review Order" calls the checkout validate endpoint (preview only, §13 of
 * C2). "Place Order" calls a SEPARATE, persisting endpoint
 * (`commerce/store-orders`, C3 §6) — the Cart it reads from (`useCart()`) is
 * never trusted for a price, a name, or a Company selection either time;
 * only `productSlug`/`quantity`/`selectedOptions` leave this page. The Cart
 * is cleared ONLY after a successful Place Order response (§55) — never on
 * Review, never on a failed submission (§56).
 */
export function CheckoutPage() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const navigate = useNavigate();
  const { cart, clearCart } = useCart();
  const { session } = useCustomerSession();

  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [addresses, setAddresses] = useState<readonly CustomerAddress[]>([]);
  const [savedAddressId, setSavedAddressId] = useState<string>("");
  const [emirate, setEmirate] = useState("");
  const [area, setArea] = useState("");
  const [address, setAddress] = useState("");
  const [locationLink, setLocationLink] = useState("");
  const [deliveryInstructions, setDeliveryInstructions] = useState("");
  const [selectedDeliveryCompanyId, setSelectedDeliveryCompanyId] = useState<string>();

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CheckoutResult>();
  const [error, setError] = useState<string>();

  const [placingOrder, setPlacingOrder] = useState(false);
  const [placeError, setPlaceError] = useState<string>();
  // §10: generated fresh whenever the reviewed state changes (a new
  // `runValidate()` result), then REUSED across every Place Order attempt
  // for that same reviewed state -- a genuine retry (double click, lost
  // response, network retry) must reuse the same key so the server treats
  // it as one submission, not several.
  const [idempotencyKey, setIdempotencyKey] = useState<string>();

  useEffect(() => {
    if (session.status !== "authenticated") return;
    void fetchCustomerProfile().then((profileResult) => {
      if (profileResult.kind === "ok") {
        setName(profileResult.value.name);
        setMobile(profileResult.value.mobile);
      }
    });
    void fetchCustomerAddresses().then((addressResult) => {
      if (addressResult.kind !== "ok") return;
      setAddresses(addressResult.value);
      const defaultAddress = addressResult.value.find((candidate) => candidate.isDefault) ?? addressResult.value[0];
      if (defaultAddress !== undefined) setSavedAddressId(defaultAddress.id);
    });
  }, [session.status]);

  if (cart === null || cart.lines.length === 0) {
    return (
      <div className="store-container store-section">
        <MessageState bodyKey="checkout.emptyCart.body" titleKey="checkout.emptyCart.title" />
        <p className="store-cart__continue">
          <Link to={localePath("/")}>{t("cart.continueShopping")}</Link>
        </p>
      </div>
    );
  }

  const usingSavedAddress = session.status === "authenticated" && savedAddressId !== "";

  const buildRequestBase = () => ({
    cartLines: cart.lines.map((line) => ({
      productSlug: line.productSlug,
      quantity: line.quantity,
      selectedOptions: line.selectedOptions.map((option) => ({
        groupName: option.groupName,
        value: option.value,
      })),
    })),
    customerMobile: mobile,
    customerName: name,
    paymentMethod: "cod" as const,
    ...(usingSavedAddress
      ? { savedAddressId }
      : {
          newAddress: {
            address,
            emirate,
            ...(area.trim() === "" ? {} : { area }),
            ...(locationLink.trim() === "" ? {} : { locationLink }),
            ...(deliveryInstructions.trim() === "" ? {} : { deliveryInstructions }),
          },
        }),
    storeSlug: cart.storeSlug,
    ...(selectedDeliveryCompanyId === undefined ? {} : { selectedDeliveryCompanyId }),
  });

  const runValidate = async (companyId?: string) => {
    setError(undefined);
    setPlaceError(undefined);
    setSubmitting(true);
    if (companyId !== undefined) setSelectedDeliveryCompanyId(companyId);
    try {
      const response = await validateCheckout({
        ...buildRequestBase(),
        ...(companyId === undefined ? {} : { selectedDeliveryCompanyId: companyId }),
      });
      if (response.kind === "error") {
        setResult(undefined);
        setError(t(`checkout.errors.${response.error.errorCode}`, response.error.message));
        return;
      }
      setResult(response.value);
      setIdempotencyKey(crypto.randomUUID());
    } finally {
      setSubmitting(false);
    }
  };

  const placeOrder = async () => {
    if (result === undefined || idempotencyKey === undefined) return;
    setPlaceError(undefined);
    setPlacingOrder(true);
    try {
      const response = await placeStoreOrder({
        ...buildRequestBase(),
        expectedCodTotal: result.codTotal,
        idempotencyKey,
      });
      if (response.kind === "error") {
        if (response.error.errorCode === "checkout_changed") {
          // §69: the reviewed state is stale -- force a fresh Review rather
          // than letting the Customer retry blind against old totals. The
          // message is set on the page-level `error` (shown above the
          // form), not `placeError` (shown inside the Review section) --
          // that section is about to unmount along with `result`, and
          // would take the message down with it.
          setResult(undefined);
          setError(t("checkout.errors.checkout_changed"));
          return;
        }
        setPlaceError(t(`checkout.errors.${response.error.errorCode}`, response.error.message));
        return;
      }
      // §55: Cart clears ONLY after this success response.
      clearCart();
      navigate(localePath(`/order-confirmation/${response.value.storeOrderNumber}`), {
        state: { order: response.value },
      });
    } finally {
      setPlacingOrder(false);
    }
  };

  return (
    <div className="store-container store-section store-checkout">
      <h1 className="store-cart__title">{t("checkout.title")}</h1>

      <form
        className="store-form store-checkout__form"
        onSubmit={(event) => {
          event.preventDefault();
          void runValidate();
        }}
      >
        <section className="store-checkout__section">
          <h2>{t("checkout.contact.title")}</h2>
          <div className="store-field">
            <label htmlFor="checkout-name">{t("checkout.contact.name")}</label>
            <input
              id="checkout-name"
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </div>
          <div className="store-field">
            <label htmlFor="checkout-mobile">{t("checkout.contact.mobile")}</label>
            <input
              dir="ltr"
              id="checkout-mobile"
              onChange={(event) => setMobile(event.target.value)}
              placeholder="971501234567"
              required
              value={mobile}
            />
          </div>
        </section>

        <section className="store-checkout__section">
          <h2>{t("checkout.address.title")}</h2>
          {addresses.length === 0 ? null : (
            <div className="store-field">
              <label htmlFor="checkout-saved-address">{t("checkout.address.savedAddress")}</label>
              <select
                id="checkout-saved-address"
                onChange={(event) => setSavedAddressId(event.target.value)}
                value={savedAddressId}
              >
                {addresses.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label ?? candidate.recipientName} — {candidate.area ?? candidate.emirate}
                  </option>
                ))}
                <option value="">{t("checkout.address.useNewAddress")}</option>
              </select>
            </div>
          )}
          {usingSavedAddress ? null : (
            <>
              <div className="store-field">
                <label htmlFor="checkout-emirate">{t("checkout.address.emirate")}</label>
                <input
                  id="checkout-emirate"
                  onChange={(event) => setEmirate(event.target.value)}
                  required
                  value={emirate}
                />
              </div>
              <div className="store-field">
                <label htmlFor="checkout-area">{t("checkout.address.area")}</label>
                <input id="checkout-area" onChange={(event) => setArea(event.target.value)} value={area} />
              </div>
              <div className="store-field">
                <label htmlFor="checkout-address">{t("checkout.address.address")}</label>
                <input
                  id="checkout-address"
                  onChange={(event) => setAddress(event.target.value)}
                  required
                  value={address}
                />
              </div>
              <div className="store-field">
                <label htmlFor="checkout-location-link">{t("checkout.address.locationLink")}</label>
                <input
                  dir="ltr"
                  id="checkout-location-link"
                  onChange={(event) => setLocationLink(event.target.value)}
                  value={locationLink}
                />
              </div>
              <div className="store-field">
                <label htmlFor="checkout-instructions">{t("checkout.address.instructions")}</label>
                <input
                  id="checkout-instructions"
                  onChange={(event) => setDeliveryInstructions(event.target.value)}
                  value={deliveryInstructions}
                />
              </div>
            </>
          )}
        </section>

        {error === undefined ? null : (
          <p className="store-form-error" role="alert">
            {error}
          </p>
        )}

        <button className="store-button store-button--onnavy" disabled={submitting} type="submit">
          {submitting ? t("common.loading") : t("checkout.reviewOrder")}
        </button>
      </form>

      {result === undefined ? null : (
        <CheckoutReview
          onPlaceOrder={() => void placeOrder()}
          onSelectCompany={(id) => void runValidate(id)}
          placeError={placeError}
          placing={placingOrder}
          result={result}
        />
      )}
    </div>
  );
}

function CheckoutReview({
  onPlaceOrder,
  onSelectCompany,
  placeError,
  placing,
  result,
}: {
  readonly onPlaceOrder: () => void;
  readonly onSelectCompany: (companyId: string) => void;
  readonly placeError: string | undefined;
  readonly placing: boolean;
  readonly result: CheckoutResult;
}) {
  const { t } = useTranslation();
  const currency = "AED";

  return (
    <section aria-live="polite" className="store-checkout__review">
      <h2>{t("checkout.review.title")}</h2>

      <ul className="store-checkout__reviewlines">
        {result.lines.map((line) => (
          <li className="store-checkout__reviewline" key={line.productSlug}>
            <TraderText as="span" value={line.productName} />
            {line.selectedOptions.length === 0 ? null : (
              <span className="store-cart__lineoptions">
                {" "}
                {line.selectedOptions.map((option) => `${option.groupName}: ${option.value}`).join(" · ")}
              </span>
            )}
            {line.valid ? (
              <Money amount={line.lineSubtotal} className="store-price" currency={currency} />
            ) : (
              <span className="store-alert store-alert--warning" role="alert">
                {line.issue}
              </span>
            )}
          </li>
        ))}
      </ul>

      {result.validationWarnings.length === 0 ? null : (
        <p className="store-alert store-alert--warning" role="alert">
          {result.validationWarnings.join(" ")}
        </p>
      )}

      <div className="store-checkout__reviewrow">
        <span>{t("checkout.review.productSubtotal")}</span>
        <Money amount={result.productSubtotal} className="store-price" currency={currency} />
      </div>

      {result.deliveryOptions.length > 1 ? (
        <div className="store-field">
          <label htmlFor="checkout-delivery-company">{t("checkout.delivery.chooseCompany")}</label>
          <select
            id="checkout-delivery-company"
            onChange={(event) => onSelectCompany(event.target.value)}
            value={result.selectedDeliveryCompany?.companyId ?? ""}
          >
            {result.deliveryOptions.map((option) => (
              <option key={option.companyId} value={option.companyId}>
                {option.name} — {currency} {option.customerDeliveryFee}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {result.zeroCompanyMessage === null ? (
        <div className="store-checkout__reviewrow">
          <span>{t("checkout.review.deliveryFee")}</span>
          <Money amount={result.customerDeliveryFee} className="store-price" currency={currency} />
        </div>
      ) : (
        <p className="store-note">{result.zeroCompanyMessage}</p>
      )}

      <div className="store-checkout__reviewrow store-checkout__reviewrow--total">
        <span>{t("checkout.review.codTotal")}</span>
        <Money amount={result.codTotal} className="store-price store-price--lg" currency={currency} />
      </div>

      {result.canProceed ? (
        <p className="store-note store-note--action">{t("checkout.review.readyForHandoff")}</p>
      ) : (
        <p className="store-alert store-alert--warning" role="alert">
          {t("checkout.review.notReady")}
        </p>
      )}

      {placeError === undefined ? null : (
        <p className="store-form-error" role="alert">
          {placeError}
        </p>
      )}

      <button
        aria-busy={placing}
        className="store-button store-button--onnavy"
        disabled={!result.canProceed || placing}
        onClick={onPlaceOrder}
        type="button"
      >
        {placing ? t("checkout.placingOrder") : t("checkout.placeOrder")}
      </button>
    </section>
  );
}
