import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";

export function PasswordChangeView({ api, onChanged }: { api: ApiClient; onChanged: () => void }) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError(t("userAdmin.passwordMismatch"));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await api.post<void>("auth/change-password", { currentPassword, newPassword });
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("userAdmin.actionFailed"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <main className="password-change-page">
      <section className="password-change-panel" aria-labelledby="password-change-title">
        <KeyRound aria-hidden="true" size={30} />
        <h1 id="password-change-title">{t("userAdmin.passwordChangeTitle")}</h1>
        <p>{t("userAdmin.passwordChangeHelp")}</p>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}
        <form onSubmit={(event) => void submit(event)}>
          <label className="field" htmlFor="current-password">
            <span>{t("userAdmin.currentPassword")}</span>
            <input
                autoComplete="current-password"
                id="current-password"
                minLength={8}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                type="password"
                value={currentPassword}
              />
          </label>
          <label className="field" htmlFor="new-password">
            <span>{t("userAdmin.newPassword")}</span>
            <input
                aria-describedby="password-policy"
                autoComplete="new-password"
                id="new-password"
                minLength={8}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                type="password"
                value={newPassword}
              />
          </label>
          <label className="field" htmlFor="confirm-password">
            <span>{t("userAdmin.confirmNewPassword")}</span>
            <input
                aria-describedby={
                  confirmPassword !== "" && newPassword !== confirmPassword
                    ? "password-mismatch"
                    : undefined
                }
                aria-invalid={confirmPassword !== "" && newPassword !== confirmPassword}
                autoComplete="new-password"
                id="confirm-password"
                minLength={8}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                type="password"
                value={confirmPassword}
              />
            {confirmPassword !== "" && newPassword !== confirmPassword ? (
              <small className="field-error" id="password-mismatch">
                {t("userAdmin.passwordMismatch")}
              </small>
            ) : null}
          </label>
          <small id="password-policy">{t("userAdmin.passwordPolicy")}</small>
          <button className="button button-primary button-wide" disabled={saving} type="submit">
            {saving ? t("common.working") : t("userAdmin.changePassword")}
          </button>
        </form>
      </section>
    </main>
  );
}
