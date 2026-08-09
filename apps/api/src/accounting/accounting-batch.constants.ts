/**
 * Accounting Batch Operations — vocabularies and the single-item service rule.
 *
 * ===========================================================================
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ===========================================================================
 *
 * A batch type may exist ONLY where an authoritative single-item service
 * already owns both the read-only eligibility check and the execution of that
 * action. The batch module contributes selection, classification, sequencing
 * and audit. It contributes no accounting rule.
 *
 * Concretely, and permanently:
 *
 *  - no eligibility rule may be reimplemented here, even as "just a status
 *    check" -- the single-item service's own readiness call is the answer;
 *  - no posting map, account resolution, amount derivation or period rule may
 *    appear in the batch module;
 *  - execution, when it is built, must call the named single-item service once
 *    per item and must not reach past it into SQL that changes accounting data.
 *
 * A second copy of a rule is a second answer. It will agree on the day it is
 * written and disagree later, silently, across hundreds of records at once --
 * which is precisely the failure mode batching makes expensive.
 *
 * `batchTypeServices` below is that contract written down. Each entry names the
 * service and method the batch delegates to, so a reviewer can check the rule
 * without reading the implementation, and so adding a type without a service is
 * visibly wrong rather than merely undocumented.
 */

export const accountingBatchStatuses = [
  "draft",
  "validating",
  "ready",
  "processing",
  "partially_completed",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AccountingBatchStatus = (typeof accountingBatchStatuses)[number];

export const accountingBatchTypes = [
  "accounting_event_reprocess",
  "operational_posting_retry",
  "historical_accounting_recovery",
] as const;
export type AccountingBatchType = (typeof accountingBatchTypes)[number];

export const accountingBatchValidationStatuses = [
  "pending",
  "eligible",
  "blocked",
  "duplicate",
  "invalid",
  "already_processed",
  // Recovery-only verdicts, stored verbatim from the recovery classifier so
  // three distinct facts are not collapsed into `blocked`.
  "closed_period",
  "invalid_source_data",
  "no_accounting_required",
] as const;
export type AccountingBatchValidationStatus =
  (typeof accountingBatchValidationStatuses)[number];

export const accountingBatchExecutionStatuses = [
  "pending",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
] as const;

/**
 * The authoritative single-item service behind each batch type.
 *
 * Both supported types delegate to the SAME pair, and that is deliberate rather
 * than an oversight: "retry this operational posting" is, in this repository,
 * re-queueing the operational Accounting Event that failed to post. There is no
 * separate operational retry service, so inventing one for the batch module
 * would be exactly the duplication this file forbids. The two types differ only
 * in which items may be enrolled -- `operational_posting_retry` additionally
 * requires the Event to carry an operational area.
 */
export const batchTypeServices: Readonly<
  Record<
    AccountingBatchType,
    {
      readonly execution: string;
      readonly sourceType: string;
      readonly validation: string;
    }
  >
> = {
  accounting_event_reprocess: {
    execution: "AccountingEventQueryService.reprocess",
    sourceType: "accounting_event",
    validation: "AccountingEventQueryService.reprocessingReadiness",
  },
  // DISTINCT from the two reprocess types, necessarily: eligible recovery rows
  // have NO Accounting Event yet, so a type whose execution is "reprocess the
  // Event" has nothing to call. Items point at the source records themselves,
  // and execution calls the SAME SQL capture helper every operational trigger
  // delegates to -- creating the missing Event; the normal processor posts it.
  historical_accounting_recovery: {
    execution: "enqueue_operational_accounting_event (triggers' capture helper)",
    sourceType: "order_or_outsourced_driver_fee_accrual",
    validation: "AccountingRecoveryService.classifySources",
  },
  operational_posting_retry: {
    execution: "AccountingEventQueryService.reprocess",
    sourceType: "accounting_event",
    validation: "AccountingEventQueryService.reprocessingReadiness",
  },
};

/**
 * Batch types deliberately NOT supported, and why.
 *
 * Recorded so the omission reads as a decision rather than an oversight, and so
 * a later prompt does not "restore" one without resolving the blocker.
 *
 * `journal_review` -- Manual Journal review actions were considered and
 * excluded. `ManualJournalService.validate()` is not a read-only check: it
 * flips a Journal between `draft` and `balanced` as a side effect, so it cannot
 * serve as the rerunnable, record-free validation this feature requires. The
 * approve and post paths have no read-only readiness counterpart, and writing
 * one inside the batch module would duplicate the Journal transition and
 * segregation rules. The lawful fix is a read-only readiness method on
 * `ManualJournalService` itself, which is a change to that service and outside
 * this foundation.
 */
export const unsupportedBatchTypes = ["journal_review"] as const;

/**
 * How many source records one batch may hold.
 *
 * Bounded because validation reuses the single-item readiness service ONCE PER
 * ITEM rather than reimplementing it as a set query. That is the cost of the
 * rule above and is accepted deliberately: a set query would be a second copy
 * of the eligibility logic. The limit keeps a single validation request's cost
 * predictable; it is not a statement about how much work is safe to execute.
 */
export const accountingBatchMaxItems = 200;

/**
 * Legal status moves. The single description of the lifecycle -- the service
 * asks this map and restates none of it.
 */
const transitions: Readonly<Record<AccountingBatchStatus, readonly AccountingBatchStatus[]>> = {
  cancelled: [],
  completed: [],
  draft: ["validating", "cancelled"],
  // `failed` and `partially_completed` are RETRYABLE, not terminal: execution
  // re-enters them to process only the unfinished items. `completed` and
  // `cancelled` stay dead ends -- a finished batch can never run again.
  failed: ["processing", "cancelled"],
  partially_completed: ["processing", "cancelled"],
  processing: ["completed", "partially_completed", "failed"],
  // Adding items to a validated batch returns it to `draft`: the new items are
  // unclassified, so the batch is no longer the thing that was reviewed.
  ready: ["draft", "validating", "processing", "cancelled"],
  validating: ["ready", "draft", "cancelled"],
};

export const canTransitionBatch = (
  from: AccountingBatchStatus,
  to: AccountingBatchStatus,
): boolean => transitions[from].includes(to);

/**
 * How long a `processing` batch must sit without ANY persisted activity —
 * neither the job row nor one of its item rows updated — before operator
 * recovery may treat the run as interrupted.
 *
 * A deliberately conservative documented constant, not a guess: the item loop
 * writes an outcome row every few seconds while alive, and even the slowest
 * single item (one readiness read plus one capture or requeue) completes in
 * well under a minute. Fifteen minutes of total silence is therefore not a
 * slow worker; it is a dead one. Recovery ALSO probes the live row locks
 * before acting, so this threshold is the first fence, never the only one.
 */
export const accountingBatchProcessingStaleMinutes = 15;

/** Statuses whose items may still be edited. */
export const editableBatchStatuses: readonly AccountingBatchStatus[] = ["draft", "ready"];

/** Statuses past which no cancellation is possible. */
export const terminalBatchStatuses: readonly AccountingBatchStatus[] = [
  "cancelled",
  "completed",
];

/** Statuses from which execution may start or resume. */
export const executableBatchStatuses: readonly AccountingBatchStatus[] = [
  "ready",
  "partially_completed",
  "failed",
];
