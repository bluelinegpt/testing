import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { requestCustomerPasswordReset } from "../api/customer-auth-client.js";
import { useLocalePath } from "../routing/locale-routing.js";

/**
 * §38/§48: enumeration-safe reset request.
 *
 * The success message is shown for EVERY submission that reaches the
 * server, regardless of whether the identifier matched an account -- the
 * API itself already returns the same `{acknowledged:true}` shape either
 * way (§35), so there is no branch here that could leak existence.
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const localePath = useLocalePath();

  const [identifier, setIdentifier] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      const result = await requestCustomerPasswordReset(identifier);
      if (result.kind === "error") {
        setError(t(`auth.errors.${result.error.errorCode}`, result.error.message));
        return;
      }
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="store-container store-auth-page">
      <div className="store-auth-card">
        <h1>{t("auth.forgotPasswordTitle")}</h1>
        <p className="store-auth-card__lead">{t("auth.forgotPasswordLead")}</p>
        {sent ? (
          <p className="store-form-success" role="status">
            {t("auth.resetLinkSent")}
          </p>
        ) : (
          <>
            {error === undefined ? null : (
              <p className="store-form-error" role="alert">
                {error}
              </p>
            )}
            <form className="store-form" onSubmit={(event) => void submit(event)}>
              <div className="store-field">
                <label htmlFor="forgot-identifier">{t("auth.identifier")}</label>
                <input
                  autoComplete="username"
                  dir="ltr"
                  id="forgot-identifier"
                  onChange={(event) => setIdentifier(event.target.value)}
                  required
                  value={identifier}
                />
              </div>
              <button className="store-button store-button--onnavy" disabled={submitting} type="submit">
                {submitting ? t("common.loading") : t("auth.submitReset")}
              </button>
            </form>
          </>
        )}
        <p className="store-auth-card__footer">
          <Link to={localePath("/login")}>{t("auth.login")}</Link>
        </p>
      </div>
    </div>
  );
}
