import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";

type Provider = {
  readonly key: string;
  readonly label: string;
  readonly enabled: boolean;
};

type Connection = {
  readonly id: string;
  readonly referenceNumber: string;
  readonly provider: string;
  readonly externalStoreName: string;
  readonly status: string;
  readonly healthStatus: string;
  readonly connectionMode: string;
  readonly lastWebhookAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorAt: string | null;
  readonly importedOrders: number;
  readonly failedEvents: number;
  readonly totalEvents: number;
};

function titleize(value: string | undefined) {
  return (value ?? "unknown").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Pre-production fix: this page's own content (headings, provider
 * descriptions, actions, table columns) is now fully localized via the
 * shared `portal.integrations.*` resources -- provider brand names (Salla,
 * Shopify, WooCommerce) are left as-is, brand names are not translated.
 * Real backend feature gating (`provider.enabled`) is unchanged by this fix
 * -- a provider is never labeled "Available" just because its UI exists.
 */
export function TraderCommerceIntegrationsView({ api }: { readonly api: ApiClient }) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<readonly Provider[]>([]);
  const [connections, setConnections] = useState<readonly Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [shopDomain, setShopDomain] = useState("");
  const [wooStoreUrl, setWooStoreUrl] = useState("");
  const [wooConsumerKey, setWooConsumerKey] = useState("");
  const [wooConsumerSecret, setWooConsumerSecret] = useState("");
  const [mockStoreName, setMockStoreName] = useState("Test Store");

  function providerCopy(provider: Provider) {
    if (provider.key === "salla") return t("portal.integrations.sallaCopy");
    if (provider.key === "shopify") return t("portal.integrations.shopifyCopy");
    if (provider.key === "woocommerce") return t("portal.integrations.woocommerceCopy");
    return t("portal.integrations.mockCopy");
  }

  function lastActivity(connection: Connection) {
    const value = connection.lastWebhookAt ?? connection.lastSuccessAt ?? connection.lastErrorAt;
    return value ? new Date(value).toLocaleString() : t("portal.integrations.noActivityYet");
  }

  function apiMessage(cause: unknown, fallback: string) {
    if (cause instanceof ApiError) return cause.message;
    if (cause instanceof Error) return cause.message;
    return fallback;
  }

  const visibleProviders = useMemo(
    () => providers.filter((provider) => provider.key !== "mock_commerce" || import.meta.env.DEV),
    [providers],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [providerResult, connectionResult] = await Promise.all([
        api.get<{ readonly items: readonly Provider[] }>(
          "portal/trader/commerce-integrations/providers",
        ),
        api.get<{ readonly items: readonly Connection[] }>(
          "portal/trader/commerce-integrations/connections?pageSize=50",
        ),
      ]);
      setProviders(providerResult.items);
      setConnections(connectionResult.items);
    } catch (cause) {
      setError(apiMessage(cause, t("portal.integrations.loadFailed")));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is stable enough for this dependency array's purpose.
  }, [api]);

  useEffect(() => void load(), [load]);

  async function guarded(action: () => Promise<string | void>) {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const nextMessage = await action();
      if (nextMessage) setMessage(nextMessage);
    } catch (cause) {
      setError(apiMessage(cause, t("portal.integrations.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function connectSalla() {
    await guarded(async () => {
      const result = await api.post<{ readonly authorizationUrl?: string }>(
        "portal/trader/commerce-integrations/connections/salla/start",
        {
          redirectAfter: "/integrations",
        },
      );
      if (!result.authorizationUrl) return t("portal.integrations.sallaNotReady");
      window.location.assign(result.authorizationUrl);
    });
  }

  async function connectShopify(event: FormEvent) {
    event.preventDefault();
    if (!shopDomain.trim()) {
      setError(t("portal.integrations.shopifyDomainRequired"));
      return;
    }
    await guarded(async () => {
      const result = await api.post<{ readonly authorizationUrl?: string }>(
        "portal/trader/commerce-integrations/connections/shopify/start",
        {
          redirectAfter: "/integrations",
          shopDomain: shopDomain.trim(),
        },
      );
      if (!result.authorizationUrl) return t("portal.integrations.shopifyNotReady");
      window.location.assign(result.authorizationUrl);
    });
  }

  async function connectMock(event: FormEvent) {
    event.preventDefault();
    await guarded(async () => {
      await api.post("portal/trader/commerce-integrations/connections/mock", {
        externalStoreName: mockStoreName.trim() || "Test Store",
        connectionMode: "bidirectional",
      });
      await load();
      return t("portal.integrations.testStoreConnected");
    });
  }

  async function connectWooCommerce(event: FormEvent) {
    event.preventDefault();
    if (!wooStoreUrl.trim() || !wooConsumerKey.trim() || !wooConsumerSecret.trim()) {
      setError(t("portal.integrations.woocommerceRequired"));
      return;
    }
    await guarded(async () => {
      await api.post("portal/trader/commerce-integrations/connections/woocommerce/connect", {
        consumerKey: wooConsumerKey.trim(),
        consumerSecret: wooConsumerSecret.trim(),
        connectionMode: "inbound_only",
        storeUrl: wooStoreUrl.trim(),
      });
      setWooConsumerSecret("");
      await load();
      return t("portal.integrations.woocommerceConnected");
    });
  }

  async function syncNow(connection: Connection) {
    await guarded(async () => {
      await api.post(`portal/trader/commerce-integrations/connections/${connection.id}/sync`, {});
      await load();
      return t("portal.integrations.syncRecorded", { store: connection.externalStoreName });
    });
  }

  async function disconnect(connection: Connection) {
    await guarded(async () => {
      await api.post(
        `portal/trader/commerce-integrations/connections/${connection.id}/disconnect`,
        {
          reason: "Disconnected by Trader Portal",
        },
      );
      await load();
      return t("portal.integrations.disconnected", { store: connection.externalStoreName });
    });
  }

  async function reconnect(connection: Connection) {
    await guarded(async () => {
      await api.post(
        `portal/trader/commerce-integrations/connections/${connection.id}/reconnect`,
        {},
      );
      await load();
      return t("portal.integrations.reconnected", { store: connection.externalStoreName });
    });
  }

  return (
    <section className="data-surface">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t("portal.integrations.eyebrow")}</p>
          <h1>{t("portal.integrations.title")}</h1>
          <p>{t("portal.integrations.lead")}</p>
        </div>
        <div className="heading-actions">
          <button
            className="button button-secondary"
            disabled={busy || loading}
            onClick={() => void load()}
            type="button"
          >
            {t("portal.integrations.refresh")}
          </button>
        </div>
      </div>

      {message ? <div className="alert alert-success">{message}</div> : null}
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="dashboard-grid">
        {visibleProviders.map((provider) => (
          <article className="dashboard-card" key={provider.key}>
            <p className="eyebrow">
              {provider.enabled
                ? t("portal.integrations.available")
                : t("portal.integrations.comingSoon")}
            </p>
            <h2>{provider.label}</h2>
            <p>{providerCopy(provider)}</p>
            {provider.key === "salla" ? (
              <button
                className="button button-primary"
                disabled={busy || !provider.enabled}
                onClick={() => void connectSalla()}
                type="button"
              >
                {t("portal.integrations.connectSalla")}
              </button>
            ) : provider.key === "shopify" ? (
              <form className="stacked-form" onSubmit={(event) => void connectShopify(event)}>
                <label>
                  {t("portal.integrations.shopifyDomainLabel")}
                  <input
                    dir="ltr"
                    onChange={(event) => setShopDomain(event.target.value)}
                    placeholder="mystore.myshopify.com"
                    value={shopDomain}
                  />
                </label>
                <button
                  className="button button-primary"
                  disabled={busy || !provider.enabled}
                  type="submit"
                >
                  {t("portal.integrations.connectShopify")}
                </button>
              </form>
            ) : provider.key === "mock_commerce" ? (
              <form className="stacked-form" onSubmit={(event) => void connectMock(event)}>
                <label>
                  {t("portal.integrations.mockStoreNameLabel")}
                  <input
                    onChange={(event) => setMockStoreName(event.target.value)}
                    value={mockStoreName}
                  />
                </label>
                <button
                  className="button button-secondary"
                  disabled={busy || !provider.enabled}
                  type="submit"
                >
                  {t("portal.integrations.connectTestStore")}
                </button>
              </form>
            ) : provider.key === "woocommerce" ? (
              <form className="stacked-form" onSubmit={(event) => void connectWooCommerce(event)}>
                <label>
                  {t("portal.integrations.woocommerceUrlLabel")}
                  <input
                    dir="ltr"
                    onChange={(event) => setWooStoreUrl(event.target.value)}
                    placeholder="https://shop.example.com"
                    value={wooStoreUrl}
                  />
                </label>
                <label>
                  {t("portal.integrations.woocommerceConsumerKeyLabel")}
                  <input
                    dir="ltr"
                    onChange={(event) => setWooConsumerKey(event.target.value)}
                    placeholder="ck_..."
                    value={wooConsumerKey}
                  />
                </label>
                <label>
                  {t("portal.integrations.woocommerceConsumerSecretLabel")}
                  <input
                    autoComplete="new-password"
                    dir="ltr"
                    onChange={(event) => setWooConsumerSecret(event.target.value)}
                    placeholder="cs_..."
                    type="password"
                    value={wooConsumerSecret}
                  />
                </label>
                <button
                  className="button button-primary"
                  disabled={busy || !provider.enabled}
                  type="submit"
                >
                  {t("portal.integrations.connectWoocommerce")}
                </button>
              </form>
            ) : (
              <button className="button button-secondary" disabled type="button">
                {t("portal.integrations.comingSoon")}
              </button>
            )}
          </article>
        ))}
      </div>

      <div className="page-heading">
        <div>
          <p className="eyebrow">{t("portal.integrations.connectedStores")}</p>
          <h2>{t("portal.integrations.yourConnections")}</h2>
        </div>
      </div>
      {loading ? (
        <div className="loading-row">{t("portal.integrations.loadingIntegrations")}</div>
      ) : connections.length === 0 ? (
        <p>{t("portal.integrations.noConnections")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("portal.integrations.colStore")}</th>
              <th>{t("portal.integrations.colProvider")}</th>
              <th>{t("portal.integrations.colStatus")}</th>
              <th>{t("portal.integrations.colHealth")}</th>
              <th>{t("portal.integrations.colImportedOrders")}</th>
              <th>{t("portal.integrations.colErrors")}</th>
              <th>{t("portal.integrations.colLastActivity")}</th>
              <th>{t("portal.integrations.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {connections.map((connection) => (
              <tr key={connection.id}>
                <td>
                  {connection.externalStoreName}
                  <br />
                  <span className="muted-text">{connection.referenceNumber}</span>
                </td>
                <td>{titleize(connection.provider)}</td>
                <td>{titleize(connection.status)}</td>
                <td>{titleize(connection.healthStatus)}</td>
                <td>{connection.importedOrders ?? 0}</td>
                <td>{connection.failedEvents ?? 0}</td>
                <td>{lastActivity(connection)}</td>
                <td>
                  <div className="inline-actions">
                    <button
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() => void syncNow(connection)}
                      type="button"
                    >
                      {t("portal.integrations.sync")}
                    </button>
                    {connection.status === "disconnected" ? (
                      <button
                        className="button button-secondary"
                        disabled={busy}
                        onClick={() => void reconnect(connection)}
                        type="button"
                      >
                        {t("portal.integrations.reconnect")}
                      </button>
                    ) : (
                      <button
                        className="button button-secondary"
                        disabled={busy}
                        onClick={() => void disconnect(connection)}
                        type="button"
                      >
                        {t("portal.integrations.disconnect")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
