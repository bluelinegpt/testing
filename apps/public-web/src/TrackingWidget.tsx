import { useState, type FormEvent } from "react";
import { trackEvent } from "./analytics";
import { publicUi, usePublicLocale } from "./public-localization";
import {
  lookupByAirwayBill,
  verifyAmbiguousShipment,
  TrackingRequestError,
  type PublicTrackingResult,
} from "./tracking-client";

type Step = "input" | "verify" | "result" | "not_found" | "support";

/**
 * The one shared tracking flow -- both the Homepage compact widget and the
 * full /track page render this component (with `compact` only affecting
 * layout/copy density), and both call the exact same
 * lookupByAirwayBill/verifyAmbiguousShipment functions, which in turn call
 * the exact same PublicTrackingService the Yousef agent calls. No second
 * tracking implementation anywhere on the website.
 */
export function TrackingWidget({ compact = false }: { compact?: boolean }) {
  const locale = usePublicLocale();
  const t = publicUi[locale];
  const [step, setStep] = useState<Step>("input");
  const [airwayBill, setAirwayBill] = useState("");
  const [mobile, setMobile] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [result, setResult] = useState<PublicTrackingResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const surface = compact ? "homepage" : "track_page";

  const reset = () => {
    setStep("input");
    setAirwayBill("");
    setMobile("");
    setVerificationToken("");
    setResult(null);
    setError("");
  };

  const submitAirwayBill = async (event: FormEvent) => {
    event.preventDefault();
    if (!airwayBill.trim() || busy) return;
    setBusy(true);
    setError("");
    trackEvent("tracking_started", { locale, surface });
    try {
      const outcome = await lookupByAirwayBill(airwayBill.trim(), locale);
      if (outcome.result === "verified") {
        setResult(outcome.tracking);
        setStep("result");
        trackEvent("tracking_success", { locale, surface });
      } else if (outcome.result === "verification_required") {
        setVerificationToken(outcome.verificationToken);
        setStep("verify");
        trackEvent("tracking_verification_required", { locale, surface });
      } else {
        setStep("not_found");
        trackEvent("tracking_failed", { locale, surface, outcome: "not_found" });
      }
    } catch (err) {
      setError(err instanceof TrackingRequestError ? err.message : t.trackingErrorGeneric);
    } finally {
      setBusy(false);
    }
  };

  const submitMobile = async (event: FormEvent) => {
    event.preventDefault();
    if (!mobile.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const outcome = await verifyAmbiguousShipment(verificationToken, mobile.trim(), locale);
      if (outcome.result === "verified") {
        setResult(outcome.tracking);
        setStep("result");
        trackEvent("tracking_success", { locale, surface });
      } else if (outcome.result === "ambiguous") {
        setStep("support");
        trackEvent("tracking_failed", { locale, surface, outcome: "ambiguous" });
      } else {
        setError(t.trackingNotVerified);
        trackEvent("tracking_failed", { locale, surface, outcome: "not_verified" });
      }
    } catch (err) {
      setError(err instanceof TrackingRequestError ? err.message : t.trackingErrorGeneric);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`tracking-widget ${compact ? "tracking-widget--compact" : ""}`}
      dir={locale === "ar" ? "rtl" : "ltr"}
    >
      {step === "input" && (
        <form className="tracking-form" onSubmit={submitAirwayBill}>
          <label htmlFor="tracking-awb">{t.trackingInputLabel}</label>
          <div className="tracking-form-row">
            <input
              id="tracking-awb"
              dir="ltr"
              value={airwayBill}
              onChange={(event) => setAirwayBill(event.target.value)}
              placeholder={t.trackingInputPlaceholder}
              autoComplete="off"
            />
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? t.trackingChecking : t.trackingSubmitCta}
            </button>
          </div>
          {error && (
            <p className="tracking-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}

      {step === "verify" && (
        <form className="tracking-form" onSubmit={submitMobile}>
          <p className="tracking-verify-title">{t.trackingVerifyTitle}</p>
          <p className="tracking-verify-intro">{t.trackingVerifyIntro}</p>
          <label htmlFor="tracking-mobile">{t.trackingMobileLabel}</label>
          <div className="tracking-form-row">
            <input
              id="tracking-mobile"
              dir="ltr"
              inputMode="tel"
              value={mobile}
              onChange={(event) => setMobile(event.target.value)}
              placeholder={t.trackingMobilePlaceholder}
              autoComplete="off"
            />
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? t.trackingChecking : t.trackingVerifyCta}
            </button>
          </div>
          {error && (
            <p className="tracking-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="text-link tracking-back" onClick={reset}>
            {t.trackingBack}
          </button>
        </form>
      )}

      {step === "not_found" && (
        <div className="tracking-message">
          <p>{t.trackingNotFound}</p>
          <button type="button" className="button button-secondary" onClick={reset}>
            {t.trackingTrackAnother}
          </button>
        </div>
      )}

      {step === "support" && (
        <div className="tracking-message">
          <p>{t.trackingSupport}</p>
          <div className="tracking-message-actions">
            <a className="button button-secondary" href="/contact">
              {t.trackingContactSupport}
            </a>
            <button type="button" className="text-link tracking-back" onClick={reset}>
              {t.trackingTrackAnother}
            </button>
          </div>
        </div>
      )}

      {step === "result" && result && (
        <div className="tracking-result">
          <div className="tracking-result-grid">
            <TrackingLine label={t.trackingAirwayBillLabel} value={result.airwayBill} ltr />
            <TrackingLine label={t.trackingStatusLabel} value={result.statusLabel} />
            <TrackingLine
              label={t.trackingLastUpdatedLabel}
              value={formatTrackingDate(result.lastUpdated, locale)}
            />
            {result.deliveredAt && (
              <TrackingLine
                label={t.trackingDeliveredAtLabel}
                value={formatTrackingDate(result.deliveredAt, locale)}
              />
            )}
          </div>
          {result.timeline.length > 0 && !compact && (
            <div className="tracking-timeline">
              <p className="tracking-timeline-title">{t.trackingTimelineTitle}</p>
              <ol>
                {result.timeline.map((step, index) => (
                  <li key={`${step.status}-${index}`}>
                    <span className="tracking-timeline-status">{step.statusLabel}</span>
                    <span className="tracking-timeline-date">
                      {formatTrackingDate(step.occurredAt, locale)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <button type="button" className="button button-secondary" onClick={reset}>
            {t.trackingTrackAnother}
          </button>
        </div>
      )}
    </div>
  );
}

function TrackingLine({
  label,
  value,
  ltr = false,
}: {
  label: string;
  value: string;
  ltr?: boolean;
}) {
  return (
    <div className="tracking-line">
      <span>{label}</span>
      <strong dir={ltr ? "ltr" : undefined}>{value}</strong>
    </div>
  );
}

function formatTrackingDate(value: string, locale: "en" | "ar"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-AE" : "en-AE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Dubai",
  }).format(date);
}

export function TrackingPage() {
  const locale = usePublicLocale();
  const t = publicUi[locale];
  return (
    <section className="inner-hero tracking-page" dir={locale === "ar" ? "rtl" : "ltr"}>
      <p className="eyebrow">
        <span />
        {t.trackingEyebrow}
      </p>
      <h1>{t.trackingPageTitle}</h1>
      <p>{t.trackingPageIntro}</p>
      <div className="tracking-page-card">
        <TrackingWidget />
      </div>
      <p className="tracking-privacy-note">{t.trackingPrivacyNote}</p>
    </section>
  );
}
