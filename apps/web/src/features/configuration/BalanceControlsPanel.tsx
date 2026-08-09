import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";

/**
 * Cash and Bank Balance Controls — Company Profile section.
 *
 * ===========================================================================
 * SUPERSEDE, NEVER EDIT
 * ===========================================================================
 *
 * There is no Save-in-place and no Delete anywhere in this panel. A change
 * SCHEDULES a new effective-dated rule; the backend closes the current one at
 * that date and the new one takes over.
 *
 * Editing the active rule would rewrite the past: every payment previously
 * blocked, and every override audited under the old terms, would silently be
 * judged against a policy that did not exist when the decision was made. That
 * is exactly what effective dating exists to prevent, so the UI does not offer
 * the affordance at all rather than offering it and warning about it.
 *
 * ===========================================================================
 * THE BACKEND IS AUTHORITATIVE
 * ===========================================================================
 *
 * The checks here — overdraft limit required, date not in the past — exist to
 * give a fast, friendly answer, not to decide anything. The same rules are
 * enforced by the API and by CHECK constraints, and a rejection is rendered
 * from the API's own error code. Nothing is saved on the strength of a
 * client-side check alone, and no raw constraint text ever reaches the screen.
 */

/**
 * ENFORCEMENT IS LIVE.
 *
 * This was a temporary safety gate held closed while the policy was
 * configurable but inert. A control a user can see and configure but that
 * enforces nothing is worse than no control: it manufactures assurance that
 * does not exist, so the configuration stayed visible and readable while every
 * way of changing it was closed.
 *
 * All five outgoing workflows now consult the policy before writing -- Payroll
 * Payments, Outsourced Driver Fee cash payments, Trader Settlements, General
 * Expense Payments and Cash/Bank Movements -- so a scheduled policy is
 * honoured and scheduling is open again.
 *
 * This flag MIRRORS `balanceControlEnforcementReady` in
 * balance-control.controller.ts, which is the authoritative gate: the API
 * rejects a write regardless of what this screen offers. The two must be
 * switched together, and this one exists only so the screen does not present a
 * form whose submission the server would refuse.
 */
const enforcementEnabled = true;

type CashPolicy = "allow" | "allow_with_override" | "block";
type BankPolicy = CashPolicy | "allow_within_overdraft";

const cashPolicies: readonly CashPolicy[] = ["block", "allow_with_override", "allow"];
const bankPolicies: readonly BankPolicy[] = [
  "block",
  "allow_within_overdraft",
  "allow_with_override",
  "allow",
];

/**
 * How permissive each option is, lowest first.
 *
 * Used only to decide whether a change LOOSENS the control, which is the one
 * direction that gets a confirmation step. Tightening needs no ceremony.
 */
const permissiveness: Readonly<Record<string, number>> = {
  allow: 3,
  allow_with_override: 1,
  allow_within_overdraft: 2,
  block: 0,
};

