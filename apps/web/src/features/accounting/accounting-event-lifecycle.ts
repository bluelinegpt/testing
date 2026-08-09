import type { TFunction } from "i18next";

import { operationalAreaLabel } from "./accounting-labels.js";

/**
 * The single business-facing model of an Accounting Event's lifecycle.
 *
 * The backend stores nine technical states — `received`, `processing`,
 * `validated`, `posted`, `failed`, `retry_pending`, `blocked_configuration`,
 * `reversed`, `ignored_duplicate` — and none of them says *why* an Event is
 * sitting still. Two facts made that a real problem:
 *
 *  - `blocked_configuration` is defined in the schema but **no code ever
 *    writes it**. An Event blocked by disabled Automatic Posting or a disabled
 *    operational Area simply stays `received` forever.
 *  - The processor's claim query requires `accounting_enabled`,
 *    `automatic_posting_enabled` and the Event's Area to be enabled. An Event
 *    failing any of those is never picked up, and nothing on the row records
 *    that.
 *
 * So the blocker is derived from the **configuration flags the query layer now
 * returns alongside the Event**, not invented. Waiting is reported as waiting,
 * never as failure.
 *
 * Every screen — list, detail, badge, action eligibility — resolves state
 * through this one function so they cannot disagree.
 */

export type LifecycleTone = "danger" | "info" | "success" | "warning";

export interface EventLifecycle {
  /** Short recommended next action, or `undefined` when none is needed. */
  readonly action?: string | undefined;
  /** Concise blocker title for the list's Blocker column. */
  readonly blocker?: string | undefined;
  /** Where the blocker is fixed, when the application has such a screen. */
  readonly configurationPath?: string | undefined;
  /** Plain-language explanation for the detail screen. */
  readonly explanation?: string | undefined;
  /** Translated business status, the most prominent element on the screen. */
  readonly label: string;
  /** Whether reprocessing is worth offering at all. */
  readonly retryable: boolean;
  /** Stable key, for styling and tests. */
  readonly state: string;
  readonly tone: LifecycleTone;
}

