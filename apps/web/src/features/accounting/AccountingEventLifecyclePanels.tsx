import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { ApiError } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { DirectionalText, StatusBadge, formatAccountingDate } from "./AccountingComponents.js";
import { AccountingApi, accountingQueryKey } from "./accounting-api.js";
import { eventTypeLabel, operationalAreaLabel } from "./accounting-labels.js";
import { recordRoute } from "./accounting-routes.js";
import { useAccountingResource } from "./use-accounting-resource.js";
import { classifyFailure, eventLifecycle, type EventLifecycle } from "./accounting-event-lifecycle.js";
import type { AccountingRecord } from "./accounting-types.js";

/**
 * The Accounting Event lifecycle panels: status banner, Processing Timeline,
 * and Failure Details.
 *
 * All three read the same enriched detail payload and the one lifecycle mapper,
 * so the badge, the blocker and the reprocess eligibility can never disagree.
 * Nothing here is reconstructed: every timestamp shown is a column the Event
 * row or the append-only audit trail actually stores.
 */

/** Company-local date and time. Never a raw ISO string in the normal view. */
function dateTime(value: unknown, language: string): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(language === "ar" ? "ar-AE" : "en-AE", {
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Dubai",
    year: "numeric",
  }).format(parsed);
}

const toneClass: Readonly<Record<string, string>> = {
  danger: "accounting-lifecycle-danger",
  info: "accounting-lifecycle-info",
  success: "accounting-lifecycle-success",
  warning: "accounting-lifecycle-warning",
};

/**
 * The most prominent element on the Event screen: what state it is in, what is
 * blocking it, and what to do next — in that order.
 */
