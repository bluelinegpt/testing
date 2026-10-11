import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";

import {
  ACCOUNTING_INTEGRITY_CODES,
  type AccountingInspection,
  type AccountingRecoveryDecisionRow,
  type AccountingRepairability,
  PlatformAccountingRepairAdapter,
  recoveryDecisionOf,
} from "../accounting/platform-accounting-repair.adapter.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { findingIdOf, type FindingSeverity, type RepairIssue } from "./repair-center.model.js";
import { RepairOrderingService } from "./repair-ordering.service.js";
import { PLATFORM_REPAIR_CENTER_EXECUTE_PERMISSION } from "./repair-preview.service.js";

/**
 * REPAIR CENTER -- ACCOUNTING EVENT FINDING DETAILS + RECOVERY PREVIEW
 * (Phase 2, Prompt 4). Read-only (writes nothing): every call recomputes from
 * the database through
 * `PlatformAccountingRepairAdapter.inspect` (the certified precheck).
 *
 * The finding is event-centric: its id is derived from (Company, Event,
 * ACCOUNTING_EVENT_UNRESOLVED) and it is CURRENT only while the Event is
 * unresolved (failed / blocked_configuration). No raw payload, metadata or
 * customer data is returned.
 */

export const ACCOUNTING_FINDING_REASON = "ACCOUNTING_EVENT_UNRESOLVED";
export const ACCOUNTING_CAPABILITY = "REPROCESS_ACCOUNTING_EVENT";

export interface AccountingFinding {
  readonly findingId: string;
  readonly companyId: string;
  readonly eventId: string;
  readonly domain: "ACCOUNTING";
  readonly entityType: "accounting_event";
  readonly entityId: string;
  readonly entityNumber: string;
  readonly health: "HEALTHY" | "ISSUE" | "REVIEW";
  readonly severity: FindingSeverity;
  readonly reasonCode: string;
  readonly classificationCode: string;
  readonly current: boolean;
  readonly title: string;
  readonly summary: string;
  readonly detectedState: string;
  readonly expectedState: string;
  readonly recommendedAction: string;
  readonly repairCapability: string | null;
  readonly repairability: AccountingRepairability;
  readonly blockers: readonly RepairIssue[];
  readonly warnings: readonly RepairIssue[];
  readonly detectedAt: string;
}

export interface AccountingEventDetails {
  readonly companyId: string;
  readonly eventId: string;
  readonly event: {
    readonly eventType: string;
    readonly status: string;
    readonly sourceType: string;
    readonly businessReference: string | null;
    readonly accountingDate: string | null;
    readonly attempts: number;
    readonly maxAttempts: number;
    readonly failureCategory: string | null;
    readonly failureCode: string | null;
    readonly failureSummary: string | null;
    readonly failedAt: string | null;
  };
  readonly support: AccountingInspection["support"];
  readonly accountingMode: { readonly enabled: boolean; readonly automaticPostingEnabled: boolean };
  readonly finding: AccountingFinding;
  readonly sourceOrderId: string | null;
  /** Administrative diagnostics: the certified precheck's own figures (account codes only). */
  readonly diagnostics: {
    readonly fiscalPeriod: { readonly status: string | null; readonly yearStatus: string | null };
    readonly areaEnabled: boolean;
    readonly actorPresent: boolean;
    readonly postedJournalsForSource: number;
    readonly otherPostedEventsForSource: number;
    readonly precheck: AccountingInspection["precheck"] | null;
  };
  /** Phase 4 Prompt 1: decision, source, actor, period, mappings, journals, investigation. */
  readonly recovery: AccountingRecoveryContext;
  readonly previewVersion: string;
  readonly generatedAt: string;
}

