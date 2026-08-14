import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { LoginResponse } from "../../api/contracts.js";
import tawseelhubIcon from "../../assets/tawseelhub-icon.png";

export function LoginView({
  api,
  onAuthenticated,
}: {
  api: ApiClient;
  onAuthenticated: (session: LoginResponse) => void;
}) {
  const { t } = useTranslation();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      // No Company is sent. The API resolves the tenant from the request host.
      let session = await api.post<LoginResponse>("auth/login", {
        identifier: identifier.trim(),
        password,
      });
      api.setAccessToken(session.accessToken);
      if (
        !Array.isArray(session.identity.permissions) ||
        session.identity.permissions.length === 0
      ) {
        const identity = await api.get<{ permissions: readonly string[] }>("auth/me");
        session = {
          ...session,
          identity: {
            ...session.identity,
            permissions: identity.permissions,
          },
        };
      }
      onAuthenticated(session);
    } catch {
      api.setAccessToken(undefined);
      setError(t("auth.invalid"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-main">
      <section className="login-tool" aria-labelledby="login-title">
        <div className="login-brand-block">
          <img alt="" aria-hidden="true" className="login-brand-mark" src={tawseelhubIcon} />
          <div>
            <strong>TawseelHub</strong>
            <span>{t("auth.workspace")}</span>
          </div>
        </div>
        <form className="login-form" noValidate onSubmit={(event) => void submit(event)}>
          <div className="form-heading">
            <h1 id="login-title">{t("auth.signIn")}</h1>
            <p>{t("auth.companyAccess")}</p>
          </div>
          {error === undefined ? null : (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          <label className="field">
            <span>{t("auth.identifier")}</span>
            <input
              autoCapitalize="none"
              autoComplete="username"
              autoFocus
              maxLength={320}
              onChange={(event) => setIdentifier(event.target.value)}
              required
              value={identifier}
            />
          </label>
          <label className="field">
            <span>{t("auth.password")}</span>
            <input
              autoComplete="current-password"
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          <button className="button button-primary button-wide" disabled={submitting} type="submit">
            {submitting ? t("common.working") : t("auth.signIn")}
          </button>
        </form>
      </section>
    </main>
  );
}
