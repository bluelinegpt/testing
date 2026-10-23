import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingEventQueryService } from "./accounting-event-query.service.js";
import { AccountingEventRepository } from "./accounting-event.repository.js";
import { AccountingReprocessPrecheckService } from "./accounting-reprocess-precheck.service.js";
import { accountingEventTypes, type AccountingEventType } from "./accounting.constants.js";
import { OperationalJournalPostingService } from "./operational-journal-posting.service.js";

/**
 * PLATFORM ACCOUNTING REPAIR ADAPTER (Phase 2, Prompt 4).
 *
 * Lets the Platform Repair Center diagnose and recover ONE failed accounting
 * event of ONE Company WITHOUT impersonating a Company user and WITHOUT any
 * weaker rule:
 *
 *   AUTHORIZATION   comes from the Platform (platform.companies.repair_center
 *                   .execute, checked by the controller/guard) -- never from a
 *                   borrowed Company identity;
 *   PRECONDITIONS   are the certified ones, run through the certified code:
 *                   `AccountingReprocessPrecheckService.precheckFor` (readiness
 *                   + the posting pipeline's own dry run: source, period,
 *                   mappings, balance, duplicates), plus the one refusal the
 *                   posting pipeline raises that the precheck does not report
 *                   (`accounting_event_actor_missing`).
 *
 * Execution is ONE transaction, owned by the caller (RepairExecutionService):
 * lock the Event row -> re-run the precheck under the lock -> the certified
 * re-queue (`AccountingEventQueryService.requeueInTransaction`, reviewer NULL:
 * a Platform administrator is not a Company account) -> the certified claim
 * (`AccountingEventRepository.claimInTransaction`) -> the certified posting
 * (`OperationalJournalPostingService.process`, which writes the Journal) ->
 * verification -> the caller's repair audit -> COMMIT. Any failure rolls back
 * everything; the Event is left exactly as it was. This adapter never writes
 * an accounting table itself.
 *
 * The Journal is attributed exactly as the background worker would attribute
 * it (to the Event's own operational actor); the Platform administrator is
 * recorded in the re-queue audit row and in `platform_repair_executions`.
 */

export type AccountingSupport = "SUPPORTED" | "UNSUPPORTED" | "MANUAL_REVIEW";

const REPAIR_CENTER_TYPES: readonly AccountingEventType[] = [
  "order_delivered",
  "trader_receivable_recognized",
  "trader_receivable_payment_received",
  "trader_credit_issued",
  "trader_settlement_confirmed",
  "driver_collection_confirmed",
  // Phase 5 Prompt 1: Payroll approval and Payroll payment (certified
  // loaders payrollApproval / payrollPayment, original actor = the Company
  // user who approved / paid, same posting core).
  "employee_payroll_approved",
  "employee_payroll_paid",
];
/** Forward types the posting pipeline loads, outside Repair Center domains. */
const OUT_OF_SCOPE_TYPES: readonly AccountingEventType[] = [
  "employee_variable_earnings_interim_paid",
  "employee_salary_advance_paid",
  "outsourced_driver_fee_accrued",
  "outsourced_driver_fee_paid",
  "general_expense_approved",
  "general_expense_payment_completed",
  "cash_deposit_confirmed",
  "cash_withdrawal_confirmed",
  "bank_deposit_confirmed",
  "bank_withdrawal_confirmed",
  "cash_to_bank_transfer_confirmed",
  "bank_to_cash_transfer_confirmed",
  "bank_to_bank_transfer_confirmed",
  "cash_to_cash_transfer_confirmed",
  "driver_collection_corrected",
];

/**
 * Phase 5 Prompt 1: the ONLY source type each promoted Payroll event is ever
 * captured with (`capture_payroll_period_accounting_event` /
 * `capture_payroll_payment_accounting_event`). An event of these types with
 * any other source was not produced by the certified capture, so it is never
 * a recovery candidate: out of scope, MANUAL_REVIEW (triage and Preview
 * agree).
 */
export const CERTIFIED_SOURCE_TYPES: Readonly<Record<string, string>> = {
  employee_payroll_approved: "payroll_period",
  employee_payroll_paid: "payroll_payment",
};

/** The support of ONE event: its type, narrowed by the certified source shape. */
export function accountingEventSupportOf(
  type: string,
  sourceEntityType: string,
): { support: AccountingSupport; reason: string } {
  const expected = CERTIFIED_SOURCE_TYPES[type];
  if (expected !== undefined && sourceEntityType !== expected) {
    return {
      reason: `A ${type} event is only ever captured for a ${expected}; this one points at a ${sourceEntityType}, so it was not produced by the certified capture and is never recovered automatically.`,
      support: "MANUAL_REVIEW",
    };
  }
  return accountingSupportOf(type);
}

function classifyType(type: string): { support: AccountingSupport; reason: string } {
  if ((REPAIR_CENTER_TYPES as readonly string[]).includes(type)) {
    return {
      reason: "Forward operational event the certified pipeline loads and posts; in Repair Center scope.",
      support: "SUPPORTED",
    };
  }
  if (type.endsWith("_reversed")) {
    return {
      reason:
        "Reversal event: posted by inverting the original Journal. Certified for the Company accounting screens, not enabled for Platform recovery yet.",
      support: "MANUAL_REVIEW",
    };
  }
  if ((OUT_OF_SCOPE_TYPES as readonly string[]).includes(type)) {
    return {
      reason: type.startsWith("employee_") || type.startsWith("outsourced_driver_")
        ? "Early-payment / driver-fee event: not certified for Platform recovery (Phase 5 covers Payroll approval and payment only)."
        : "Expense / cash-bank event: outside the Repair Center's order, receivable, settlement and collection domains.",
      support: "MANUAL_REVIEW",
    };
  }
  return {
    reason: "The posting pipeline has no forward source loader for this event type.",
    support: "UNSUPPORTED",
  };
}

