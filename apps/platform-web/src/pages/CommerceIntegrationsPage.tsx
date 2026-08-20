import { FormEvent, useEffect, useState } from "react";

import { platformApi } from "../api/platform-client.js";

const eventTypes = ["order.created", "order.updated", "order.cancelled"] as const;

function titleize(value: string | undefined) {
  return (value ?? "unknown").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function eventBadge(status: string | undefined) {
  if (status === "succeeded" || status === "duplicate") return "platform-badge platform-badge--complete";
  if (status === "failed" || status === "rejected") return "platform-badge platform-badge--disabled";
  if (status === "retrying" || status === "processing") return "platform-badge platform-badge--suspended";
  return "platform-badge";
}

function defaultOrder() {
  return {
    externalOrderId: "TEST-10001",
    externalOrderNumber: "TEST-10001",
    customerName: "Aiman",
    customerMobile: "+971506468441",
    countryCode: "AE",
    emirate: "Dubai",
    area: "Al Aweer",
    address: "Al Aweer, Dubai",
    packageCount: 1,
    codAmount: 250,
    codRequired: true,
    currency: "AED",
    notes: "Mock commerce order",
  };
}

export function CommerceIntegrationsPage() {
  const [providers, setProviders] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [areas, setAreas] = useState<any[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [simulation, setSimulation] = useState({ eventType: "order.created", externalEventId: "", invalidSignature: false, simulateFailure: "", order: defaultOrder() });
  const [mappingDraft, setMappingDraft] = useState({ externalValue: "Aweer", areaId: "" });

  async function load(keepSelectedId?: string) {
    const [providerResult, connectionResult] = await Promise.all([
      platformApi.commerceProviders(),
      platformApi.commerceConnections({ pageSize: 50 }),
    ]);
    setProviders(providerResult.items ?? []);
    setConnections(connectionResult.items ?? []);
    const nextSelectedId = keepSelectedId ?? selected?.id ?? connectionResult.items?.[0]?.id;
    if (nextSelectedId) await openConnection(nextSelectedId);
  }

  async function openConnection(id: string) {
    const detail = await platformApi.commerceConnection(id);
    setSelected(detail);
    const areaResult = await platformApi.commerceAreas(id);
    setAreas(areaResult.items ?? []);
    setMappingDraft((current) => ({ ...current, areaId: current.areaId || areaResult.items?.[0]?.id || "" }));
  }

  useEffect(() => { void load(); }, []);

  async function guarded(action: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const nextMessage = await action();
      if (nextMessage) setMessage(nextMessage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function simulate(input: Partial<typeof simulation> = {}) {
    if (!selected) return;
    await guarded(async () => {
      const merged = { ...simulation, ...input };
      const result = await platformApi.simulateCommerceEvent(selected.id, {
        eventType: merged.eventType,
        externalEventId: merged.externalEventId || undefined,
        invalidSignature: merged.invalidSignature || undefined,
        simulateFailure: merged.simulateFailure || undefined,
        order: merged.order,
      });
      await load(selected.id);
      return `Simulator result: ${result?.status ?? "received"}${result?.errorCode ? ` (${result.errorCode})` : ""}.`;
    });
  }

  async function saveMapping(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    await guarded(async () => {
      await platformApi.saveCommerceAreaMapping(selected.id, mappingDraft);
      await load(selected.id);
      return "Area mapping saved. You can now retry the failed event.";
    });
  }

  async function retryEvent(id: string) {
    if (!selected) return;
    await guarded(async () => {
      const result = await platformApi.retryCommerceEvent(id);
      await load(selected.id);
      const orderText = result?.orderReference ? ` · Order ${result.orderReference}` : "";
      return `Retry result: ${titleize(result?.eventStatus ?? result?.status ?? "received")}${orderText}.`;
    });
  }

  async function health(state: string) {
    if (!selected) return;
    await guarded(async () => {
      await platformApi.testCommerceConnection(selected.id, state);
      await load(selected.id);
      return `Connection health set to ${state}.`;
    });
  }

  async function disconnect() {
    if (!selected) return;
    await guarded(async () => {
      await platformApi.disconnectCommerceConnection(selected.id, "Platform mock acceptance test");
      await load(selected.id);
      return "Connection disconnected.";
    });
  }

  async function reconnect() {
    if (!selected) return;
    await guarded(async () => {
      await platformApi.reconnectCommerceConnection(selected.id);
      await load(selected.id);
      return "Connection reconnected.";
    });
  }

  async function outboundDelivered(orderId: string) {
    if (!selected) return;
    await guarded(async () => {
      const result = await platformApi.outboundCommerceDelivered(orderId);
      await load(selected.id);
      return `Outbound delivered result: ${result?.status ?? "recorded"}.`;
    });
  }

  const lastOrderId = selected?.events?.find((event: any) => event.tawseelhubOrderId)?.tawseelhubOrderId;

  return (
    <section className="platform-page">
      <div className="platform-page__header">
        <div>
          <p className="platform-page__eyebrow">Commerce</p>
          <h1>Commerce Integrations</h1>
          <p>Monitor Trader-owned store connections, review webhook behavior, and support failed provider events.</p>
        </div>
      </div>
      {message ? <p className="platform-success">{message}</p> : null}
      {error ? <p className="platform-warning">{error}</p> : null}

      <div className="platform-grid platform-grid--two">
        <div className="platform-card">
          <h2>Provider foundation</h2>
          <div className="lead-action-grid">
            {providers.map((provider) => (
              <span className={provider.enabled ? "platform-badge platform-badge--complete" : "platform-badge"} key={provider.key}>
                {titleize(provider.label)} · {provider.enabled ? "Enabled" : "Future"}
              </span>
            ))}
          </div>
          <p className="platform-muted">
            Platform is now a monitoring and support console for commerce integrations. Traders connect Salla,
            Shopify, and future providers from their own Trader Portal so the company and Trader are always
            taken from the authenticated session.
          </p>
        </div>

        <div className="platform-card">
          <h2>Connections</h2>
          <table className="platform-table">
            <thead><tr><th>Store</th><th>Trader</th><th>Status</th><th>Health</th><th>Orders</th><th>Open</th></tr></thead>
            <tbody>{connections.map((connection) => (
              <tr key={connection.id}>
                <td>{connection.externalStoreName}<br /><span className="platform-muted">{connection.referenceNumber}</span></td>
                <td>{connection.companyName}<br /><span className="platform-muted">{connection.traderName}</span></td>
                <td><span className="platform-badge">{titleize(connection.status)}</span></td>
                <td>{titleize(connection.healthStatus)}</td>
                <td>{connection.importedOrders ?? 0}</td>
                <td><button className="platform-button platform-button--quiet" type="button" onClick={() => void openConnection(connection.id)}>View</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      {selected ? (
        <div className="platform-grid platform-grid--two">
          <div className="platform-card">
            <h2>{selected.externalStoreName}</h2>
            <div className="lead-action-grid">
              <span className="platform-badge">{selected.referenceNumber}</span>
              <span className="platform-badge">{titleize(selected.provider)}</span>
              <span className="platform-badge">{titleize(selected.status)}</span>
              <span className="platform-badge">{titleize(selected.healthStatus)}</span>
              <span className="platform-badge">{selected.credentialConfigured ? "Credential configured" : "No credential"}</span>
            </div>
            <div className="lead-contact-actions">
              <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void health("healthy")}>Healthy</button>
              <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void health("degraded")}>Degraded</button>
              <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void disconnect()}>Disconnect</button>
              <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void reconnect()}>Reconnect</button>
              {lastOrderId ? <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void outboundDelivered(lastOrderId)}>Outbound Delivered</button> : null}
            </div>

            <form className="platform-form" onSubmit={(event) => { event.preventDefault(); void simulate(); }}>
              <h3>Mock event simulator</h3>
              <label className="platform-field">Event type<select value={simulation.eventType} onChange={(event) => setSimulation({ ...simulation, eventType: event.target.value })}>{eventTypes.map((eventType) => <option key={eventType} value={eventType}>{eventType}</option>)}</select></label>
              <label className="platform-field">External event ID<input placeholder="Blank = generated unique event" value={simulation.externalEventId} onChange={(event) => setSimulation({ ...simulation, externalEventId: event.target.value })} /></label>
              <label className="platform-field">External order number<input value={simulation.order.externalOrderNumber} onChange={(event) => setSimulation({ ...simulation, order: { ...simulation.order, externalOrderId: event.target.value, externalOrderNumber: event.target.value } })} /></label>
              <label className="platform-field">Customer mobile<input value={simulation.order.customerMobile} onChange={(event) => setSimulation({ ...simulation, order: { ...simulation.order, customerMobile: event.target.value } })} /></label>
              <label className="platform-field">Area<input value={simulation.order.area} onChange={(event) => setSimulation({ ...simulation, order: { ...simulation.order, area: event.target.value } })} /></label>
              <label className="platform-field">COD<input type="number" value={simulation.order.codAmount} onChange={(event) => setSimulation({ ...simulation, order: { ...simulation.order, codAmount: Number(event.target.value) } })} /></label>
              <div className="lead-contact-actions">
                <button className="platform-button platform-button--primary" disabled={busy} type="submit">Send Event</button>
                <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void simulate({ externalEventId: "same-event-TEST-10001" })}>Send Same Event Again</button>
                <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void simulate({ invalidSignature: true })}>Invalid Signature</button>
                <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void simulate({ eventType: "order.created", externalEventId: "", order: { ...simulation.order, externalOrderId: `MAP-${Date.now()}`, externalOrderNumber: `MAP-${Date.now()}`, area: "Aweer" } })}>Mapping Failure</button>
                <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void simulate({ simulateFailure: "timeout" })}>Provider Timeout</button>
                <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void simulate({ simulateFailure: "processing_failure" })}>Processing Failure</button>
              </div>
            </form>

            <form className="platform-form" onSubmit={saveMapping}>
              <h3>Area mapping fix</h3>
              <label className="platform-field">External area value<input value={mappingDraft.externalValue} onChange={(event) => setMappingDraft({ ...mappingDraft, externalValue: event.target.value })} /></label>
              <label className="platform-field">Tawseelhub Area<select value={mappingDraft.areaId} onChange={(event) => setMappingDraft({ ...mappingDraft, areaId: event.target.value })}>{areas.map((area) => <option key={area.id} value={area.id}>{area.nameEn} ({area.code})</option>)}</select></label>
              <button className="platform-button platform-button--primary" disabled={busy || !mappingDraft.areaId} type="submit">Save Mapping</button>
            </form>
          </div>

          <div className="platform-card">
            <h2>Event log</h2>
            <table className="platform-table">
              <thead><tr><th>Received</th><th>Event</th><th>Status</th><th>External</th><th>Order</th><th>Result</th><th>Action</th></tr></thead>
              <tbody>{selected.events?.map((event: any) => (
                <tr key={event.id}>
                  <td>{new Date(event.receivedAt).toLocaleString()}</td>
                  <td>{event.eventType}<br /><span className="platform-muted">{event.externalEventId}</span></td>
                  <td><span className={eventBadge(event.status)}>{titleize(event.status)}</span></td>
                  <td>{event.externalReference ?? event.externalOrderId ?? "—"}</td>
                  <td>{event.tawseelhubOrderNumber ?? event.tawseelhubOrderId ?? "—"}</td>
                  <td>{event.resultSummary ?? event.errorMessageSafe ?? "—"}</td>
                  <td>
                    {["failed", "retrying"].includes(event.status) ? (
                      <button className="platform-button platform-button--quiet" disabled={busy} type="button" onClick={() => void retryEvent(event.id)}>Retry</button>
                    ) : null}
                  </td>
                </tr>
              ))}</tbody>
            </table>
            <h3>Mappings</h3>
            <div className="platform-list">
              {selected.mappings?.length ? selected.mappings.map((mapping: any) => (
                <article key={mapping.id}><strong>{mapping.externalValue} → {mapping.areaName}</strong><span>{titleize(mapping.status)} · {mapping.provider}</span></article>
              )) : <p className="platform-muted">No manual mappings yet.</p>}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
