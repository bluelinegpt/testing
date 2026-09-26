import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { loginCustomer } from "../api/customer-auth-client.js";
import { useCustomerSession } from "../auth/customer-session-context.js";
import { useLocalePath } from "../routing/locale-routing.js";

/**
 * §23/§47: real Customer sign-in.
 *
 * §36 -- `returnTo` is only ever a same-origin, relative Store path. A
 * value that looks like an absolute or protocol-relative URL
 * (`https://…`, `//…`) is rejected outright rather than trusted, which is
 * the entire open-redirect defence: nothing here ever calls
 * `window.location.href = returnTo`, only React Router's `navigate()` with
 * a value already confirmed to start with a single `/`.
 */
function safeReturnTo(raw: string | null, fallback: string): string {
  if (raw === null) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}

export function LoginPage() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setSession } = useCustomerSession();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      const result = await loginCustomer({ identifier, password });
      if (result.kind === "error") {
        setError(t(`auth.errors.${result.error.errorCode}`, result.error.message));
        return;
      }
      setSession(result.value);
      navigate(safeReturnTo(searchParams.get("returnTo"), localePath("/account")), { replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="store-container store-auth-page">
      <div className="store-auth-card">
        <h1>{t("auth.loginTitle")}</h1>
        {error === undefined ? null : (
          <p className="store-form-error" role="alert">
            {error}
          </p>
        )}
        <form className="store-form" onSubmit={(event) => void submit(event)}>
          <div className="store-field">
            <label htmlFor="login-identifier">{t("auth.identifier")}</label>
            <input
              autoComplete="username"
              dir="ltr"
              id="login-identifier"
              onChange={(event) => setIdentifier(event.target.value)}
              required
              value={identifier}
            />
          </div>
          <div className="store-field">
            <label htmlFor="login-password">{t("auth.password")}</label>
            <input
              autoComplete="current-password"
              id="login-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </div>
          <button className="store-button store-button--onnavy" disabled={submitting} type="submit">
            {submitting ? t("common.loading") : t("auth.login")}
          </button>
        </form>
        <p className="store-auth-card__footer">
          <Link to={localePath("/forgot-password")}>{t("auth.forgotPassword")}</Link>
        </p>
        <p className="store-auth-card__footer">
          {t("auth.noAccount")} <Link to={localePath("/register")}>{t("auth.newAccount")}</Link>
        </p>
      </div>
    </div>
  );
}
