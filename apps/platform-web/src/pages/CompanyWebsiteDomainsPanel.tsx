import { useEffect, useState, type ReactElement } from "react";
import {
  platformApi,
  PlatformApiError,
  type CompanyWebsiteDomains,
} from "../api/platform-client.js";
export function CompanyWebsiteDomainsPanel({
  companyId,
  canManage,
}: {
  companyId: string;
  canManage: boolean;
}): ReactElement {
  const [data, setData] = useState<CompanyWebsiteDomains>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = () =>
    platformApi
      .companyWebsiteDomains(companyId)
      .then(setData)
      .catch((e) =>
        setError(e instanceof PlatformApiError ? e.message : "Domains could not be loaded."),
      );
  useEffect(() => {
    void load();
  }, [companyId]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof PlatformApiError ? e.message : "Domain action failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="website-domains">
      <div className="platform-panel__header">
        <div>
          <h4>Domains</h4>
          <p className="platform-muted">
            Fallback Tawseelhub domain: <strong>{data?.fallbackHostname ?? "Loading…"}</strong>
          </p>
        </div>
      </div>
      {canManage ? (
        <form
          className="platform-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const hostname = String(new FormData(form).get("hostname") ?? "");
            void run(async () => {
              await platformApi.addCompanyWebsiteDomain(companyId, hostname);
              form.reset();
            });
          }}
        >
          <label className="platform-field">
            <span>Custom domain</span>
            <input
              autoCapitalize="none"
              autoCorrect="off"
              name="hostname"
              placeholder="dana.com"
              required
            />
          </label>
          <button className="platform-button" disabled={busy} type="submit">
            Add Domain
          </button>
        </form>
      ) : null}
      {data?.cnameTarget ? (
        <p className="platform-muted">
          After verification records are added, point the hostname to{" "}
          <code>{data.cnameTarget}</code> using the DNS record supported by the registrar.
        </p>
      ) : null}
      <div className="website-domain-list">
        {data?.domains.map((domain) => (
          <article className="website-template-card" key={domain.id}>
            <div className="platform-panel__header">
              <h5>{domain.hostname}</h5>
              {domain.isPrimary ? <span className="platform-badge">Primary</span> : null}
            </div>
            <dl className="platform-review">
              <div>
                <dt>Status</dt>
                <dd>{domain.status.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Ownership</dt>
                <dd>{domain.verificationStatus}</dd>
              </div>
              <div>
                <dt>SSL</dt>
                <dd>{domain.sslStatus}</dd>
              </div>
            </dl>
            {domain.verificationRecords.length ? (
              <div>
                <strong>DNS verification</strong>
                {domain.verificationRecords.map((record) => (
                  <p key={`${record.type}-${record.name}`}>
                    <code>
                      {record.type} {record.name} {record.value}
                    </code>
                  </p>
                ))}
              </div>
            ) : null}
            {domain.lastError ? <p role="alert">{domain.lastError}</p> : null}
            {canManage ? (
              <div className="platform-actions">
                <button
                  className="platform-button"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      platformApi.companyWebsiteDomainAction(
                        companyId,
                        domain.id,
                        "refresh",
                        domain.version,
                      ),
                    )
                  }
                  type="button"
                >
                  Check Verification
                </button>
                {domain.status === "active" && !domain.isPrimary ? (
                  <button
                    className="platform-button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        platformApi.makeCompanyWebsiteDomainPrimary(
                          companyId,
                          domain.id,
                          domain.version,
                          data.websiteVersion,
                        ),
                      )
                    }
                    type="button"
                  >
                    Make Primary
                  </button>
                ) : null}
                {domain.status !== "disabled" ? (
                  <button
                    className="platform-button platform-button--quiet"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Disable ${domain.hostname}?`))
                        void run(() =>
                          platformApi.companyWebsiteDomainAction(
                            companyId,
                            domain.id,
                            "disable",
                            domain.version,
                          ),
                        );
                    }}
                    type="button"
                  >
                    Disable
                  </button>
                ) : null}
                <button
                  className="platform-button platform-button--danger"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Remove ${domain.hostname}? Website content will be preserved.`))
                      void run(() =>
                        platformApi.companyWebsiteDomainAction(
                          companyId,
                          domain.id,
                          "remove",
                          domain.version,
                        ),
                      );
                  }}
                  type="button"
                >
                  Remove
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
