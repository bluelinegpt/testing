import type { TFunction } from "i18next";

import { canAccessCompanyPath } from "../../app/company-access.js";
import { recordRoute, type RoutableRecord } from "./accounting-routes.js";
import { eventTypeLabel, subledgerReference } from "./accounting-labels.js";
import type { RelatedRecord } from "./RelatedRecords.js";

/**
 * Builds the Related Records list for each Accounting record type.
 *
 * Three rules hold everywhere in this module:
 *
 *  - The reference shown is always a business reference (Journal Number,
 *    Order Number, Payment Number). A record identifier is only ever used to
 *    build the route, never rendered.
 *  - A link appears only when a VERIFIED route exists (`accounting-routes.ts`)
 *    AND the User's permissions allow that route. The backend is the authority;
 *    this check only stops the UI from offering a door that will not open.
 *  - A relationship that does not exist yet still renders, with an explicit
 *    empty state. Blank cells and raw nulls are never shown.
 */

export interface RelatedContext {
  readonly permissions: readonly string[];
  readonly t: TFunction;
}

const text = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value.trim() : "";
};

/**
 * A relationship to a record that has a real detail screen.
 *
 * `identifier` is whatever that screen's route consumes — an id for Accounting
 * sections, an Order Number for Orders, a Code for Trader/Driver/Employee.
 */
function link(
  context: RelatedContext,
  type: RoutableRecord,
  identifier: string,
  label: string,
  reference: string,
  emptyState: string,
): RelatedRecord {
  if (reference === "") return { emptyState, label };
  const path = recordRoute(type, identifier);
  // No route means the identifier was missing, not that access was denied —
  // either way the reference is shown without a link.
  if (path === undefined) return { label, permitted: true, reference };
  if (!canAccessCompanyPath(path, context.permissions)) {
    return { label, permitted: false, reference };
  }
  return { label, path, permitted: true, reference };
}

/**
 * One Journal line's subledger, resolved to a business reference and — when a
 * verified route exists and the User may follow it — a link.
 *
 * `subledgerReference` does the field resolution (Phase 2 enrichment); this
 * adds the permission gate so the line table renders the same way as every
 * other Related Record on the screen.
 */
export function journalLineRelatedRecord(
  line: Record<string, unknown>,
  language: string,
  context: RelatedContext,
): RelatedRecord {
  const resolved = subledgerReference(line, language);
  const label = context.t("accounting.related.openRecord");
  if (resolved === undefined) {
    return { emptyState: context.t("accounting.related.notApplicable"), label };
  }
  if (resolved.path === undefined) {
    // Present but not navigable: no detail screen exists for this record type.
    return {
      disabledReason: context.t("accounting.related.noDetailScreen"),
      label,
      reference: resolved.label,
    };
  }
  if (!canAccessCompanyPath(resolved.path, context.permissions)) {
    return { label, permitted: false, reference: resolved.label };
  }
  return { label, path: resolved.path, permitted: true, reference: resolved.label };
}

/**
 * A link to a Journal from its identifier and number. Used by the Accounting
 * Event list, where the Journal cell is the same control on every row.
 */
export function journalLink(
  journalId: string,
  journalNumber: string,
  label: string,
  context: RelatedContext,
): RelatedRecord {
  return link(
    context,
    "journal",
    journalId,
    label,
    journalNumber,
    context.t("accounting.related.journalNotCreated"),
  );
}

/**
 * The operational record one Accounting Event row came from, resolved from the
 * list payload's own `sourceEntityType` / `sourceEntityId` / `sourceReference`.
 * No lookup: the capture trigger already stored the business reference.
 */
export function eventSourceRelatedRecord(
  row: Record<string, unknown>,
  context: RelatedContext,
): RelatedRecord | undefined {
  return sourceRecord(context, text(row, "sourceEntityType"), {
    id: text(row, "sourceEntityId"),
    reference: text(row, "sourceReference"),
  });
}

