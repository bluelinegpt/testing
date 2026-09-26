import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { useSessionAccess } from "../../app/SessionAccessContext.js";
import { AccountingApi, accountingQueryKey } from "./accounting-api.js";
import { accountingLabel, eventTypeLabel } from "./accounting-labels.js";
import { recordRoute } from "./accounting-routes.js";
import { RelatedRecords, type RelatedRecord } from "./RelatedRecords.js";
import { useAccountingResource } from "./use-accounting-resource.js";

/**
 * Related Accounting records for one OPERATIONAL record — Order, Trader
 * Settlement, Trader Receivable, Trader Collection, Driver Collection, Payroll
 * Period/Payment, Outsourced Driver Fee.
 *
 * Those screens hold no Accounting data of their own, so this panel fetches it
 * from a single Company-scoped, bounded endpoint. One request per screen: the
 * backend resolves both Journal references inline, so nothing here can fan out
 * per Event.
 *
 * The panel is additive and self-contained. It renders its own loading and
 * failure states and returns nothing when the User has no Accounting access,
 * so dropping it into an operational screen cannot break that screen.
 */

/** Source types the Related Records endpoint accepts. */
export type RelatedSourceType =
  | "driver_reconciliation"
  | "order"
  | "outsourced_driver_fee_accrual"
  | "outsourced_driver_fee_payment"
  | "payroll_payment"
  | "payroll_period"
  | "trader_collection"
  | "trader_receivable"
  | "trader_settlement";

interface RelatedEvent {
  readonly accountingDate?: string | null;
  readonly eventType?: string | null;
  readonly journalId?: string | null;
  readonly journalNumber?: string | null;
  readonly processingStatus?: string | null;
  readonly reversalJournalId?: string | null;
  readonly reversalJournalNumber?: string | null;
}

const accountingViewPermissions = [
  "accounting.view",
  "accounting.manage",
  "users_roles.manage",
] as const;

export function AccountingRelatedPanel({
  api,
  companyId,
  onNavigate,
  permissions,
  sourceId,
  sourceType,
}: {
  readonly api: ApiClient;
  readonly companyId?: string | undefined;
  readonly onNavigate?: ((path: string) => void) | undefined;
  readonly permissions?: readonly string[] | undefined;
  readonly sourceId: string;
  readonly sourceType: RelatedSourceType;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new AccountingApi(api), [api]);
  // Dialogs nested several levels deep have no reason to carry permissions,
  // the Company or a navigator, so those fall back to the session context.
  const session = useSessionAccess();
  const resolvedCompanyId = companyId ?? session?.companyId ?? "";
  const resolvedPermissions = permissions ?? session?.permissions ?? [];
  const navigate = onNavigate ?? session?.navigate;
  // The backend is the authority on access; this only avoids a request that is
  // certain to be refused, so an operational-only User sees no panel at all
  // rather than a permanent failure message.
  const mayView = accountingViewPermissions.some((permission) =>
    resolvedPermissions.includes(permission),
  );
  // Without a navigator a link would be a dead control, so the panel stays
  // hidden rather than rendering references nobody can follow.
  const enabled = mayView && sourceId !== "" && navigate !== undefined;
  const related = useAccountingResource<{ readonly events: readonly RelatedEvent[] }>(
    accountingQueryKey(resolvedCompanyId, "related", { sourceId, sourceType }),
    (signal) =>
      enabled
        ? client.get<{ readonly events: readonly RelatedEvent[] }>(
            `related/${sourceType}/${encodeURIComponent(sourceId)}`,
            undefined,
            signal,
          )
        : Promise.resolve({ events: [] }),
  );

  if (!enabled || navigate === undefined) return null;
  if (related.loading) {
    return (
      <section className="accounting-preview-panel accounting-related-records">
        <h3>{t("accounting.related.title")}</h3>
        <p className="accounting-empty">{t("accounting.related.loading")}</p>
      </section>
    );
  }
  if (related.error !== undefined) {
    // A failed lookup must never take the operational screen down with it.
    return (
      <section className="accounting-preview-panel accounting-related-records">
        <h3>{t("accounting.related.title")}</h3>
        <p className="accounting-empty">{t("accounting.related.failed")}</p>
      </section>
    );
  }

  const events = related.data?.events ?? [];
  const records: RelatedRecord[] = [];
  if (events.length === 0) {
    records.push({
      emptyState: t("accounting.related.awaitingAccounting"),
      label: t("accounting.related.openJournal"),
    });
  }
  for (const event of events) {
    const eventName = eventTypeLabel(t, event.eventType);
    const journalNumber = (event.journalNumber ?? "").trim();
    const journalId = (event.journalId ?? "").trim();
    const journalPath = recordRoute("journal", journalId);
    records.push(
      journalNumber === "" || journalPath === undefined
        ? {
            // The Event exists but has not produced a Journal yet — its
            // processing status is the honest answer, not a blank cell.
            emptyState: accountingLabel(t, "accounting.status", event.processingStatus, {
              emptyLabel: t("accounting.related.journalNotCreated"),
            }),
            label: eventName,
          }
        : { label: eventName, path: journalPath, permitted: true, reference: journalNumber },
    );
    const reversalNumber = (event.reversalJournalNumber ?? "").trim();
    const reversalPath = recordRoute("journal", (event.reversalJournalId ?? "").trim());
    if (reversalNumber !== "" && reversalPath !== undefined) {
      records.push({
        label: t("accounting.related.reversalJournal"),
        path: reversalPath,
        permitted: true,
        reference: reversalNumber,
      });
    }
  }
  return <RelatedRecords onNavigate={navigate} records={records} />;
}