export function EventLifecycleBanner({
  detail,
  lifecycle,
  onNavigate,
  permissions,
}: {
  readonly detail: AccountingRecord;
  readonly lifecycle: EventLifecycle;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const postedAfterFailure =
    lifecycle.state === "posted" &&
    (detail.failed_at !== null || detail.reprocessed_at !== null) &&
    detail.failed_at !== undefined;
  // Whether this User can actually reach the configuration screen the blocker
  // points at. If not, telling them to open it is useless advice.
  const canConfigure =
    permissions.includes("users_roles.manage") ||
    permissions.includes("accounting.configuration.manage") ||
    permissions.includes("accounting.manage");
  return (
    <section className={`accounting-lifecycle-banner ${toneClass[lifecycle.tone] ?? ""}`}>
      <div className="accounting-lifecycle-heading">
        <strong>{lifecycle.label}</strong>
        {lifecycle.blocker === undefined || lifecycle.blocker === lifecycle.label ? null : (
          <span className="accounting-lifecycle-blocker">{lifecycle.blocker}</span>
        )}
      </div>
      {/* A successful reprocess must not hide that this Event once failed. */}
      {!postedAfterFailure ? null : (
        <p className="accounting-lifecycle-note">{t("accounting.lifecycle.previouslyFailed")}</p>
      )}
      {lifecycle.explanation === undefined ? null : <p>{lifecycle.explanation}</p>}
      {lifecycle.action === undefined ? null : (
        <p className="accounting-lifecycle-action">
          <strong>{t("accounting.failures.requiredAction")}:</strong>{" "}
          {canConfigure || lifecycle.configurationPath === undefined
            ? lifecycle.action
            : t("accounting.lifecycle.actions.contactAdministrator")}
        </p>
      )}
      {lifecycle.configurationPath === undefined || !canConfigure ? null : (
        <button
          className="button button-secondary"
          onClick={() => onNavigate(lifecycle.configurationPath!)}
          type="button"
        >
          {lifecycle.action}
        </button>
      )}
    </section>
  );
}

interface TimelineEntry {
  readonly at: unknown;
  readonly detail?: string | undefined;
  readonly label: string;
}

/**
 * Processing Timeline, built only from stored timestamps.
 *
 * The Event row keeps one timestamp per milestone, not a per-attempt history —
 * so re-running an Event overwrites `last_attempt_at` and `failed_at`. The
 * append-only audit trail is therefore the source for anything historical
 * (failures and reprocess requests), and the row supplies the rest. Nothing is
 * interpolated, and an unavailable stage is omitted rather than guessed.
 */
export function EventProcessingTimeline({
  detail,
  language,
}: {
  readonly detail: AccountingRecord;
  readonly language: string;
}) {
  const { t } = useTranslation();
  const history = Array.isArray(detail.history)
    ? (detail.history as readonly AccountingRecord[])
    : [];
  const entries: TimelineEntry[] = [];
  const add = (at: unknown, label: string, note?: string) => {
    if (at === null || at === undefined || at === "") return;
    entries.push({ at, label, ...(note === undefined ? {} : { detail: note }) });
  };

  add(detail.created_at, t("accounting.lifecycle.timeline.received"));
  add(detail.validated_at, t("accounting.lifecycle.timeline.processingStarted"));
  add(
    detail.processing_locked_at,
    t("accounting.lifecycle.timeline.processingStarted"),
    t("accounting.lifecycle.timeline.attempt", { count: Number(detail.attempt_count ?? 0) }),
  );
  add(
    detail.processed_at,
    t("accounting.lifecycle.timeline.posted"),
    typeof detail.journalNumber === "string" ? detail.journalNumber : undefined,
  );

  // Historical entries from the audit trail. These survive a later success, so
  // an Event that failed twice and then posted still shows all three.
  for (const row of history) {
    const action = String(row.action ?? "");
    const actor = String(row.actorName ?? "").trim();
    const note = actor === "" ? undefined : actor;
    if (action === "accounting.operational_event.failed") {
      add(row.occurredAt, t("accounting.lifecycle.timeline.failed"), note);
    } else if (action === "accounting.event.reprocessing_requested") {
      const reason = String(row.reason ?? "").trim();
      add(
        row.occurredAt,
        t("accounting.lifecycle.timeline.reprocessRequested"),
        [note, reason === "" ? undefined : reason].filter(Boolean).join(" — ") || undefined,
      );
    }
  }

  add(detail.next_attempt_at, t("accounting.lifecycle.timeline.retryScheduled"));

  if (entries.length === 0) {
    return (
      <section className="accounting-preview-panel">
        <h3>{t("accounting.lifecycle.timeline.title")}</h3>
        <p className="accounting-empty">{t("accounting.lifecycle.timeline.empty")}</p>
      </section>
    );
  }
  // Chronological, so the story reads top to bottom regardless of which source
  // each entry came from.
  entries.sort((left, right) => new Date(String(left.at)).getTime() - new Date(String(right.at)).getTime());
  return (
    <section className="accounting-preview-panel">
      <h3>{t("accounting.lifecycle.timeline.title")}</h3>
      <ol className="accounting-timeline">
        {entries.map((entry, index) => (
          <li key={`${entry.label}-${String(entry.at)}-${index}`}>
            <span className="accounting-timeline-dot" aria-hidden="true" />
            <div>
              <strong>{entry.label}</strong>
              <small>{dateTime(entry.at, language)}</small>
              {entry.detail === undefined ? null : (
                <p>
                  <DirectionalText>{entry.detail}</DirectionalText>
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Failure Details, shown only while the Event is actually failed or blocked.
 *
 * Once it posts, this panel disappears and the history moves to the timeline —
 * the page must not keep looking broken after the problem was fixed.
 */
export function EventFailureDetails({
  detail,
  language,
  lifecycle,
}: {
  readonly detail: AccountingRecord;
  readonly language: string;
  readonly lifecycle: EventLifecycle;
}) {
  const { t } = useTranslation();
  const status = String(detail.processing_status ?? "");
  if (!["failed", "blocked_configuration", "retry_pending"].includes(status)) return null;
  const failure = classifyFailure(detail);
  const history = Array.isArray(detail.history)
    ? (detail.history as readonly AccountingRecord[])
    : [];
  const failures = history.filter(
    (row) => String(row.action ?? "") === "accounting.operational_event.failed",
  );
  const rows: readonly (readonly [string, string])[] = [
    [t("accounting.failures.category"), t(`accounting.failures.${failure.key}`)],
    // `safe_error_summary` is written by the processor from a curated map or an
    // ApplicationException message — never from the raw driver error.
    [t("accounting.failures.summary"), String(detail.safe_error_summary ?? "—")],
    [
      t("accounting.failures.firstFailure"),
      failures[0] === undefined ? "—" : dateTime(failures[0].occurredAt, language),
    ],
    [t("accounting.failures.latestFailure"), dateTime(detail.failed_at, language)],
    [
      t("accounting.failures.attempts"),
      `${String(detail.attempt_count ?? 0)} / ${String(detail.max_attempts ?? 0)}`,
    ],
    [
      t("accounting.failures.isRetryable"),
      lifecycle.retryable ? t("accounting.failures.isRetryable") : t("accounting.failures.notRetryable"),
    ],
  ];
  return (
    <section className="accounting-preview-panel accounting-failure-details">
      <h3>{t("accounting.failures.title")}</h3>
      <dl className="accounting-detail-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div>
          <dt>{t("accounting.fields.status")}</dt>
          <dd>
            <StatusBadge value={status} />
          </dd>
        </div>
      </dl>
      {lifecycle.explanation === undefined ? null : <p>{lifecycle.explanation}</p>}
      {lifecycle.action === undefined ? null : (
        <p className="accounting-lifecycle-action">
          <strong>{t("accounting.failures.requiredAction")}:</strong> {lifecycle.action}
        </p>
      )}
    </section>
  );
}


interface ReprocessReadiness {
  readonly attemptCount?: number;
  readonly blockers?: readonly string[];
  readonly eligible?: boolean;
  readonly maxAttempts?: number;
  readonly operationalArea?: string | null;
  readonly status?: string;
}

/**
 * Safe single-Event reprocessing: precheck, gate, confirm, execute.
 *
 * ===========================================================================
 * THE PRECHECK IS THE GATE; THE BACKEND IS THE AUTHORITY
 * ===========================================================================
 *
 * The Reprocess button stays disabled until the LATEST precheck on this screen
 * came back `allowed`. That is a courtesy, not a control: the backend re-runs
 * the full precheck inside the reprocess flow and refuses on any blocker, so a
 * page that somehow enabled the button early would still be refused. Every
 * figure in the panel -- totals, mappings, period, verdict -- is a backend
 * value rendered as given; nothing is computed here.
 *
 * Executing sends the Event status the user REVIEWED (`expectedStatus`), so an
 * Event that moved on since the precheck is refused rather than run against a
 * different state. Reprocessing itself only re-queues the Event for the normal
 * processor; the Journal, when one results, is created asynchronously there.
 */

interface PrecheckBlocking {
  readonly code: string;
  readonly message: string;
}

interface PrecheckResult {
  readonly accountingDate: string | null;
  readonly allowed: boolean;
  readonly blockers: readonly PrecheckBlocking[];
  readonly event: { readonly id: string; readonly reference: string | null; readonly status: string };
  readonly existing: {
    readonly journalId: string | null;
    readonly journalNumber: string | null;
    readonly otherPostedEventId: string | null;
    readonly otherPostedJournalId: string | null;
  };
  readonly expectedCreditTotal: string;
  readonly expectedDebitTotal: string;
  readonly expectedPostingType: string;
  readonly fiscalPeriod: { readonly id: string | null; readonly status: string | null };
  readonly recommendedAction: string;
  readonly resolvedMappings: readonly {
    readonly accountCode: string;
    readonly accountName: string;
    readonly accountNameAr: string | null;
    readonly amount: string;
    readonly entryIntent: string;
    readonly mappingKey: string;
  }[];
  readonly source: { readonly id: string; readonly reference: string | null; readonly type: string };
  readonly warnings: readonly PrecheckBlocking[];
}

/**
 * Detail route per source entity type, from the verified route map. Orders
 * route by REFERENCE (order number); everything else by id. A type with no
 * detail screen yields no link rather than an invented one.
 */
function sourceHref(type: string, id: string, reference: string | null): string | undefined {
  switch (type) {
    case "order":
      return recordRoute("order", reference);
    case "driver_reconciliation":
      return recordRoute("driver_collection", id);
    case "general_expense":
      return recordRoute("general_expense", id);
    case "general_expense_payment":
      return recordRoute("expense_payment", id);
    case "cash_bank_movement":
      return recordRoute("cash_bank_movement", id);
    case "outsourced_driver_fee_accrual":
      return recordRoute("outsourced_driver_fee_accrual", id);
    case "outsourced_driver_fee_payment":
      return recordRoute("outsourced_driver_fee_payment", id);
    case "payroll_payment":
      return recordRoute("payroll_payment", id);
    case "payroll_period":
      return recordRoute("payroll_period", id);
    case "trader_receivable":
      return recordRoute("trader_receivable", id);
    case "trader_collection":
      return recordRoute("trader_collection", id);
    case "trader_settlement":
      return recordRoute("trader_settlement", id);
    default:
      return undefined;
  }
}

export function EventReprocessAction({
  client,
  companyId,
  detail,
  eventId,
  language,
  onDone,
}: {
  readonly client: AccountingApi;
  readonly companyId: string;
  readonly detail: AccountingRecord;
  readonly eventId: string;
  readonly language: string;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [precheck, setPrecheck] = useState<PrecheckResult>();
  const [precheckAt, setPrecheckAt] = useState<string>();
  const [precheckBusy, setPrecheckBusy] = useState(false);
  const [precheckError, setPrecheckError] = useState<string>();
  const readiness = useAccountingResource<ReprocessReadiness>(
    accountingQueryKey(companyId, "event-readiness", { eventId }),
    (signal) =>
      client.get<ReprocessReadiness>(
        `events/${encodeURIComponent(eventId)}/reprocessing-readiness`,
        undefined,
        signal,
      ),
  );
  if (readiness.loading || readiness.error !== undefined) return null;
  const blockers = readiness.data?.blockers ?? [];
  const eligible = readiness.data?.eligible === true;
  const lifecycle = eventLifecycle(detail, t);
  // Posted, reversed and in-flight Events show nothing at all: offering an
  // action that will always be refused is worse than offering none.
  if (!eligible && blockers.some((code) =>
    ["event_already_posted", "event_currently_processing", "event_reversed",
     "event_ignored_duplicate", "event_status_not_reprocessable"].includes(code))) {
    return null;
  }

  const runPrecheck = async (): Promise<PrecheckResult | undefined> => {
    setPrecheckBusy(true);
    setPrecheckError(undefined);
    try {
      const result = await client.post<PrecheckResult>(
        `events/${encodeURIComponent(eventId)}/reprocess-precheck`,
      );
      setPrecheck(result);
      setPrecheckAt(new Date().toISOString());
      return result;
    } catch (cause) {
      setPrecheckError(
        cause instanceof ApiError && cause.code === "forbidden"
          ? t("accounting.precheck.permissionDenied")
          : t("accounting.precheck.failed"),
      );
      return undefined;
    } finally {
      setPrecheckBusy(false);
    }
  };

  const submit = async () => {
    if (precheck === undefined || !precheck.allowed) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.post(`events/${encodeURIComponent(eventId)}/reprocess`, {
        // The status the user REVIEWED: an Event that moved on is refused.
        expectedStatus: precheck.event.status,
        reason: note.trim() === ""
          ? "Reprocessing requested from the Accounting Event screen"
          : note.trim(),
      });
      setOpen(false);
      // Refresh both the Event detail and the precheck: the verdict that was
      // just consumed is stale by definition.
      onDone();
      void runPrecheck();
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : "";
      setError(
        t(`accounting.precheck.executeErrors.${code}`, {
          defaultValue: t("accounting.precheck.executeErrors.generic"),
        }),
      );
      // The refusal names current conditions; show them.
      void runPrecheck();
    } finally {
      setBusy(false);
    }
  };

  const source = precheck?.source;
  const sourceLink =
    source === undefined ? undefined : sourceHref(source.type, source.id, source.reference);
  const journalLink = recordRoute("journal", precheck?.existing.journalId ?? null);
  const otherJournalLink = recordRoute("journal", precheck?.existing.otherPostedJournalId ?? null);
  const otherEventLink = recordRoute(
    "accounting_event",
    precheck?.existing.otherPostedEventId ?? null,
  );

  return (
    <div className="detail-panel">
      <h3>{t("accounting.precheck.heading")}</h3>
      <div className="accounting-form-actions">
        <button
          className="button button-secondary"
          disabled={precheckBusy}
          onClick={() => void runPrecheck()}
          type="button"
        >
          {precheckBusy ? t("common.loading", { defaultValue: "Loading" }) : t("accounting.precheck.run")}
        </button>
        <button
          className="button"
          disabled={!eligible || busy || precheck === undefined || !precheck.allowed}
          onClick={() => setOpen(true)}
          type="button"
        >
          {t("accounting.reprocess.action")}
        </button>
      </div>
      {precheck === undefined && precheckError === undefined ? (
        <p className="accounting-hint">{t("accounting.precheck.notRun")}</p>
      ) : null}
      {precheck !== undefined && !precheck.allowed ? (
        <p className="accounting-hint">{t("accounting.precheck.blockedNote")}</p>
      ) : null}
      {precheckError === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {precheckError}
        </div>
      )}

      {precheck === undefined ? null : (
        <>
          <dl className="accounting-detail-grid">
            <div>
              <dt>{t("accounting.precheck.verdict")}</dt>
              <dd>
                <span
                  className={`status-badge ${precheck.allowed ? "status-active" : "status-warning"}`}
                >
                  {precheck.allowed
                    ? t("accounting.precheck.allowed")
                    : t("accounting.precheck.blocked")}
                </span>
              </dd>
            </div>
            <div>
              <dt>{t("accounting.related.event")}</dt>
              <dd>
                <DirectionalText>{precheck.event.reference ?? "—"}</DirectionalText>
              </dd>
            </div>
            <div>
              <dt>{t("accounting.fields.status")}</dt>
              <dd>
                <StatusBadge value={precheck.event.status} />
              </dd>
            </div>
            <div>
              <dt>{t("accounting.precheck.sourceType")}</dt>
              <dd>{precheck.source.type}</dd>
            </div>
            <div>
              <dt>{t("accounting.related.sourceTransaction")}</dt>
              <dd>
                {sourceLink === undefined ? (
                  <DirectionalText>{precheck.source.reference ?? "—"}</DirectionalText>
                ) : (
                  <Link to={sourceLink}>
                    <DirectionalText>
                      {precheck.source.reference ?? precheck.source.id}
                    </DirectionalText>
                  </Link>
                )}
              </dd>
            </div>
            <div>
              <dt>{t("accounting.precheck.expectedPostingType")}</dt>
              <dd>{eventTypeLabel(t, precheck.expectedPostingType)}</dd>
            </div>
            <div>
              <dt>{t("accounting.fields.accountingDate")}</dt>
              <dd>{formatAccountingDate(precheck.accountingDate, language)}</dd>
            </div>
            <div>
              <dt>{t("accounting.precheck.fiscalPeriod")}</dt>
              <dd>
                {precheck.fiscalPeriod.id === null ? (
                  "—"
                ) : (
                  <Link to={`/accounting/fiscal-periods/${precheck.fiscalPeriod.id}`}>
                    {t(`accounting.status.${String(precheck.fiscalPeriod.status)}`, {
                      defaultValue: String(precheck.fiscalPeriod.status ?? "—"),
                    })}
                  </Link>
                )}
              </dd>
            </div>
            <div>
              <dt>{t("accounting.precheck.expectedDebit")}</dt>
              <dd>
                <bdi className="accounting-amount" dir="ltr">{precheck.expectedDebitTotal}</bdi>
              </dd>
            </div>
            <div>
              <dt>{t("accounting.precheck.expectedCredit")}</dt>
              <dd>
                <bdi className="accounting-amount" dir="ltr">{precheck.expectedCreditTotal}</bdi>
              </dd>
            </div>
            <div>
              <dt>{t("accounting.precheck.recommendedAction")}</dt>
              <dd>
                {t(`accounting.precheck.actions.${precheck.recommendedAction}`, {
                  defaultValue: precheck.recommendedAction,
                })}
              </dd>
            </div>
            <div>
              <dt>{t("accounting.precheck.checkedAt")}</dt>
              <dd>{dateTime(precheckAt, language)}</dd>
            </div>
          </dl>

          {precheck.existing.journalId === null &&
          precheck.existing.otherPostedEventId === null ? null : (
            <p>
              {journalLink === undefined ? null : (
                <Link to={journalLink}>
                  <DirectionalText>
                    {precheck.existing.journalNumber ?? t("accounting.precheck.existingJournal")}
                  </DirectionalText>
                </Link>
              )}{" "}
              {otherEventLink === undefined ? null : (
                <Link to={otherEventLink}>{t("accounting.precheck.duplicateEvent")}</Link>
              )}{" "}
              {otherJournalLink === undefined ? null : (
                <Link to={otherJournalLink}>{t("accounting.precheck.existingJournal")}</Link>
              )}
            </p>
          )}

          {precheck.resolvedMappings.length === 0 ? null : (
            <>
              <h4>{t("accounting.precheck.mappings")}</h4>
              <div className="table-scroll-x">
                <table className="data-table accounting-table">
                  <thead>
                    <tr>
                      <th>{t("accounting.precheck.mappingKey")}</th>
                      <th>{t("accounting.precheck.account")}</th>
                      <th>{t("accounting.precheck.role")}</th>
                      <th>{t("accounting.precheck.amount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {precheck.resolvedMappings.map((line, index) => (
                      <tr key={`${line.mappingKey}:${index}`}>
                        <td>
                          <DirectionalText>{line.mappingKey}</DirectionalText>
                        </td>
                        <td>
                          <DirectionalText>{line.accountCode}</DirectionalText>{" "}
                          {language === "ar" && line.accountNameAr !== null
                            ? line.accountNameAr
                            : line.accountName}
                        </td>
                        <td>
                          {line.entryIntent === "debit"
                            ? t("accounting.precheck.debit")
                            : t("accounting.precheck.credit")}
                        </td>
                        <td>
                          <bdi className="accounting-amount" dir="ltr">{line.amount}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {precheck.blockers.length === 0 ? null : (
            <>
              <h4>{t("accounting.precheck.blockersHeading")}</h4>
              <ul className="accounting-blocker-list">
                {precheck.blockers.map((blocker) => (
                  <li key={blocker.code}>
                    {t(`accounting.precheck.codes.${blocker.code}`, {
                      defaultValue: blocker.message,
                    })}
                  </li>
                ))}
              </ul>
            </>
          )}
          {precheck.warnings.length === 0 ? null : (
            <>
              <h4>{t("accounting.precheck.warningsHeading")}</h4>
              <ul className="accounting-blocker-list">
                {precheck.warnings.map((warning) => (
                  <li key={warning.code}>
                    {t(`accounting.precheck.codes.${warning.code}`, {
                      defaultValue: warning.message,
                    })}
                  </li>
                ))}
              </ul>
            </>
          )}
          {/* No invented expiry: the statement of record is that the backend
              revalidates everything again at execution. */}
          <p className="accounting-hint">{t("accounting.precheck.revalidationNote")}</p>
        </>
      )}

      {!open || precheck === undefined ? null : (
        <Modal
          closeLabel={t("common.cancel", { defaultValue: "Cancel" })}
          onRequestClose={() => setOpen(false)}
          title={t("accounting.reprocess.preview")}
          titleId="accounting-reprocess-preview"
        >
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
          <dl className="accounting-detail-grid">
            <div>
              <dt>{t("accounting.related.event")}</dt>
              <dd>{eventTypeLabel(t, detail.event_type)}</dd>
            </div>
            <div>
              <dt>{t("accounting.related.sourceTransaction")}</dt>
              <dd>
                <DirectionalText>{precheck.source.reference ?? "—"}</DirectionalText>
              </dd>
            </div>
            <div>
              <dt>{t("accounting.fields.status")}</dt>
              <dd>{lifecycle.label}</dd>
            </div>
            <div>
              <dt>{t("accounting.fields.accountingDate")}</dt>
              <dd>{formatAccountingDate(precheck.accountingDate, language)}</dd>
            </div>
            <div>
              <dt>{t("accounting.precheck.fiscalPeriod")}</dt>
              <dd>
                {t(`accounting.status.${String(precheck.fiscalPeriod.status)}`, {
                  defaultValue: String(precheck.fiscalPeriod.status ?? "—"),
                })}
              </dd>
            </div>
            <div>
              <dt>{t("accounting.precheck.expectedDebit")}</dt>
              <dd>
                <bdi className="accounting-amount" dir="ltr">{precheck.expectedDebitTotal}</bdi>
              </dd>
            </div>
            <div>
              <dt>{t("accounting.precheck.expectedCredit")}</dt>
              <dd>
                <bdi className="accounting-amount" dir="ltr">{precheck.expectedCreditTotal}</bdi>
              </dd>
            </div>
          </dl>
          <div className="alert alert-warning" role="status">
            {t("accounting.precheck.revalidationWarning")}
          </div>
          <label className="field">
            <span>{t("accounting.reprocess.note")}</span>
            <textarea onChange={(event) => setNote(event.currentTarget.value)} value={note} />
          </label>
          <div className="modal-actions">
            <button
              className="button button-primary"
              disabled={busy || !precheck.allowed}
              onClick={() => void submit()}
              type="button"
            >
              {t("accounting.reprocess.confirm")}
            </button>
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
              type="button"
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