/** Journal detail: source Accounting Event, and the reversal pair. */
export function journalRelatedRecords(
  detail: Record<string, unknown>,
  context: RelatedContext,
): readonly RelatedRecord[] {
  const { t } = context;
  const eventReference = text(detail, "eventSourceReference");
  const eventType = text(detail, "accountingEventType");
  const records: RelatedRecord[] = [
    link(
      context,
      "accounting_event",
      text(detail, "accountingEventId"),
      t("accounting.related.originalEvent"),
      // An Event has no number of its own; its business reference is the
      // record that raised it, qualified by the Event Type.
      eventReference === ""
        ? eventType === ""
          ? ""
          : eventTypeLabel(t, eventType)
        : `${eventReference} — ${eventTypeLabel(t, eventType)}`,
      t("accounting.related.notApplicable"),
    ),
    link(
      context,
      "journal",
      text(detail, "originalJournalId"),
      t("accounting.related.originalJournal"),
      text(detail, "originalJournalNumber"),
      t("accounting.related.notApplicable"),
    ),
    link(
      context,
      "journal",
      text(detail, "reversalJournalId"),
      t("accounting.related.reversalJournal"),
      text(detail, "reversalJournalNumber"),
      t("accounting.related.notReversed"),
    ),
  ];
  const source = journalSourceRecord(detail, context);
  return source === undefined ? records : [source, ...records];
}

/**
 * The operational record a Journal came from.
 *
 * A Journal carries its own `source_entity_type` / `source_entity_id` /
 * `source_reference`; the Accounting Event that raised it carries the same
 * facts. The Journal's own columns are preferred and the Event's are the
 * fallback, because a Journal can exist without an Event (Manual Journal,
 * Opening Balance) but never the other way round.
 *
 * Returns `undefined` for a Journal with no operational source — a Manual
 * Journal shows no invented "Source" row.
 */
export function journalSourceRecord(
  detail: Record<string, unknown>,
  context: RelatedContext,
): RelatedRecord | undefined {
  const ownType = text(detail, "sourceEntityType");
  const type = ownType === "" ? text(detail, "eventSourceEntityType") : ownType;
  if (type === "") return undefined;
  const id = ownType === "" ? text(detail, "eventSourceEntityId") : text(detail, "sourceEntityId");
  const own = text(detail, "sourceReference");
  const reference = own === "" ? text(detail, "eventSourceReference") : own;
  return sourceRecord(context, type, { id, reference });
}

/** Accounting Event detail: the operational record, and both Journals. */
export function eventRelatedRecords(
  detail: Record<string, unknown>,
  context: RelatedContext,
): readonly RelatedRecord[] {
  const { t } = context;
  const records: RelatedRecord[] = [
    link(
      context,
      "journal",
      text(detail, "journalId"),
      t("accounting.related.openJournal"),
      text(detail, "journalNumber"),
      t("accounting.related.journalNotCreated"),
    ),
    link(
      context,
      "journal",
      text(detail, "reversalJournalId"),
      t("accounting.related.reversalJournal"),
      text(detail, "reversalJournalNumber"),
      t("accounting.related.notReversed"),
    ),
    link(
      context,
      "accounting_event",
      text(detail, "originalEventId"),
      t("accounting.related.originalEvent"),
      text(detail, "originalEventReference"),
      t("accounting.related.notApplicable"),
    ),
    // The reverse edge, resolved in the query layer rather than stored: the
    // Event that reverses this one. Both directions now navigate.
    link(
      context,
      "accounting_event",
      text(detail, "reversalEventId"),
      t("accounting.related.reversalEvent"),
      text(detail, "reversalEventReference"),
      t("accounting.related.notReversed"),
    ),
    // The Journal pair, so a posted Event reaches its reversal Journal and a
    // reversal Journal reaches the original.
    link(
      context,
      "journal",
      text(detail, "journalReversedByJournalId"),
      t("accounting.related.reversalJournal"),
      text(detail, "journalReversedByJournalNumber"),
      t("accounting.related.notReversed"),
    ),
    link(
      context,
      "journal",
      text(detail, "journalReversalOfJournalId"),
      t("accounting.related.originalJournal"),
      text(detail, "journalReversalOfJournalNumber"),
      t("accounting.related.notApplicable"),
    ),
  ];
  const source = sourceRecord(context, text(detail, "sourceEntityType"), {
    id: text(detail, "sourceEntityId"),
    reference: text(detail, "sourceReference"),
  });
  return source === undefined ? records : [source, ...records];
}

/**
 * Resolves the operational record an Accounting Event was raised from.
 *
 * `source_reference` on the Event already holds the business reference the
 * capture trigger recorded (Order Number, Settlement Number, Receivable
 * Number …), so nothing has to be looked up to display it. Only the ROUTE
 * differs by type — Orders route by Number, Accounting sections by id, and the
 * remaining types have no detail screen at all.
 */