export interface AccountingRecoveryPreview {
  readonly companyId: string;
  readonly eventId: string;
  readonly businessReference: string | null;
  readonly finding: AccountingFinding;
  readonly repairability: AccountingRepairability;
  readonly proposedRepair: {
    readonly capabilityCode: string;
    readonly title: string;
    readonly explanation: string;
    readonly executionHandler: string;
    readonly candidateOnly: boolean;
  } | null;
  readonly currentState: Readonly<Record<string, string | number | boolean | null>>;
  readonly proposedChanges: readonly {
    readonly entityType: string;
    readonly action: "create" | "update" | "delete" | "none";
    readonly entityNumber: string | null;
    readonly description: string;
    readonly details: Readonly<Record<string, string | number | boolean | null>>;
  }[];
  readonly preservedHistory: readonly { readonly entityType: string; readonly entityNumber: string | null; readonly description: string }[];
  readonly blockers: readonly RepairIssue[];
  readonly warnings: readonly RepairIssue[];
  readonly requiredInputs: readonly { readonly name: string; readonly required: boolean; readonly description: string }[];
  readonly requiredPermission: string;
  readonly domainPermissionEquivalent: string;
  readonly idempotencyKeyBasis: string | null;
  readonly accountingMode: { readonly enabled: boolean; readonly automaticPostingEnabled: boolean };
  readonly previewVersion: string;
  readonly execution: { readonly available: boolean; readonly reason: string; readonly requiredPlatformPermission: string };
  /** Phase 4 Prompt 1: everything the administrator checks before executing. */
  readonly recovery: AccountingRecoveryContext;
  readonly generatedAt: string;
}

/**
 * Phase 4 Prompt 1 -- the recovery context shown by Preview (and by the
 * manual-review explanation): the audited decision for the type, the source,
 * the original actor, the fiscal period, the mapping state, the existing
 * Journal(s) and their balance, the planned operation and what must be true
 * afterwards. Built from the one state read and the certified precheck; no
 * query of its own.
 */
export interface AccountingRecoveryContext {
  readonly decision: AccountingRecoveryDecisionRow | null;
  readonly source: {
    readonly type: string;
    readonly reference: string | null;
    readonly state: "PRESENT" | "MISSING" | "NOT_TRACKED";
  };
  readonly originalActor: {
    readonly state: "VALID" | "MISSING" | "INVALID";
    readonly accountKind: string | null;
    readonly accountStatus: string | null;
    readonly note: string;
  };
  readonly fiscalPeriod: { readonly status: string | null; readonly yearStatus: string | null; readonly matches: number };
  readonly mappings: {
    readonly state: "RESOLVED" | "UNRESOLVED" | "NOT_EVALUATED";
    readonly lines: readonly { readonly accountCode: string; readonly accountName: string; readonly amount: string; readonly entryIntent: string }[];
    readonly blockerCodes: readonly string[];
  };
  readonly existingJournals: {
    readonly linkedToEvent: number;
    readonly postedForSource: number;
    readonly otherPostedEventsForSource: number;
    readonly eventJournal: {
      readonly journalNumber: string;
      readonly status: string;
      readonly balanced: boolean;
      readonly debit: string;
      readonly credit: string;
      readonly lines: number;
    } | null;
  };
  readonly plannedOperation: string;
  readonly postRecoveryExpectation: string;
  readonly blocker: string | null;
  readonly recommendedInvestigation: readonly string[];
}

const MAPPING_CODE = /mapping|account_inactive|account_not|posting_account|control_account/u;