/** The supported-event inventory (Part C), one row per declared event type. */
export const ACCOUNTING_EVENT_SUPPORT: Readonly<
  Record<AccountingEventType, { support: AccountingSupport; reason: string }>
> = Object.fromEntries(accountingEventTypes.map((type) => [type, classifyType(type)])) as Readonly<
  Record<AccountingEventType, { support: AccountingSupport; reason: string }>
>;

export function accountingSupportOf(eventType: string) {
  return classifyType(eventType);
}

/**
 * RECOVERY DECISION TABLE (Repair Center Phase 4, Prompt 1).
 *
 * The audited Platform recovery decision for EVERY declared event type while
 * GL Accounting is ON. While Accounting is OFF every type is
 * NOT_REQUIRED_WHEN_ACCOUNTING_OFF (operational finance runs with no GL; an
 * unresolved historical event is never recovered and never enables
 * Accounting). One capability, REPROCESS_ACCOUNTING_EVENT, executes the
 * SUPPORTED rows; the handler (`inspect`) decides per event.
 *
 *   SUPPORTED_READY        forward type with a certified source loader, a
 *                          deterministic mapping, the original operational
 *                          actor on the event and the same posting core: READY
 *                          for one event once the certified precheck passes.
 *   SUPPORTED_CONDITIONAL  as above, plus a type-specific precondition the
 *                          precheck does not prove (stated in `condition`).
 *   MANUAL_REVIEW          no certified Platform recovery: a person decides.
 *   OUT_OF_SCOPE_PHASE_4   certified for the Company screens, outside the
 *                          Phase 4 Repair Center domains (payroll -> Phase 5).
 *
 * BLOCKED is never a per-type decision: it is a per-event state (period,
 * mapping, actor, automatic posting...) that clears when the condition does.
 */
export type AccountingRecoveryDecision =
  | "SUPPORTED_READY"
  | "SUPPORTED_CONDITIONAL"
  | "BLOCKED"
  | "MANUAL_REVIEW"
  | "NOT_REQUIRED_WHEN_ACCOUNTING_OFF"
  | "OUT_OF_SCOPE_PHASE_4";

export interface AccountingRecoveryDecisionRow {
  readonly decision: Exclude<AccountingRecoveryDecision, "BLOCKED" | "NOT_REQUIRED_WHEN_ACCOUNTING_OFF">;
  readonly whenAccountingOff: "NOT_REQUIRED_WHEN_ACCOUNTING_OFF";
  readonly reason: string;
  /** Type-specific precondition (SUPPORTED_CONDITIONAL only). */
  readonly condition: string | null;
  /** The certified capture path today (trigger / service), or null. */
  readonly producer: string | null;
  /** The posting pipeline's forward loader, or how the type posts. */
  readonly posting: string;
  /** Whether a missing event of this type is detected by Accounting Health. */
  readonly missingDetection: boolean;
}

const PRODUCERS: Readonly<Partial<Record<AccountingEventType, string>>> = {
  order_delivered: "trigger capture_order_accounting_event (orders.delivery_status -> delivered)",
  order_recognition_reversed: "trigger capture_order_accounting_event (delivered -> returned_to_trader / cancelled)",
  trader_receivable_recognized: "trigger capture_trader_receivable_accounting_event (insert)",
  trader_receivable_reversed: "trigger capture_trader_receivable_accounting_event (-> cancelled / reversed)",
  trader_receivable_payment_received: "trigger capture_trader_collection_accounting_event (insert confirmed)",
  trader_receivable_payment_reversed: "trigger capture_trader_collection_accounting_event (confirmed -> reversed)",
  trader_credit_issued: "ReceivableOffsetReversalService.enqueueCreditPosting (only when the Settlement had GL involvement)",
  trader_settlement_confirmed: "trigger capture_trader_settlement_accounting_event (confirmed, reversal_of_id null)",
  trader_settlement_reversed: "trigger capture_trader_settlement_accounting_event (confirmed reversal Settlement)",
  driver_collection_confirmed: "trigger capture_driver_collection_accounting_event (confirmed, reversal_of_id null)",
  driver_collection_reversed: "trigger capture_driver_collection_accounting_event (confirmed reversal)",
  driver_collection_corrected: "trigger capture_order_correction_accounting_event (order correction with collection money)",
  employee_payroll_approved: "trigger capture_payroll_period_accounting_event",
  employee_payroll_reversed: "trigger capture_payroll_period_accounting_event",
  employee_payroll_paid: "trigger capture_payroll_payment_accounting_event",
  employee_payroll_payment_reversed: "trigger capture_payroll_payment_accounting_event",
  employee_variable_earnings_interim_paid: "trigger capture_employee_early_payment_accounting_event",
  employee_variable_earnings_interim_payment_reversed: "trigger capture_employee_early_payment_accounting_event",
  employee_salary_advance_paid: "trigger capture_employee_early_payment_accounting_event",
  employee_salary_advance_reversed: "trigger capture_employee_early_payment_accounting_event",
  outsourced_driver_fee_accrued: "trigger capture_driver_fee_accrual_accounting_event",
  outsourced_driver_fee_accrual_reversed: "trigger capture_driver_fee_accrual_accounting_event",
  outsourced_driver_fee_paid: "trigger capture_driver_fee_payment_accounting_event",
  outsourced_driver_fee_payment_reversed: "trigger capture_driver_fee_payment_accounting_event",
  general_expense_approved: "GeneralExpenseAccountingEventWriter",
  general_expense_payment_completed: "GeneralExpenseAccountingEventWriter",
  general_expense_reversed: "GeneralExpenseAccountingEventWriter",
  general_expense_payment_reversed: "GeneralExpenseAccountingEventWriter",
  cash_deposit_confirmed: "CashBankManagementService.enqueueEvent",
  cash_withdrawal_confirmed: "CashBankManagementService.enqueueEvent",
  bank_deposit_confirmed: "CashBankManagementService.enqueueEvent",
  bank_withdrawal_confirmed: "CashBankManagementService.enqueueEvent",
  cash_to_bank_transfer_confirmed: "CashBankManagementService.enqueueEvent",
  bank_to_cash_transfer_confirmed: "CashBankManagementService.enqueueEvent",
  bank_to_bank_transfer_confirmed: "CashBankManagementService.enqueueEvent",
  cash_to_cash_transfer_confirmed: "CashBankManagementService.enqueueEvent",
  cash_bank_movement_reversed: "CashBankManagementService.enqueueEvent",
};

