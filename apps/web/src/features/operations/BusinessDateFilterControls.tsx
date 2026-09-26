import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppliedReportDateMode } from "../../api/contracts.js";
import { formatDate, formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

/**
 * Date Mode controls and the backend's resolved-window summary.
 *
 * One component for Driver Collections, Trader Settlements and Trader
 * Collections. Three copies of "which day does 02:00 belong to" would eventually
 * disagree, and the disagreement would be about money.
 *
 * Nothing here computes a window. Every value shown comes from
 * `appliedDateMode` exactly as the server resolved it — a boundary derived in
 * the browser would be built from the viewer's own clock and timezone, and would
 * not describe the query that actually ran.
 */
export function BusinessDateFilterControls({
  applied,
  authoritativeTimestampLabel,
  businessDateFrom,
  businessDateTo,
  calendarDateFrom,
  calendarDateTo,
  calendarFromLabel,
  calendarKeyFrom,
  calendarKeyTo,
  calendarToLabel,
  dateMode,
  historicalWarningLabel,
  onChange,
}: {
  /** Metadata from the list response. Absent until the first load returns. */
  applied: AppliedReportDateMode | undefined;
  /** Human label for the timestamp. Falls back to the backend's own string. */
  authoritativeTimestampLabel?: string | undefined;
  businessDateFrom: string;
  businessDateTo: string;
  /**
   * Calendar Date inputs, for screens whose calendar filter belongs to this
   * control rather than to their own filter bar.
   *
   * Optional throughout: the three screens that keep their calendar dates in
   * their own filter bar pass none of these and render exactly as before.
   */
  calendarDateFrom?: string | undefined;
  calendarDateTo?: string | undefined;
  calendarFromLabel?: string | undefined;
  calendarKeyFrom?: string | undefined;
  calendarKeyTo?: string | undefined;
  calendarToLabel?: string | undefined;
  dateMode: string;
  /**
   * Screen-specific wording for the historical-exclusion notice.
   *
   * Optional: the three screens that do not pass it keep the generic
   * message exactly as before.
   */
  historicalWarningLabel?: string | undefined;
  onChange: (patch: Record<string, string>) => void;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.language);
  const [showSegments, setShowSegments] = useState(false);
  const businessMode = dateMode === "business_date";
  // Only this control owns the calendar inputs when the caller supplied keys
  // for them; otherwise the screen's own filter bar still does.
  const ownsCalendar = calendarKeyFrom !== undefined && calendarKeyTo !== undefined;
  // Switching mode must clear the fields belonging to the mode being left, or a
  // stale value would travel invisibly into a request it does not belong in.
  const clearedOnSwitch = (next: "business_date" | "calendar_date"): Record<string, string> =>
    next === "business_date"
      ? {
          dateMode: "business_date",
          ...(ownsCalendar ? { [calendarKeyFrom]: "", [calendarKeyTo]: "" } : {}),
        }
      : { businessDateFrom: "", businessDateTo: "", dateMode: ownsCalendar ? "calendar_date" : "" };
  // Purely a display guard. The backend rejects an inverted range too; this
  // just says so before a pointless round trip.
  const invertedRange =
    businessMode &&
    businessDateFrom !== "" &&
    businessDateTo !== "" &&
    businessDateFrom > businessDateTo;

  return (
    <div className="business-date-controls">
      <div className="business-date-fields">
        <label className="field compact-field">
          <span>{t("configuration.businessDay.dateMode")}</span>
          <select
            name="dateMode"
            onChange={(event) =>
              onChange(
                clearedOnSwitch(
                  event.target.value === "business_date" ? "business_date" : "calendar_date",
                ),
              )
            }
            value={businessMode ? "business_date" : "calendar_date"}
          >
            <option value="calendar_date">{t("configuration.businessDay.calendarDate")}</option>
            <option value="business_date">{t("configuration.businessDay.businessDate")}</option>
          </select>
        </label>
        {businessMode || !ownsCalendar ? null : (
          <>
            <label className="field compact-field">
              <span>{calendarFromLabel}</span>
              <input
                dir="ltr"
                onChange={(event) => onChange({ [calendarKeyFrom]: event.target.value })}
                type="date"
                value={calendarDateFrom ?? ""}
              />
            </label>
            <label className="field compact-field">
              <span>{calendarToLabel}</span>
              <input
                dir="ltr"
                onChange={(event) => onChange({ [calendarKeyTo]: event.target.value })}
                type="date"
                value={calendarDateTo ?? ""}
              />
            </label>
          </>
        )}
        {!businessMode ? null : (
          <>
            <label className="field compact-field">
              <span>{t("configuration.businessDay.businessDateFrom")}</span>
              <input
                dir="ltr"
                onChange={(event) => onChange({ businessDateFrom: event.target.value })}
                type="date"
                value={businessDateFrom}
              />
            </label>
            <label className="field compact-field">
              <span>{t("configuration.businessDay.businessDateTo")}</span>
              <input
                dir="ltr"
                onChange={(event) => onChange({ businessDateTo: event.target.value })}
                type="date"
                value={businessDateTo}
              />
            </label>
          </>
        )}
      </div>

      {!invertedRange ? null : (
        <p className="field-error">{t("configuration.businessDay.invalidRange")}</p>
      )}

      {/* Rendered only once the server has answered, and only for the mode it
          actually applied — showing a window next to Calendar Date results
          would describe a query that never ran. */}
      {applied === undefined || applied.dateMode !== "business_date" ? null : (
        <BusinessDaySummary
          applied={applied}
          authoritativeTimestampLabel={authoritativeTimestampLabel}
          historicalWarningLabel={historicalWarningLabel}
          locale={locale}
          onToggleSegments={() => setShowSegments((open) => !open)}
          showSegments={showSegments}
        />
      )}
    </div>
  );
}

function BusinessDaySummary({
  applied,
  authoritativeTimestampLabel,
  historicalWarningLabel,
  locale,
  onToggleSegments,
  showSegments,
}: {
  applied: AppliedReportDateMode;
  authoritativeTimestampLabel?: string | undefined;
  historicalWarningLabel?: string | undefined;
  locale: "ar" | "en";
  onToggleSegments: () => void;
  showSegments: boolean;
}) {
  const { t } = useTranslation();
  // `displayEnd` is the inclusive instant to read; `endUtc` is the exclusive
  // bound the query used. Showing the exclusive bound would claim the window
  // covers a moment it does not.
  const range =
    applied.businessDateFrom === null
      ? null
      : `${formatDate(applied.businessDateFrom, locale)} – ${formatDate(
          applied.businessDateTo ?? applied.businessDateFrom,
          locale,
        )}`;

  return (
    <div className="business-date-summary">
      <dl className="business-date-summary-grid">
        {range === null ? null : (
          <div>
            <dt>{t("configuration.businessDay.businessDate")}</dt>
            <dd dir="ltr">{range}</dd>
          </div>
        )}
        {applied.startUtc === null || applied.displayEnd === null ? null : (
          <div>
            <dt>{t("configuration.businessDay.appliedWindow")}</dt>
            <dd dir="ltr">
              {formatDateTime(applied.startUtc, locale)} – {formatDateTime(applied.displayEnd, locale)}
            </dd>
          </div>
        )}
        {applied.timezone === null ? null : (
          <div>
            <dt>{t("configuration.businessDay.companyTimezone")}</dt>
            <dd dir="ltr">{applied.timezone}</dd>
          </div>
        )}
        {applied.businessDayStart === null ? null : (
          <div>
            <dt>{t("configuration.businessDay.startTime")}</dt>
            <dd dir="ltr">{applied.businessDayStart}</dd>
          </div>
        )}
        {applied.authoritativeTimestamp === null ? null : (
          <div>
            <dt>{t("configuration.businessDay.authoritativeTimestamp")}</dt>
            <dd dir="ltr">
              {authoritativeTimestampLabel ?? applied.authoritativeTimestamp}
            </dd>
          </div>
        )}
      </dl>

      {/* Noticeable, but not fatal: the rows shown are correct, some older ones
          simply cannot be placed in a business day. No count is estimated and
          nothing was deleted. */}
      {!applied.excludesHistoricalRows ? null : (
        <div className="alert alert-warning" role="status">
          {historicalWarningLabel ?? t("configuration.businessDay.historicalExcluded")}
        </div>
      )}

      {!applied.spansRuleChange ? null : (
        <div className="alert alert-info">
          <strong>{t("configuration.businessDay.multipleRulesApplied")}</strong>
          <span className="cell-secondary">
            {t("configuration.businessDay.configurationChangedDuringRange")}
          </span>
          <button className="link-button" onClick={onToggleSegments} type="button">
            {t(
              showSegments
                ? "configuration.businessDay.hideRuleDetails"
                : "configuration.businessDay.showRuleDetails",
            )}
          </button>
          {!showSegments ? null : (
            // Scrolls inside itself so a long range cannot push the page wide.
            <div className="business-date-segments">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("configuration.businessDay.businessDateFrom")}</th>
                    <th>{t("configuration.businessDay.businessDateTo")}</th>
                    <th>{t("configuration.businessDay.windowStart")}</th>
                    <th>{t("configuration.businessDay.windowEnd")}</th>
                    <th>{t("configuration.businessDay.companyTimezone")}</th>
                    <th>{t("configuration.businessDay.startTime")}</th>
                  </tr>
                </thead>
                <tbody>
                  {applied.segments.map((segment) => (
                    // Keyed by the window itself, never by configurationId — a
                    // configuration identifier is not something a user should
                    // see or that a key needs.
                    <tr key={`${segment.businessDateFrom}-${segment.startUtc}`}>
                      <td dir="ltr">{formatDate(segment.businessDateFrom, locale)}</td>
                      <td dir="ltr">{formatDate(segment.businessDateTo, locale)}</td>
                      <td dir="ltr">{formatDateTime(segment.startUtc, locale)}</td>
                      <td dir="ltr">{formatDateTime(segment.displayEnd, locale)}</td>
                      <td dir="ltr">{segment.timezone}</td>
                      <td dir="ltr">{segment.businessDayStart}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The three filter keys every integrated screen adds to its filter state. */
export const businessDateFilterDefaults = {
  businessDateFrom: "",
  businessDateTo: "",
  dateMode: "",
} as const;