interface ScheduleEntry {
  readonly bankOverdraftLimit: string;
  readonly bankPolicy: BankPolicy;
  readonly cashPolicy: CashPolicy;
  readonly changeReason: string;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly id: string;
  readonly isActive: boolean;
  readonly isCurrent: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

interface Schedule {
  readonly active: ScheduleEntry | null;
  readonly history: readonly ScheduleEntry[];
  readonly scheduled: readonly ScheduleEntry[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BalanceControlsPanel({
  api,
  canManage,
}: {
  readonly api: ApiClient;
  readonly canManage: boolean;
}) {
  const { t } = useTranslation();
  const [schedule, setSchedule] = useState<Schedule>();
  const [cashPolicy, setCashPolicy] = useState<CashPolicy>("block");
  const [bankPolicy, setBankPolicy] = useState<BankPolicy>("allow_within_overdraft");
  const [overdraftLimit, setOverdraftLimit] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [changeReason, setChangeReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "error" | "success"; message: string }>();

  const load = useCallback(() => {
    api
      .get<Schedule>("company-profile/balance-controls")
      .then((loaded) => {
        setSchedule(loaded);
        // Seed the form from what is in force, so a change starts from the
        // truth rather than from a default the Company never chose.
        if (loaded.active !== null) {
          setCashPolicy(loaded.active.cashPolicy);
          setBankPolicy(loaded.active.bankPolicy);
          setOverdraftLimit(
            loaded.active.bankPolicy === "allow_within_overdraft"
              ? loaded.active.bankOverdraftLimit
              : "",
          );
        }
      })
      .catch((cause: unknown) => {
        setStatus({
          kind: "error",
          message: t(
            `accounting.errors.codes.${cause instanceof ApiError ? cause.code : "unknown"}`,
            { defaultValue: t("balanceControls.errors.load") },
          ),
        });
      });
  }, [api, t]);

  useEffect(load, [load]);

  const overdraftApplies = bankPolicy === "allow_within_overdraft";
  const loosensCash =
    schedule?.active !== null &&
    schedule !== undefined &&
    (permissiveness[cashPolicy] ?? 0) >
      (permissiveness[schedule.active?.cashPolicy ?? "block"] ?? 0);
  const loosensBank =
    schedule?.active !== null &&
    schedule !== undefined &&
    (permissiveness[bankPolicy] ?? 0) >
      (permissiveness[schedule.active?.bankPolicy ?? "block"] ?? 0);
  const loosens = loosensCash === true || loosensBank === true;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A less restrictive control is the change worth pausing on: it widens what
    // the system will let people do with money. Tightening does not ask.
    if (loosens && !confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setStatus(undefined);
    api
      .post("company-profile/balance-controls", {
        bankOverdraftLimit: overdraftApplies ? overdraftLimit : undefined,
        bankPolicy,
        cashPolicy,
        changeReason,
        effectiveFrom,
      })
      .then(() => {
        setStatus({ kind: "success", message: t("balanceControls.saved") });
        setChangeReason("");
        setConfirming(false);
        setSaving(false);
        load();
      })
      .catch((cause: unknown) => {
        setStatus({
          kind: "error",
          // Rendered from the API's own error code, so a CHECK constraint or a
          // SQL message can never reach a user.
          message: t(
            `balanceControls.errors.${cause instanceof ApiError ? cause.code : "unknown"}`,
            { defaultValue: t("balanceControls.errors.save") },
          ),
        });
        setConfirming(false);
        setSaving(false);
      });
  };

  const describe = (entry: ScheduleEntry) =>
    t("balanceControls.summaryLine", {
      bank: t(`balanceControls.bankOptions.${entry.bankPolicy}`),
      cash: t(`balanceControls.cashOptions.${entry.cashPolicy}`),
      limit:
        entry.bankPolicy === "allow_within_overdraft" ? entry.bankOverdraftLimit : t("common.none"),
    });

  return (
    <section className="configuration-panel balance-controls">
      <h2>{t("balanceControls.heading")}</h2>
      <p className="accounting-hint">{t("balanceControls.intro")}</p>

      {/* The one honest caveat left. Payments recorded before funding accounts
          were captured cannot be attributed to an account, so the balance the
          policy judges against is short by an unknown amount in a Company with
          such history. Stated here rather than assumed away. */}
      <p className="accounting-hint">{t("balanceControls.coverageNote")}</p>

      {status === undefined ? null : (
        <p
          className={`form-status ${status.kind === "error" ? "form-status-error" : "form-status-success"}`}
          role={status.kind === "error" ? "alert" : "status"}
        >
          {status.message}
        </p>
      )}

      <h3>{t("balanceControls.currentHeading")}</h3>
      {schedule?.active == null ? (
        <p className="empty-state">{t("balanceControls.empty.active")}</p>
      ) : (
        <dl className="reconciliation-summary">
          <div>
            <dt>{t("balanceControls.fields.enforcementStatus")}</dt>
            <dd>
              <strong>
                {enforcementEnabled
                  ? t("balanceControls.enforcement.enforced")
                  : t("balanceControls.enforcement.notEnforced")}
              </strong>
            </dd>
          </div>
          <div>
            <dt>{t("balanceControls.fields.cashPolicy")}</dt>
            <dd>{t(`balanceControls.cashOptions.${schedule.active.cashPolicy}`)}</dd>
          </div>
          <div>
            <dt>{t("balanceControls.fields.bankPolicy")}</dt>
            <dd>{t(`balanceControls.bankOptions.${schedule.active.bankPolicy}`)}</dd>
          </div>
          <div>
            <dt>{t("balanceControls.fields.overdraftLimit")}</dt>
            <dd>
              <bdi dir="ltr">
                {schedule.active.bankPolicy === "allow_within_overdraft"
                  ? schedule.active.bankOverdraftLimit
                  : t("common.none")}
              </bdi>
            </dd>
          </div>
          <div>
            <dt>{t("balanceControls.fields.effectiveFrom")}</dt>
            <dd>
              <bdi dir="ltr">{schedule.active.effectiveFrom ?? "—"}</bdi>
            </dd>
          </div>
          <div>
            <dt>{t("balanceControls.fields.updatedBy")}</dt>
            <dd>{schedule.active.updatedBy ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("balanceControls.fields.updatedAt")}</dt>
            <dd>
              <bdi dir="ltr">{schedule.active.updatedAt.slice(0, 10)}</bdi>
            </dd>
          </div>
        </dl>
      )}

      {schedule === undefined || schedule.scheduled.length === 0 ? null : (
        <>
          <h3>{t("balanceControls.scheduledHeading")}</h3>
          <ul className="balance-controls-schedule">
            {schedule.scheduled.map((entry) => (
              <li key={entry.id}>
                <bdi dir="ltr">{entry.effectiveFrom}</bdi> — {describe(entry)}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Permission is the only remaining reason to withhold the form. The
          enforcement flag is kept in the condition so that closing it again
          hides the form rather than offering one the API would refuse. */}
      {!canManage || !enforcementEnabled ? (
        <p className="accounting-hint">
          {canManage
            ? t("balanceControls.activationDisabled")
            : t("balanceControls.readOnly")}
        </p>
      ) : (
        <form className="company-profile-grid" onSubmit={submit}>
          <h3>{t("balanceControls.scheduleHeading")}</h3>
          <div className="cp-fields">
            <label className="field">
              <span>{t("balanceControls.fields.cashPolicy")}</span>
              <select
                onChange={(event) => {
                  setCashPolicy(event.target.value as CashPolicy);
                  setConfirming(false);
                }}
                value={cashPolicy}
              >
                {cashPolicies.map((option) => (
                  <option key={option} value={option}>
                    {t(`balanceControls.cashOptions.${option}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("balanceControls.fields.bankPolicy")}</span>
              <select
                onChange={(event) => {
                  setBankPolicy(event.target.value as BankPolicy);
                  setConfirming(false);
                }}
                value={bankPolicy}
              >
                {bankPolicies.map((option) => (
                  <option key={option} value={option}>
                    {t(`balanceControls.bankOptions.${option}`)}
                  </option>
                ))}
              </select>
            </label>
            {/* Hidden rather than disabled when it does not apply: a greyed
                field still reads as a setting that exists, and an overdraft
                limit under a blocking policy is not a setting, it is noise. */}
            {overdraftApplies ? (
              <label className="field">
                <span>{t("balanceControls.fields.overdraftLimit")}</span>
                <input
                  dir="ltr"
                  inputMode="decimal"
                  min="0.01"
                  onChange={(event) => setOverdraftLimit(event.target.value)}
                  required
                  step="0.01"
                  type="number"
                  value={overdraftLimit}
                />
              </label>
            ) : null}
            <label className="field">
              <span>{t("balanceControls.fields.effectiveFrom")}</span>
              <input
                dir="ltr"
                min={today()}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                required
                type="date"
                value={effectiveFrom}
              />
            </label>
            <label className="field field-wide">
              <span>{t("balanceControls.fields.changeReason")}</span>
              <input
                maxLength={500}
                minLength={3}
                onChange={(event) => setChangeReason(event.target.value)}
                required
                value={changeReason}
              />
            </label>
          </div>

          {/* The projected policy, stated in words before anything is saved. */}
          <p className="alert alert-info" role="status">
            {t("balanceControls.projected", {
              bank: t(`balanceControls.bankOptions.${bankPolicy}`),
              cash: t(`balanceControls.cashOptions.${cashPolicy}`),
              date: effectiveFrom,
              limit: overdraftApplies ? overdraftLimit || "0.00" : t("common.none"),
            })}
          </p>

          {confirming ? (
            <p className="alert alert-warning" role="alert">
              {t("balanceControls.confirmLoosen")}
            </p>
          ) : null}

          <div className="accounting-filter-actions">
            <button className="button" disabled={saving} type="submit">
              {confirming
                ? t("balanceControls.confirmAction")
                : t("balanceControls.scheduleAction")}
            </button>
            {confirming ? (
              <button
                className="button button-secondary"
                onClick={() => setConfirming(false)}
                type="button"
              >
                {t("common.cancel")}
              </button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