/** Forward types whose missing event Accounting Health detects (mirrors the capture conditions). */
export const MISSING_EVENT_DETECTED_TYPES: readonly AccountingEventType[] = [
  "employee_payroll_approved",
  "employee_payroll_paid",
  "order_delivered",
  "trader_receivable_recognized",
  "trader_receivable_payment_received",
  "trader_credit_issued",
  "trader_settlement_confirmed",
  "driver_collection_confirmed",
];

function decisionOf(type: AccountingEventType): AccountingRecoveryDecisionRow {
  const producer = PRODUCERS[type] ?? null;
  const reversal = type.endsWith("_reversed");
  const base = {
    condition: null,
    missingDetection: (MISSING_EVENT_DETECTED_TYPES as readonly string[]).includes(type),
    posting: reversal
      ? "OperationalJournalPostingService.reverse (inverts the original Posted Journal)"
      : FORWARD_LOADER_TYPES.has(type)
        ? `OperationalSourceLoader.load -> OperationalJournalPostingService.process`
        : "none: OperationalSourceLoader has no forward loader (posting refuses accounting_event_source_conflict)",
    producer,
    whenAccountingOff: "NOT_REQUIRED_WHEN_ACCOUNTING_OFF" as const,
  };
  if (type === "trader_credit_issued") {
    return {
      ...base,
      condition:
        "The source Settlement's own trader_settlement_confirmed event must be Posted: the Credit's Journal clears the AR residual that Settlement's Journal left, and without it would CREATE an AR balance.",
      decision: "SUPPORTED_CONDITIONAL",
      reason: "Certified loader (traderCredit), deterministic mapping (order_cod_receivable / trader_payable), original actor on the event.",
    };
  }
  if ((REPAIR_CENTER_TYPES as readonly string[]).includes(type)) {
    return {
      ...base,
      decision: "SUPPORTED_READY",
      reason:
        "Certified forward loader, deterministic mapping, original operational actor on the event, same posting core; READY once the certified precheck passes for the event.",
    };
  }
  if (type.startsWith("employee_") || type.startsWith("outsourced_driver_fee_")) {
    return {
      ...base,
      decision: "OUT_OF_SCOPE_PHASE_4",
      reason:
        "Early-payment / outsourced driver fee accounting: not certified for Platform recovery; Phase 5 Prompt 1 certifies Payroll approval and payment only.",
    };
  }
  if (type.startsWith("general_expense_") || type.startsWith("cash_") || (type.startsWith("bank_") && type !== "bank_transfer_confirmed" && type !== "bank_transfer_reversed")) {
    return {
      ...base,
      decision: "OUT_OF_SCOPE_PHASE_4",
      reason:
        "Expense / cash-bank accounting: certified for the Company accounting screens, outside the Phase 4 Repair Center domains (orders, Trader receivables, credits, settlements, driver collections).",
    };
  }
  if (type === "driver_expense_confirmed" || type === "bank_transfer_confirmed" || type === "bank_transfer_reversed") {
    return {
      ...base,
      decision: "MANUAL_REVIEW",
      reason:
        "Legacy type: no current producer (no trigger, no service writes it) and no certified forward source loader, so the exact source cannot be reconstructed. No weak loader is created.",
    };
  }
  return {
    ...base,
    decision: "MANUAL_REVIEW",
    reason:
      "Reversal event: posts only by inverting the original Posted Journal, which depends on the original event's history; not fully provable for Platform recovery.",
  };
}

const FORWARD_LOADER_TYPES: ReadonlySet<string> = new Set([...REPAIR_CENTER_TYPES, ...OUT_OF_SCOPE_TYPES]);

export const ACCOUNTING_RECOVERY_DECISIONS: Readonly<Record<AccountingEventType, AccountingRecoveryDecisionRow>> =
  Object.fromEntries(accountingEventTypes.map((type) => [type, decisionOf(type)])) as Readonly<
    Record<AccountingEventType, AccountingRecoveryDecisionRow>
  >;

export function recoveryDecisionOf(eventType: string): AccountingRecoveryDecisionRow | undefined {
  return (ACCOUNTING_RECOVERY_DECISIONS as Readonly<Record<string, AccountingRecoveryDecisionRow>>)[eventType];
}

/** Integrity classifications of a posted / reversed event (never recovered automatically). */
export const ACCOUNTING_INTEGRITY_CODES = new Set([
  "ACCOUNTING_POSTED_WITHOUT_JOURNAL",
  "ACCOUNTING_JOURNAL_UNBALANCED",
  "ACCOUNTING_JOURNAL_LINKAGE_MISMATCH",
  "ACCOUNTING_DUPLICATE_EFFECTIVE_POSTING",
]);

export type AccountingRepairability = "NOT_REQUIRED" | "READY" | "BLOCKED" | "MANUAL_REVIEW";

export interface AccountingIssue {
  readonly code: string;
  readonly message: string;
}

