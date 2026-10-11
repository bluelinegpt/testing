import { type ReactElement, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  type CompanyDataResetExecution,
  type CompanyDataResetPlan,
  type CompanyDataResetRequest,
  platformApi,
  platformApiErrorMessage,
  PlatformApiError,
  type ResetDomain,
  type ResetPreset,
  type ResetUserMode,
  type ResetUserPlan,
} from "../api/platform-client.js";

/**
 * Platform Administration -> Company -> Company Data Reset.
 *
 * Preview first: the server returns ONE deterministic plan (what is removed,
 * what is kept, every user's handling) and its planVersion. Execute sends the
 * same choices + that planVersion + the typed confirmation, and the server
 * applies exactly that plan or refuses (stale / blocked). Nothing is implied:
 * operational and financial presets keep every user, workforce record,
 * trader and customer; user removal is a separate, explicit mode.
 *
 * Prompt 3 (final UX): Traders & customers choice, required dependencies,
 * role and protection state per user, explicit protected-admin deletion,
 * clear stale / blocked / rolled-back messages, a single in-flight execution,
 * and the audit reference + backup checksum after success.
 */

/** UI choices. "TRADERS_CUSTOMERS" is the CUSTOM preset with only that domain. */
type ResetChoice = ResetPreset | "TRADERS_CUSTOMERS";

const choices: readonly { value: ResetChoice; label: string; note: string }[] = [
  { label: "Operational data", note: "Orders and operational records. Keeps users, workforce, traders, customers and configuration.", value: "OPERATIONAL_DATA" },
  { label: "Financial data", note: "Accounting, settlements, collections, receivables, payroll transactions. Keeps users, workforce, traders, customers and configuration.", value: "FINANCIAL_DATA" },
  { label: "Users & workforce", note: "Only the user mode you choose. No business data.", value: "USERS_WORKFORCE" },
  { label: "Traders & customers", note: "Traders and customers. Their orders and financial records are listed as required dependencies before anything runs. Keeps users and workforce.", value: "TRADERS_CUSTOMERS" },
  { label: "Full Company data — keep Company", note: "Operational + financial data; traders/customers and workforce only if you choose; user mode explicit.", value: "FULL_COMPANY_DATA_KEEP_COMPANY" },
  { label: "Custom", note: "Choose the data groups yourself.", value: "CUSTOM" },
];

const domains: readonly { value: ResetDomain; label: string }[] = [
  { label: "Operational", value: "OPERATIONAL" },
  { label: "Financial", value: "FINANCIAL" },
  { label: "Traders & customers", value: "TRADERS_CUSTOMERS" },
  { label: "Workforce (employees & drivers)", value: "WORKFORCE" },
  { label: "Integrations configuration", value: "INTEGRATIONS" },
];
const domainLabel = (domain: ResetDomain): string => domains.find((entry) => entry.value === domain)?.label ?? domain;

const userModes: readonly { value: ResetUserMode; label: string }[] = [
  { label: "Keep all users", value: "KEEP_ALL_USERS" },
  { label: "Delete selected users", value: "DELETE_SELECTED_USERS" },
  { label: "Delete all eligible users", value: "DELETE_ALL_ELIGIBLE_USERS" },
];

const summaryRows: readonly { key: keyof CompanyDataResetPlan["summary"]; label: string }[] = [
  { key: "orders", label: "Orders" },
  { key: "collections", label: "Collections" },
  { key: "settlements", label: "Settlements" },
  { key: "accountingTransactions", label: "Accounting transactions (journals)" },
  { key: "payrollTransactions", label: "Payroll transactions" },
  { key: "traders", label: "Traders" },
  { key: "customers", label: "Customers" },
  { key: "employees", label: "Employees" },
  { key: "drivers", label: "Drivers" },
  { key: "companyUsers", label: "Company users" },
  { key: "globalIdentities", label: "Global identities" },
];

const stateLabel: Readonly<Record<ResetUserPlan["eligibility"]["state"], string>> = {
  BLOCKED: "Blocked",
  ELIGIBLE: "Eligible",
  PROTECTED: "Protected",
  SHARED: "Shared identity",
};

function errorText(failure: unknown): string {
  return failure instanceof PlatformApiError ? failure.message : platformApiErrorMessage(0, undefined, undefined);
}

