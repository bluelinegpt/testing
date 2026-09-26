import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useSessionAccess } from "../../app/SessionAccessContext.js";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type { CompanyProfile } from "../../api/contracts.js";
import { useCompanyBranding } from "../../app/CompanyBrandingContext.js";
import { PageHeader } from "../../components/PageHeader.js";
import { BalanceControlsPanel } from "./BalanceControlsPanel.js";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/jpg"];

interface FormState {
  nameAr: string;
  nameEn: string;
  subtitleAr: string;
  subtitleEn: string;
  telephone: string;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "");
  return letters.toUpperCase();
}

export function CompanyProfileWorkspace({
  api,
  permissions,
}: {
  api: ApiClient;
  readonly permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const branding = useCompanyBranding();
  // The authenticated Company. Never a request parameter.
  const session = useSessionAccess();
  const [profile, setProfile] = useState<CompanyProfile>();
  const [form, setForm] = useState<FormState>();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "error" | "success"; message: string }>();
  const [selectedFile, setSelectedFile] = useState<File>();
  const [selectedPreview, setSelectedPreview] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  /* Brief confirmation that the clipboard write actually happened. Reset on a
     timer rather than left on screen, so a later copy still reads as new. */
  const [copied, setCopied] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useMemo(
    () => async () => {
      const loaded = await api.get<CompanyProfile>("company-profile");
      setProfile(loaded);
      setForm({
        nameAr: loaded.nameAr ?? "",
        nameEn: loaded.nameEn,
        subtitleAr: loaded.subtitleAr ?? "",
        subtitleEn: loaded.subtitleEn ?? "",
        telephone: loaded.telephone ?? "",
      });
    },
    [api],
  );

  useEffect(() => {
    void load().catch(() => setStatus({ kind: "error", message: t("companyProfile.loadError") }));
  }, [load, t]);

  useEffect(() => {
    if (selectedFile === undefined) {
      setSelectedPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setSelectedPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  const update = (field: keyof FormState, value: string) =>
    setForm((current) => (current === undefined ? current : { ...current, [field]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form === undefined) return;
    setSaving(true);
    setStatus(undefined);
    try {
      await api.patch<CompanyProfile>("company-profile", {
        nameAr: form.nameAr.trim(),
        nameEn: form.nameEn.trim(),
        subtitleAr: form.subtitleAr.trim() === "" ? undefined : form.subtitleAr.trim(),
        subtitleEn: form.subtitleEn.trim() === "" ? undefined : form.subtitleEn.trim(),
        telephone: form.telephone.trim(),
      });
      await load();
      await branding.refreshBranding();
      setStatus({ kind: "success", message: t("companyProfile.saved") });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof ApiError ? error.message : t("companyProfile.saveError"),
      });
    } finally {
      setSaving(false);
    }
  };

  const chooseFile = (file: File | undefined) => {
    setFileError(undefined);
    if (file === undefined) {
      setSelectedFile(undefined);
      return;
    }
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setSelectedFile(undefined);
      setFileError(t("companyProfile.errors.fileType"));
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setSelectedFile(undefined);
      setFileError(t("companyProfile.errors.fileSize"));
      return;
    }
    setSelectedFile(file);
  };

  const uploadLogo = async () => {
    if (selectedFile === undefined) return;
    setLogoBusy(true);
    setStatus(undefined);
    try {
      const body = new FormData();
      body.append("file", selectedFile);
      await api.postMultipart<CompanyProfile>("company-profile/logo", body);
      setSelectedFile(undefined);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
      await load();
      await branding.refreshBranding();
      setStatus({ kind: "success", message: t("companyProfile.logoUploaded") });
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof ApiError ? error.message : t("companyProfile.errors.uploadFailed"),
      });
    } finally {
      setLogoBusy(false);
    }
  };

  const removeLogo = async () => {
    setLogoBusy(true);
    setStatus(undefined);
    try {
      await api.delete<CompanyProfile>("company-profile/logo");
      await load();
      await branding.refreshBranding();
      setStatus({ kind: "success", message: t("companyProfile.logoRemoved") });
    } catch {
      setStatus({ kind: "error", message: t("companyProfile.errors.uploadFailed") });
    } finally {
      setLogoBusy(false);
    }
  };

  if (form === undefined) {
    return (
      <div className="workspace">
        <PageHeader title={t("companyProfile.title")} />
        <p className="muted">{status?.message ?? t("common.loading")}</p>
      </div>
    );
  }

  const hasLogo = profile?.logo != null;
  const copyCompanyId = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* Clipboard access can be refused (permission, insecure origin). The
         field is selectable, so the user can still copy manually -- failing
         silently here is better than an error over a convenience action. */
    }
  };

  const previewName = branding.companyName || form.nameEn || form.nameAr;

  return (
    <div className="workspace">
      <PageHeader title={t("companyProfile.title")} description={t("companyProfile.description")} />

      {status !== undefined ? (
        <p
          className={status.kind === "success" ? "form-success" : "field-error"}
          role={status.kind === "error" ? "alert" : "status"}
        >
          {status.message}
        </p>
      ) : null}

      <section className="configuration-panel company-profile-card">
        <form className="company-profile-grid" onSubmit={(event) => void submit(event)}>
          <h2>{t("companyProfile.identityHeading")}</h2>
          <div className="cp-fields">
            {/* Read-only, and deliberately NOT part of `form`.

                The value comes from the authenticated session rather than from
                the profile payload, so it is the Company the user is signed in
                as by construction -- there is no request parameter that could
                point it at anyone else. Keeping it out of `form` also means it
                can never reach the update payload: `submit` sends `form`, and
                this field is not in it. */}
            {session?.companyId === undefined ? null : (
              <label className="field">
                <span>{t("companyProfile.companyId")}</span>
                <div className="cp-company-id">
                  {/* An identifier is LTR even on an Arabic page: a UUID read
                      right-to-left is a different string. */}
                  <input
                    dir="ltr"
                    readOnly
                    value={session.companyId}
                  />
                  <button
                    className="button button-secondary"
                    onClick={() => void copyCompanyId(session.companyId)}
                    type="button"
                  >
                    {copied ? t("companyProfile.copied") : t("common.copy")}
                  </button>
                </div>
              </label>
            )}
            <label className="field">
              <span>{t("companyProfile.nameEn")}</span>
              <input
                dir="ltr"
                maxLength={160}
                onChange={(event) => update("nameEn", event.target.value)}
                required
                value={form.nameEn}
              />
            </label>
            <label className="field">
              <span>{t("companyProfile.nameAr")}</span>
              <input
                dir="rtl"
                maxLength={160}
                onChange={(event) => update("nameAr", event.target.value)}
                required
                value={form.nameAr}
              />
            </label>
            <label className="field">
              <span>{t("companyProfile.subtitleEn")}</span>
              <input
                dir="ltr"
                maxLength={200}
                onChange={(event) => update("subtitleEn", event.target.value)}
                value={form.subtitleEn}
              />
            </label>
            <label className="field">
              <span>{t("companyProfile.subtitleAr")}</span>
              <input
                dir="rtl"
                maxLength={200}
                onChange={(event) => update("subtitleAr", event.target.value)}
                value={form.subtitleAr}
              />
            </label>
            <label className="field">
              <span>{t("companyProfile.telephone")}</span>
              <input
                dir="ltr"
                inputMode="tel"
                maxLength={32}
                onChange={(event) => update("telephone", event.target.value)}
                required
                value={form.telephone}
              />
            </label>
          </div>
          <div className="cp-actions">
            <button className="button button-primary" disabled={saving} type="submit">
              {saving ? t("common.working") : t("common.save")}
            </button>
          </div>
        </form>

        <hr className="cp-divider" />

        <div className="cp-logo-section">
          <h2>{t("companyProfile.logoHeading")}</h2>
          <div className="company-logo-manager">
            <div className="company-logo-previews">
              <figure className="company-logo-figure">
                <figcaption>{t("companyProfile.currentLogo")}</figcaption>
                {hasLogo && branding.logoUrl !== undefined ? (
                  <img alt={previewName} className="company-logo-image" src={branding.logoUrl} />
                ) : (
                  <span aria-hidden="true" className="company-logo-placeholder">
                    {initialsOf(previewName)}
                  </span>
                )}
              </figure>
              {selectedPreview !== undefined ? (
                <figure className="company-logo-figure">
                  <figcaption>{t("companyProfile.selectedPreview")}</figcaption>
                  <img
                    alt={t("companyProfile.selectedPreview")}
                    className="company-logo-image"
                    src={selectedPreview}
                  />
                </figure>
              ) : null}
            </div>

            <div className="company-logo-controls">
              <p className="muted">{t("companyProfile.logoHint")}</p>
              <input
                accept="image/png,image/jpeg"
                aria-label={t("companyProfile.chooseFile")}
                onChange={(event) => chooseFile(event.target.files?.[0])}
                ref={fileInputRef}
                type="file"
              />
              {fileError !== undefined ? (
                <p className="field-error" role="alert">
                  {fileError}
                </p>
              ) : null}
              <div className="company-logo-actions">
                <button
                  className="button button-primary"
                  disabled={selectedFile === undefined || logoBusy}
                  onClick={() => void uploadLogo()}
                  type="button"
                >
                  {logoBusy
                    ? t("common.working")
                    : hasLogo
                      ? t("companyProfile.replaceLogo")
                      : t("companyProfile.uploadLogo")}
                </button>
                {hasLogo ? (
                  <button
                    className="button button-secondary"
                    disabled={logoBusy}
                    onClick={() => void removeLogo()}
                    type="button"
                  >
                    {t("companyProfile.removeLogo")}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>

      <BalanceControlsPanel api={api} canManage={permissions.includes("accounting.manage")} />
    </div>
  );
}
