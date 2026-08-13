import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { type TrackingResult, trackStoreOrder } from "../api/customer-orders-client.js";
import { CodeText, LabelledValue, Money, TraderText } from "../components/Bidi.js";
import { orderStatusLabel, orderStatusTone } from "../localization/order-status.js";
import { useLocalePath } from "../routing/locale-routing.js";

/**
 * §31-34: `/track` -- public, unauthenticated. Order number, mobile and
 * tracking token together (§22/§23); a wrong combination of any of the three
 * shows the exact same generic message (§34), never which field was wrong.
 */
export function TrackPage() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const [storeOrderNumber, setStoreOrderNumber] = useState("");
  const [mobile, setMobile] = useState("");
  const [trackingToken, setTrackingToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [result, setResult] = useState<TrackingResult>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setInvalid(false);
    setResult(undefined);
    setSubmitting(true);
    try {
      const response = await trackStoreOrder({
        mobile,
        storeOrderNumber: storeOrderNumber.trim(),
        trackingToken: trackingToken.trim(),
      });
      if (response.kind === "error") {
        setInvalid(true);
        return;
      }
      setResult(response.value);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="store-container store-track">
      <h1>{t("tracking.title")}</h1>
      <p>{t("tracking.lead")}</p>

      <form className="store-form" onSubmit={(event) => void submit(event)}>
        <div className="store-field">
          <label htmlFor="track-order-number">{t("tracking.orderNumber")}</label>
          <input
            dir="ltr"
            id="track-order-number"
            onChange={(event) => setStoreOrderNumber(event.target.value)}
            required
            value={storeOrderNumber}
          />
        </div>
        <div className="store-field">
          <label htmlFor="track-mobile">{t("tracking.mobile")}</label>
          <input
            dir="ltr"
            id="track-mobile"
            onChange={(event) => setMobile(event.target.value)}
            required
            value={mobile}
          />
        </div>
        <div className="store-field">
          <label htmlFor="track-token">{t("tracking.token")}</label>
          <input
            dir="ltr"
            id="track-token"
            onChange={(event) => setTrackingToken(event.target.value)}
            required
            value={trackingToken}
          />
        </div>
        {invalid ? (
          <p className="store-form-error" role="alert">
            {t("tracking.invalid")}
          </p>
        ) : null}
        <button className="store-button store-button--onnavy" disabled={submitting} type="submit">
          {submitting ? t("tracking.submitting") : t("tracking.submit")}
        </button>
      </form>

      {result === undefined ? null : <TrackingResultCard localePath={localePath} result={result} />}
    </div>
  );
}

function TrackingResultCard({
  localePath,
  result,
}: {
  readonly localePath: (path: string) => string;
  readonly result: TrackingResult;
}) {
  const { t } = useTranslation();
  return (
    <section className="store-account-section store-track__result">
      <div className="store-order-card__row">
        <h2>
          <CodeText value={result.storeOrderNumber} />
        </h2>
        <span className={`store-badge store-badge--${orderStatusTone(result.status)}`}>
          {orderStatusLabel(t, result.status)}
        </span>
      </div>
      <p dir="ltr">{new Date(result.createdAt).toLocaleString()}</p>
      <Link to={localePath(`/${result.storeSlug}`)}>
        <TraderText value={result.storeDisplayName} />
      </Link>

      <dl className="store-facts">
        <LabelledValue
          label={t("orders.items")}
          value={t("orders.itemCount", { count: result.items.length })}
        />
        <LabelledValue
          label={t("orders.codTotal")}
          value={<Money amount={result.codTotal} currency="AED" />}
        />
        {result.deliveryCompanyName === null ? null : (
          <LabelledValue label={t("orders.deliveryCompany")} value={result.deliveryCompanyName} />
        )}
        {result.deliverySummary === null ? null : (
          <LabelledValue label={t("orders.deliveryStatus")} value={result.deliverySummary.deliveryStatus} />
        )}
      </dl>
    </section>
  );
}
