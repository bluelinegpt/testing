import { type ReactElement, useEffect, useState } from "react";

import {
  type RepairHistoryDetail,
  type RepairHistoryPage,
  type RepairHistoryResult,
  platformApi,
  platformApiErrorMessage,
  PlatformApiError,
} from "../api/platform-client.js";

/**
 * Repair Center -> Repair History (Phase 2, Prompt 5). READ-ONLY.
 *
 * One chronology for the Company named in the URL: every successful repair
 * (the authoritative execution record) plus every refused, failed or
 * replayed attempt. Newest first, paginated by the server. Viewing needs only
 * the Repair Center READ permission. Only business references, codes and the
 * administrator's username are shown -- never customer data.
 */

const PAGE_SIZE = 25;

const resultLabel: Record<RepairHistoryResult, string> = {
  FAILED: "Failed",
  REFUSED: "Refused",
  REPLAYED: "Replay (no change)",
  SUCCEEDED: "Succeeded",
};

const resultBadge: Record<RepairHistoryResult, string> = {
  FAILED: "platform-badge platform-badge--severity-high",
  REFUSED: "platform-badge platform-badge--severity-medium",
  REPLAYED: "platform-badge platform-badge--severity-low",
  SUCCEEDED: "platform-badge platform-badge--active",
};

const resultFilters: readonly { readonly label: string; readonly value: "" | RepairHistoryResult }[] = [
  { label: "All results", value: "" },
  { label: "Succeeded", value: "SUCCEEDED" },
  { label: "Failed", value: "FAILED" },
  { label: "Refused", value: "REFUSED" },
  { label: "Replays", value: "REPLAYED" },
];

function errorText(failure: unknown): string {
  return failure instanceof PlatformApiError ? failure.message : platformApiErrorMessage(0, undefined, undefined);
}

function entityLabel(entityType: string): string {
  if (entityType === "accounting_event") return "Accounting event";
  if (entityType === "trader_receivable") return "Trader receivable";
  return "Order";
}

export interface RepairHistoryFocus {
  readonly kind: "execution" | "attempt";
  readonly id: string;
  /** Changes on every request so the same record can be re-opened. */
  readonly nonce: number;
}

