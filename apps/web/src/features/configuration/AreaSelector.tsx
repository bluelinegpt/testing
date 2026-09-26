import { useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyArea, Emirate } from "../../api/contracts.js";
import { CompanyBrandingContext } from "../../app/CompanyBrandingContext.js";
import { SearchCombobox } from "../../components/SearchCombobox.js";
import { normalizeLocale } from "../../localization/locale.js";
import { localizeName } from "../../localization/localize-name.js";

import { AreaFormDialog } from "./AreaFormDialog.js";

/**
 * Shared Emirate + Area picker for Trader, Customer, pricing, Order and address
 * forms.
 *
 * The Emirate is chosen first and narrows the Area list, which is how operators
 * think about UAE addresses and which keeps the Area list short. Inline "Add
 * Area" opens the same authoritative Area form used by Configuration → Areas,
 * so no second Area implementation exists. The parent's own state is untouched
 * while the modal is open, so nothing typed into the parent form is lost.
 */
export function AreaSelector({
  api,
  areaLabel,
  allowCreate = true,
  arabicFirst = false,
  disabled,
  emirateLabel,
  includeDisabled = false,
  onChange,
  required = true,
  searchDebounceMs,
  value,
}: {
  api: ApiClient;
  areaLabel?: string | undefined;
  allowCreate?: boolean | undefined;
  arabicFirst?: boolean | undefined;
  disabled?: boolean | undefined;
  emirateLabel?: string | undefined;
  /**
   * Edit screens pass true so an Area disabled after the record was created
   * still resolves. Operational pickers leave it false.
   */
  includeDisabled?: boolean | undefined;
  onChange: (area: CompanyArea | undefined) => void;
  required?: boolean | undefined;
  /** Test seam: 0 removes the real-time typeahead wait. */
  searchDebounceMs?: number | undefined;
  value: CompanyArea | undefined;
}) {
  const { i18n, t } = useTranslation();
  // Display follows the user's Text Language (read from the branding context,
  // falling back to the UI language when no provider is present, e.g. in
  // isolated tests). `arabicFirst` forces Arabic regardless. Reading the context
  // directly — rather than via a hook that calls useTranslation again — keeps a
  // single i18n subscription so this component's render timing is unchanged.
  const branding = useContext(CompanyBrandingContext);
  const textLanguage = branding?.textLanguage ?? normalizeLocale(i18n.resolvedLanguage);
  const displayLanguage = arabicFirst ? "ar" : textLanguage;

  const [emirates, setEmirates] = useState<readonly Emirate[]>([]);
  const [emirateId, setEmirateId] = useState(value?.emirateId ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .get<readonly Emirate[]>("configuration/emirates")
      .then((loaded) => active && setEmirates(Array.isArray(loaded) ? loaded : []))
      .catch(() => active && setError(t("areas.emiratesLoadFailed")))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [api, t]);

  // Keep the Emirate in step when the caller replaces the selected Area.
  useEffect(() => {
    if (value !== undefined) setEmirateId(value.emirateId);
  }, [value]);

  const label = useCallback(
    (area: CompanyArea) => localizeName(displayLanguage, { ar: area.nameAr, en: area.nameEn }),
    [displayLanguage],
  );

  const searchPath =
    `configuration/areas/search?emirateId=${encodeURIComponent(emirateId)}` +
    `&activeOnly=${includeDisabled ? "false" : "true"}`;

  return (
    <div className="area-selector">
      <label className={required ? "field required-field" : "field"}>
        <span>{emirateLabel ?? t("areas.emirate")}</span>
        <select
          disabled={disabled === true || loading}
          onChange={(event) => {
            setEmirateId(event.target.value);
            // The chosen Area belongs to the previous Emirate, so clear it
            // rather than leaving an Area that contradicts the Emirate.
            onChange(undefined);
          }}
          value={emirateId}
        >
          <option value="">{loading ? t("common.loading") : t("areas.selectEmirate")}</option>
          {emirates.map((emirate) => (
            <option key={emirate.id} value={emirate.id}>
              {localizeName(displayLanguage, { ar: emirate.nameAr, en: emirate.nameEn })}
            </option>
          ))}
        </select>
      </label>

      <div className="area-selector-area">
        {emirateId.length === 0 ? (
          <label className="field">
            <span>{areaLabel ?? t("areas.area")}</span>
            <input disabled placeholder={t("areas.selectEmirateFirst")} readOnly value="" />
          </label>
        ) : (
          <SearchCombobox<CompanyArea>
            api={api}
            {...(searchDebounceMs === undefined ? {} : { debounceMs: searchDebounceMs })}
            emptyText={t("areas.noneFound")}
            getLabel={label}
            key={searchPath}
            label={areaLabel ?? t("areas.area")}
            onChange={onChange}
            path={searchPath}
            placeholder={t("areas.searchPlaceholder")}
            required={required}
            value={value}
          />
        )}
        {/* A small action beside the field, not a large block. */}
        {allowCreate ? (
          <button
            className="text-button"
            disabled={disabled === true || emirateId.length === 0}
            onClick={() => setAddOpen(true)}
            type="button"
          >
            {t("areas.addInline")}
          </button>
        ) : null}
      </div>

      {error === undefined ? null : (
        <small className="field-error" role="alert">
          {error}
        </small>
      )}

      {addOpen ? (
        <AreaFormDialog
          api={api}
          defaultEmirateId={emirateId}
          emirates={emirates}
          onClose={() => setAddOpen(false)}
          onSaved={(area) => {
            setAddOpen(false);
            // The new Area is selected immediately so the operator does not
            // have to find it again.
            setEmirateId(area.emirateId);
            onChange(area);
          }}
        />
      ) : null}
    </div>
  );
}
