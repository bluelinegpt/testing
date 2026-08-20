import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

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

function providerCopy(provider: Provider) {
  if (provider.key === "salla") return "Connect your Salla store so Tawseelhub can receive delivery orders.";
  if (provider.key === "shopify") return "Connect Shopify to import orders and keep fulfillment activity visible.";
  if (provider.key === "woocommerce") return "Connect your WooCommerce store and automatically import eligible orders into Tawseelhub.";
  return "Test commerce connector for local validation only.";
}

function lastActivity(connection: Connection) {
  const value = connection.lastWebhookAt ?? connection.lastSuccessAt ?? connection.lastErrorAt;
  return value ? new Date(value).toLocaleString() : "No activity yet";
}

function apiMessage(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return fallback;
}

export function TraderCommerceIntegrationsView({ api }: { readonly api: ApiClient }) {
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

  const visibleProviders = useMemo(
    () => providers.filter((provider) => provider.key !== "mock_commerce" || import.meta.env.DEV),
    [providers],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [providerResult, connectionResult] = await Promise.all([
        api.get<{ readonly items: readonly Provider[] }>("portal/trader/commerce-integrations/providers"),
        api.get<{ readonly items: readonly Connection[] }>("portal/trader/commerce-integrations/connections?pageSize=50"),
      ]);
      setProviders(providerResult.items);
      setConnections(connectionResult.items);
    } catch (cause) {
      setError(apiMessage(cause, "Commerce integrations could not be loaded."));
    } finally {
      setLoading(false);
    }
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
      setError(apiMessage(cause, "The integration action could not be completed."));
    } finally {
      setBusy(false);
    }
  }

  async function connectSalla() {
    await guarded(async () => {
      const result = await api.post<{ readonly authorizationUrl?: string }>("portal/trader/commerce-integrations/connections/salla/start", {
        redirectAfter: "/integrations",
      });
      if (!result.authorizationUrl) return "Salla is not ready to connect yet.";
      window.location.assign(result.authorizationUrl);
    });
  }

  async function connectShopify(event: FormEvent) {
    event.preventDefault();
    if (!shopDomain.trim()) {
      setError("Enter your Shopify store domain first, for example mystore.myshopify.com.");
      return;
    }
    await guarded(async () => {
      const result = await api.post<{ readonly authorizationUrl?: string }>("portal/trader/commerce-integrations/connections/shopify/start", {
        redirectAfter: "/integrations",
        shopDomain: shopDomain.trim(),
      });
      if (!result.authorizationUrl) return "Shopify is not ready to connect yet.";
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
      return "Test store connected.";
    });
  }

  async function connectWooCommerce(event: FormEvent) {
    event.preventDefault();
    if (!wooStoreUrl.trim() || !wooConsumerKey.trim() || !wooConsumerSecret.trim()) {
      setError("Enter the WooCommerce Store URL, Consumer Key, and Consumer Secret first.");
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
      return "WooCommerce store connected. Your Consumer Secret is not shown again.";
    });
  }

  async function syncNow(connection: Connection) {
    await guarded(async () => {
      await api.post(`portal/trader/commerce-integrations/connections/${connection.id}/sync`, {});
      await load();
      return `Sync request recorded for ${connection.externalStoreName}.`;
    });
  }

  async function disconnect(connection: Connection) {
    await guarded(async () => {
      await api.post(`portal/trader/commerce-integrations/connections/${connection.id}/disconnect`, {
        reason: "Disconnected by Trader Portal",
      });
      await load();
      return `${connection.externalStoreName} disconnected.`;
    });
  }

  async function reconnect(connection: Connection) {
    await guarded(async () => {
      await api.post(`portal/trader/commerce-integrations/connections/${connection.id}/reconnect`, {});
      await load();
      return `${connection.externalStoreName} reconnected.`;
    });
  }

  return (
    <section className="data-surface">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Commerce</p>
          <h1>Integrations</h1>
          <p>Connect your online store to Tawseelhub and manage imported delivery orders from one place.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-secondary" disabled={busy || loading} onClick={() => void load()} type="button">
            Refresh
          </button>
        </div>
      </div>

      {message ? <div className="alert alert-success">{message}</div> : null}
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}

      <div className="dashboard-grid">
        {visibleProviders.map((provider) => (
          <article className="dashboard-card" key={provider.key}>
            <p className="eyebrow">{provider.enabled ? "Available" : "Coming soon"}</p>
            <h2>{provider.label}</h2>
            <p>{providerCopy(provider)}</p>
            {provider.key === "salla" ? (
              <button className="button button-primary" disabled={busy || !provider.enabled} onClick={() => void connectSalla()} type="button">
                Connect Salla
              </button>
            ) : provider.key === "shopify" ? (
              <form className="stacked-form" onSubmit={(event) => void connectShopify(event)}>
                <label>
                  Shopify store domain
                  <input
                    dir="ltr"
                    onChange={(event) => setShopDomain(event.target.value)}
                    placeholder="mystore.myshopify.com"
                    value={shopDomain}
                  />
                </label>
                <button className="button button-primary" disabled={busy || !provider.enabled} type="submit">
                  Connect Shopify
                </button>
              </form>
            ) : provider.key === "mock_commerce" ? (
              <form className="stacked-form" onSubmit={(event) => void connectMock(event)}>
                <label>
                  Test store name
                  <input onChange={(event) => setMockStoreName(event.target.value)} value={mockStoreName} />
                </label>
                <button className="button button-secondary" disabled={busy || !provider.enabled} type="submit">
                  Connect Test Store
                </button>
              </form>
            ) : provider.key === "woocommerce" ? (
              <form className="stacked-form" onSubmit={(event) => void connectWooCommerce(event)}>
                <label>
                  WooCommerce store URL
                  <input
                    dir="ltr"
                    onChange={(event) => setWooStoreUrl(event.target.value)}
                    placeholder="https://shop.example.com"
                    value={wooStoreUrl}
                  />
                </label>
                <label>
                  Consumer Key
                  <input
                    dir="ltr"
                    onChange={(event) => setWooConsumerKey(event.target.value)}
                    placeholder="ck_..."
                    value={wooConsumerKey}
                  />
                </label>
                <label>
                  Consumer Secret
                  <input
                    autoComplete="new-password"
                    dir="ltr"
                    onChange={(event) => setWooConsumerSecret(event.target.value)}
                    placeholder="cs_..."
                    type="password"
                    value={wooConsumerSecret}
                  />
                </label>
                <button className="button button-primary" disabled={busy || !provider.enabled} type="submit">
                  Connect WooCommerce
                </button>
              </form>
            ) : (
              <button className="button button-secondary" disabled type="button">
                Coming Soon
              </button>
            )}
          </article>
        ))}
      </div>

      <div className="page-heading">
        <div>
          <p className="eyebrow">Connected stores</p>
          <h2>Your commerce connections</h2>
        </div>
      </div>
      {loading ? (
        <div className="loading-row">Loading integrations…</div>
      ) : connections.length === 0 ? (
        <p>No commerce integrations connected yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Store</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Health</th>
              <th>Imported orders</th>
              <th>Errors</th>
              <th>Last activity</th>
              <th>Actions</th>
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
                    <button className="button button-secondary" disabled={busy} onClick={() => void syncNow(connection)} type="button">
                      Sync
                    </button>
                    {connection.status === "disconnected" ? (
                      <button className="button button-secondary" disabled={busy} onClick={() => void reconnect(connection)} type="button">
                        Reconnect
                      </button>
                    ) : (
                      <button className="button button-secondary" disabled={busy} onClick={() => void disconnect(connection)} type="button">
                        Disconnect
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
