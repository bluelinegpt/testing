import { type ReactElement, useCallback, useEffect, useState } from "react";

import {
  PlatformApiError,
  type PlatformAuditEntry,
  type PlatformAuditPage,
  platformApi,
} from "../api/platform-client.js";

/**
 * The Platform administrative trail.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILTERS ARE A FORM, NOT LIVE-AS-YOU-TYPE
 * ---------------------------------------------------------------------------
 *
 * Each change is a database query over an append-only table that only grows.
 * Firing one per keystroke would put load on the audit table proportional to
 * how fast somebody types, for results they are not reading yet. Submitting
 * deliberately also makes the current filter unambiguous, which matters on a
 * screen people use to answer "what exactly did we look at".
 *
 * ---------------------------------------------------------------------------
 * WHY BEFORE/AFTER ARE COLLAPSED
 * ---------------------------------------------------------------------------
 *
 * Most rows carry structured detail that is essential when investigating one
 * entry and pure noise across fifty. They are rendered on demand, per row.
 */
const PAGE_SIZE = 25;

interface Filters {
  action: string;
  from: string;
  to: string;
}

const emptyFilters: Filters = { action: "", from: "", to: "" };

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function AuditDetail({ entry }: { entry: PlatformAuditEntry }): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (entry.before === null && entry.after === null && entry.reason === null) return null;
  return (
    <>
      <button
        aria-expanded={open}
        className="platform-button platform-button--quiet"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? "Hide detail" : "Show detail"}
      </button>
      {open ? (
        <dl className="platform-audit__detail">
          {entry.reason === null ? null : (
            <>
              <dt>Reason</dt>
              <dd>{entry.reason}</dd>
            </>
          )}
          {entry.before === null ? null : (
            <>
              <dt>Before</dt>
              <dd>
                <code>{JSON.stringify(entry.before)}</code>
              </dd>
            </>
          )}
          {entry.after === null ? null : (
            <>
              <dt>After</dt>
              <dd>
                <code>{JSON.stringify(entry.after)}</code>
              </dd>
            </>
          )}
          <dt>Correlation</dt>
          <dd>
            <code>{entry.correlationId}</code>
          </dd>
        </dl>
      ) : null}
    </>
  );
}

export function AuditPage(): ReactElement {
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [actions, setActions] = useState<readonly string[]>([]);
  const [result, setResult] = useState<PlatformAuditPage | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void platformApi
      .platformAuditActions()
      .then((items) => {
        if (!cancelled) setActions(items);
      })
      // A failure to populate the filter list must not hide the trail itself.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async (filters: Filters, requested: number): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setResult(
        await platformApi.platformAudit({
          ...(filters.action === "" ? {} : { action: filters.action }),
          // A date is a whole day to the reader, so the upper bound is
          // exclusive of the following midnight rather than of the date
          // itself — otherwise "to 5 March" would silently exclude 5 March.
          ...(filters.from === "" ? {} : { from: `${filters.from}T00:00:00Z` }),
          ...(filters.to === "" ? {} : { to: `${filters.to}T23:59:59Z` }),
          page: requested,
          pageSize: PAGE_SIZE,
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof PlatformApiError
          ? cause.message
          : "The audit history could not be loaded.",
      );
      setResult(undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(applied, page);
  }, [applied, page, load]);

  const total = result?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="platform-panel">
      <h2>Audit</h2>
      <p className="platform-muted">
        Every administrative action taken from the Platform Portal, across all Companies. Entries
        cannot be edited or removed.
      </p>

      <form
        className="platform-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setApplied(draft);
        }}
      >
        <div className="platform-field">
          <label htmlFor="audit-action">Action</label>
          <select
            id="audit-action"
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
            value={draft.action}
          >
            <option value="">All actions</option>
            {actions.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>
        <div className="platform-field">
          <label htmlFor="audit-from">From</label>
          <input
            id="audit-from"
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            type="date"
            value={draft.from}
          />
        </div>
        <div className="platform-field">
          <label htmlFor="audit-to">To</label>
          <input
            id="audit-to"
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            type="date"
            value={draft.to}
          />
        </div>
        <button className="platform-button" type="submit">
          Apply filters
        </button>
        <button
          className="platform-button platform-button--quiet"
          onClick={() => {
            setDraft(emptyFilters);
            setApplied(emptyFilters);
            setPage(1);
          }}
          type="button"
        >
          Clear
        </button>
      </form>

      {error === undefined ? null : (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}

      {loading ? <p>Loading audit history…</p> : null}

      {!loading && error === undefined && (result?.items.length ?? 0) === 0 ? (
        <p className="platform-muted">No audit entries match these filters.</p>
      ) : null}

      {(result?.items.length ?? 0) > 0 ? (
        <>
          <table className="platform-table">
            <caption className="platform-visually-hidden">Platform audit history</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Company</th>
                <th scope="col">Administrator</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {(result?.items ?? []).map((entry) => (
                <tr key={entry.id}>
                  <td>{formatWhen(entry.occurredAt)}</td>
                  <td>
                    <code>{entry.action}</code>
                  </td>
                  {/* A Platform-only action has no Company, which is a fact
                      about the action rather than missing data. */}
                  <td>{entry.companyName ?? "—"}</td>
                  <td>{entry.actorUsername ?? "—"}</td>
                  <td>
                    <AuditDetail entry={entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <nav aria-label="Audit pages" className="platform-pagination">
            <button
              className="platform-button platform-button--quiet"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              type="button"
            >
              Previous
            </button>
            <span>
              Page {page} of {lastPage} · {total} entries
            </span>
            <button
              className="platform-button platform-button--quiet"
              disabled={page >= lastPage}
              onClick={() => setPage((value) => value + 1)}
              type="button"
            >
              Next
            </button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