export function recoveryContextOf(inspection: AccountingInspection): AccountingRecoveryContext {
  const { state } = inspection;
  const journal = state.linkedJournal;
  const balanced =
    journal !== null && journal.lines >= 2 && Number(journal.debit) > 0 && journal.debit === journal.credit;
  const actorState: AccountingRecoveryContext["originalActor"]["state"] = !state.actor.present
    ? "MISSING"
    : state.actor.kind === "company_user" && state.actor.sameCompany
      ? "VALID"
      : "INVALID";
  const mappingBlockers = inspection.blockers.filter((blocker) => MAPPING_CODE.test(blocker.code)).map((b) => b.code);
  const ready = inspection.repairability === "READY";
  const investigation: string[] = [];
  switch (inspection.classificationCode) {
    case "ACCOUNTING_POSTED_WITHOUT_JOURNAL":
      investigation.push(
        "Find whether a Journal for this source exists under another event or was removed; compare the event's processing timeline with the Journal register.",
        "Do not create a Journal from the Repair Center: decide with the Company accountant whether a certified repost is required.",
      );
      break;
    case "ACCOUNTING_JOURNAL_UNBALANCED":
      investigation.push(
        "Compare the Journal's lines with the source's financial components; identify the missing or altered line.",
        "A balancing line is never inserted: the Company reverses and reposts through its certified Journal workflow.",
      );
      break;
    case "ACCOUNTING_JOURNAL_LINKAGE_MISMATCH":
      investigation.push(
        "Identify which event owns the Journal (accounting_event_id) and which source it posts; confirm the source was not posted twice.",
      );
      break;
    case "ACCOUNTING_DUPLICATE_EFFECTIVE_POSTING":
    case "ACCOUNTING_HISTORY_AMBIGUOUS":
      investigation.push(
        "List every Posted event and Journal for this source; decide which one is the intended posting.",
        "History is never deleted automatically; the Company reverses the duplicate through its certified Journal reversal.",
      );
      break;
    default:
      if (inspection.repairability === "MANUAL_REVIEW") {
        investigation.push("Review the event type's decision and the source record with the Company accountant.");
      }
  }
  return {
    blocker: inspection.repairability === "BLOCKED" ? (inspection.blockers[0]?.code ?? null) : null,
    decision: recoveryDecisionOf(state.event.eventType) ?? null,
    existingJournals: {
      eventJournal:
        journal === null
          ? null
          : {
              balanced,
              credit: journal.credit,
              debit: journal.debit,
              journalNumber: journal.journalNumber,
              lines: journal.lines,
              status: journal.status,
            },
      linkedToEvent: state.eventJournals.count,
      otherPostedEventsForSource: state.otherPostedEventsForSource,
      postedForSource: state.postedJournalsForSource,
    },
    fiscalPeriod: { matches: state.period.matches, status: state.period.status, yearStatus: state.period.yearStatus },
    mappings: {
      blockerCodes: mappingBlockers,
      lines: inspection.precheck?.resolvedMappings ?? [],
      state: inspection.precheck === undefined ? "NOT_EVALUATED" : mappingBlockers.length > 0 ? "UNRESOLVED" : "RESOLVED",
    },
    originalActor: {
      accountKind: state.actor.kind,
      accountStatus: state.actor.status,
      note:
        "The Journal is attributed to the event's original operational actor, exactly as the background processor would. The Platform administrator is the operator, recorded in the re-queue audit and the repair execution -- never the Company accounting actor.",
      state: actorState,
    },
    plannedOperation: ready
      ? "REPROCESS_ACCOUNTING_EVENT: lock -> recompute -> certified precheck -> re-queue -> claim -> the same posting core, synchronously -> verify -> audit -> commit."
      : "None: no recovery is executed for this classification.",
    postRecoveryExpectation: ready
      ? "Exactly one Posted, balanced Journal owned by this event, for this source and Company; the event Posted; no other effective posting for the source."
      : "Nothing changes.",
    recommendedInvestigation: investigation,
    source: {
      reference: state.event.sourceReference,
      state: state.source.exists === null ? "NOT_TRACKED" : state.source.exists ? "PRESENT" : "MISSING",
      type: state.event.sourceEntityType,
    },
  };
}

export function accountingFindingOf(
  companyId: string,
  eventId: string,
  inspection: AccountingInspection,
  detectedAt: string,
): AccountingFinding {
  const { state } = inspection;
  // Phase 4 Prompt 1: a Journal-integrity defect of a posted event is a
  // current ISSUE (never recovered automatically -- MANUAL_REVIEW).
  const integrity = ACCOUNTING_INTEGRITY_CODES.has(inspection.classificationCode);
  const unresolved = ["failed", "blocked_configuration"].includes(state.event.processingStatus) || integrity;
  const health: AccountingFinding["health"] = integrity
    ? "ISSUE"
    : inspection.repairability === "NOT_REQUIRED"
      ? "HEALTHY"
      : inspection.repairability === "MANUAL_REVIEW"
        ? "REVIEW"
        : "ISSUE";
  return {
    blockers: inspection.blockers,
    classificationCode: inspection.classificationCode,
    companyId,
    current: unresolved,
    detectedAt,
    detectedState: integrity
      ? `Accounting event ${state.event.eventType} is ${state.event.processingStatus}: ${inspection.classificationCode}.`
      : unresolved
      ? `Accounting event ${state.event.eventType} is ${state.event.processingStatus}` +
        (state.event.errorCode === null ? "" : ` (${state.event.errorCode})`) +
        ` after ${state.event.attemptCount} attempt(s).`
      : `Accounting event ${state.event.eventType} is ${state.event.processingStatus}.`,
    domain: "ACCOUNTING",
    entityId: eventId,
    entityNumber: state.event.sourceReference ?? eventId,
    entityType: "accounting_event",
    eventId,
    expectedState: "The event posted once through the certified pipeline, owning one balanced Journal.",
    findingId: findingIdOf(companyId, eventId, ACCOUNTING_FINDING_REASON),
    health,
    reasonCode: ACCOUNTING_FINDING_REASON,
    recommendedAction:
      inspection.repairability === "READY"
        ? "reprocess_accounting_event"
        : inspection.repairability === "BLOCKED"
          ? "resolve_blockers"
          : inspection.repairability === "MANUAL_REVIEW"
            ? "manual_review"
            : "none",
    repairCapability:
      inspection.support.support === "SUPPORTED" && unresolved && !integrity ? ACCOUNTING_CAPABILITY : null,
    repairability: inspection.repairability,
    severity: health === "ISSUE" ? "high" : health === "REVIEW" ? "medium" : "none",
    summary: state.event.safeErrorSummary ?? `Classification: ${inspection.classificationCode}`,
    title: integrity
      ? "Accounting journal integrity"
      : unresolved
        ? "Unresolved accounting event"
        : "Accounting event",
    warnings: inspection.warnings,
  };
}