/** Everything the fingerprint covers -- read in ONE statement. */
export interface AccountingEventState {
  readonly event: {
    readonly id: string;
    readonly eventType: string;
    readonly eventVersion: number;
    readonly processingStatus: string;
    readonly sourceEntityType: string;
    readonly sourceEntityId: string;
    readonly sourceReference: string | null;
    readonly effectiveAccountingDate: string | null;
    readonly operationalArea: string | null;
    readonly eventHash: string;
    readonly actorPresent: boolean;
    readonly journalId: string | null;
    readonly reversalOfEventId: string | null;
    readonly attemptCount: number;
    readonly maxAttempts: number;
    readonly failureCategory: string | null;
    readonly errorCode: string | null;
    readonly safeErrorSummary: string | null;
    readonly failedAt: string | null;
    readonly createdAt: string;
    readonly lockedStale: boolean;
  };
  readonly configuration: {
    readonly accountingEnabled: boolean;
    readonly automaticPostingEnabled: boolean;
    readonly areaEnabled: boolean;
    readonly version: string | null;
  };
  readonly period: {
    readonly id: string | null;
    readonly status: string | null;
    readonly yearStatus: string | null;
    readonly version: string | null;
    readonly matches: number;
  };
  readonly mappingsDigest: string;
  readonly accountsDigest: string;
  /** Every fiscal year / period status of the Company (a close anywhere changes it). */
  readonly periodsDigest: string;
  readonly postedJournalsForSource: number;
  readonly otherPostedEventsForSource: number;
  readonly sourceOrderId: string | null;
  /** Phase 4 Prompt 1: the event's original operational actor, as stored. */
  readonly actor: {
    readonly present: boolean;
    /** account_kind of the actor account (null when absent / not found). */
    readonly kind: string | null;
    readonly sameCompany: boolean;
    readonly status: string | null;
  };
  /** Phase 4 Prompt 1: the source record (Repair Center source types only). */
  readonly source: {
    /** null when the source type is outside the Repair Center domains. */
    readonly exists: boolean | null;
    /** md5 of the source row; any change to it makes a preview stale. */
    readonly digest: string | null;
  };
  /** Every Journal linked to this event (`accounting_event_id` or `journal_id`). */
  readonly eventJournals: { readonly count: number; readonly digest: string };
  /** The Journal the event points at (`journal_id`), with its integrity facts. */
  readonly linkedJournal: {
    readonly journalNumber: string;
    readonly status: string;
    readonly eventLinkMatches: boolean;
    readonly sourceMatches: boolean;
    readonly debit: string;
    readonly credit: string;
    readonly lines: number;
    readonly periodStatus: string | null;
  } | null;
  /** `trader_credit_issued` only: the source Settlement's own event is Posted. */
  readonly creditSettlementPosted: boolean | null;
}

export interface AccountingInspection {
  readonly state: AccountingEventState;
  readonly support: { readonly support: AccountingSupport; readonly reason: string };
  readonly repairability: AccountingRepairability;
  readonly blockers: readonly AccountingIssue[];
  readonly warnings: readonly AccountingIssue[];
  /** Why NOT_REQUIRED / MANUAL_REVIEW, in one code. */
  readonly classificationCode: string;
  readonly previewVersion: string;
  /** Only when the full certified precheck ran (supported, unresolved, Accounting ON). */
  readonly precheck?: {
    readonly accountingDate: string | null;
    readonly expectedDebitTotal: string;
    readonly expectedCreditTotal: string;
    readonly fiscalPeriodStatus: string | null;
    readonly resolvedMappings: readonly {
      readonly accountCode: string;
      readonly accountName: string;
      readonly amount: string;
      readonly entryIntent: string;
    }[];
  };
}

export interface AccountingRecoveryOutcome {
  readonly journalId: string;
  readonly journalNumber: string;
}

const UNRESOLVED = ["failed", "blocked_configuration"];
const ALREADY_DONE = ["posted", "ignored_duplicate", "ignored_no_accounting_required", "reversed"];

/** Precheck codes that mean "the GL already has this" -> nothing to repair. */
const NOT_REQUIRED_CODES = new Set([
  "event_already_posted",
  "event_journal_already_exists",
  "accounting_no_posting_required",
  "event_no_accounting_required",
]);
/** Precheck codes that are ambiguous history -> a person must decide. */
const AMBIGUOUS_CODES = new Set([
  "accounting_event_duplicate_posted",
  "accounting_journal_exists_for_source",
  "event_ignored_duplicate",
  "event_reversed",
]);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

/**
 * The Journal integrity of a Posted / Reversed event, from stored state only.
 * `undefined` when the Journal proves the posting.
 */
export function journalIntegrityDefect(
  state: AccountingEventState,
): { readonly code: string; readonly message: string } | undefined {
  const journal = state.linkedJournal;
  if (state.event.journalId === null || journal === null || !["posted", "reversed"].includes(journal.status)) {
    return {
      code: "ACCOUNTING_POSTED_WITHOUT_JOURNAL",
      message:
        "The event is recorded as posted but has no posted Journal. A Journal is never created blindly: whether the posting happened, failed or was removed must be established first.",
    };
  }
  if (!journal.eventLinkMatches || !journal.sourceMatches) {
    return {
      code: "ACCOUNTING_JOURNAL_LINKAGE_MISMATCH",
      message: "The event's Journal does not point back to this event and its source.",
    };
  }
  if (journal.lines < 2 || !new Decimal(journal.debit).greaterThan(0) || !new Decimal(journal.debit).equals(journal.credit)) {
    return {
      code: "ACCOUNTING_JOURNAL_UNBALANCED",
      message: "The event's Journal is not balanced. No balancing line is ever inserted; a certified reversal / repost must be decided by a person.",
    };
  }
  if (state.event.processingStatus === "posted" && state.otherPostedEventsForSource > 0) {
    return {
      code: "ACCOUNTING_DUPLICATE_EFFECTIVE_POSTING",
      message: "Another Posted event of the same type covers the same source: the source is posted more than once. History is never deleted automatically.",
    };
  }
  return undefined;
}