function sourceRecord(
  context: RelatedContext,
  sourceType: string,
  source: { readonly id: string; readonly reference: string },
): RelatedRecord | undefined {
  const { t } = context;
  const notCreated = t("accounting.related.notCreated");
  switch (sourceType) {
    case "order":
      // Orders route by Order Number, which is exactly what the trigger stored.
      return link(
        context,
        "order",
        source.reference,
        t("accounting.related.order"),
        source.reference,
        notCreated,
      );
    case "general_expense":
      return link(
        context,
        "general_expense",
        source.id,
        t("accounting.related.generalExpense"),
        source.reference,
        notCreated,
      );
    case "general_expense_payment":
      return link(
        context,
        "expense_payment",
        source.id,
        t("accounting.related.expensePayment"),
        source.reference,
        notCreated,
      );
    case "cash_bank_movement":
      return link(
        context,
        "cash_bank_movement",
        source.id,
        t("accounting.related.cashBankMovement"),
        source.reference,
        notCreated,
      );
    case "trader_settlement":
      return link(
        context,
        "trader_settlement",
        source.id,
        t("accounting.related.traderSettlement"),
        source.reference,
        notCreated,
      );
    case "trader_receivable":
      return link(
        context,
        "trader_receivable",
        source.id,
        t("accounting.related.traderReceivable"),
        source.reference,
        notCreated,
      );
    case "trader_collection":
      return link(
        context,
        "trader_collection",
        source.id,
        t("accounting.related.traderCollection"),
        source.reference,
        notCreated,
      );
    case "driver_reconciliation":
      return link(
        context,
        "driver_collection",
        source.id,
        t("accounting.related.driverCollection"),
        source.reference,
        notCreated,
      );
    case "payroll_period":
      return link(
        context,
        "payroll_period",
        source.id,
        t("accounting.related.payrollPeriod"),
        source.reference,
        notCreated,
      );
    case "payroll_payment":
      return link(
        context,
        "payroll_payment",
        source.id,
        t("accounting.related.payrollPayment"),
        source.reference,
        notCreated,
      );
    case "outsourced_driver_fee_accrual":
      return link(
        context,
        "outsourced_driver_fee_accrual",
        source.id,
        t("accounting.related.driverFeeAccrual"),
        source.reference,
        notCreated,
      );
    case "outsourced_driver_fee_payment":
      return link(
        context,
        "outsourced_driver_fee_payment",
        source.id,
        t("accounting.related.driverFeePayment"),
        source.reference,
        notCreated,
      );
    // A Manual Journal has no operational source; nothing is shown rather than
    // an invented "Source" row.
    default:
      return undefined;
  }
}

/**
 * General Expense detail: the recognition Journal, its reversal, and every
 * Payment recorded against the Expense.
 *
 * `events` and `payments` already ship with the Expense detail response, so no
 * additional request is made and the panel cannot cause an N+1.
 */
export function expenseRelatedRecords(
  detail: Record<string, unknown>,
  context: RelatedContext,
): readonly RelatedRecord[] {
  const { t } = context;
  const events = Array.isArray(detail.events)
    ? (detail.events as readonly Record<string, unknown>[])
    : [];
  const payments = Array.isArray(detail.payments)
    ? (detail.payments as readonly Record<string, unknown>[])
    : [];
  const recognition = events.find(
    (event) => text(event, "sourceEntityType") === "general_expense",
  );
  const records: RelatedRecord[] = [
    link(
      context,
      "journal",
      recognition === undefined ? "" : text(recognition, "journalId"),
      t("accounting.related.recognitionJournal"),
      recognition === undefined ? "" : text(recognition, "journalNumber"),
      t("accounting.related.journalNotCreated"),
    ),
    link(
      context,
      "journal",
      recognition === undefined ? "" : text(recognition, "reversalJournalId"),
      t("accounting.related.reversalJournal"),
      recognition === undefined ? "" : text(recognition, "reversalJournalNumber"),
      t("accounting.related.notReversed"),
    ),
  ];
  if (payments.length === 0) {
    records.push({
      emptyState: t("accounting.related.noPaymentsRecorded"),
      label: t("accounting.related.payments"),
    });
    return records;
  }
  for (const payment of payments) {
    records.push(
      link(
        context,
        "expense_payment",
        text(payment, "id"),
        t("accounting.related.expensePayment"),
        text(payment, "paymentNumber"),
        t("accounting.related.paymentNotRecorded"),
      ),
    );
  }
  return records;
}

