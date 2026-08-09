import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";
import { AccountingApi, accountingQueryKey } from "./accounting-api.js";
import {
  DirectionalText,
  LoadPanel,
  StatusBadge,
  accountingPermissions,
} from "./AccountingComponents.js";
import type { AccountingRecord } from "./accounting-types.js";
import { useAccountingResource } from "./use-accounting-resource.js";

interface SetupStep {
  readonly key: string;
  readonly path: string;
  readonly state: "complete" | "blocked" | "warning";
}

function dubaiDate(): string {
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Dubai",
    year: "numeric",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function records(value: unknown): readonly AccountingRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is AccountingRecord => typeof item === "object" && item !== null)
    : [];
}

/**
 * Steps whose panel lives further down THIS page rather than on another
 * route. Their `path` is "/accounting/setup" — navigating there from here is
 * a no-op, so Open scrolls to the panel instead.
 */
const inPageAnchors: Readonly<Record<string, string>> = {
  activation: "accounting-setup-activation",
  requiredMappings: "accounting-setup-mappings",
};

/**
 * Every operational posting area the backend accepts
 * (`accountingOperationalAreas`). Listed here so the panel always shows the
 * full set — including areas the readiness endpoint may omit — rather than
 * only whatever happens to come back.
 */
const operationalAreas = [
  "orders",
  "trader_receivables",
  "trader_settlements",
  "driver_collections",
  "driver_expenses",
  "employee_payroll",
  "outsourced_driver_fees",
  "general_expenses",
  "cash_bank_management",
] as const;