@Injectable()
export class RepairAccountingRecoveryService {
  public constructor(
    @Inject(PlatformAccountingRepairAdapter) private readonly adapter: PlatformAccountingRepairAdapter,
    @Inject(RepairOrderingService) private readonly ordering: RepairOrderingService,
  ) {}

  /**
   * Not a READ ONLY transaction, deliberately: the certified precheck takes
   * `FOR SHARE` locks, which a read-only transaction refuses. Statements run
   * autocommit exactly like the Company precheck; nothing is written.
   */
  private async unlocked<T>(work: (db: Kysely<DatabaseSchema> | null) => Promise<T>): Promise<T> {
    return work(null);
  }

  private async inspectOrThrow(db: Kysely<DatabaseSchema> | null, companyId: string, eventId: string) {
    const inspection = await this.adapter.inspect(db, companyId, eventId);
    if (inspection === undefined) {
      throw new ApplicationException("accounting_event_not_found", "The Accounting Event was not found", HttpStatus.NOT_FOUND);
    }
    // Phase 6: the source's operational finding is repaired first (same rule as execution).
    return this.ordering.apply(db, companyId, inspection);
  }

  public details(companyId: string, eventId: string): Promise<AccountingEventDetails> {
    return this.unlocked(async (db) => {
      const inspection = await this.inspectOrThrow(db, companyId, eventId);
      const { state } = inspection;
      const generatedAt = new Date().toISOString();
      return {
        accountingMode: {
          automaticPostingEnabled: state.configuration.automaticPostingEnabled,
          enabled: state.configuration.accountingEnabled,
        },
        companyId,
        diagnostics: {
          actorPresent: state.event.actorPresent,
          areaEnabled: state.configuration.areaEnabled,
          fiscalPeriod: { status: state.period.status, yearStatus: state.period.yearStatus },
          otherPostedEventsForSource: state.otherPostedEventsForSource,
          postedJournalsForSource: state.postedJournalsForSource,
          precheck: inspection.precheck ?? null,
        },
        event: {
          accountingDate: state.event.effectiveAccountingDate,
          attempts: state.event.attemptCount,
          businessReference: state.event.sourceReference,
          eventType: state.event.eventType,
          failedAt: state.event.failedAt,
          failureCategory: state.event.failureCategory,
          failureCode: state.event.errorCode,
          failureSummary: state.event.safeErrorSummary,
          maxAttempts: state.event.maxAttempts,
          sourceType: state.event.sourceEntityType,
          status: state.event.processingStatus,
        },
        eventId,
        finding: accountingFindingOf(companyId, eventId, inspection, generatedAt),
        generatedAt,
        previewVersion: inspection.previewVersion,
        recovery: recoveryContextOf(inspection),
        sourceOrderId: state.sourceOrderId,
        support: inspection.support,
      };
    });
  }

