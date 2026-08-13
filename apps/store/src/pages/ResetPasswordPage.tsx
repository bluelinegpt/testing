import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";

import { completeCustomerPasswordReset } from "../api/customer-auth-client.js";
import { useLocalePath } from "../routing/locale-routing.js";

/**
 * §41/§49: completes a Customer password reset.
 *
 * The token travels only in the URL's query string (`?token=…`, from the
 * link a reset email/SMS would eventually carry) -- never written to
 * `localStorage`/`sessionStorage`, and dropped from memory the moment this
 * component unmounts.
 */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (newPassword !== confirmPassword) {
      setError(t("auth.errors.passwordMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      const result = await completeCustomerPasswordReset({ newPassword, token });
      if (result.kind === "error") {
        setError(t(`auth.errors.${result.error.errorCode}`, result.error.message));
        return;
      }
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="store-container store-auth-page">
      <div className="store-auth-card">
        <h1>{t("auth.completeReset")}</h1>
        {done ? (
          <p className="store-form-success" role="status">
            {t("auth.resetSuccess")}
          </p>
        ) : token === "" ? (
          <p className="store-form-error" role="alert">
            {t("auth.errors.password_reset_token_invalid")}
          </p>
        ) : (
          <>
            <p className="store-auth-card__lead">{t("auth.resetLead")}</p>
            {error === undefined ? null : (
              <p className="store-form-error" role="alert">
                {error}
              </p>
            )}
            <form className="store-form" onSubmit={(event) => void submit(event)}>
              <div className="store-field">
                <label htmlFor="reset-new-password">{t("auth.newPassword")}</label>
                <input
                  autoComplete="new-password"
                  id="reset-new-password"
                  minLength={8}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                  type="password"
                  value={newPassword}
                />
              </div>
              <div className="store-field">
                <label htmlFor="reset-confirm-password">{t("auth.confirmPassword")}</label>
                <input
                  autoComplete="new-password"
                  id="reset-confirm-password"
                  minLength={8}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  type="password"
                  value={confirmPassword}
                />
              </div>
              <button className="store-button store-button--onnavy" disabled={submitting} type="submit">
                {submitting ? t("common.loading") : t("auth.completeReset")}
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