/** Expense Payment detail: the Expense it settles, its Event and its Journal. */
export function expensePaymentRelatedRecords(
  detail: Record<string, unknown>,
  context: RelatedContext,
): readonly RelatedRecord[] {
  const { t } = context;
  return [
    link(
      context,
      "general_expense",
      text(detail, "expenseId"),
      t("accounting.related.generalExpense"),
      text(detail, "expenseNumber"),
      t("accounting.related.notAvailable"),
    ),
    link(
      context,
      "accounting_event",
      text(detail, "accountingEventId"),
      t("accounting.related.openEvent"),
      // The Payment Number identifies the Event to the User; the Event itself
      // carries no separate business reference.
      text(detail, "accountingEventId") === "" ? "" : text(detail, "paymentNumber"),
      t("accounting.related.awaitingAccounting"),
    ),
    link(
      context,
      "journal",
      text(detail, "journalId"),
      t("accounting.related.paymentJournal"),
      text(detail, "journalNumber"),
      t("accounting.related.journalNotCreated"),
    ),
  ];
}

/**
 * The Cash or Bank Account on one side of a Movement, shown as
 * `Code — Name` and linked to whichever Account screen actually holds it.
 */
function movementEndpoint(
  detail: Record<string, unknown>,
  context: RelatedContext,
  side: "destination" | "source",
  label: string,
): RelatedRecord {
  const cashId = text(detail, `${side}_cash_account_id`);
  const isCash = cashId !== "";
  const code = text(detail, `${side}${isCash ? "Cash" : "Bank"}AccountCode`);
  const name = text(detail, `${side}${isCash ? "Cash" : "Bank"}AccountName`);
  return link(
    context,
    isCash ? "cash_account" : "bank_account",
    isCash ? cashId : text(detail, `${side}_bank_account_id`),
    label,
    code === "" ? "" : name === "" ? code : `${code} — ${name}`,
    context.t("accounting.related.notApplicable"),
  );
}

/** Cash/Bank Movement detail: its Event, its Journal, and the reversal pair. */
export function movementRelatedRecords(
  detail: Record<string, unknown>,
  context: RelatedContext,
): readonly RelatedRecord[] {
  const { t } = context;
  return [
    movementEndpoint(detail, context, "source", t("accounting.related.sourceAccount")),
    movementEndpoint(detail, context, "destination", t("accounting.related.destinationAccount")),
    link(
      context,
      "accounting_event",
      text(detail, "accountingEventId"),
      t("accounting.related.openEvent"),
      text(detail, "accountingEventId") === "" ? "" : text(detail, "movementNumber"),
      t("accounting.related.awaitingAccounting"),
    ),
    link(
      context,
      "journal",
      text(detail, "journalId"),
      t("accounting.related.openJournal"),
      text(detail, "journalNumber"),
      t("accounting.related.journalNotCreated"),
    ),
    link(
      context,
      "journal",
      text(detail, "reversalJournalId"),
      t("accounting.related.reversalJournal"),
      text(detail, "reversalJournalNumber"),
      t("accounting.related.notReversed"),
    ),
    link(
      context,
      "cash_bank_movement",
      text(detail, "reversalOfMovementId"),
      t("accounting.related.reverses"),
      text(detail, "reversalOfMovementNumber"),
      t("accounting.related.notApplicable"),
    ),
    link(
      context,
      "cash_bank_movement",
      text(detail, "reversedByMovementId"),
      t("accounting.related.reversedBy"),
      text(detail, "reversedByMovementNumber"),
      t("accounting.related.notReversed"),
    ),
  ];
}

/** Opening Balance detail: the Journal the batch posted, if it has posted. */
export function openingBalanceRelatedRecords(
  detail: Record<string, unknown>,
  context: RelatedContext,
): readonly RelatedRecord[] {
  const { t } = context;
  return [
    link(
      context,
      "journal",
      text(detail, "journalId"),
      t("accounting.related.openJournal"),
      text(detail, "journalNumber"),
      t("accounting.related.journalNotCreated"),
    ),
    link(
      context,
      "journal",
      text(detail, "reversalJournalId"),
      t("accounting.related.reversalJournal"),
      text(detail, "reversalJournalNumber"),
      t("accounting.related.notReversed"),
    ),
  ];
}