/** What the Platform Admin is told when execution does not succeed. Never "success". */
function executionFailureText(failure: unknown): string {
  const code = failure instanceof PlatformApiError ? failure.code : undefined;
  const status = failure instanceof PlatformApiError ? failure.status : 0;
  // No answer from the API (timeout, network, gateway): the outcome is NOT known -- never claim either way.
  if (!(failure instanceof PlatformApiError) || status === 0 || status === 502 || status === 503 || status === 504) {
    return "The connection ended before the result arrived, so the outcome is unknown. Do not execute again: run Preview — if the reset ran, Preview shows it as the last reset and the old plan is refused.";
  }
  if (code === "reset_plan_stale") return "Company data changed after Preview. Run Preview again. Nothing was changed.";
  if (code === "reset_plan_blocked") return `This plan is blocked and was not executed. Nothing was changed. ${errorText(failure)}`;
  if (code === "company_reset_backup_failed") return `The reset was not started: the mandatory backup failed. Nothing was changed. ${errorText(failure)}`;
  if (code === "company_reset_confirmation_mismatch") return `The confirmation did not match. Nothing was changed. ${errorText(failure)}`;
  return `Reset failed and was rolled back — nothing was changed. ${errorText(failure)}`;
}

export function CompanyDataResetPage(): ReactElement {
  const { companyId = "" } = useParams();
  const [choice, setChoice] = useState<ResetChoice>("OPERATIONAL_DATA");
  const [customDomains, setCustomDomains] = useState<readonly ResetDomain[]>([]);
  const [userMode, setUserMode] = useState<ResetUserMode>("KEEP_ALL_USERS");
  const [tradersCustomers, setTradersCustomers] = useState<"KEEP" | "RESET">("KEEP");
  const [workforce, setWorkforce] = useState<"KEEP" | "RESET">("KEEP");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [deleteAdmins, setDeleteAdmins] = useState<readonly string[]>([]);
  const [plan, setPlan] = useState<CompanyDataResetPlan>();
  const [planRequest, setPlanRequest] = useState<CompanyDataResetRequest>();
  /** False after any change to the choices: the plan must be previewed again. */
  const [planFresh, setPlanFresh] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<CompanyDataResetExecution>();
  /** One execution in flight at most: a double click never sends a second request. */
  const executing = useRef(false);

  const preset: ResetPreset = choice === "TRADERS_CUSTOMERS" ? "CUSTOM" : choice;
  const usersAllowed = choice === "USERS_WORKFORCE" || choice === "FULL_COMPANY_DATA_KEEP_COMPANY" || choice === "CUSTOM";
  // Selecting users needs the user list first: an empty selection previews as a listing only.
  const listingOnly = usersAllowed && userMode === "DELETE_SELECTED_USERS" && selected.length === 0;
  const effectiveMode: ResetUserMode = listingOnly ? "KEEP_ALL_USERS" : userMode;
  const buildRequest = (
    mode: ResetUserMode = effectiveMode,
    users: readonly string[] = selected,
    admins: readonly string[] = deleteAdmins,
  ): CompanyDataResetRequest => ({
    preset,
    ...(choice === "CUSTOM" ? { domains: customDomains } : {}),
    ...(choice === "TRADERS_CUSTOMERS" ? { domains: ["TRADERS_CUSTOMERS"] as ResetDomain[] } : {}),
    ...(usersAllowed ? { userMode: mode } : {}),
    ...(usersAllowed && mode === "DELETE_SELECTED_USERS" ? { selectedAccountIds: users } : {}),
    ...(usersAllowed && mode !== "KEEP_ALL_USERS" && admins.length > 0 ? { deleteAdminAccountIds: admins } : {}),
    ...(choice === "FULL_COMPANY_DATA_KEEP_COMPANY" ? { tradersCustomers, workforce } : {}),
  });

  const invalidate = (): void => {
    setPlan(undefined);
    setPlanFresh(false);
    setPlanRequest(undefined);
    setResult(undefined);
    setConfirmation("");
  };

  const runPreview = (body: CompanyDataResetRequest, fresh: boolean): void => {
    setBusy(true);
    setError(undefined);
    void platformApi
      .companyDataResetPreview(companyId, body)
      .then((next) => {
        setPlan(next);
        setPlanRequest(body);
        setPlanFresh(fresh);
      })
      .catch((failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };

  const preview = (): void => {
    setResult(undefined);
    runPreview(buildRequest(), !listingOnly);
  };

  const execute = (): void => {
    if (plan === undefined || planRequest === undefined || executing.current) return;
    executing.current = true;
    setBusy(true);
    setError(undefined);
    void platformApi
      .companyDataResetExecute(companyId, { ...planRequest, confirmation: confirmation.trim(), planVersion: plan.planVersion })
      .then((next) => {
        setResult(next);
        setPlan(undefined);
        setPlanFresh(false);
        setConfirmation("");
      })
      .catch((failure: unknown) => {
        setError(executionFailureText(failure));
        // A stale or blocked plan must be previewed again; nothing was changed.
        const unknown = !(failure instanceof PlatformApiError) || [0, 502, 503, 504].includes(failure.status);
        if (unknown || (failure instanceof PlatformApiError && (failure.code === "reset_plan_stale" || failure.code === "reset_plan_blocked"))) {
          setPlan(undefined);
          setPlanFresh(false);
        }
      })
      .finally(() => {
        executing.current = false;
        setBusy(false);
      });
  };

  const toggle = (list: readonly string[], id: string): readonly string[] =>
    list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];

  /** A Company Admin is never an ordinary selection: one explicit control selects AND confirms it. */
  const toggleProtectedAdmin = (accountId: string): void => {
    const on = !deleteAdmins.includes(accountId);
    setDeleteAdmins((current) => (on ? [...current, accountId] : current.filter((entry) => entry !== accountId)));
    if (userMode === "DELETE_SELECTED_USERS") {
      setSelected((current) => (on ? [...current.filter((entry) => entry !== accountId), accountId] : current.filter((entry) => entry !== accountId)));
    }
    setPlanFresh(false);
  };

  return (
    <section aria-labelledby="company-data-reset-title" className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <p className="platform-page__eyebrow">Company Data Reset</p>
          <h2 id="company-data-reset-title">Reset Company data — the Company is always kept</h2>
          <p className="platform-muted">
            Preview shows exactly what would be removed and kept. Nothing changes until you execute the previewed plan.
          </p>
        </div>
        <Link className="platform-button platform-button--quiet" to={`/companies/${companyId}`}>
          Back to Company
        </Link>
      </div>

      <fieldset className="platform-card">
        <legend>1. What to reset</legend>
        {choices.map((option) => (
          <label className="platform-field" key={option.value}>
            <input
              checked={choice === option.value}
              name="preset"
              onChange={() => {
                setChoice(option.value);
                setUserMode("KEEP_ALL_USERS");
                setSelected([]);
                setDeleteAdmins([]);
                invalidate();
              }}
              type="radio"
            />{" "}
            <strong>{option.label}</strong> — <span className="platform-muted">{option.note}</span>
          </label>
        ))}
        {choice === "CUSTOM" ? (
          <div aria-label="Custom domains">
            {domains.map((domain) => (
              <label className="platform-field" key={domain.value}>
                <input
                  checked={customDomains.includes(domain.value)}
                  onChange={() => {
                    setCustomDomains((current) => toggle(current, domain.value) as ResetDomain[]);
                    invalidate();
                  }}
                  type="checkbox"
                />{" "}
                {domain.label}
              </label>
            ))}
          </div>
        ) : null}
        {choice === "FULL_COMPANY_DATA_KEEP_COMPANY" ? (
          <div>
            <label className="platform-field">
              <span>Traders & customers</span>
              <select aria-label="Traders and customers" onChange={(event) => { setTradersCustomers(event.target.value as "KEEP" | "RESET"); invalidate(); }} value={tradersCustomers}>
                <option value="KEEP">Keep</option>
                <option value="RESET">Reset</option>
              </select>
            </label>
            <label className="platform-field">
              <span>Workforce (employees & drivers)</span>
              <select aria-label="Workforce" onChange={(event) => { setWorkforce(event.target.value as "KEEP" | "RESET"); invalidate(); }} value={workforce}>
                <option value="KEEP">Keep</option>
                <option value="RESET">Reset</option>
              </select>
            </label>
          </div>
        ) : null}
        {usersAllowed ? (
          <label className="platform-field">
            <span>2. Users</span>
            <select
              aria-label="User mode"
              onChange={(event) => {
                setUserMode(event.target.value as ResetUserMode);
                setSelected([]);
                setDeleteAdmins([]);
                invalidate();
              }}
              value={userMode}
            >
              {userModes.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="platform-muted" data-testid="users-kept-note">
            Every user, Employee and Driver is kept by this choice.
          </p>
        )}
        <button className="platform-button" disabled={busy} onClick={preview} type="button">
          {busy && plan === undefined && result === undefined ? "Previewing…" : "Preview reset"}
        </button>
      </fieldset>

      {error === undefined ? null : (
        <p className="platform-login__error" role="alert">
          {error}
        </p>
      )}

      {plan === undefined ? null : (
        <section aria-label="Reset preview" className="platform-card">
          <h3>
            Preview — {plan.company.name} ({plan.company.code})
          </h3>
          <p className="platform-muted">
            Data groups reset:{" "}
            <strong data-testid="effective-domains">
              {plan.effectiveDomains.length === 0 ? "none" : plan.effectiveDomains.map(domainLabel).join(", ")}
            </strong>
          </p>
          {plan.requiredDependencies.length === 0 ? null : (
            <div>
              <h4>Required dependencies</h4>
              <ul aria-label="Required dependencies">
                {plan.requiredDependencies.map((dependency) => (
                  <li key={dependency.domain}>
                    <strong>{domainLabel(dependency.domain)}</strong> — {dependency.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <table aria-label="Reset summary" className="platform-table">
            <thead>
              <tr>
                <th scope="col">Records</th>
                <th scope="col">Delete</th>
                <th scope="col">Keep</th>
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => {
                const value = plan.summary[row.key] as { delete: number; preserve: number };
                return (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td>{value.delete}</td>
                    <td>{value.preserve}</td>
                  </tr>
                );
              })}
              <tr>
                <td>Role assignments / memberships removed</td>
                <td>
                  {plan.summary.roleAssignmentsDeleted} / {plan.summary.membershipsDeleted}
                </td>
                <td>—</td>
              </tr>
              <tr>
                <td>Protected admins / shared identities preserved</td>
                <td>—</td>
                <td>
                  {plan.summary.protectedAdmins} / {plan.summary.sharedIdentitiesPreserved}
                </td>
              </tr>
              <tr>
                <td>Fiscal years / periods (kept; reopened by a Financial reset)</td>
                <td>—</td>
                <td data-testid="fiscal-calendar">
                  {plan.fiscalCalendar.fiscalYearsPreserved} / {plan.fiscalCalendar.periodsPreserved}
                  {plan.fiscalCalendar.fiscalYearsToOpen + plan.fiscalCalendar.periodsToOpen > 0
                    ? ` (reopen ${plan.fiscalCalendar.fiscalYearsToOpen} / ${plan.fiscalCalendar.periodsToOpen})`
                    : ""}
                </td>
              </tr>
              <tr>
                <td>Reference numbering (orders, settlements, collections, journals…)</td>
                <td>—</td>
                <td data-testid="reference-counters">PRESERVE — numbering continues</td>
              </tr>
              <tr>
                <td>Platform repair executions, attempts, general audit</td>
                <td>—</td>
                <td data-testid="audit-preserved">PRESERVE</td>
              </tr>
            </tbody>
          </table>

          <table aria-label="Company users" className="platform-table">
            <thead>
              <tr>
                <th scope="col">Select</th>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">State</th>
                <th scope="col">This plan</th>
                <th scope="col">Employee</th>
                <th scope="col">Driver</th>
                <th scope="col">Login</th>
              </tr>
            </thead>
            <tbody>
              {plan.users.map((user) => {
                const protectedAdmin = user.eligibility.state === "PROTECTED";
                const selectable = userMode === "DELETE_SELECTED_USERS" && (user.eligibility.state === "ELIGIBLE" || user.eligibility.state === "SHARED");
                return (
                  <tr key={user.accountId}>
                    <td>
                      {selectable ? (
                        <input
                          aria-label={`Select ${user.username}`}
                          checked={selected.includes(user.accountId)}
                          onChange={() => {
                            setSelected((current) => toggle(current, user.accountId));
                            setPlanFresh(false);
                          }}
                          type="checkbox"
                        />
                      ) : null}
                      {protectedAdmin && userMode !== "KEEP_ALL_USERS" ? (
                        <label>
                          <input
                            aria-label={`Confirm deleting admin ${user.username}`}
                            checked={deleteAdmins.includes(user.accountId)}
                            onChange={() => toggleProtectedAdmin(user.accountId)}
                            type="checkbox"
                          />{" "}
                          delete protected admin (explicit)
                        </label>
                      ) : null}
                    </td>
                    <td>
                      {user.displayName} <span className="platform-muted">({user.username} · {user.accountKind === "driver" ? "Driver login" : "Company user"})</span>
                    </td>
                    <td>{user.roles.length === 0 ? "—" : user.roles.join(", ")}</td>
                    <td>
                      <span
                        className={user.eligibility.state === "ELIGIBLE" ? "platform-badge platform-badge--active" : "platform-badge platform-badge--severity-high"}
                        title={user.eligibility.reason ?? undefined}
                      >
                        {stateLabel[user.eligibility.state]}
                      </span>
                      {user.eligibility.reason === null ? null : <div className="platform-muted">{user.eligibility.reason}</div>}
                    </td>
                    <td>
                      {user.remove ? "REMOVE" : user.classification}
                      {user.reason === null ? null : <div className="platform-muted">{user.reason}</div>}
                    </td>
                    <td>{user.employee === null ? "—" : `${user.employee.reference}: ${user.employee.action}`}</td>
                    <td>{user.driver === null ? "—" : `${user.driver.reference}: ${user.driver.action}`}</td>
                    <td>{user.remove ? user.identity.action : "KEEP"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {plan.blockers.length === 0 ? null : (
            <div role="alert">
              <h4>Blocked — this plan cannot be executed</h4>
              <ul aria-label="Blockers">
                {plan.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}
          {plan.warnings.length === 0 ? null : (
            <ul aria-label="Warnings">
              {plan.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <p className="platform-muted" data-testid="plan-reference">
            Plan {plan.planVersion.slice(0, 17)}…
            {plan.lastReset === null ? " · no previous reset" : ` · last reset ${plan.lastReset.at} (audit ${plan.lastReset.auditEventId})`}
          </p>

          {!planFresh ? (
            <p className="platform-muted" data-testid="preview-again">
              {userMode === "DELETE_SELECTED_USERS" && selected.length === 0
                ? "Select the users to delete, then preview again."
                : "Your choices changed: preview again before executing."}
            </p>
          ) : plan.executable ? (
            <div aria-label="Confirm reset">
              <label className="platform-field">
                <span>
                  Type <code>{plan.confirmation}</code> to confirm
                </span>
                <input aria-label="Confirmation" onChange={(event) => setConfirmation(event.target.value)} value={confirmation} />
              </label>
              <button
                className="platform-button platform-button--danger"
                disabled={busy || confirmation.trim() !== plan.confirmation}
                onClick={execute}
                type="button"
              >
                {busy ? "Resetting…" : "Execute this reset plan"}
              </button>
            </div>
          ) : (
            <p className="platform-muted" data-testid="not-executable">
              {plan.blockers.length > 0
                ? "This plan cannot be executed. Resolve the blocked items above and preview again."
                : "Nothing would be reset with this selection."}
            </p>
          )}
        </section>
      )}

      {result === undefined ? null : (
        <section aria-label="Reset result" className="platform-card" role="status">
          <h3>Reset completed</h3>
          <p>
            {result.totalRemoved} row(s) removed · data groups {result.effectiveDomains.map(domainLabel).join(", ") || "none"} · logins deleted{" "}
            {result.identitiesDeleted}, preserved {result.identitiesPreserved}
            {result.periodsOpened + result.fiscalYearsOpened > 0 ? ` · reopened ${result.fiscalYearsOpened} fiscal year(s), ${result.periodsOpened} period(s)` : ""}
          </p>
          <p className="platform-muted" data-testid="result-audit">
            Audit event {result.auditEventId} · reference {result.correlationId} · integrity checks passed: {result.integrityChecks.length}
          </p>
          <p className="platform-muted" data-testid="result-backup">
            Backup {result.backupFile} · sha256 {result.backupSha256.slice(0, 16)}… · {result.backupBytes} bytes
          </p>
          <button
            className="platform-button platform-button--quiet"
            disabled={busy}
            onClick={() => {
              // Re-preview the same data groups with every user kept: the Company's state after the reset.
              setUserMode("KEEP_ALL_USERS");
              setSelected([]);
              setDeleteAdmins([]);
              setResult(undefined);
              runPreview(buildRequest("KEEP_ALL_USERS", [], []), true);
            }}
            type="button"
          >
            Preview the Company&apos;s current state
          </button>
        </section>
      )}
    </section>
  );
}