export function AccountingSetupWizard({
  api,
  companyId,
  onNavigate,
  permissions,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly onNavigate: (path: string) => void;
  readonly permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new AccountingApi(api), [api]);
  const rights = accountingPermissions(permissions);
  const [revision, setRevision] = useState(0);
  const [effectiveOn, setEffectiveOn] = useState(dubaiDate);
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [decisionReason, setDecisionReason] = useState("");
  const [mappingFilter, setMappingFilter] = useState("all");
  const [mappingAreaFilter, setMappingAreaFilter] = useState("all");
  const [zeroReason, setZeroReason] = useState("");
  const [zeroAcknowledged, setZeroAcknowledged] = useState(false);
  const [activationConfirmed, setActivationConfirmed] = useState(false);
  const [activationWarnings, setActivationWarnings] = useState(false);
  const [activationResult, setActivationResult] = useState<AccountingRecord>();

  useEffect(() => {
    setSelectedAccounts({});
    setActivationResult(undefined);
    setOperationError(undefined);
    setDecisionReason("");
    setMappingFilter("all");
    setMappingAreaFilter("all");
    setZeroReason("");
    setZeroAcknowledged(false);
    setActivationConfirmed(false);
    setActivationWarnings(false);
  }, [companyId]);

  const configuration = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "setup:configuration", { revision }),
    (signal) => client.configuration(signal),
  );
  const completeness = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "setup:completeness", { revision }),
    (signal) => client.configurationReadiness(signal),
  );
  const accounts = useAccountingResource<
    { readonly items?: readonly AccountingRecord[] } | readonly AccountingRecord[]
  >(accountingQueryKey(companyId, "setup:accounts", { revision }), (signal) =>
    client.get("accounts", { activeOnly: false }, signal),
  );
  const suggestions = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "setup:mapping-suggestions", { effectiveOn, revision }),
    (signal) => client.mappingSuggestions(effectiveOn, signal),
  );
  const issues = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "setup:mapping-issues", { effectiveOn, revision }),
    (signal) => client.mappingIssues(effectiveOn, signal),
  );
  const zeroOpening = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "setup:zero-opening", { effectiveOn, revision }),
    (signal) => client.zeroOpeningStatus(effectiveOn, signal),
  );
  const areas = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "setup:areas", { revision }),
    (signal) => client.setupAreas(signal),
  );
  const postingStatus = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "setup:posting-status", { revision }),
    (signal) => client.automaticPostingStatus(signal),
  );
  const fiscalYears = useAccountingResource<readonly AccountingRecord[]>(
    accountingQueryKey(companyId, "setup:fiscal-years", { revision }),
    (signal) => client.fiscalYears(signal),
  );
  const fiscalPeriods = useAccountingResource<readonly AccountingRecord[]>(
    accountingQueryKey(companyId, "setup:fiscal-periods", { revision }),
    (signal) => client.fiscalPeriods(undefined, signal),
  );
  const activationPreviewResource = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "setup:activation-preview", { effectiveOn, revision }),
    () =>
      rights.configure
        ? client.post<AccountingRecord>("setup/activation-preview", { activationDate: effectiveOn })
        : Promise.resolve({
            activationEligible: false,
            configurationPercentage: completeness.data?.percentage ?? 0,
            criticalBlockers: ["missing_accounting_configuration_permission"],
            warnings: [],
          }),
  );
  const activationPreview = activationPreviewResource.data;
  const activationBlockers = Array.isArray(activationPreview?.criticalBlockers)
    ? activationPreview.criticalBlockers.map(String)
    : [];
  const activationWarningCodes = Array.isArray(activationPreview?.warnings)
    ? activationPreview.warnings.map(String)
    : [];

  const accountRows = Array.isArray(accounts.data)
    ? accounts.data
    : accounts.data !== undefined && "items" in accounts.data
      ? (accounts.data.items ?? [])
      : [];
  const completed = new Set(
    Array.isArray(completeness.data?.completedSteps)
      ? completeness.data.completedSteps.map(String)
      : [],
  );
  const blockers = records(completeness.data?.blockers);
  const mappingRows = records(suggestions.data?.items);
  const issueRows = records(issues.data?.items);
  const filteredMappingRows = mappingRows.filter((row) => {
    const areaMatches =
      mappingAreaFilter === "all" || String(row.operationalArea) === mappingAreaFilter;
    if (!areaMatches) return false;
    const mappingIssuesForRow = issueRows.filter((issue) => issue.mappingKey === row.mappingKey);
    switch (mappingFilter) {
      case "mandatory":
        return row.mandatoryStatus === "mandatory";
      case "missing":
        return row.currentMapping === null;
      case "invalid":
        return row.status === "invalid_existing_mapping";
      case "low":
      case "medium":
      case "high":
        return row.confidence === mappingFilter;
      case "unresolved":
        return row.status === "unresolved";
      case "existing_valid":
        return row.status === "already_configured";
      case "gap":
        return mappingIssuesForRow.some(
          (issue) =>
            String(issue.issueType).includes("gap") ||
            issue.issueType === "mapping_begins_after_activation" ||
            issue.issueType === "mapping_ends_before_period_end",
        );
      case "overlap":
        return mappingIssuesForRow.some((issue) => issue.issueType === "overlap");
      default:
        return true;
    }
  });
  const mappingAreas = [...new Set(mappingRows.map((row) => String(row.operationalArea)))];
  const areaRows = records(areas.data?.areas);
  // Always render the full operational-area set in a stable order, falling
  // back to a not-ready placeholder for any area the readiness payload omits,
  // so an area can never silently disappear from the panel.
  const orderedAreas = operationalAreas.map(
    (key) =>
      areaRows.find((row) => String(row.area) === key) ?? {
        activationBlockers: [],
        area: key,
        failedEventCount: "0",
        lastSuccessfulPosting: null,
        missingMappings: [],
        ready: false,
        status: "not_ready",
      },
  );
  const enabledAreas = new Set(
    Array.isArray(postingStatus.data?.enabledAreas)
      ? postingStatus.data.enabledAreas.map(String)
      : [],
  );
  const globalPostingEnabled = postingStatus.data?.automaticPostingEnabled === true;
  const steps: readonly SetupStep[] = [
    {
      key: "chart",
      path: "/accounting/chart-of-accounts",
      state: accountRows.length > 0 ? "complete" : "blocked",
    },
    {
      key: "classification",
      path: "/accounting/chart-of-accounts",
      state: completed.has("accountsClassified") ? "complete" : "warning",
    },
    {
      key: "mappings",
      path: "/accounting/setup",
      state: issueRows.some((item) => item.activationBlocker === true) ? "blocked" : "complete",
    },
    {
      key: "fiscalYear",
      path: "/accounting/fiscal-years",
      state: completed.has("fiscalYear") ? "complete" : "blocked",
    },
    {
      key: "fiscalPeriod",
      path: "/accounting/fiscal-periods",
      state: completed.has("openFiscalPeriod") ? "complete" : "blocked",
    },
    {
      key: "cashBank",
      path: "/accounting/cash-accounts",
      state: completed.has("cashAndBankLinked") ? "complete" : "warning",
    },
    {
      key: "opening",
      path: "/accounting/opening-balances",
      state:
        String(zeroOpening.data?.status).includes("confirmed") || completed.has("openingBalances")
          ? "complete"
          : "warning",
    },
    {
      key: "areas",
      // Its own screen: navigating to "/accounting/setup" from this page was
      // a no-op, so Open appeared to do nothing.
      path: "/accounting/automatic-posting",
      state: areaRows.some((item) => item.ready !== true) ? "warning" : "complete",
    },
    {
      key: "activation",
      path: "/accounting/setup",
      state: configuration.data?.accountingEnabled === true ? "complete" : "blocked",
    },
  ];
  const percentage = Math.round(
    (steps.filter((step) => step.state === "complete").length / steps.length) * 100,
  );
  const firstIncomplete = steps.find((step) => step.state !== "complete");
  const loading = [
    configuration,
    completeness,
    accounts,
    suggestions,
    issues,
    zeroOpening,
    areas,
    postingStatus,
    fiscalYears,
    fiscalPeriods,
  ].some((resource) => resource.loading);
  const error = [
    configuration,
    completeness,
    accounts,
    suggestions,
    issues,
    zeroOpening,
    areas,
    postingStatus,
    fiscalYears,
    fiscalPeriods,
  ].find((resource) => resource.error !== undefined)?.error;

  const refreshAll = () => {
    setRevision((value) => value + 1);
    setActivationConfirmed(false);
    setActivationWarnings(false);
  };

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const refreshAccountingReadiness = () => refreshAll();
    window.addEventListener(
      "blueline:accounting-cash-bank-links-changed",
      refreshAccountingReadiness,
    );
    return () => {
      window.removeEventListener(
        "blueline:accounting-cash-bank-links-changed",
        refreshAccountingReadiness,
      );
    };
  }, []);

  const operation = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setOperationError(undefined);
    try {
      await action();
      refreshAll();
    } catch (issue) {
      setOperationError(issue instanceof ApiError ? issue.code : "request_failed");
    } finally {
      setBusy(undefined);
    }
  };

  const decide = (
    row: AccountingRecord,
    decision: "accept" | "change" | "reject" | "unresolved" | "not_applicable",
  ) => {
    const suggestionId = String(row.suggestionId);
    const chosen = selectedAccounts[suggestionId];
    const effectiveFrom = String(row.effectiveFromProposal ?? effectiveOn);
    void operation(`decision:${suggestionId}`, () =>
      client.post(`setup/mapping-suggestions/${suggestionId}/decision`, {
        decision: decision === "accept" && chosen !== undefined ? "change" : decision,
        ...(chosen === undefined ? {} : { accountId: chosen }),
        effectiveFrom,
        reason: decisionReason.trim() || t("accounting.setup.defaultDecisionReason"),
      }),
    );
  };

  const activePeriod = fiscalPeriods.data?.find(
    (period) =>
      String(period.startDate ?? period.periodStart) <= effectiveOn &&
      String(period.endDate ?? period.periodEnd) >= effectiveOn &&
      ["open", "reopened"].includes(String(period.status)),
  );
  const activeYear = fiscalYears.data?.find(
    (year) =>
      String(year.startDate) <= effectiveOn &&
      String(year.endDate) >= effectiveOn &&
      ["open", "reopened"].includes(String(year.status)),
  );

  return (
    <section className="accounting-page accounting-setup-wizard">
      <PageHeader
        eyebrow={t("accounting.title")}
        title={t("accounting.setup.title")}
        description={t("accounting.setup.description")}
      />
      <LoadPanel error={error} loading={loading} onRefresh={refreshAll}>
        <section className="accounting-setup-summary">
          <div>
            <strong>{percentage}%</strong>
            <span>{t("accounting.setup.complete")}</span>
          </div>
          <progress max={100} value={percentage}>
            {percentage}%
          </progress>
          <button
            className="button button-primary"
            disabled={firstIncomplete === undefined}
            onClick={() => firstIncomplete && onNavigate(firstIncomplete.path)}
            type="button"
          >
            {t("accounting.setup.continue")}
          </button>
        </section>
        <label className="field">
          <span>{t("accounting.setup.effectiveAccountingDate")}</span>
          <input
            dir="ltr"
            onChange={(event) => setEffectiveOn(event.target.value)}
            type="date"
            value={effectiveOn}
          />
        </label>
        <ol className="accounting-setup-steps">
          {steps.map((step, index) => (
            <li key={step.key}>
              <span className="accounting-setup-step-number">{index + 1}</span>
              <div>
                <strong>{t(`accounting.setup.steps.${step.key}`)}</strong>
                <small>{t(`accounting.setup.help.${step.key}`)}</small>
              </div>
              <StatusBadge value={step.state} />
              {step.key === "cashBank" ? (
                <div className="button-row">
                  <button
                    className="button button-secondary"
                    onClick={() => onNavigate("/accounting/cash-accounts")}
                    type="button"
                  >
                    {t("accounting.sections.cash-accounts")}
                  </button>
                  <button
                    className="button button-secondary"
                    onClick={() => onNavigate("/accounting/bank-accounts")}
                    type="button"
                  >
                    {t("accounting.sections.bank-accounts")}
                  </button>
                </div>
              ) : (
                <button
                  className="button button-secondary"
                  onClick={() => {
                    // Steps whose target is this same page (Automatic Posting
                    // areas, Activation, Mapping review) previously navigated
                    // to "/accounting/setup" while already on it — the click
                    // did nothing visible and the panel, far below, was never
                    // found. Scroll to the panel instead.
                    const anchor = inPageAnchors[step.key];
                    if (anchor !== undefined) {
                      document
                        .querySelector(`#${anchor}`)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                      return;
                    }
                    onNavigate(step.path);
                  }}
                  type="button"
                >
                  {t("accounting.actions.open")}
                </button>
              )}
            </li>
          ))}
        </ol>

        <section className="accounting-setup-blockers" id="accounting-setup-mappings">
          <h2>{t("accounting.setup.mappingReview")}</h2>
          <p>{t("accounting.setup.deterministicNotice")}</p>
          <label className="field">
            <span>{t("accounting.setup.decisionReason")}</span>
            <input
              maxLength={1000}
              onChange={(event) => setDecisionReason(event.target.value)}
              value={decisionReason}
            />
          </label>
          <div className="accounting-filter-bar">
            <label>
              {t("accounting.setup.operationalArea")}
              <select
                onChange={(event) => setMappingAreaFilter(event.target.value)}
                value={mappingAreaFilter}
              >
                <option value="all">{t("common.all")}</option>
                {mappingAreas.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("common.filter")}
              <select
                onChange={(event) => setMappingFilter(event.target.value)}
                value={mappingFilter}
              >
                <option value="all">{t("common.all")}</option>
                <option value="mandatory">{t("accounting.setup.mandatoryMapping")}</option>
                <option value="missing">{t("accounting.setup.missingMappings")}</option>
                <option value="invalid">{t("accounting.setup.incompatibleAccount")}</option>
                <option value="low">{t("accounting.setup.lowConfidence")}</option>
                <option value="medium">{t("accounting.setup.mediumConfidence")}</option>
                <option value="high">{t("accounting.setup.highConfidence")}</option>
                <option value="unresolved">{t("accounting.setup.unresolved")}</option>
                <option value="existing_valid">{t("accounting.setup.existingValid")}</option>
                <option value="gap">{t("accounting.setup.mappingGap")}</option>
                <option value="overlap">{t("accounting.setup.mappingOverlap")}</option>
              </select>
            </label>
          </div>
          <div className="table-shell accounting-table-shell">
            <table className="data-table accounting-table">
              <thead>
                <tr>
                  <th>{t("accounting.setup.operationalArea")}</th>
                  <th>{t("accounting.setup.requiredMapping")}</th>
                  <th>{t("accounting.setup.mandatoryStatus")}</th>
                  <th>{t("accounting.setup.currentMapping")}</th>
                  <th>{t("accounting.setup.suggestedAccount")}</th>
                  <th>{t("accounting.fields.accountCode")}</th>
                  <th>{t("accounting.fields.accountType")}</th>
                  <th>{t("accounting.fields.accountClass")}</th>
                  <th>{t("accounting.setup.confidence")}</th>
                  <th>{t("accounting.setup.compatibility")}</th>
                  <th>{t("accounting.mappings.effectiveFrom")}</th>
                  <th>{t("accounting.fields.status")}</th>
                  <th>{t("accounting.setup.action")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredMappingRows.map((row) => {
                  const suggestionId = String(row.suggestionId);
                  const suggested = row.suggestedAccount as AccountingRecord | null;
                  const alternatives = records(row.alternativeCandidates);
                  const current = row.currentMapping as AccountingRecord | null;
                  const currentAccount = current?.account as AccountingRecord | null;
                  return (
                    <tr key={suggestionId}>
                      <td>{String(row.operationalArea)}</td>
                      <td>{String(row.mappingLabel)}</td>
                      <td>
                        <StatusBadge value={row.mandatoryStatus} />
                      </td>
                      <td>
                        {currentAccount === null || currentAccount === undefined ? (
                          t("accounting.setup.unresolved")
                        ) : (
                          <>
                            <DirectionalText>{String(currentAccount.code)}</DirectionalText>{" "}
                            {String(currentAccount.nameEn)}
                          </>
                        )}
                      </td>
                      <td>
                        <select
                          aria-label={t("accounting.setup.suggestedAccount")}
                          disabled={row.status === "already_configured"}
                          onChange={(event) =>
                            setSelectedAccounts((value) => ({
                              ...value,
                              [suggestionId]: event.target.value,
                            }))
                          }
                          value={selectedAccounts[suggestionId] ?? String(suggested?.id ?? "")}
                        >
                          {suggested === null ? (
                            <option value="">{t("accounting.setup.noSafeSuggestion")}</option>
                          ) : (
                            <option value={String(suggested.id)}>
                              {String(suggested.code)} - {String(suggested.nameEn)}
                            </option>
                          )}
                          {alternatives.map((candidate) => (
                            <option key={String(candidate.id)} value={String(candidate.id)}>
                              {String(candidate.code)} - {String(candidate.nameEn)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <DirectionalText>{String(suggested?.code ?? "—")}</DirectionalText>
                      </td>
                      <td>{String(suggested?.accountType ?? "—")}</td>
                      <td>{String(suggested?.accountClass ?? "—")}</td>
                      <td>
                        <StatusBadge value={row.confidence} />
                        <small>{String(row.confidenceReason)}</small>
                      </td>
                      <td>
                        <StatusBadge value={row.compatibilityStatus} />
                      </td>
                      <td>
                        <DirectionalText>
                          {String(row.effectiveFromProposal ?? effectiveOn)}
                        </DirectionalText>
                      </td>
                      <td>
                        <StatusBadge value={row.status} />
                      </td>
                      <td>
                        {row.status === "already_configured" ? (
                          <StatusBadge value={row.status} />
                        ) : (
                          <>
                            <button
                              className="button button-primary"
                              disabled={
                                !rights.configure || busy !== undefined || suggested === null
                              }
                              onClick={() => decide(row, "accept")}
                              type="button"
                            >
                              {t("accounting.setup.acceptSuggestion")}
                            </button>
                            <button
                              className="button button-secondary"
                              disabled={!rights.configure || busy !== undefined}
                              onClick={() => decide(row, "reject")}
                              type="button"
                            >
                              {t("accounting.setup.rejectSuggestion")}
                            </button>
                            <button
                              className="button button-secondary"
                              disabled={!rights.configure || busy !== undefined}
                              onClick={() => decide(row, "unresolved")}
                              type="button"
                            >
                              {t("accounting.setup.leaveUnresolved")}
                            </button>
                            {row.mandatoryStatus === "conditional" ? (
                              <button
                                className="button button-secondary"
                                disabled={!rights.configure || busy !== undefined}
                                onClick={() => decide(row, "not_applicable")}
                                type="button"
                              >
                                {t("accounting.setup.markNotApplicable")}
                              </button>
                            ) : null}
                          </>
                        )}
                        <button
                          className="button button-secondary"
                          disabled={suggested === null}
                          onClick={() =>
                            onNavigate(
                              `/accounting/chart-of-accounts/${String(
                                selectedAccounts[suggestionId] ?? suggested?.id,
                              )}`,
                            )
                          }
                          type="button"
                        >
                          {t("accounting.setup.openAccount")}
                        </button>
                        {current === null ? null : (
                          <button
                            className="button button-secondary"
                            onClick={() => onNavigate("/accounting/mappings")}
                            type="button"
                          >
                            {t("accounting.setup.openMapping")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p>
            {t("accounting.setup.mappingIssueSummary", {
              gaps: String((issues.data?.counts as AccountingRecord | undefined)?.gaps ?? "0"),
              overlaps: String(
                (issues.data?.counts as AccountingRecord | undefined)?.overlaps ?? "0",
              ),
            })}
          </p>
        </section>

        <section className="accounting-activation-preview">
          <h2>{t("accounting.setup.openingBalanceStatus")}</h2>
          <StatusBadge value={zeroOpening.data?.status} />
          <p>{t("accounting.setup.zeroOpeningWarning")}</p>
          <label className="field">
            <span>{t("accounting.setup.reason")}</span>
            <textarea onChange={(event) => setZeroReason(event.target.value)} value={zeroReason} />
          </label>
          <label>
            <input
              checked={zeroAcknowledged}
              onChange={(event) => setZeroAcknowledged(event.target.checked)}
              type="checkbox"
            />{" "}
            {t("accounting.setup.zeroOpeningAcknowledgement")}
          </label>
          {zeroOpening.data?.status === "zero_opening_confirmed" ? (
            <button
              className="button button-secondary"
              disabled={!rights.configure || busy !== undefined}
              onClick={() =>
                void operation("zero-revoke", () =>
                  client.post("setup/zero-opening/revoke", {
                    reason: zeroReason.trim() || t("accounting.setup.defaultRevocationReason"),
                  }),
                )
              }
              type="button"
            >
              {t("accounting.setup.revokeZeroOpening")}
            </button>
          ) : (
            <button
              className="button button-secondary"
              disabled={
                !rights.configure ||
                busy !== undefined ||
                !zeroAcknowledged ||
                zeroReason.trim() === "" ||
                activePeriod === undefined ||
                activeYear === undefined
              }
              onClick={() =>
                void operation("zero-confirm", () =>
                  client.post("setup/zero-opening/confirm", {
                    effectiveDate: effectiveOn,
                    fiscalYearId: activeYear?.id,
                    fiscalPeriodId: activePeriod?.id,
                    confirmationStatement: t("accounting.setup.zeroOpeningStatement"),
                    reason: zeroReason.trim(),
                    administratorAcknowledged: zeroAcknowledged,
                  }),
                )
              }
              type="button"
            >
              {t("accounting.setup.confirmZeroOpening")}
            </button>
          )}
        </section>

        <section className="accounting-setup-blockers" id="accounting-setup-areas">
          <h2>{t("accounting.setup.areaReadiness")}</h2>
          <p className="accounting-preview-note">
            {t("accounting.setup.areasHelp", {
              defaultValue:
                "Enable only the areas you want posted automatically. Each area is independent, and global Automatic Posting must also be enabled below.",
            })}
          </p>
          {/* The shared error banner sits at the foot of this long page, so a
              rejected toggle looked like nothing happened. Repeat it here. */}
          {operationError === undefined ? null : (
            <div className="alert alert-error" role="alert">
              {t(`accounting.errors.codes.${operationError}`, {
                defaultValue: t("accounting.errors.safe"),
              })}
            </div>
          )}
          <div className="table-shell accounting-table-shell">
            <table className="data-table accounting-table">
              <thead>
                <tr>
                  <th>{t("accounting.setup.operationalArea")}</th>
                  <th>{t("accounting.setup.enablement", { defaultValue: "Enabled" })}</th>
                  <th>{t("accounting.statusTitle")}</th>
                  <th>{t("accounting.setup.missingMappings")}</th>
                  <th>{t("accounting.setup.periodBlocker", { defaultValue: "Period blocker" })}</th>
                  <th>{t("accounting.setup.failedEvents")}</th>
                  <th>{t("accounting.setup.lastSuccessfulPosting")}</th>
                  <th>{t("accounting.setup.action")}</th>
                </tr>
              </thead>
              <tbody>
                {orderedAreas.map((area) => {
                  const areaKey = String(area.area);
                  const enabled = enabledAreas.has(areaKey);
                  const blockers = Array.isArray(area.activationBlockers)
                    ? area.activationBlockers.map(String)
                    : [];
                  const periodBlocked = blockers.includes("open_fiscal_period_missing");
                  return (
                    <tr key={areaKey}>
                      <td>{t(`accounting.setup.areas.${areaKey}`, { defaultValue: areaKey })}</td>
                      <td>
                        <StatusBadge value={enabled ? "enabled" : "disabled"} />
                      </td>
                      <td>
                        {/* Readiness is independent of enablement: an enabled
                            area can still be not ready, and that must stay
                            visible rather than be masked by "enabled". */}
                        <StatusBadge value={area.ready === true ? "ready" : "not_ready"} />
                      </td>
                      <td>
                        {Array.isArray(area.missingMappings) && area.missingMappings.length > 0
                          ? area.missingMappings.join(", ")
                          : "—"}
                      </td>
                      <td>
                        {periodBlocked
                          ? t("accounting.setup.openPeriodMissing", {
                              defaultValue: "No open fiscal period",
                            })
                          : "—"}
                      </td>
                      <td>{String(area.failedEventCount ?? "0")}</td>
                      <td>
                        {area.lastSuccessfulPosting === null
                          ? t("accounting.setup.unavailable")
                          : String(area.lastSuccessfulPosting)}
                      </td>
                      <td>
                        <button
                          className="button button-secondary"
                          disabled={
                            !rights.configure ||
                            busy !== undefined ||
                            (!enabled && area.ready !== true) ||
                            configuration.data?.accountingEnabled !== true
                          }
                          onClick={() => {
                            if (
                              !globalThis.confirm(
                                t(
                                  enabled
                                    ? "accounting.setup.confirmDisableArea"
                                    : "accounting.setup.confirmEnableArea",
                                ),
                              )
                            )
                              return;
                            void operation(`area:${areaKey}`, () =>
                              client.post(
                                `setup/automatic-posting/areas/${enabled ? "disable" : "enable"}`,
                                {
                                  area: areaKey,
                                  confirmation: true,
                                  reason: t("accounting.setup.areaChangeReason"),
                                },
                              ),
                            );
                          }}
                          type="button"
                        >
                          {t(
                            enabled
                              ? "accounting.setup.disableArea"
                              : "accounting.setup.enableArea",
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Requirement: global Automatic Posting is a SEPARATE, explicit
              confirmation taken after the areas have been chosen. Enabling an
              area alone never starts posting. */}
          <div className="accounting-global-posting">
            <h3>
              {t("accounting.setup.globalPosting", { defaultValue: "Global Automatic Posting" })}
            </h3>
            <p>
              {globalPostingEnabled
                ? t("accounting.setup.globalPostingEnabled", {
                    defaultValue: "Automatic Posting is enabled. Enabled areas post automatically.",
                  })
                : t("accounting.setup.globalPostingDisabled", {
                    defaultValue:
                      "Automatic Posting is disabled. Events stay in Received until it is enabled.",
                  })}
            </p>
            <p className="accounting-preview-note">
              {t("accounting.setup.globalPostingAreaSummary", {
                areas:
                  enabledAreas.size === 0
                    ? t("accounting.setup.noAreasEnabled", { defaultValue: "none" })
                    : [...enabledAreas]
                        .map((key) =>
                          t(`accounting.setup.areas.${key}`, { defaultValue: key }),
                        )
                        .join(", "),
                defaultValue: "Areas currently enabled: {{areas}}",
              })}
            </p>
            <button
              className="button button-primary"
              disabled={
                !rights.configure ||
                busy !== undefined ||
                configuration.data?.accountingEnabled !== true ||
                (!globalPostingEnabled && enabledAreas.size === 0)
              }
              onClick={() => {
                const turningOn = !globalPostingEnabled;
                if (
                  !globalThis.confirm(
                    t(
                      turningOn
                        ? "accounting.setup.confirmEnableGlobalPosting"
                        : "accounting.setup.confirmDisableGlobalPosting",
                      {
                        defaultValue: turningOn
                          ? "Enable Automatic Posting for the enabled areas?"
                          : "Disable Automatic Posting for all areas?",
                      },
                    ),
                  )
                )
                  return;
                // The two DTOs differ and reject unknown fields: enable takes
                // { areas, reason }, disable takes { reason } only.
                void operation("global-posting", () =>
                  turningOn
                    ? client.post("automatic-posting/enable", {
                        areas: [...enabledAreas],
                        reason: t("accounting.setup.areaChangeReason"),
                      })
                    : client.post("automatic-posting/disable", {
                        reason: t("accounting.setup.areaChangeReason"),
                      }),
                );
              }}
              type="button"
            >
              {t(
                globalPostingEnabled
                  ? "accounting.setup.disableGlobalPosting"
                  : "accounting.setup.enableGlobalPosting",
                {
                  defaultValue: globalPostingEnabled
                    ? "Disable Automatic Posting"
                    : "Enable Automatic Posting",
                },
              )}
            </button>
            {globalPostingEnabled || enabledAreas.size > 0 ? null : (
              <p className="field-hint">
                {t("accounting.setup.enableAreaFirst", {
                  defaultValue: "Enable at least one area before enabling Automatic Posting.",
                })}
              </p>
            )}
          </div>
        </section>

        <section className="accounting-activation-preview" id="accounting-setup-activation">
          <h2>{t("accounting.setup.activationPreview")}</h2>
          <p>
            {configuration.data?.accountingEnabled === true
              ? t("accounting.setup.manualEnabled")
              : t("accounting.setup.manualDisabled")}
          </p>
          <button
            className="button button-secondary"
            disabled={!rights.configure || busy !== undefined || activationPreviewResource.loading}
            onClick={() => {
              setOperationError(undefined);
              activationPreviewResource.refresh();
            }}
            type="button"
          >
            {t("accounting.setup.reviewActivation")}
          </button>
          <LoadPanel
            error={activationPreviewResource.error}
            loading={activationPreviewResource.loading}
            onRefresh={activationPreviewResource.refresh}
          >
            {activationPreview === undefined ? (
              <div className="accounting-state" role="status">
                {t("accounting.setup.activationPreviewEmpty", {
                  defaultValue:
                    "Activation preview is not available yet. Refresh the preview to try again.",
                })}
              </div>
            ) : (
              <div className="accounting-activation-preview-result">
                <div className="accounting-activation-readiness">
                  <StatusBadge
                    value={activationPreview.activationEligible === true ? "ready" : "blocked"}
                  />
                  <strong>{String(activationPreview.configurationPercentage ?? "0")}%</strong>
                  <span>
                    {activationPreview.activationEligible === true
                      ? t("accounting.setup.activationReady", {
                          defaultValue: "Ready for manual activation.",
                        })
                      : t("accounting.setup.activationBlocked", {
                          defaultValue: "Resolve the blockers before activation.",
                        })}
                  </span>
                </div>
                <section>
                  <h3>{t("accounting.setup.blockers")}</h3>
                  {activationBlockers.length === 0 ? (
                    <p>
                      {t("accounting.setup.noActivationBlockers", {
                        defaultValue: "No activation blockers were found.",
                      })}
                    </p>
                  ) : (
                    <ul>
                      {activationBlockers.map((blocker) => (
                        <li key={blocker}>
                          {t(`accounting.setup.blockerCodes.${blocker}`, {
                            defaultValue: blocker.replaceAll("_", " "),
                          })}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section>
                  <h3>
                    {t("accounting.setup.activationWarnings", {
                      defaultValue: "Activation warnings",
                    })}
                  </h3>
                  {activationWarningCodes.length === 0 ? (
                    <p>
                      {t("accounting.setup.noActivationWarnings", {
                        defaultValue: "No activation warnings were found.",
                      })}
                    </p>
                  ) : (
                    <ul>
                      {activationWarningCodes.map((warning) => (
                        <li key={warning}>
                          {t(`accounting.setup.warningCodes.${warning}`, {
                            defaultValue: warning.replaceAll("_", " "),
                          })}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                {rights.configure &&
                activationPreview.activationEligible === true &&
                configuration.data?.accountingEnabled !== true ? (
                  <div className="accounting-activation-actions">
                    <label>
                      <input
                        checked={activationWarnings}
                        onChange={(event) => setActivationWarnings(event.target.checked)}
                        type="checkbox"
                      />
                      {t("accounting.setup.warningAcknowledgement")}
                    </label>
                    <label>
                      <input
                        checked={activationConfirmed}
                        onChange={(event) => setActivationConfirmed(event.target.checked)}
                        type="checkbox"
                      />
                      {t("accounting.setup.activationConfirmation")}
                    </label>
                    <button
                      className="button button-primary"
                      disabled={busy !== undefined || !activationWarnings || !activationConfirmed}
                      onClick={() => {
                        setBusy("activate");
                        setOperationError(undefined);
                        void client
                          .post<AccountingRecord>("setup/activate-manual-accounting", {
                            activationDate: effectiveOn,
                            acknowledgedWarningCodes: [
                              "historical_backfill_not_run",
                              "controlled_testing_required",
                            ],
                            confirmation: true,
                          })
                          .then((result) => {
                            setActivationResult(result);
                            refreshAll();
                          })
                          .catch((issue: unknown) =>
                            setOperationError(
                              issue instanceof ApiError ? issue.code : "request_failed",
                            ),
                          )
                          .finally(() => setBusy(undefined));
                      }}
                      type="button"
                    >
                      {t("accounting.setup.activateManualAccounting")}
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </LoadPanel>
          {activationResult === undefined ? null : (
            <section className="accounting-success">
              <h3>{t("accounting.setup.activationSuccess")}</h3>
              <ol>
                {Array.isArray(activationResult.nextTestingSteps)
                  ? activationResult.nextTestingSteps.map((step) => (
                      <li key={String(step)}>{String(step).replaceAll("_", " ")}</li>
                    ))
                  : null}
              </ol>
            </section>
          )}
        </section>

        {blockers.length > 0 ? (
          <section className="accounting-setup-blockers">
            <h2>{t("accounting.setup.blockers")}</h2>
            <ul>
              {blockers.map((blocker, index) => (
                <li key={index}>{String("message" in blocker ? blocker.message : blocker)}</li>
              ))}
            </ul>
          </section>
        ) : null}
        {operationError === undefined ? null : (
          <div className="form-error" role="alert">
            {t(`accounting.errors.codes.${operationError}`, {
              defaultValue: t("accounting.errors.safe"),
            })}
          </div>
        )}
      </LoadPanel>
    </section>
  );
}