/** Reads a field that the list aliases differently from the detail. */
function field(row: Record<string, unknown>, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/**
 * Friendly failure classification.
 *
 * Keyed on the specific `error_code` first — that is what the posting service
 * actually raises — and falls back to the coarse `failure_category` the
 * processor persists (`transient`, `configuration`, `period`, `source`,
 * `validation`, `system`). A code the map does not recognise degrades to its
 * category rather than to a raw string.
 *
 * Returns the translation key suffix under `accounting.failures`, plus whether
 * a retry alone can clear it.
 */
const failureByCode: Readonly<Record<string, { key: string; retryable: boolean }>> = {
  accounting_cash_bank_gl_account_invalid: { key: "accountInactive", retryable: false },
  accounting_event_accounting_date_missing: { key: "sourceInvalid", retryable: false },
  accounting_event_actor_missing: { key: "sourceInvalid", retryable: false },
  accounting_event_already_reversed: { key: "duplicateJournalPrevented", retryable: false },
  accounting_event_fiscal_period_not_found: { key: "fiscalPeriodMissing", retryable: false },
  accounting_event_fiscal_year_closed: { key: "fiscalPeriodClosed", retryable: false },
  accounting_event_mapping_control_account_invalid: { key: "missingMapping", retryable: false },
  accounting_event_mapping_inactive_account: { key: "accountInactive", retryable: false },
  accounting_event_mapping_missing: { key: "missingMapping", retryable: false },
  accounting_event_mapping_overlap: { key: "missingMapping", retryable: false },
  accounting_event_mapping_summary_account: { key: "missingMapping", retryable: false },
  accounting_event_not_balanced: { key: "unbalancedJournal", retryable: false },
  accounting_event_original_not_posted: { key: "sourceInvalid", retryable: false },
  accounting_event_payload_mismatch: { key: "sourceInvalid", retryable: false },
  accounting_event_period_closed: { key: "fiscalPeriodClosed", retryable: false },
  accounting_event_period_soft_closed: { key: "fiscalPeriodClosed", retryable: false },
  accounting_event_transient_failure: { key: "temporary", retryable: true },
  accounting_general_expense_cash_account_invalid: { key: "accountInactive", retryable: false },
};

const failureByCategory: Readonly<Record<string, { key: string; retryable: boolean }>> = {
  configuration: { key: "configurationMissing", retryable: false },
  period: { key: "fiscalPeriodClosed", retryable: false },
  source: { key: "sourceInvalid", retryable: false },
  system: { key: "technical", retryable: false },
  transient: { key: "temporary", retryable: true },
  validation: { key: "sourceInvalid", retryable: false },
};

export function classifyFailure(
  row: Record<string, unknown>,
): { readonly key: string; readonly retryable: boolean } {
  const code = field(row, "error_code", "errorCode");
  const byCode = failureByCode[code];
  if (byCode !== undefined) return byCode;
  const category = field(row, "failure_category", "failureCategory");
  return failureByCategory[category] ?? { key: "technical", retryable: false };
}

/** Whether the Company/Area configuration lets the processor claim this Event. */
function configurationBlocker(
  row: Record<string, unknown>,
  t: TFunction,
): EventLifecycle | undefined {
  const area = field(row, "operational_area", "area");
  if (row.accountingEnabled === false) {
    return {
      action: t("accounting.lifecycle.actions.openSetup"),
      blocker: t("accounting.lifecycle.configurationRequired"),
      configurationPath: "/accounting/configuration",
      explanation: t("accounting.lifecycle.explain.accountingDisabled"),
      label: t("accounting.lifecycle.configurationRequired"),
      retryable: false,
      state: "configurationRequired",
      tone: "warning",
    };
  }
  if (row.automaticPostingEnabled === false) {
    return {
      action: t("accounting.lifecycle.actions.openAutomaticPosting"),
      blocker: t("accounting.lifecycle.waitingAutomaticPosting"),
      configurationPath: "/accounting/automatic-posting",
      explanation: t("accounting.lifecycle.explain.automaticPostingDisabled"),
      label: t("accounting.lifecycle.waitingAutomaticPosting"),
      retryable: false,
      state: "waitingAutomaticPosting",
      tone: "warning",
    };
  }
  if (row.areaEnabled === false && area !== "") {
    // Named, not generic: "Waiting for Driver Collections Automatic Posting"
    // tells the User exactly which switch to turn on.
    const areaName = operationalAreaLabel(t, area);
    return {
      action: t("accounting.lifecycle.actions.openAutomaticPosting"),
      blocker: t("accounting.lifecycle.waitingArea", { area: areaName }),
      configurationPath: "/accounting/automatic-posting",
      explanation: t("accounting.lifecycle.explain.areaDisabled", { area: areaName }),
      label: t("accounting.lifecycle.waitingArea", { area: areaName }),
      retryable: false,
      state: "waitingAreaEnablement",
      tone: "warning",
    };
  }
  return undefined;
}

/**
 * Resolves one Event row — from either the list or the detail payload — into
 * its business lifecycle.
 */
export function eventLifecycle(row: Record<string, unknown>, t: TFunction): EventLifecycle {
  const status = field(row, "processing_status", "status");

  if (status === "posted") {
    return {
      label: t("accounting.lifecycle.posted"),
      retryable: false,
      state: "posted",
      tone: "success",
    };
  }
  if (status === "reversed") {
    return {
      label: t("accounting.lifecycle.reversed"),
      retryable: false,
      state: "reversed",
      tone: "info",
    };
  }
  if (status === "ignored_duplicate") {
    return {
      explanation: t("accounting.lifecycle.explain.ignoredDuplicate"),
      label: t("accounting.failures.duplicateJournalPrevented"),
      retryable: false,
      state: "ignoredDuplicate",
      tone: "info",
    };
  }
  if (status === "processing") {
    return {
      explanation: t("accounting.lifecycle.explain.processing"),
      label: t("accounting.lifecycle.processing"),
      // Never offer a retry against an Event a worker currently holds.
      retryable: false,
      state: "processing",
      tone: "info",
    };
  }

  if (status === "failed" || status === "blocked_configuration") {
    const failure = classifyFailure(row);
    // A configuration blocker outranks the recorded failure: fixing the
    // configuration is what the User must do, whatever the last error said.
    const blocked = configurationBlocker(row, t);
    const failureAction =
      t(`accounting.failures.actions.${failure.key}`, { defaultValue: "" }) || undefined;
    return {
      action: blocked?.action ?? failureAction,
      blocker: t(`accounting.failures.${failure.key}`),
      ...(blocked?.configurationPath === undefined
        ? {}
        : { configurationPath: blocked.configurationPath }),
      explanation: t(`accounting.failures.explain.${failure.key}`, { defaultValue: "" }) || undefined,
      label: t("accounting.lifecycle.failed"),
      retryable: failure.retryable && blocked === undefined,
      state: "failed",
      tone: "danger",
    };
  }

  if (status === "retry_pending") {
    const failure = classifyFailure(row);
    return {
      action: t("accounting.lifecycle.actions.noneNeeded"),
      blocker: t(`accounting.failures.${failure.key}`),
      explanation: t("accounting.lifecycle.explain.retryPending"),
      label: t("accounting.lifecycle.retryPending"),
      retryable: true,
      state: "retryPending",
      tone: "warning",
    };
  }

  // received / validated: not a failure. Say what it is waiting for.
  const blocked = configurationBlocker(row, t);
  if (blocked !== undefined) return blocked;
  return {
    explanation: t("accounting.lifecycle.explain.awaitingProcessing"),
    label: t("accounting.lifecycle.awaitingProcessing"),
    retryable: false,
    state: "awaitingProcessing",
    tone: "info",
  };
}
