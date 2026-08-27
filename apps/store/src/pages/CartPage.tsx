import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { fetchStoreProduct } from "../api/commerce-client.js";
import { useCart } from "../cart/cart-context.js";
import type { CartLine } from "../cart/cart-types.js";
import { Money, TraderText } from "../components/Bidi.js";
import { MessageState } from "../components/States.js";
import { useLocalePath } from "../routing/locale-routing.js";

/**
 * `/cart` — the Cart page (Customer Commerce Prompt C1, Part D).
 *
 * Shows Product Subtotal only (§21) -- no delivery fee, no COD fee, no grand
 * total. Those require an authoritative price re-read this app does not do
 * yet (C2 Checkout). Every number here is the Cart's own DISPLAY snapshot,
 * never re-priced by this page.
 *
 * On mount, each distinct Product in the Cart is re-fetched once (§42-45):
 * a Product that has gone inactive, become unavailable, or dropped a
 * selected option value is marked on its line rather than silently kept as
 * if still purchasable. This is the full extent of C1's revalidation --
 * there is no Checkout yet to hand a clean Cart to, so this only has to
 * make the CURRENT state honest, not final.
 */
export function CartPage() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const { cart, clearCart, itemCount, removeLine, replaceLine, setQuantity } = useCart();
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    if (cart === null) return;
    const controller = new AbortController();
    for (const line of cart.lines) {
      void revalidateLine(cart.storeSlug, line, controller.signal).then((result) => {
        if (controller.signal.aborted || result === undefined) return;
        replaceLine(line.lineKey, result);
      });
    }
    return () => controller.abort();
    // Revalidate once per Cart identity change (lines array reference), not
    // on every render -- `replaceLine` itself changes that reference, so this
    // intentionally does not loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart?.storeSlug, cart?.lines.length]);

  if (cart === null || cart.lines.length === 0) {
    return (
      <div className="store-container store-section">
        <MessageState bodyKey="cart.empty.body" titleKey="cart.empty.title" />
        <p className="store-cart__continue">
          <Link to={localePath("/")}>{t("cart.continueShopping")}</Link>
        </p>
      </div>
    );
  }

  const subtotal = cart.lines.reduce(
    (total, line) => total + Number(line.unitPrice) * line.quantity,
    0,
  );

  return (
    <div className="store-container store-section">
      <h1 className="store-cart__title">{t("cart.title")}</h1>
      <p className="store-cart__store">
        <Link to={localePath(`/${cart.storeSlug}`)}>
          <TraderText value={cart.storeDisplayName} />
        </Link>
      </p>

      <ul className="store-cart__lines">
        {cart.lines.map((line) => (
          <li className="store-cart__line" key={line.lineKey}>
            <div className="store-cart__lineimage">
              {line.imageUrl === null ? (
                <div className="store-gallery__empty" />
              ) : (
                <img alt="" src={line.imageUrl} />
              )}
            </div>
            <div className="store-cart__linebody">
              <TraderText as="p" className="store-cart__linename" value={line.productName} />
              {line.selectedOptions.length === 0 ? null : (
                <p className="store-cart__lineoptions">
                  {line.selectedOptions
                    .map((option) => `${option.groupName}: ${option.value}`)
                    .join(" · ")}
                </p>
              )}
              {line.invalidReason === null ? null : (
                <p className="store-alert store-alert--warning store-cart__lineinvalid" role="alert">
                  {t(`cart.lineUnavailable.${line.invalidReason}`)}
                </p>
              )}
              <div className="store-quantity">
                <button
                  aria-label={t("cart.decreaseQuantity")}
                  disabled={line.quantity <= (line.minimumQuantity ?? 1)}
                  onClick={() =>
                    setQuantity(line.lineKey, Math.max(line.minimumQuantity ?? 1, line.quantity - 1))
                  }
                  type="button"
                >
                  −
                </button>
                <span role="status">{line.quantity}</span>
                <button
                  aria-label={t("cart.increaseQuantity")}
                  disabled={line.maximumQuantity !== null && line.quantity >= line.maximumQuantity}
                  onClick={() => setQuantity(line.lineKey, line.quantity + 1)}
                  type="button"
                >
                  +
                </button>
              </div>
            </div>
            <div className="store-cart__lineprice">
              <Money amount={line.unitPrice} className="store-price" currency={cart.currency} />
              <Money
                amount={(Number(line.unitPrice) * line.quantity).toFixed(2)}
                className="store-cart__linesubtotal"
                currency={cart.currency}
              />
              <button
                aria-label={t("cart.removeLine", { product: line.productName })}
                className="store-cart__remove"
                onClick={() => removeLine(line.lineKey)}
                type="button"
              >
                {t("cart.remove")}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="store-cart__summary">
        <div className="store-cart__summaryrow">
          <span>{t("cart.productSubtotal")}</span>
          <Money amount={subtotal.toFixed(2)} className="store-price store-price--lg" currency={cart.currency} />
        </div>
        <p className="store-cart__itemcount">
          {t("cart.itemCount", { count: itemCount })}
        </p>
        <Link className="store-button store-button--onnavy" to={localePath("/checkout")}>
          {t("cart.proceedToCheckout")}
        </Link>
      </div>

      <div className="store-cart__actions">
        <Link to={localePath("/")}>{t("cart.continueShopping")}</Link>
        {confirmingClear ? (
          <span className="store-cart__clearconfirm">
            {t("cart.clearCartConfirm")}{" "}
            <button
              onClick={() => {
                clearCart();
                setConfirmingClear(false);
              }}
              type="button"
            >
              {t("cart.clearCart")}
            </button>
            <button onClick={() => setConfirmingClear(false)} type="button">
              {t("cart.storeReplaceCancel")}
            </button>
          </span>
        ) : (
          <button
            className="store-button store-button--quiet"
            onClick={() => setConfirmingClear(true)}
            type="button"
          >
            {t("cart.clearCart")}
          </button>
        )}
      </div>
    </div>
  );
}

async function revalidateLine(
  storeSlug: string,
  line: CartLine,
  signal: AbortSignal,
): Promise<CartLine | undefined> {
  const result = await fetchStoreProduct(storeSlug, line.productSlug, signal);
  if (signal.aborted) return undefined;
  if (result.kind === "error") {
    // "unavailable" here means the API/network failed, not the Product --
    // a transient failure is not evidence the Product is gone, so the line
    // is left as it was rather than punished for a network blip.
    if (result.reason === "not_found") {
      return line.invalidReason === "product_inactive"
        ? undefined
        : { ...line, invalidReason: "product_inactive" };
    }
    return undefined;
  }
  const product = result.value;
  if (product.availabilityStatus !== "available") {
    return line.invalidReason === "product_unavailable"
      ? undefined
      : { ...line, invalidReason: "product_unavailable" };
  }
  const optionStillValid = line.selectedOptions.every((selected) => {
    const group = product.options.find((candidate) => candidate.name === selected.groupName);
    if (group === undefined) return false;
    return group.values.some((value) => value.value === selected.value && value.isActive);
  });
  if (!optionStillValid) {
    return line.invalidReason === "option_removed" ? undefined : { ...line, invalidReason: "option_removed" };
  }
  return line.invalidReason === null ? undefined : { ...line, invalidReason: null };
}
