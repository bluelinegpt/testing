/**
 * Closing workflow vocabulary: statuses, legal transitions, and the two
 * checklist templates.
 *
 * ===========================================================================
 * WHY THE TRANSITION MAP IS DATA
 * ===========================================================================
 *
 * Writing the rules as a table rather than as a chain of `if` statements means
 * the whole state machine can be read in one place and asserted against. A
 * closing workflow is a control an auditor examines; "which moves are legal"
 * should be answerable by looking, not by tracing branches.
 *
 * It is also the only place that knows a move is illegal. The database CHECKs
 * constrain the VALUES a status may take and who may approve; they cannot
 * express that `closed` may not go straight back to `in_progress`.
 *
 * ===========================================================================
 * WHY TASK KEYS ARE STABLE STRINGS
 * ===========================================================================
 *
 * `task_key` is written into every checklist row and never changes. The LABEL
 * is snapshotted beside it, so renaming a template item later does not rewrite
 * what a completed checklist said at the time it was completed.
 *
 * Nothing here performs a check. Each entry names a step a person must confirm;
 * the automated evaluation lands in `check_result` in a later prompt, and its
 * absence is deliberately distinguishable from a failed check.
 */

export const closingWorkflowTypes = ["monthly", "year_end"] as const;
export type ClosingWorkflowType = (typeof closingWorkflowTypes)[number];

export const closingWorkflowStatuses = [
  "draft",
  "in_progress",
  "blocked",
  "ready_for_review",
  "under_review",
  "changes_requested",
  "ready_for_approval",
  "approved",
  "closed",
  "reopened",
  "cancelled",
] as const;
export type ClosingWorkflowStatus = (typeof closingWorkflowStatuses)[number];

export const closingTaskStatuses = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "not_applicable",
] as const;
export type ClosingTaskStatus = (typeof closingTaskStatuses)[number];

export const closingWorkflowPriorities = ["low", "normal", "high", "critical"] as const;
export type ClosingWorkflowPriority = (typeof closingWorkflowPriorities)[number];

/**
 * Which status may follow which.
 *
 * `closed` leads only to `reopened`, and only a separately authorised reopen
 * process may make that move -- the map permits it, the permission decides it.
 * `cancelled` leads nowhere: an abandoned workflow stays abandoned, and the
 * lawful way to try again is a new workflow.
 */
export const closingStatusTransitions: Readonly<
  Record<ClosingWorkflowStatus, readonly ClosingWorkflowStatus[]>
> = {
  approved: ["closed", "changes_requested", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  cancelled: [],
  changes_requested: ["in_progress", "cancelled"],
  closed: ["reopened"],
  draft: ["in_progress", "cancelled"],
  in_progress: ["blocked", "ready_for_review", "cancelled"],
  ready_for_approval: ["approved", "changes_requested", "cancelled"],
  ready_for_review: ["under_review", "cancelled"],
  reopened: ["in_progress", "cancelled"],
  under_review: ["ready_for_approval", "changes_requested", "cancelled"],
};

/** Statuses after which a workflow is finished for uniqueness purposes. */
export const closingTerminalStatuses: readonly ClosingWorkflowStatus[] = ["cancelled", "closed"];

export const canTransition = (from: ClosingWorkflowStatus, to: ClosingWorkflowStatus): boolean =>
  closingStatusTransitions[from].includes(to);

export interface ClosingTaskTemplate {
  /** Written to `task_key`. Never change one; add a new key instead. */
  readonly key: string;
  readonly label: string;
  /** A mandatory task must be completed or explicitly marked not applicable. */
  readonly mandatory: boolean;
  readonly sequence: number;
}

/**
 * Monthly Closing checklist.
 *
 * Ordered as the work is actually done: operational data first, then the
 * ledger, then the statements, then approval. A Trial Balance reviewed before
 * failed Accounting Events are resolved is a Trial Balance reviewed twice.
 */
export const monthlyClosingTemplate: readonly ClosingTaskTemplate[] = [
  {
    key: "operational_transactions_posted",
    label: "All operational transactions posted",
    mandatory: true,
    sequence: 1,
  },
  {
    key: "failed_accounting_events_resolved",
    label: "Failed Accounting Events resolved",
    mandatory: true,
    sequence: 2,
  },
  {
    key: "unposted_journals_reviewed",
    label: "Unposted Journals reviewed",
    mandatory: true,
    sequence: 3,
  },
  {
    key: "cash_bank_reconciled",
    label: "Cash and Bank reconciliation completed",
    mandatory: true,
    sequence: 4,
  },
  {
    key: "trader_driver_balances_reviewed",
    label: "Trader and Driver balances reviewed",
    mandatory: true,
    sequence: 5,
  },
  { key: "payroll_reviewed", label: "Payroll reviewed", mandatory: true, sequence: 6 },
  { key: "expenses_reviewed", label: "Expenses reviewed", mandatory: true, sequence: 7 },
  { key: "trial_balance_reviewed", label: "Trial Balance reviewed", mandatory: true, sequence: 8 },
  {
    key: "profit_and_loss_reviewed",
    label: "Profit and Loss reviewed",
    mandatory: true,
    sequence: 9,
  },
  { key: "balance_sheet_reviewed", label: "Balance Sheet reviewed", mandatory: true, sequence: 10 },
  { key: "final_approval", label: "Final approval", mandatory: true, sequence: 11 },
];

/**
 * Year-End Closing checklist.
 *
 * Every item from `closing_journal_prepared` onward describes a financial
 * action this prompt does NOT perform. They exist so the workflow can track
 * that a person did them; executing them is a later, separate decision.
 */
export const yearEndClosingTemplate: readonly ClosingTaskTemplate[] = [
  {
    key: "all_monthly_periods_closed",
    label: "All monthly periods closed",
    mandatory: true,
    sequence: 1,
  },
  {
    key: "final_trial_balance",
    label: "Final Trial Balance reviewed",
    mandatory: true,
    sequence: 2,
  },
  {
    key: "final_profit_and_loss",
    label: "Final Profit and Loss reviewed",
    mandatory: true,
    sequence: 3,
  },
  {
    key: "final_balance_sheet",
    label: "Final Balance Sheet reviewed",
    mandatory: true,
    sequence: 4,
  },
  {
    key: "closing_journal_prepared",
    label: "Closing Journal prepared",
    mandatory: true,
    sequence: 5,
  },
  {
    key: "profit_loss_transferred",
    label: "Profit/loss transferred to retained earnings",
    mandatory: true,
    sequence: 6,
  },
  {
    key: "balances_carried_forward",
    label: "Balances carried forward",
    mandatory: true,
    sequence: 7,
  },
  {
    key: "next_fiscal_year_created",
    label: "Next fiscal year created",
    mandatory: true,
    sequence: 8,
  },
  {
    key: "next_periods_created",
    label: "Next 12 accounting periods created",
    mandatory: true,
    sequence: 9,
  },
  {
    key: "first_new_period_opened",
    label: "First new period opened",
    mandatory: true,
    sequence: 10,
  },
  { key: "prior_year_locked", label: "Prior year locked", mandatory: true, sequence: 11 },
];

export const closingTemplateFor = (type: ClosingWorkflowType): readonly ClosingTaskTemplate[] =>
  type === "monthly" ? monthlyClosingTemplate : yearEndClosingTemplate;
