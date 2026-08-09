import { useTranslation } from "react-i18next";

import { DirectionalText } from "./AccountingComponents.js";

/**
 * One navigable related record. `path` is omitted when the record exists but
 * the user may not open it — the business reference is still shown, because
 * knowing that a Journal exists is not the same as being able to read it.
 */
export interface RelatedRecord {
  /** Business reference shown to the User, e.g. `JRN-000012` or `EXP-000001 — Payee`. */
  readonly reference?: string | undefined;
  /** Translated label for the relationship, e.g. "Reversal Journal". */
  readonly label: string;
  readonly path?: string | undefined;
  /**
   * Shown in place of the reference when the relationship does not exist yet —
   * "Journal Not Created", "No Payments Recorded". Never leave a blank cell.
   */
  readonly emptyState?: string | undefined;
  /** True when the record exists but this User may not open it. */
  readonly permitted?: boolean | undefined;
  /** Why the link is disabled, e.g. no detail screen exists for this type. */
  readonly disabledReason?: string | undefined;
}

/**
 * Reusable Related Records panel. Renders only the records that exist, links
 * only those the User may open, and never shows an identifier — a record with
 * no business reference is not rendered at all rather than falling back to a
 * UUID.
 */
export function RelatedRecords({
  onNavigate,
  records,
  title,
}: {
  readonly onNavigate: (path: string) => void;
  readonly records: readonly RelatedRecord[];
  readonly title?: string | undefined;
}) {
  const { t } = useTranslation();
  // A relationship is rendered when it has a reference OR an explicit empty
  // state; the rest are dropped so the panel never lists blank rows.
  const shown = records.filter(
    (record) =>
      (typeof record.reference === "string" && record.reference.trim() !== "") ||
      (typeof record.emptyState === "string" && record.emptyState.trim() !== ""),
  );
  return (
    <section className="accounting-preview-panel accounting-related-records">
      <h3>{title ?? t("accounting.related.title")}</h3>
      {shown.length === 0 ? (
        <p className="accounting-empty">{t("accounting.related.noneAvailable")}</p>
      ) : (
        <dl className="accounting-detail-grid">
          {shown.map((record) => {
            const reference =
              typeof record.reference === "string" ? record.reference.trim() : "";
            const restricted = record.permitted === false;
            // Link only when the record exists, the User may open it, and a
            // verified route exists. Anything else shows the reference plainly.
            const navigable = reference !== "" && !restricted && record.path !== undefined;
            const hint = restricted
              ? t("accounting.related.restricted")
              : (record.disabledReason ?? undefined);
            return (
              <div key={`${record.label}-${reference || String(record.emptyState)}`}>
                <dt>{record.label}</dt>
                <dd>
                  {reference === "" ? (
                    <span className="accounting-pending-amount">{record.emptyState}</span>
                  ) : navigable ? (
                    <button
                      className="accounting-related-link"
                      onClick={() => onNavigate(record.path!)}
                      type="button"
                    >
                      <DirectionalText>{reference}</DirectionalText>
                    </button>
                  ) : (
                    <span className="accounting-related-disabled" title={hint}>
                      <DirectionalText>{reference}</DirectionalText>
                      {hint === undefined ? null : <small>{hint}</small>}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
