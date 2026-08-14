import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Link } from "react-router-dom";

import { platformApi, type CompanyPage } from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";
import { companyPortalUrl } from "../config/company-portal.js";

/**
 * The Company list.
 *
 * Search, filtering, sorting and paging all happen on the SERVER. Loading every
 * Company into the browser and filtering there would work today, with one
 * tenant, and would quietly stop working at the exact point the product becomes
 * successful.
 */
const statuses = ["draft", "active", "suspended", "disabled"] as const;
const environments = ["development", "demo", "sandbox", "trial", "production"] as const;

export function CompaniesPage(): ReactElement {
  const session = usePlatformSession();
  const canManage = session.can("platform.companies.manage");

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [environment, setEnvironment] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("code");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<CompanyPage | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setFailed(false);
    void platformApi
      .companies({ search, status, environment, page, sort, direction })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [search, status, environment, page, sort, direction]);

  useEffect(() => load(), [load]);

  const pageCount = data === undefined ? 1 : Math.max(1, Math.ceil(data.total / data.pageSize));

  /**
   * Sorting is a server round-trip, not a client-side array sort. Sorting only
   * the current page would silently reorder 25 rows out of however many exist
   * and look exactly like it worked.
   */
  function sortBy(column: string): void {
    setPage(1);
    if (sort === column) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(column);
    setDirection("asc");
  }

  function SortHeader({ column, label }: { column: string; label: string }): ReactElement {
    const active = sort === column;
    return (
      <th
        aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
        scope="col"
      >
        <button className="platform-sort" onClick={() => sortBy(column)} type="button">
          {label}
          {active ? <span aria-hidden="true">{direction === "asc" ? " ▲" : " ▼"}</span> : null}
        </button>
      </th>
    );
  }

  return (
    <section className="platform-panel">
      <div className="platform-panel__header">
        <h2>Companies</h2>
        {canManage ? (
          <Link className="platform-button" to="/companies/new">
            Create Company
          </Link>
        ) : null}
      </div>

      <div className="platform-filters">
        <label className="platform-field" htmlFor="company-search">
          <span>Search</span>
          <input
            id="company-search"
            onChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            placeholder="Name, code or subdomain"
            type="search"
            value={search}
          />
        </label>
        <label className="platform-field" htmlFor="company-status">
          <span>Status</span>
          <select
            id="company-status"
            onChange={(event) => {
              setPage(1);
              setStatus(event.target.value);
            }}
            value={status}
          >
            <option value="">All statuses</option>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="platform-field" htmlFor="company-environment">
          <span>Environment</span>
          <select
            id="company-environment"
            onChange={(event) => {
              setPage(1);
              setEnvironment(event.target.value);
            }}
            value={environment}
          >
            <option value="">All environments</option>
            {environments.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      {failed ? (
        <p role="alert">The Company list could not be loaded.</p>
      ) : data === undefined ? (
        <p>Loading…</p>
      ) : data.items.length === 0 ? (
        <p className="platform-muted">No Companies match these filters.</p>
      ) : (
        <>
          <table className="platform-table">
            <thead>
              <tr>
                <SortHeader column="code" label="Code" />
                <SortHeader column="name" label="Name" />
                <th scope="col">Subdomain</th>
                <SortHeader column="status" label="Status" />
                <SortHeader column="environment" label="Environment" />
                <th scope="col">Country</th>
                <th scope="col">Timezone</th>
                <th scope="col">Language</th>
                <th scope="col">Accounting</th>
                <th scope="col">Admin</th>
                <th scope="col">Onboarding</th>
                <SortHeader column="createdAt" label="Created" />
                <th scope="col">Portal</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((company) => (
                <tr key={company.id}>
                  <td>
                    <Link to={`/companies/${company.id}`}>{company.code}</Link>
                  </td>
                  <td>{company.nameEn}</td>
                  <td>{company.subdomain}</td>
                  <td>
                    <span className={`platform-badge platform-badge--${company.status}`}>
                      {company.status}
                    </span>
                  </td>
                  <td>
                    {/* Production is called out because it is the value a
                        future destructive-maintenance guard turns on. */}
                    <span
                      className={
                        company.environment === "production"
                          ? "platform-badge platform-badge--production"
                          : "platform-badge"
                      }
                    >
                      {company.environment}
                    </span>
                  </td>
                  <td>{company.countryCode}</td>
                  <td>{company.timezone ?? "—"}</td>
                  <td>{company.defaultLanguage ?? "—"}</td>
                  <td>{company.accountingSetupStatus.replace(/_/g, " ")}</td>
                  <td>{company.companyAdminCount > 0 ? "Configured" : "Pending"}</td>
                  <td>
                    {/* Derived on the server, in the list query, so the column
                        costs one statement rather than one per row. */}
                    <span className={`platform-badge platform-badge--${company.readinessState}`}>
                      {company.readinessState.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td>{new Date(company.createdAt).toISOString().slice(0, 10)}</td>
                  <td>
                    <a
                      className="platform-button platform-button--quiet"
                      href={companyPortalUrl(company.subdomain)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="platform-pager">
            <button
              className="platform-button platform-button--quiet"
              disabled={data.page <= 1}
              onClick={() => setPage((current) => current - 1)}
              type="button"
            >
              Previous
            </button>
            <span className="platform-muted">
              Page {data.page} of {pageCount} · {data.total} Compan{data.total === 1 ? "y" : "ies"}
            </span>
            <button
              className="platform-button platform-button--quiet"
              disabled={data.page >= pageCount}
              onClick={() => setPage((current) => current + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
