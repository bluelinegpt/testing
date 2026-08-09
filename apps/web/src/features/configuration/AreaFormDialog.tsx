import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyArea, Emirate } from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { normalizeLocale } from "../../localization/locale.js";

/** Removes one field's error without disturbing the others. */
function clearField(errors: Record<string, string>, field: string): Record<string, string> {
  const next = { ...errors };
  delete next[field];
  return next;
}

/**
 * The single authoritative Area form.
 *
 * Configuration → Areas and every inline "Add Area" action render this same
 * component, so there is exactly one implementation of the Area rules. It
 * serves both create and edit: passing `area` switches it to edit mode.
 */
export function AreaFormDialog({
  api,
  area,
  defaultEmirateId,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  /** Present for edit, omitted for create. */
  area?: CompanyArea | undefined;
  /** Prefills the Emirate when the parent form already chose one. */
  defaultEmirateId?: string | undefined;
  onClose: () => void;
  onSaved: (area: CompanyArea) => void;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const editing = area !== undefined;

  const [emirates, setEmirates] = useState<readonly Emirate[]>([]);
  const [emirateId, setEmirateId] = useState(area?.emirateId ?? defaultEmirateId ?? "");
  const [nameEn, setNameEn] = useState(area?.nameEn ?? "");
  const [nameAr, setNameAr] = useState(area?.nameAr ?? "");
  const [notes, setNotes] = useState(area?.notes ?? "");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .get<readonly Emirate[]>("configuration/emirates")
      .then((loaded) => active && setEmirates(loaded))
      .catch(() => active && setError(t("areas.emiratesLoadFailed")))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [api, t]);

  const emirateLabel = (emirate: Emirate) => (locale === "ar" ? emirate.nameAr : emirate.nameEn);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = nameEn.trim();
    const errors: Record<string, string> = {};
    if (emirateId.length === 0) errors.emirateId = t("areas.emirateRequired");
    if (trimmed.length === 0) errors.nameEn = t("areas.nameRequired");
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    setError(undefined);
    try {
      const payload = {
        emirateId,
        nameAr: nameAr.trim(),
        nameEn: trimmed,
        notes: notes.trim(),
      };
      const saved = editing
        ? await api.patch<CompanyArea>(`configuration/areas/${area.id}`, payload)
        : await api.post<CompanyArea>("configuration/areas", payload);
      onSaved(saved);
    } catch (caught) {
      // Surface the duplicate rule against the field it belongs to.
      const code = (caught as { code?: string }).code;
      if (code === "area_exists") {
        setFieldErrors({ nameEn: t("areas.duplicate") });
      } else if (code === "area_emirate_change_blocked") {
        setFieldErrors({ emirateId: t("areas.emirateChangeBlocked") });
      } else {
        setError(t("areas.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={editing ? t("areas.editTitle") : t("areas.createTitle")}
      titleId="area-form-title"
    >
      <form className="form-grid" noValidate onSubmit={(event) => void submit(event)}>
        {error === undefined ? null : (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        {/* The error sits outside the label so it cannot pollute the field's
            accessible name; aria-describedby still associates the two. */}
        <div className="field-group">
          <label className="field required-field">
            <span>{t("areas.emirate")}</span>
            <select
              aria-describedby={
                fieldErrors.emirateId === undefined ? undefined : "area-emirate-error"
              }
              aria-invalid={fieldErrors.emirateId !== undefined}
              disabled={loading || saving}
              onChange={(event) => {
                setEmirateId(event.target.value);
                setFieldErrors((current) => clearField(current, "emirateId"));
              }}
              required
              value={emirateId}
            >
              <option value="">{loading ? t("common.loading") : t("areas.selectEmirate")}</option>
              {emirates.map((emirate) => (
                <option key={emirate.id} value={emirate.id}>
                  {emirateLabel(emirate)}
                </option>
              ))}
            </select>
          </label>
          {fieldErrors.emirateId === undefined ? null : (
            <small className="field-error" id="area-emirate-error" role="alert">
              {fieldErrors.emirateId}
            </small>
          )}
        </div>

        <div className="field-group">
          <label className="field required-field">
            <span>{t("areas.nameEn")}</span>
            <input
              aria-describedby={fieldErrors.nameEn === undefined ? undefined : "area-name-error"}
              aria-invalid={fieldErrors.nameEn !== undefined}
              autoFocus
              disabled={saving}
              maxLength={160}
              onChange={(event) => {
                setNameEn(event.target.value);
                setFieldErrors((current) => clearField(current, "nameEn"));
              }}
              required
              value={nameEn}
            />
          </label>
          {fieldErrors.nameEn === undefined ? null : (
            <small className="field-error" id="area-name-error" role="alert">
              {fieldErrors.nameEn}
            </small>
          )}
        </div>

        <label className="field">
          <span>{t("areas.nameAr")}</span>
          <input
            dir="rtl"
            disabled={saving}
            maxLength={160}
            onChange={(event) => setNameAr(event.target.value)}
            value={nameAr}
          />
        </label>

        <label className="field field-wide">
          <span>{t("areas.notes")}</span>
          <textarea
            disabled={saving}
            maxLength={1000}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            value={notes}
          />
        </label>

        {/* The Area Code is generated by the backend and is never entered. */}
        {editing ? (
          <p className="field-hint field-wide">
            {t("areas.code")}: <strong>{area.code}</strong>
          </p>
        ) : null}

        <div className="modal-actions">
          <button className="button" disabled={saving} onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" disabled={saving || loading} type="submit">
            {saving ? t("common.working") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