  public preview(companyId: string, eventId: string): Promise<AccountingRecoveryPreview> {
    return this.unlocked(async (db) => {
      const inspection = await this.inspectOrThrow(db, companyId, eventId);
      const { state } = inspection;
      const generatedAt = new Date().toISOString();
      const finding = accountingFindingOf(companyId, eventId, inspection, generatedAt);
      const recoverable = finding.current && finding.repairCapability !== null;
      const ready = inspection.repairability === "READY" && recoverable;
      const mode = {
        automaticPostingEnabled: state.configuration.automaticPostingEnabled,
        enabled: state.configuration.accountingEnabled,
      };
      return {
        accountingMode: mode,
        blockers: inspection.blockers,
        businessReference: state.event.sourceReference,
        companyId,
        currentState: {
          accountingEnabled: mode.enabled,
          attempts: state.event.attemptCount,
          eventStatus: state.event.processingStatus,
          eventType: state.event.eventType,
          failureCode: state.event.errorCode,
          fiscalPeriodStatus: state.period.status,
          postedJournalsForSource: state.postedJournalsForSource,
          sourceType: state.event.sourceEntityType,
        },
        domainPermissionEquivalent: "accounting.post",
        eventId,
        execution: ready
          ? {
              available: true,
              reason: "READY: the server re-runs the certified precheck under a lock before reprocessing.",
              requiredPlatformPermission: PLATFORM_REPAIR_CENTER_EXECUTE_PERMISSION,
            }
          : {
              available: false,
              reason: !recoverable
                ? "No certified Platform recovery applies to this event."
                : `Only a READY event can be recovered (this one is ${inspection.repairability}).`,
              requiredPlatformPermission: PLATFORM_REPAIR_CENTER_EXECUTE_PERMISSION,
            },
        finding,
        generatedAt,
        idempotencyKeyBasis: ready ? `repair:${ACCOUNTING_CAPABILITY}:${companyId}:${eventId}:${inspection.previewVersion}` : null,
        preservedHistory: [
          {
            description: "The event's prior failures stay in its audit timeline (failures and reprocess requests are append-only audit rows)",
            entityNumber: state.event.sourceReference,
            entityType: "accounting_event_history",
          },
          {
            description: "The business record (order, receivable, settlement, collection) is read, never changed",
            entityNumber: state.event.sourceReference,
            entityType: state.event.sourceEntityType,
          },
          {
            description: "An immutable Platform repair audit record is added; nothing existing is rewritten",
            entityNumber: null,
            entityType: "platform_repair_execution",
          },
        ],
        previewVersion: inspection.previewVersion,
        recovery: recoveryContextOf(inspection),
        proposedChanges: recoverable
          ? [
              {
                action: "update",
                description: `Event processing state moves ${state.event.processingStatus} -> received -> processing -> posted inside one transaction (certified re-queue, claim and posting)`,
                details: { from: state.event.processingStatus, to: "posted" },
                entityNumber: state.event.sourceReference,
                entityType: "accounting_event",
              },
              {
                action: "create",
                description: inspection.precheck === undefined
                  ? "One Journal, created by the normal posting pipeline only if posting succeeds"
                  : `One balanced Journal (debit ${inspection.precheck.expectedDebitTotal} = credit ${inspection.precheck.expectedCreditTotal}) created by the normal posting pipeline`,
                details: {
                  accountingDate: inspection.precheck?.accountingDate ?? null,
                  lines: inspection.precheck?.resolvedMappings.length ?? null,
                },
                entityNumber: null,
                entityType: "journal_entry",
              },
              {
                action: "none",
                description: "Order business status, receivable amounts, settlement history and customer/trader data are not changed",
                details: {},
                entityNumber: state.event.sourceReference,
                entityType: state.event.sourceEntityType,
              },
            ]
          : [],
        proposedRepair: recoverable
          ? {
              candidateOnly: !ready,
              capabilityCode: ACCOUNTING_CAPABILITY,
              executionHandler:
                "PlatformAccountingRepairAdapter.reprocessInTransaction (precheckFor -> requeueInTransaction -> claimInTransaction -> OperationalJournalPostingService.process)",
              explanation:
                "Reprocess the existing accounting event through the certified accounting pipeline, synchronously and atomically. No journal is written by the Repair Center.",
              title: "Reprocess Accounting Event",
            }
          : null,
        repairability: inspection.repairability,
        requiredInputs: recoverable
          ? [{ description: "Mandatory reason (recorded on the event and in the repair audit)", name: "reason", required: true }]
          : [],
        requiredPermission: PLATFORM_REPAIR_CENTER_EXECUTE_PERMISSION,
        warnings: inspection.warnings,
      };
    });
  }
}
