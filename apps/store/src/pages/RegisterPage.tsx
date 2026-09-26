import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import { registerCustomer } from "../api/customer-auth-client.js";
import { useCustomerSession } from "../auth/customer-session-context.js";
import { useLocalePath } from "../routing/locale-routing.js";

/** §17/§45/§46: real Customer registration, replacing the reserved placeholder. */
export function RegisterPage() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const navigate = useNavigate();
  const { setSession } = useCustomerSession();

  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (password !== confirmPassword) {
      setError(t("auth.errors.passwordMismatch"));
      return;
    }
    if (!acceptedTerms) return;
    setSubmitting(true);
    try {
      const result = await registerCustomer({
        acceptedTerms: true,
        mobile,
        name,
        password,
        ...(email.trim() === "" ? {} : { email: email.trim() }),
      });
      if (result.kind === "error") {
        setError(t(`auth.errors.${result.error.errorCode}`, result.error.message));
        return;
      }
      setSession(result.value);
      navigate(localePath("/account"), { replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="store-container store-auth-page">
      <div className="store-auth-card">
        <h1>{t("auth.registerTitle")}</h1>
        <p className="store-auth-card__lead">{t("auth.registerLead")}</p>
        {error === undefined ? null : (
          <p className="store-form-error" role="alert">
            {error}
          </p>
        )}
        <form className="store-form" onSubmit={(event) => void submit(event)}>
          <div className="store-field">
            <label htmlFor="register-name">{t("auth.name")}</label>
            <input
              autoComplete="name"
              id="register-name"
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </div>
          <div className="store-field">
            <label htmlFor="register-mobile">{t("auth.mobile")}</label>
            <input
              autoComplete="tel"
              dir="ltr"
              id="register-mobile"
              onChange={(event) => setMobile(event.target.value)}
              placeholder="050 xxx xxxx"
              required
              value={mobile}
            />
          </div>
          <div className="store-field">
            <label htmlFor="register-email">{t("auth.email")}</label>
            <input
              autoComplete="email"
              dir="ltr"
              id="register-email"
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </div>
          <div className="store-field">
            <label htmlFor="register-password">{t("auth.password")}</label>
            <input
              autoComplete="new-password"
              id="register-password"
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </div>
          <div className="store-field">
            <label htmlFor="register-confirm-password">{t("auth.confirmPassword")}</label>
            <input
              autoComplete="new-password"
              id="register-confirm-password"
              minLength={8}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              type="password"
              value={confirmPassword}
            />
          </div>
          <div className="store-field store-field--checkbox">
            <input
              checked={acceptedTerms}
              id="register-terms"
              onChange={(event) => setAcceptedTerms(event.target.checked)}
              required
              type="checkbox"
            />
            <label htmlFor="register-terms">{t("auth.termsAcceptance")}</label>
          </div>
          <button className="store-button store-button--onnavy" disabled={submitting} type="submit">
            {submitting ? t("common.loading") : t("auth.createAccount")}
          </button>
        </form>
        <p className="store-auth-card__footer">
          {t("auth.haveAccount")} <Link to={localePath("/login")}>{t("auth.login")}</Link>
        </p>
      </div>
    </div>
  );
}
