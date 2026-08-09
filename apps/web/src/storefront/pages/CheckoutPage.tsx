import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

import { CheckoutField } from "../components/CheckoutField.js";
import { OrderSummary } from "../components/OrderSummary.js";
import { useStore } from "../StoreContext.js";
import type { CartLine, CheckoutDetails } from "../types.js";

const emirates = [
  "Abu Dhabi",
  "Dubai",
  "Sharjah",
  "Ajman",
  "Umm Al Quwain",
  "Ras Al Khaimah",
  "Fujairah",
];

const timeWindows = ["Morning (9 AM – 1 PM)", "Afternoon (1 PM – 6 PM)", "Evening (6 PM – 10 PM)"];

/**
 * Guest checkout — no registration, no login, and Cash on Delivery as the ONLY
 * payment method on screen. Validation is local and for demonstration only;
 * nothing is persisted anywhere (including browser storage) — the details live
 * in React state for the review step and vanish on refresh, which is correct
 * for a prototype holding sample personal data.
 */
export function CheckoutPage({
  details,
  lines,
  onSubmit,
}: {
  readonly details: CheckoutDetails;
  readonly lines: readonly CartLine[];
  readonly onSubmit: (details: CheckoutDetails) => void;
}) {
  const navigate = useNavigate();
  const { base } = useStore();
  const [draft, setDraft] = useState<CheckoutDetails>(details);
  const [errors, setErrors] = useState<Partial<Record<keyof CheckoutDetails, string>>>({});

  const set = (key: keyof CheckoutDetails) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: Partial<Record<keyof CheckoutDetails, string>> = {};
    if (draft.fullName.trim().length < 3) next.fullName = "Please enter your full name.";
    if (!/^(\+971|0)?5\d{8}$/.test(draft.mobile.replaceAll(/[\s-]/g, ""))) {
      next.mobile = "Please enter a valid UAE mobile number, e.g. 050 123 4567.";
    }
    if (draft.emirate === "") next.emirate = "Please choose your Emirate.";
    if (draft.area.trim() === "") next.area = "Please enter your area.";
    if (draft.address.trim().length < 8) {
      next.address = "Please enter your full delivery address.";
    }
    if (draft.building.trim() === "") next.building = "Please enter your building or villa.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onSubmit(draft);
    navigate(`${base}/review`);
  };

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "6px 0 16px" }}>Checkout</h1>
      <div className="sf-cart-layout">
        <form className="sf-form-grid" noValidate onSubmit={submit}>
          <h2 style={{ fontSize: "1.05rem" }}>Your details</h2>
          <CheckoutField error={errors.fullName} id="sf-name" label="Full name">
            {(props) => (
              <input
                {...props}
                autoComplete="name"
                onChange={(event) => set("fullName")(event.currentTarget.value)}
                value={draft.fullName}
              />
            )}
          </CheckoutField>
          <CheckoutField error={errors.mobile} id="sf-mobile" label="UAE mobile number">
            {(props) => (
              <input
                {...props}
                autoComplete="tel"
                dir="ltr"
                inputMode="tel"
                onChange={(event) => set("mobile")(event.currentTarget.value)}
                placeholder="050 123 4567"
                value={draft.mobile}
              />
            )}
          </CheckoutField>

          <h2 style={{ fontSize: "1.05rem", marginTop: 8 }}>Delivery address</h2>
          <CheckoutField error={errors.emirate} id="sf-emirate" label="Emirate">
            {(props) => (
              <select
                {...props}
                onChange={(event) => set("emirate")(event.currentTarget.value)}
                value={draft.emirate}
              >
                <option value="">Choose an Emirate…</option>
                {emirates.map((emirate) => (
                  <option key={emirate} value={emirate}>
                    {emirate}
                  </option>
                ))}
              </select>
            )}
          </CheckoutField>
          <CheckoutField error={errors.area} id="sf-area" label="Area">
            {(props) => (
              <input
                {...props}
                onChange={(event) => set("area")(event.currentTarget.value)}
                placeholder="e.g. Al Barsha 1"
                value={draft.area}
              />
            )}
          </CheckoutField>
          <CheckoutField error={errors.address} id="sf-address" label="Full delivery address">
            {(props) => (
              <textarea
                {...props}
                onChange={(event) => set("address")(event.currentTarget.value)}
                placeholder="Street, landmark, directions…"
                value={draft.address}
              />
            )}
          </CheckoutField>
          <CheckoutField error={errors.building} id="sf-building" label="Building or villa">
            {(props) => (
              <input
                {...props}
                onChange={(event) => set("building")(event.currentTarget.value)}
                value={draft.building}
              />
            )}
          </CheckoutField>
          <CheckoutField id="sf-unit" label="Apartment or unit" optional>
            {(props) => (
              <input
                {...props}
                onChange={(event) => set("unit")(event.currentTarget.value)}
                value={draft.unit}
              />
            )}
          </CheckoutField>
          <CheckoutField id="sf-delivery-notes" label="Delivery notes" optional>
            {(props) => (
              <input
                {...props}
                onChange={(event) => set("deliveryNotes")(event.currentTarget.value)}
                placeholder="e.g. call before arriving"
                value={draft.deliveryNotes}
              />
            )}
          </CheckoutField>

          <h2 style={{ fontSize: "1.05rem", marginTop: 8 }}>Delivery preference</h2>
          <CheckoutField id="sf-date" label="Preferred delivery date" optional>
            {(props) => (
              <input
                {...props}
                dir="ltr"
                onChange={(event) => set("preferredDate")(event.currentTarget.value)}
                type="date"
                value={draft.preferredDate}
              />
            )}
          </CheckoutField>
          <CheckoutField id="sf-time" label="Preferred delivery time" optional>
            {(props) => (
              <select
                {...props}
                onChange={(event) => set("preferredTime")(event.currentTarget.value)}
                value={draft.preferredTime}
              >
                <option value="">Any time</option>
                {timeWindows.map((window) => (
                  <option key={window} value={window}>
                    {window}
                  </option>
                ))}
              </select>
            )}
          </CheckoutField>
          <CheckoutField id="sf-order-notes" label="Order notes" optional>
            {(props) => (
              <textarea
                {...props}
                onChange={(event) => set("orderNotes")(event.currentTarget.value)}
                value={draft.orderNotes}
              />
            )}
          </CheckoutField>

          <h2 style={{ fontSize: "1.05rem", marginTop: 8 }}>Payment method</h2>
          {/* COD is the only method — stated as a fact, not offered as a choice. */}
          <div className="sf-payment-box">
            <span aria-hidden="true" style={{ fontSize: "1.5rem" }}>
              💵
            </span>
            <div>
              <strong>Cash on Delivery</strong>
              <p style={{ color: "var(--sf-muted)", fontSize: "0.85rem", margin: 0 }}>
                Pay the driver in cash when your order arrives. No online payment is required.
              </p>
            </div>
          </div>

          <button className="sf-button sf-button-block" type="submit">
            Review Order
          </button>
        </form>
        <OrderSummary lines={lines} />
      </div>
    </>
  );
}
