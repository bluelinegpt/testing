import { useMemo, useState } from "react";
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

/**
 * Every operational posting area the backend accepts
 * (`accountingOperationalAreas`). Rendered from this fixed list so an area is
 * always visible in a stable order, even if the readiness payload omits it.
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

function records(value: unknown): readonly AccountingRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is AccountingRecord => typeof item === "object" && item !== null)
    : [];
}

/**
 * Automatic Posting control screen: per-area readiness, the events each area
 * currently has waiting, and the explicit enable/disable actions.
 *
 * Deliberately its own route (`/accounting/automatic-posting`) rather than a
 * panel buried in the Setup Wizard, so it is reachable from navigation, by
 * direct URL, and survives a refresh. Nothing here posts or processes an
 * Event — it only reads readiness and changes configuration on explicit
 * confirmation.
 */
export function AutomaticPostingPage({
  api,
  companyId,
  permissions,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new AccountingApi(api), [api]);
  const rights = accountingPermissions(permissions);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string>();
  const [operationError, setOperationError] = useState<string>();

  const areas = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "setup/automatic-posting/areas", { revision }),
    (signal) => client.get("setup/automatic-posting/areas", undefined, signal),
  );
  const postingStatus = useAccountingResource<AccountingRecord>(
    accountingQueryKey(companyId, "automatic-posting/status", { revision }),
    (signal) => client.get("automatic-posting/status", undefined, signal),
  );

  const refreshAll = () => {
    setRevision((value) => value + 1);
    areas.refresh();
    postingStatus.refresh();
  };

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

  const areaRows = records(areas.data?.areas);
  // Merge the backend payload onto the canonical list so an omitted area
  // degrades to a visible not-ready row instead of disappearing.
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
        waitingEventCount: "0",
        waitingEvents: [],
      },
  );
  const enabledAreas = new Set(
    Array.isArray(postingStatus.data?.enabledAreas)
      ? postingStatus.data.enabledAreas.map(String)
      : [],
  );
  const globalPostingEnabled = postingStatus.data?.automaticPostingEnabled === true;
  const accountingEnabled = postingStatus.data?.accountingEnabled === true;

  const areaLabel = (key: string) =>
    t(`accounting.setup.areas.${key}`, { defaultValue: key });

  return (
    <section className="accounting-page">
      <PageHeader
        actions={
          <button className="button button-secondary" onClick={refreshAll} type="button">
            {t("common.refresh")}
          </button>
        }
        description={t("accounting.automaticPosting.description", {
          defaultValue:
            "Choose which operational areas post to the ledger automatically, then enable Automatic Posting.",
        })}
        eyebrow={t("accounting.title")}
        title={t("accounting.sections.automatic-posting", { defaultValue: "Automatic Posting" })}
      />
      <LoadPanel
        error={areas.error ?? postingStatus.error}
        loading={areas.loading || postingStatus.loading}
        onRefresh={refreshAll}
      >
        {operationError === undefined ? null : (
          <div className="alert alert-error" role="alert">
            {t(`accounting.errors.codes.${operationError}`, {
              defaultValue: t("accounting.errors.safe"),
            })}
          </div>
        )}
        {accountingEnabled ? null : (
          <div className="alert alert-warning" role="status">
            {t("accounting.automaticPosting.manualAccountingRequired", {
              defaultValue:
                "Manual Accounting must be activated before any area can post automatically.",
            })}
          </div>
        )}

        <section className="accounting-setup-blockers">
          <h2>{t("accounting.setup.areaReadiness")}</h2>
          <p className="accounting-preview-note">
            {t("accounting.setup.areasHelp")}
          </p>
          <div className="table-shell accounting-table-shell">
            <table className="data-table accounting-table">
              <thead>
                <tr>
                  <th>{t("accounting.setup.operationalArea")}</th>
                  <th>{t("accounting.setup.enablement")}</th>
                  <th>{t("accounting.statusTitle")}</th>
                  <th>{t("accounting.setup.missingMappings")}</th>
                  <th>{t("accounting.setup.periodBlocker")}</th>
                  <th>{t("accounting.setup.waitingEvents", { defaultValue: "Waiting" })}</th>
                  <th>{t("accounting.setup.failedEvents")}</th>
                  <th>{t("accounting.setup.lastSuccessfulPosting")}</th>
                  <th>{t("accounting.setup.nextAction", { defaultValue: "Next action" })}</th>
                  <th>{t("accounting.setup.action")}</th>
                </tr>
              </thead>
              <tbody>
                {orderedAreas.map((area) => {
                  const areaKey = String(area.area);
                  const enabled = enabledAreas.has(areaKey);
                  const ready = area.ready === true;
                  const blockers = Array.isArray(area.activationBlockers)
                    ? area.activationBlockers.map(String)
                    : [];
                  const missing = Array.isArray(area.missingMappings)
                    ? area.missingMappings.map(String)
                    : [];
                  const nextAction = !ready
                    ? t("accounting.automaticPosting.nextResolveBlockers", {
                        defaultValue: "Resolve the blockers",
                      })
                    : enabled
                      ? globalPostingEnabled
                        ? t("accounting.automaticPosting.nextNone", { defaultValue: "—" })
                        : t("accounting.automaticPosting.nextEnableGlobal", {
                            defaultValue: "Enable Automatic Posting",
                          })
                      : t("accounting.automaticPosting.nextEnableArea", {
                          defaultValue: "Enable this area",
                        });
                  return (
                    <tr key={areaKey}>
                      <td>{areaLabel(areaKey)}</td>
                      <td>
                        <StatusBadge value={enabled ? "enabled" : "disabled"} />
                      </td>
                      <td>
                        <StatusBadge value={ready ? "ready" : "not_ready"} />
                      </td>
                      <td>{missing.length === 0 ? "—" : missing.join(", ")}</td>
                      <td>
                        {blockers.includes("open_fiscal_period_missing")
                          ? t("accounting.setup.openPeriodMissing")
                          : "—"}
                      </td>
                      <td>{String(area.waitingEventCount ?? "0")}</td>
                      <td>{String(area.failedEventCount ?? "0")}</td>
                      <td>
                        {area.lastSuccessfulPosting === null ||
                        area.lastSuccessfulPosting === undefined
                          ? t("accounting.setup.unavailable")
                          : String(area.lastSuccessfulPosting).slice(0, 10)}
                      </td>
                      <td>{nextAction}</td>
                      <td>
                        <button
                          className="button button-secondary"
                          disabled={
                            !rights.configure ||
                            busy !== undefined ||
                            !accountingEnabled ||
                            (!enabled && !ready)
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
                            // Single-area change only: never touches another
                            // area and never enables global posting.
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
                          {busy === `area:${areaKey}`
                            ? t("common.saving")
                            : t(
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
        </section>

        <section className="accounting-setup-blockers">
          <h2>{t("accounting.automaticPosting.waitingTitle", { defaultValue: "Waiting Events" })}</h2>
          {orderedAreas.every((area) => records(area.waitingEvents).length === 0) ? (
            <p className="accounting-empty">
              {t("accounting.automaticPosting.noWaitingEvents", {
                defaultValue: "No Events are waiting to be posted.",
              })}
            </p>
          ) : (
            <div className="table-shell accounting-table-shell">
              <table className="data-table accounting-table">
                <thead>
                  <tr>
                    <th>{t("accounting.setup.operationalArea")}</th>
                    <th>{t("accounting.fields.sourceReference", { defaultValue: "Source" })}</th>
                    <th>{t("accounting.fields.eventType", { defaultValue: "Event" })}</th>
                    <th>{t("accounting.statusTitle")}</th>
                    <th>{t("accounting.fields.attempts", { defaultValue: "Attempts" })}</th>
                    <th>{t("accounting.fields.journal", { defaultValue: "Journal" })}</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedAreas.flatMap((area) =>
                    records(area.waitingEvents).map((event, index) => (
                      <tr key={`${String(area.area)}-${String(event.sourceReference)}-${index}`}>
                        <td>{areaLabel(String(area.area))}</td>
                        <td className="mono">
                          <DirectionalText>{String(event.sourceReference ?? "—")}</DirectionalText>
                        </td>
                        <td>{String(event.eventType ?? "—")}</td>
                        <td>
                          <StatusBadge value={event.processingStatus} />
                        </td>
                        <td>{String(event.attemptCount ?? "0")}</td>
                        <td>
                          {event.hasJournal === true
                            ? t("accounting.automaticPosting.journalCreated", {
                                defaultValue: "Created",
                              })
                            : t("accounting.automaticPosting.journalNotCreated", {
                                defaultValue: "Not created",
                              })}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Global Automatic Posting is a separate, explicit confirmation taken
            after the areas are chosen. Enabling an area alone never starts
            posting — the processor requires both. */}
        <section className="accounting-activation-preview">
          <h2>{t("accounting.setup.globalPosting")}</h2>
          <p>
            {globalPostingEnabled
              ? t("accounting.setup.globalPostingEnabled")
              : t("accounting.setup.globalPostingDisabled")}
          </p>
          <p className="accounting-preview-note">
            {t("accounting.setup.globalPostingAreaSummary", {
              areas:
                enabledAreas.size === 0
                  ? t("accounting.setup.noAreasEnabled")
                  : [...enabledAreas].map((key) => areaLabel(key)).join(", "),
            })}
          </p>
          <button
            className="button button-primary"
            disabled={
              !rights.configure ||
              busy !== undefined ||
              !accountingEnabled ||
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
            {busy === "global-posting"
              ? t("common.saving")
              : t(
                  globalPostingEnabled
                    ? "accounting.setup.disableGlobalPosting"
                    : "accounting.setup.enableGlobalPosting",
                )}
          </button>
          {globalPostingEnabled || enabledAreas.size > 0 ? null : (
            <p className="field-hint">{t("accounting.setup.enableAreaFirst")}</p>
          )}
        </section>
      </LoadPanel>
    </section>
  );
}
