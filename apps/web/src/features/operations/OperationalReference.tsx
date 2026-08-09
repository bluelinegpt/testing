import { useTranslation } from "react-i18next";

import { useSessionAccess } from "../../app/SessionAccessContext.js";
import { canAccessCompanyPath } from "../../app/company-access.js";
import { recordRoute, type RoutableRecord } from "../accounting/accounting-routes.js";

/**
 * A business reference that opens its record when — and only when — a verified
 * route exists and the User may follow it.
 *
 * The operational detail dialogs render dozens of references (Order Numbers in
 * a Driver Collection, allocated Orders in a Settlement, settled Receivables in
 * a Collection, Employees in a Payroll Payment). Before this they were all
 * plain text, so a User could see that an Order was involved but had no way to
 * open it.
 *
 * Routing knowledge stays in one place: `accounting-routes.ts` builds the path
 * and `canAccessCompanyPath` gates it, exactly as Related Records does. No
 * dialog writes a URL, and a reference whose route or permission is missing
 * degrades to plain text rather than to a dead link.
 *
 * `identifier` is whatever that record's route actually consumes — an Order
 * NUMBER, a Trader/Driver/Employee CODE, an internal id for the Accounting and
 * Phase 3B operational routes. `children` (or the reference itself) is what the
 * User reads.
 */
export function OperationalReference({
  identifier,
  reference,
  type,
}: {
  readonly identifier?: string | null | undefined;
  readonly reference: string | null | undefined;
  readonly type: RoutableRecord;
}) {
  const { t } = useTranslation();
  const session = useSessionAccess();
  const label = typeof reference === "string" ? reference.trim() : "";
  if (label === "") return <>—</>;

  // The route usually consumes the same value the User reads (an Order Number,
  // a Trader Code); `identifier` overrides that where it does not.
  const value =
    typeof identifier === "string" && identifier.trim() !== "" ? identifier.trim() : label;
  const path = session === undefined ? undefined : recordRoute(type, value);
  if (path === undefined) return <>{label}</>;
  if (!canAccessCompanyPath(path, session!.permissions)) {
    // Visible but not openable: the reference still tells the User what the
    // record is, and the reason is available without cluttering the cell.
    return (
      <span className="accounting-related-disabled" title={t("accounting.related.restricted")}>
        {label}
      </span>
    );
  }
  return (
    <button
      className="accounting-related-link"
      onClick={(event) => {
        // These references sit inside clickable rows and dialogs; opening the
        // referenced record must not also trigger the row's own handler.
        event.stopPropagation();
        session!.navigate(path);
      }}
      type="button"
    >
      {label}
    </button>
  );
}

/**
 * `Code — Name` for a business party, with the Code kept first so it stays
 * LTR-readable inside an RTL page, and the Arabic name preferred in Arabic.
 *
 * Returns an em dash rather than a bare name-less code or a blank cell.
 */
export function partyDisplayLabel(
  code: unknown,
  nameEn: unknown,
  nameAr: unknown,
  language: string,
): string {
  const codeText = typeof code === "string" ? code.trim() : "";
  const arabic = typeof nameAr === "string" ? nameAr.trim() : "";
  const english = typeof nameEn === "string" ? nameEn.trim() : "";
  const name = language.startsWith("ar") && arabic !== "" ? arabic : english;
  if (codeText === "" && name === "") return "—";
  if (codeText === "") return name;
  if (name === "") return codeText;
  return `${codeText} — ${name}`;
}