export function RepairHistoryPanel({
  companyId,
  focus,
  refreshToken,
}: {
  readonly companyId: string;
  readonly focus?: RepairHistoryFocus | undefined;
  readonly refreshToken: number;
}): ReactElement {
  const [result, setResult] = useState<"" | RepairHistoryResult>("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<RepairHistoryPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<{ kind: "execution" | "attempt"; id: string; detail?: RepairHistoryDetail; error?: string }>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void platformApi
      .repairHistory(companyId, { page, pageSize: PAGE_SIZE, ...(result === "" ? {} : { result }) })
      .then((next) => {
        if (!cancelled) setList(next);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(errorText(failure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, page, refreshToken, result]);

  const open = (kind: "execution" | "attempt", id: string): void => {
    setSelected({ id, kind });
    void platformApi
      .repairHistoryRecord(companyId, kind, id)
      .then((detail) => setSelected({ detail, id, kind }))
      .catch((failure: unknown) => setSelected({ error: errorText(failure), id, kind }));
  };

  useEffect(() => {
    if (focus !== undefined) open(focus.kind, focus.id);
  }, [focus?.nonce]);

  const pageCount = list === undefined ? 1 : Math.max(1, Math.ceil(list.total / list.pageSize));

  return (
    <section aria-labelledby="repair-history-title" className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h2 id="repair-history-title">Repair History</h2>
          <p className="platform-muted">
            Every repair applied to this Company, and every refused or failed attempt (which applied nothing). Newest first.
          </p>
        </div>
        <label className="platform-field">
          <span>Result</span>
          <select
            aria-label="Repair history result"
            onChange={(event) => {
              setPage(1);
              setResult(event.target.value as "" | RepairHistoryResult);
            }}
            value={result}
          >
            {resultFilters.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error === undefined ? null : (
        <p className="platform-login__error" role="alert">
          {error}
        </p>
      )}

      {list === undefined ? (
        loading ? <p>Loading repair history…</p> : null
      ) : list.items.length === 0 ? (
        <p className="platform-muted" data-testid="repair-history-empty">
          No repair has been attempted for this Company.
        </p>
      ) : (
        <>
          <div className="platform-table-scroll">
            <table className="platform-table" aria-label="Repair history">
              <thead>
                <tr>
                  <th scope="col">Date / Time</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Finding</th>
                  <th scope="col">Capability</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Result</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Error / Outcome</th>
                  <th scope="col">Correlation ID</th>
                  <th scope="col">
                    <span className="platform-muted">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((row) => (
                  <tr key={`${row.kind}:${row.id}`}>
                    <td>{new Date(row.occurredAt).toLocaleString()}</td>
                    <td>
                      {entityLabel(row.entityType)} {row.entityNumber ?? "—"}
                    </td>
                    <td>{row.reasonCode ?? "—"}</td>
                    <td>{row.capabilityCode ?? "—"}</td>
                    <td>{row.actor ?? "—"}</td>
                    <td>
                      <span className={resultBadge[row.result]}>{resultLabel[row.result]}</span>
                    </td>
                    <td>{row.reason ?? "—"}</td>
                    <td>
                      {row.errorCode === null ? row.outcome ?? "—" : `${row.errorCode}: ${row.outcome ?? ""}`}
                    </td>
                    <td>
                      <code>{row.correlationId ?? "—"}</code>
                    </td>
                    <td>
                      <button className="platform-button platform-button--quiet" onClick={() => open(row.kind, row.id)} type="button">
                        View Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="platform-pager">
            <button className="platform-button platform-button--quiet" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">
              Previous
            </button>
            <span className="platform-muted">
              Page {list.page} of {pageCount} · {list.total} record{list.total === 1 ? "" : "s"}
            </span>
            <button
              className="platform-button platform-button--quiet"
              disabled={page >= pageCount}
              onClick={() => setPage((value) => value + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </>
      )}

      {selected === undefined ? null : (
        <section aria-label="Repair record" className="platform-card">
          <div className="platform-panel__header">
            <h3>Repair record</h3>
            <button className="platform-button platform-button--quiet" onClick={() => setSelected(undefined)} type="button">
              Close
            </button>
          </div>
          {selected.error !== undefined ? (
            <p role="alert">{selected.error}</p>
          ) : selected.detail === undefined ? (
            <p>Loading repair record…</p>
          ) : (
            <RepairRecordDetails detail={selected.detail} />
          )}
        </section>
      )}
    </section>
  );
}

function RepairRecordDetails({ detail }: { readonly detail: RepairHistoryDetail }): ReactElement {
  const rows: readonly (readonly [string, string])[] = [
    ["Company", detail.companyId],
    ["Entity", `${entityLabel(detail.entityType)} ${detail.entityNumber ?? "—"} (${detail.entityId})`],
    ["Finding", `${detail.reasonCode ?? "—"}${detail.findingId === null ? "" : ` · ${detail.findingId}`}`],
    ["Capability", detail.capabilityCode ?? "—"],
    ["Actor", `${detail.actor ?? "—"} (${detail.actorAuthority})`],
    ["Reason", detail.reason ?? "—"],
    ["Result", resultLabel[detail.result]],
    ["Date / Time", new Date(detail.occurredAt).toLocaleString()],
    ["Correlation ID", detail.correlationId ?? "—"],
    ["Preview version", detail.previewVersion ?? "—"],
    ...(detail.errorCode === null ? [] : ([["Error", `${detail.errorCode}: ${detail.outcome ?? ""}`]] as const)),
  ];
  return (
    <>
      <p data-testid="repair-applied-statement">
        <strong>{detail.repairAppliedStatement}</strong>
      </p>
      <dl className="platform-detail-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {detail.execution === null ? null : (
        <dl className="platform-detail-list" aria-label="Before and after">
          <div>
            <dt>Before</dt>
            <dd>
              {detail.execution.beforeHealth} · {detail.execution.beforeClassification} ·{" "}
              <code>{detail.execution.beforeFingerprint}</code>
            </dd>
          </div>
          <div>
            <dt>After</dt>
            <dd>
              {detail.execution.afterHealth} · {detail.execution.afterClassification} ·{" "}
              <code>{detail.execution.afterFingerprint}</code>
            </dd>
          </div>
          {Object.entries(detail.execution.outcome).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
          <div>
            <dt>Idempotent replays</dt>
            <dd>{detail.execution.replays} (none repaired anything)</dd>
          </div>
        </dl>
      )}
    </>
  );
}