@Injectable()
export class PlatformAccountingRepairAdapter {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(AccountingEventQueryService) private readonly events: AccountingEventQueryService,
    @Inject(AccountingReprocessPrecheckService)
    private readonly prechecks: AccountingReprocessPrecheckService,
    @Inject(AccountingEventRepository) private readonly repository: AccountingEventRepository,
    @Inject(OperationalJournalPostingService)
    private readonly posting: OperationalJournalPostingService,
  ) {}

  /**
   * ONE statement: the Event, the Company's accounting configuration, the
   * fiscal period of its accounting date, mapping and chart-of-accounts
   * digests, and posted Journals / Events for the same source. Undefined when
   * the Event is not in this Company.
   */
  public async loadState(
    db: Kysely<DatabaseSchema>,
    companyId: string,
    eventId: string,
  ): Promise<AccountingEventState | undefined> {
    const result = await sql<{ state: AccountingEventState | null }>`
      with e as (
        select * from accounting_events
         where id = ${eventId}::uuid and company_id = ${companyId}::uuid
      ),
      c as (select * from accounting_configurations where company_id = ${companyId}::uuid),
      p as (
        select ap.id, ap.status, ap.version, y.status as year_status
          from accounting_periods ap
          join fiscal_years y on y.id = ap.fiscal_year_id and y.company_id = ap.company_id
          join e on true
         where ap.company_id = ${companyId}::uuid
           and coalesce(e.effective_accounting_date, (e.created_at at time zone 'Asia/Dubai')::date)
               between ap.period_start and ap.period_end
      )
      select case when not exists (select 1 from e) then null else json_build_object(
        'event', (select json_build_object(
            'id', id, 'eventType', event_type, 'eventVersion', event_version,
            'processingStatus', processing_status, 'sourceEntityType', source_entity_type,
            'sourceEntityId', source_entity_id, 'sourceReference', source_reference,
            'effectiveAccountingDate', effective_accounting_date::text,
            'operationalArea', operational_area, 'eventHash', event_hash,
            'actorPresent', actor_id is not null, 'journalId', journal_id,
            'reversalOfEventId', reversal_of_event_id, 'attemptCount', attempt_count,
            'maxAttempts', max_attempts, 'failureCategory', failure_category,
            'errorCode', error_code, 'safeErrorSummary', safe_error_summary,
            'failedAt', failed_at::text, 'createdAt', created_at::text,
            'lockedStale', processing_status = 'processing'
                           and processing_locked_at < now() - interval '5 minutes')
          from e),
        'configuration', json_build_object(
            'accountingEnabled', coalesce((select accounting_enabled from c), false),
            'automaticPostingEnabled', coalesce((select automatic_posting_enabled from c), false),
            'areaEnabled', coalesce((select (select operational_area from e) = any(automatic_posting_areas) from c), false),
            'version', (select version::text from c)),
        'period', json_build_object(
            'id', (select min(id::text) from p), 'status', (select min(status) from p),
            'yearStatus', (select min(year_status) from p), 'version', (select min(version::text) from p),
            'matches', (select count(*) from p)),
        'mappingsDigest', coalesce((select md5(string_agg(m::text, '|' order by m.id))
            from account_mappings m where m.company_id = ${companyId}::uuid), '-'),
        'accountsDigest', coalesce((select md5(string_agg(
              a.id::text || ':' || a.is_active::text || ':' || a.is_posting_account::text || ':' ||
              a.version::text, '|' order by a.id))
            from chart_of_accounts a where a.company_id = ${companyId}::uuid), '-'),
        'periodsDigest', coalesce((select md5(string_agg(
              ap.id::text || ':' || ap.status || ':' || ap.version::text || ':' || y.status || ':' || y.version::text,
              '|' order by ap.id))
            from accounting_periods ap
            join fiscal_years y on y.id = ap.fiscal_year_id and y.company_id = ap.company_id
           where ap.company_id = ${companyId}::uuid), '-'),
        'postedJournalsForSource', (select count(*) from journal_entries j, e
            where j.company_id = ${companyId}::uuid and j.source_entity_type = e.source_entity_type
              and j.source_entity_id = e.source_entity_id and j.status = 'posted'),
        'otherPostedEventsForSource', (select count(*) from accounting_events o, e
            where o.company_id = ${companyId}::uuid and o.id <> e.id
              and o.source_entity_type = e.source_entity_type
              and o.source_entity_id = e.source_entity_id and o.event_type = e.event_type
              and o.processing_status = 'posted'),
        'actor', (select json_build_object(
            'present', e.actor_id is not null, 'kind', a.account_kind,
            'sameCompany', coalesce(a.company_id = e.company_id, false), 'status', a.status)
            from e left join accounts a on a.id = e.actor_id),
        'source', (select case e.source_entity_type
            when 'order' then (select json_build_object('exists', count(*) > 0, 'digest', md5(string_agg(to_jsonb(x)::text, '')))
              from orders x where x.id = e.source_entity_id and x.company_id = e.company_id)
            when 'trader_receivable' then (select json_build_object('exists', count(*) > 0, 'digest', md5(string_agg(to_jsonb(x)::text, '')))
              from trader_receivables x where x.id = e.source_entity_id and x.company_id = e.company_id)
            when 'trader_collection' then (select json_build_object('exists', count(*) > 0, 'digest', md5(string_agg(to_jsonb(x)::text, '')))
              from trader_collections x where x.id = e.source_entity_id and x.company_id = e.company_id)
            when 'trader_credit' then (select json_build_object('exists', count(*) > 0, 'digest', md5(string_agg(to_jsonb(x)::text, '')))
              from trader_credits x where x.id = e.source_entity_id and x.company_id = e.company_id)
            when 'trader_settlement' then (select json_build_object('exists', count(*) > 0, 'digest', md5(string_agg(to_jsonb(x)::text, '')))
              from trader_settlements x where x.id = e.source_entity_id and x.company_id = e.company_id)
            when 'driver_reconciliation' then (select json_build_object('exists', count(*) > 0, 'digest', md5(string_agg(to_jsonb(x)::text, '')))
              from driver_reconciliations x where x.id = e.source_entity_id and x.company_id = e.company_id)
            when 'payroll_period' then (select json_build_object('exists', count(*) > 0, 'digest', md5(string_agg(to_jsonb(x)::text, '')))
              from payroll_periods x where x.id = e.source_entity_id and x.company_id = e.company_id)
            when 'payroll_payment' then (select json_build_object('exists', count(*) > 0, 'digest', md5(string_agg(to_jsonb(x)::text, '')))
              from payroll_payments x where x.id = e.source_entity_id and x.company_id = e.company_id)
            else json_build_object('exists', null, 'digest', null) end from e),
        'eventJournals', (select json_build_object('count', count(*),
              'digest', coalesce(md5(string_agg(j.id::text || ':' || j.status || ':' || j.version::text, '|' order by j.id)), '-'))
            from journal_entries j
           where j.id in (select x.id from journal_entries x, e
                           where x.company_id = e.company_id and x.accounting_event_id = e.id
                          union
                          select e.journal_id from e where e.journal_id is not null)
             and j.company_id = ${companyId}::uuid),
        'linkedJournal', (select json_build_object(
              'journalNumber', j.journal_number, 'status', j.status,
              'eventLinkMatches', j.accounting_event_id is not distinct from e.id,
              'sourceMatches', j.source_entity_type is not distinct from e.source_entity_type
                               and j.source_entity_id is not distinct from e.source_entity_id,
              'debit', coalesce((select sum(l.debit) from journal_lines l
                                  where l.company_id = j.company_id and l.journal_entry_id = j.id), 0)::text,
              'credit', coalesce((select sum(l.credit) from journal_lines l
                                   where l.company_id = j.company_id and l.journal_entry_id = j.id), 0)::text,
              'lines', (select count(*) from journal_lines l
                         where l.company_id = j.company_id and l.journal_entry_id = j.id),
              'periodStatus', (select ap.status from accounting_periods ap
                                where ap.id = j.accounting_period_id and ap.company_id = j.company_id))
            from e join journal_entries j on j.id = e.journal_id and j.company_id = e.company_id),
        'creditSettlementPosted', (select case when e.event_type <> 'trader_credit_issued' then null else
              exists (select 1 from trader_credits c
                        join accounting_events se on se.company_id = c.company_id
                         and se.source_entity_type = 'trader_settlement' and se.source_entity_id = c.source_settlement_id
                         and se.event_type = 'trader_settlement_confirmed' and se.processing_status = 'posted'
                       where c.id = e.source_entity_id and c.company_id = e.company_id) end from e),
        'sourceOrderId', (select case
            when e.source_entity_type = 'order' then e.source_entity_id::text
            when e.source_entity_type = 'trader_receivable' then (
              select o.id::text from trader_receivables r
                join orders o on o.company_id = r.company_id and o.order_number = r.source_reference
               where r.id = e.source_entity_id and r.company_id = e.company_id
                 and r.source_type = 'service_charge' limit 1)
            else null end from e)
      ) end as state
    `.execute(db);
    return result.rows[0]?.state ?? undefined;
  }

  /** The fingerprint: sha256 over the canonical state; no timestamps of the read. */
  public fingerprint(state: AccountingEventState): string {
    return `rcv1:${createHash("sha256").update(canonical(state)).digest("hex")}`;
  }

  /**
   * Classify ONE Event from current state. Runs the full certified precheck
   * only when it can matter (supported, unresolved, Accounting ON).
   *
   * `db` is the EXECUTION transaction, or `null` for a preview: the certified
   * precheck's pipeline steps take `FOR SHARE` row locks (mapping resolver,
   * source loader), which PostgreSQL refuses inside a READ ONLY transaction,
   * and a caught SQL error would abort any enclosing transaction. A preview
   * therefore runs exactly like the Company precheck -- autocommit
   * statements on the pool -- and writes nothing (proven by the tests'
   * content checksums).
   */
  public async inspect(
    db: Kysely<DatabaseSchema> | null,
    companyId: string,
    eventId: string,
  ): Promise<AccountingInspection | undefined> {
    if (db === null) return this.inspect(this.database, companyId, eventId);
    const state = await this.loadState(db, companyId, eventId);
    if (state === undefined) return undefined;
    const support = accountingEventSupportOf(state.event.eventType, state.event.sourceEntityType);
    const base = { previewVersion: this.fingerprint(state), state, support };
    const status = state.event.processingStatus;
    const issue = (code: string, message: string): AccountingIssue => ({ code, message });

    // Phase 4 Prompt 1: a Posted / Reversed event is only "done" when its
    // Journal proves it. Integrity defects are never recovered automatically
    // (no balancing line, no second Journal, no deletion): MANUAL_REVIEW.
    if (status === "posted" || status === "reversed") {
      const defect = journalIntegrityDefect(state);
      if (defect !== undefined) {
        return {
          ...base,
          blockers: [],
          classificationCode: defect.code,
          repairability: "MANUAL_REVIEW",
          warnings: [issue(defect.code, defect.message)],
        };
      }
    }
    if (UNRESOLVED.includes(status) && (state.event.journalId !== null || state.eventJournals.count > 0)) {
      return {
        ...base,
        blockers: [],
        classificationCode: "ACCOUNTING_JOURNAL_LINKAGE_MISMATCH",
        repairability: "MANUAL_REVIEW",
        warnings: [
          issue(
            "ACCOUNTING_JOURNAL_LINKAGE_MISMATCH",
            "A Journal is linked to this event although the event is not Posted. Reprocessing could create a second effective Journal; a person must decide.",
          ),
        ],
      };
    }
    if (ALREADY_DONE.includes(status) || state.event.journalId !== null) {
      return {
        ...base,
        blockers: [],
        classificationCode: status === "posted" ? "ACCOUNTING_EVENT_POSTED" : "ACCOUNTING_EVENT_RESOLVED",
        repairability: "NOT_REQUIRED",
        warnings: [],
      };
    }
    if (status === "received" || status === "retry_pending") {
      return {
        ...base,
        blockers: [],
        classificationCode: "ACCOUNTING_EVENT_QUEUED",
        repairability: "NOT_REQUIRED",
        warnings: [issue("ACCOUNTING_EVENT_QUEUED", "The event is queued for the normal posting processor.")],
      };
    }
    if (status === "processing") {
      return {
        ...base,
        blockers: [
          issue(
            "ACCOUNTING_EVENT_PROCESSING",
            state.event.lockedStale
              ? "The event has been processing for more than 5 minutes; the processor's stale-lock recovery releases it."
              : "The event is being processed right now.",
          ),
        ],
        classificationCode: state.event.lockedStale ? "ACCOUNTING_EVENT_STUCK" : "ACCOUNTING_EVENT_PROCESSING",
        repairability: "BLOCKED",
        warnings: [],
      };
    }
    if (!UNRESOLVED.includes(status)) {
      return {
        ...base,
        blockers: [],
        classificationCode: "ACCOUNTING_EVENT_STATUS_UNKNOWN",
        repairability: "MANUAL_REVIEW",
        warnings: [issue("ACCOUNTING_EVENT_STATUS_UNKNOWN", `Status '${status}' is not a recoverable state.`)],
      };
    }
    // Unresolved (failed / blocked_configuration) from here on.
    if (!state.configuration.accountingEnabled) {
      // Phase 1 semantics: GL Accounting OFF -> operational finance runs with
      // no GL; a historical unresolved event is not recovered (and Accounting
      // is never switched on from here).
      return {
        ...base,
        blockers: [],
        classificationCode: "ACCOUNTING_OFF_HISTORICAL",
        repairability: "NOT_REQUIRED",
        warnings: [
          issue(
            "ACCOUNTING_OFF_HISTORICAL",
            "GL Accounting is OFF: this historical event is not recovered; operational finance does not need it.",
          ),
        ],
      };
    }
    if (support.support !== "SUPPORTED") {
      return {
        ...base,
        blockers: [],
        classificationCode: support.support === "UNSUPPORTED" ? "ACCOUNTING_EVENT_UNSUPPORTED" : "ACCOUNTING_EVENT_OUT_OF_SCOPE",
        repairability: "MANUAL_REVIEW",
        warnings: [issue("NO_CERTIFIED_PLATFORM_RECOVERY", support.reason)],
      };
    }
    // The certified precheck, wholesale.
    const precheck = await this.prechecks.precheckFor(db, companyId, eventId);
    const blockers: AccountingIssue[] = precheck.blockers.map((blocker) => ({
      code: blocker.code,
      message: blocker.message,
    }));
    // The posting pipeline refuses an Event with no operational actor
    // (`accounting_event_actor_missing`); the precheck does not report it.
    if (!state.event.actorPresent) {
      blockers.push(
        issue("accounting_event_actor_missing", "The operational Event has no accountable actor; posting refuses it."),
      );
    } else if (state.actor.kind !== "company_user" || !state.actor.sameCompany) {
      // Phase 4 Prompt 1: the Journal is attributed to the event's ORIGINAL
      // operational actor. Only a Company user of THIS Company can be that
      // actor -- never a Platform administrator, another Company's user or a
      // fabricated id. The Repair Center never substitutes another actor.
      blockers.push(
        issue(
          "accounting_event_actor_invalid",
          "The event's original actor is not a Company user of this Company; the Journal cannot be attributed to it and no other actor is substituted.",
        ),
      );
    }
    if (state.event.eventType === "trader_credit_issued" && state.creditSettlementPosted !== true) {
      blockers.push(
        issue(
          "trader_credit_settlement_not_posted",
          "The Credit's source Settlement has no Posted accounting event; posting the Credit would create an AR balance instead of clearing the Settlement's residual.",
        ),
      );
    }
    const warnings = precheck.warnings.map((warning) => ({ code: warning.code, message: warning.message }));
    const details = {
      accountingDate: precheck.accountingDate,
      expectedCreditTotal: precheck.expectedCreditTotal,
      expectedDebitTotal: precheck.expectedDebitTotal,
      fiscalPeriodStatus: precheck.fiscalPeriod.status,
      resolvedMappings: precheck.resolvedMappings.map((mapping) => ({
        accountCode: mapping.accountCode,
        accountName: mapping.accountName,
        amount: mapping.amount,
        entryIntent: mapping.entryIntent,
      })),
    };
    // A zero-money Driver Collection is now a precheck WARNING (the Company's
    // Reprocess settles it), not a blocker -- for this Platform repair, which
    // only ever posts a Journal, it is still "posting not required".
    if (
      blockers.some((blocker) => NOT_REQUIRED_CODES.has(blocker.code)) ||
      warnings.some((warning) => warning.code === "accounting_no_posting_required")
    ) {
      return { ...base, blockers, classificationCode: "ACCOUNTING_POSTING_NOT_REQUIRED", precheck: details, repairability: "NOT_REQUIRED", warnings };
    }
    if (blockers.some((blocker) => AMBIGUOUS_CODES.has(blocker.code))) {
      return { ...base, blockers, classificationCode: "ACCOUNTING_HISTORY_AMBIGUOUS", precheck: details, repairability: "MANUAL_REVIEW", warnings };
    }
    return {
      ...base,
      blockers,
      classificationCode: blockers.length > 0 ? "ACCOUNTING_PRECHECK_BLOCKED" : "ACCOUNTING_PRECHECK_PASSED",
      precheck: details,
      repairability: blockers.length > 0 ? "BLOCKED" : "READY",
      warnings,
    };
  }

  /** Locks the Event row (FOR UPDATE) inside the caller's transaction. */
  public async lockEvent(transaction: Kysely<DatabaseSchema>, companyId: string, eventId: string): Promise<boolean> {
    const locked = await sql<{ id: string }>`
      select id from accounting_events
       where id = ${eventId}::uuid and company_id = ${companyId}::uuid for update
    `.execute(transaction);
    return locked.rows[0] !== undefined;
  }

  /**
   * The certified recovery, on the caller's (locked) transaction. The caller
   * has just re-proven READY under the lock with an unchanged fingerprint.
   */
  public async reprocessInTransaction(
    transaction: Kysely<DatabaseSchema>,
    input: { readonly companyId: string; readonly eventId: string; readonly reason: string; readonly correlationId: string },
  ): Promise<AccountingRecoveryOutcome> {
    const readiness = await this.events.reprocessingReadinessFor(transaction, input.companyId, input.eventId);
    if (!readiness.eligible) {
      throw new ApplicationException(
        "accounting_event_not_reprocessable",
        "This Accounting Event cannot be reprocessed yet",
        HttpStatus.CONFLICT,
        readiness.blockers,
      );
    }
    await this.events.requeueInTransaction(transaction, {
      companyId: input.companyId,
      correlationId: input.correlationId,
      eventId: input.eventId,
      readiness,
      reason: input.reason,
      reviewerAccountId: null,
    });
    const record = await this.repository.claimInTransaction(
      transaction,
      input.companyId,
      input.eventId,
      `platform-repair-${randomUUID()}`,
    );
    if (record === undefined) {
      throw new ApplicationException(
        "accounting_event_not_claimable",
        "The Accounting Event could not be claimed for posting",
        HttpStatus.CONFLICT,
      );
    }
    const outcome = await this.posting.process(transaction, record);
    if (outcome === null) {
      // The Event needed no Journal (a Driver Collection that moved no money)
      // and was settled as ignored_no_accounting_required. This repair's
      // contract is "a Journal was posted"; refusing rolls the transaction
      // back, so nothing changes here. The Company's own Reprocess action
      // settles it.
      throw new ApplicationException(
        "accounting_no_posting_required",
        "This Accounting Event has nothing to post; use Reprocess on the Company's Accounting Events screen",
        HttpStatus.CONFLICT,
      );
    }
    return outcome;
  }

  /**
   * Success means: Event posted and owning exactly the Journal just written;
   * that Journal posted, in this Company, for the Event's source, balanced and
   * non-empty; no second posted Journal / Event for the same source.
   */
  public async verifyPosted(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
    eventId: string,
    outcome: AccountingRecoveryOutcome,
  ): Promise<readonly string[]> {
    const result = await sql<{
      status: string;
      journalId: string | null;
      journalStatus: string | null;
      journalCompany: string | null;
      sourceMatches: boolean;
      debit: string;
      credit: string;
      lines: number;
      postedJournalsForSource: number;
      otherPostedEvents: number;
    }>`
      select e.processing_status as status, e.journal_id as "journalId", j.status as "journalStatus",
             j.company_id::text as "journalCompany",
             coalesce(j.source_entity_type = e.source_entity_type and j.source_entity_id = e.source_entity_id
                      and j.accounting_event_id = e.id, false) as "sourceMatches",
             coalesce((select sum(debit) from journal_lines l
                        where l.company_id = e.company_id and l.journal_entry_id = j.id), 0)::text as debit,
             coalesce((select sum(credit) from journal_lines l
                        where l.company_id = e.company_id and l.journal_entry_id = j.id), 0)::text as credit,
             (select count(*)::int from journal_lines l
               where l.company_id = e.company_id and l.journal_entry_id = j.id) as lines,
             (select count(*)::int from journal_entries x
               where x.company_id = e.company_id and x.source_entity_type = e.source_entity_type
                 and x.source_entity_id = e.source_entity_id and x.status = 'posted'
                 and x.accounting_event_id = e.id) as "postedJournalsForSource",
             (select count(*)::int from accounting_events o
               where o.company_id = e.company_id and o.id <> e.id and o.event_type = e.event_type
                 and o.source_entity_type = e.source_entity_type and o.source_entity_id = e.source_entity_id
                 and o.processing_status = 'posted') as "otherPostedEvents"
        from accounting_events e
        left join journal_entries j on j.id = e.journal_id and j.company_id = e.company_id
       where e.id = ${eventId}::uuid and e.company_id = ${companyId}::uuid
    `.execute(transaction);
    const row = result.rows[0];
    const failures: string[] = [];
    if (row === undefined) return ["event not found"];
    if (row.status !== "posted") failures.push(`event status is ${row.status}`);
    if (row.journalId !== outcome.journalId) failures.push("event does not own the new journal");
    if (row.journalStatus !== "posted") failures.push(`journal status is ${row.journalStatus}`);
    if (row.journalCompany !== companyId) failures.push("journal company mismatch");
    if (!row.sourceMatches) failures.push("journal source does not match the event");
    if (row.lines < 2 || !new Decimal(row.debit).greaterThan(0) || !new Decimal(row.debit).equals(row.credit)) {
      failures.push("journal is not balanced");
    }
    if (row.postedJournalsForSource !== 1) failures.push(`${row.postedJournalsForSource} posted journals for the event`);
    if (row.otherPostedEvents !== 0) failures.push("another posted event covers the same source");
    return failures;
  }
}
