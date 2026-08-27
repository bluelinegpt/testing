import { Eye, EyeOff, KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";

export function PasswordChangeView({
  api,
  onChanged,
  voluntary = false,
}: {
  api: ApiClient;
  onChanged: () => void;
  /**
   * True when this form was reached by choice (the Trader/Company Portal's
   * "Change Password" nav item), not because `forcePasswordChange` demanded
   * it. The account's current password is not necessarily temporary at all
   * in that case, so the title/help text must not claim it is (T10).
   */
  voluntary?: boolean;
}) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [visible, setVisible] = useState({ current: false, next: false, confirm: false });
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
        <h1 id="password-change-title">
          {t(voluntary ? "userAdmin.passwordChangeTitleVoluntary" : "userAdmin.passwordChangeTitle")}
        </h1>
        <p>{t(voluntary ? "userAdmin.passwordChangeHelpVoluntary" : "userAdmin.passwordChangeHelp")}</p>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}
        <form onSubmit={(event) => void submit(event)}>
          <label className="field" htmlFor="current-password">
            <span>{t("userAdmin.currentPassword")}</span>
            <span className="password-input-wrap">
              <input
                autoComplete="current-password"
                id="current-password"
                minLength={8}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                type={visible.current ? "text" : "password"}
                value={currentPassword}
              />
              <button
                aria-label={t(visible.current ? "auth.hidePassword" : "auth.showPassword")}
                className="icon-button"
                onClick={() => setVisible((value) => ({ ...value, current: !value.current }))}
                type="button"
              >
                {visible.current ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </span>
          </label>
          <label className="field" htmlFor="new-password">
            <span>{t("userAdmin.newPassword")}</span>
            <span className="password-input-wrap">
              <input
                aria-describedby="password-policy"
                autoComplete="new-password"
                id="new-password"
                minLength={8}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                type={visible.next ? "text" : "password"}
                value={newPassword}
              />
              <button
                aria-label={t(visible.next ? "auth.hidePassword" : "auth.showPassword")}
                className="icon-button"
                onClick={() => setVisible((value) => ({ ...value, next: !value.next }))}
                type="button"
              >
                {visible.next ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </span>
          </label>
          <label className="field" htmlFor="confirm-password">
            <span>{t("userAdmin.confirmNewPassword")}</span>
            <span className="password-input-wrap">
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
                type={visible.confirm ? "text" : "password"}
                value={confirmPassword}
              />
              <button
                aria-label={t(visible.confirm ? "auth.hidePassword" : "auth.showPassword")}
                className="icon-button"
                onClick={() => setVisible((value) => ({ ...value, confirm: !value.confirm }))}
                type="button"
              >
                {visible.confirm ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </span>
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
