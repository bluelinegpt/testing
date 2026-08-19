/* eslint-disable @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { platformApi } from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

const label = (value?: string | null) => (value ? value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase()) : "—");
const locationLabel = (quote: any, side: "pickup" | "delivery") => {
  const country = quote[`${side}_country_name`] ?? "United Arab Emirates";
  const emirate = quote[`${side}_emirate`];
  const city = quote[`${side}_city`];
  const area = quote[`${side}_area`];
  return [emirate === "international" ? city : label(emirate), area, country].filter(Boolean).join(", ");
};

export function CustomerQuotesPage() {
  const { id } = useParams();
  return id ? <Detail id={id} /> : <List />;
}

function List() {
  const [rows, setRows] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>();
  const [query, setQuery] = useState("");
  const session = usePlatformSession();

  useEffect(() => {
    void platformApi.customerQuotes().then(setRows);
    if (session.can("platform.customer_marketplace.manage")) void platformApi.customerMarketplaceSettings().then(setSettings);
  }, [session]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((quote) => [quote.reference_number, quote.requester_name, quote.requester_mobile, quote.recipient_mobile, locationLabel(quote, "pickup"), locationLabel(quote, "delivery")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle));
  }, [query, rows]);

  return <section className="platform-panel">
    <div className="platform-panel__header">
      <div>
        <h2>Customer Quotes</h2>
        <p className="platform-muted">Public package requests, anonymous offers and custom-quote handling.</p>
      </div>
    </div>
    {settings && <article className="lead-workflow">
      <h3>Customer Marketplace Commission</h3>
      <div className="platform-filters">
        <label>Commission %<input type="number" step=".01" value={settings.commissionRatePercent} onChange={(event) => setSettings({ ...settings, commissionRatePercent: Number(event.target.value) })} /></label>
        <label>Quote expiry minutes<input type="number" value={settings.quoteExpiryMinutes} onChange={(event) => setSettings({ ...settings, quoteExpiryMinutes: Number(event.target.value) })} /></label>
        <label><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /> Enabled</label>
        <button onClick={() => void platformApi.updateCustomerMarketplaceSettings(settings).then(setSettings)}>Save</button>
      </div>
    </article>}
    <div className="platform-filters">
      <label>Search quotes<input placeholder="QTE reference, customer name or mobile" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>
    <div className="platform-table-scroll">
      <table className="platform-table">
        <thead><tr><th>Reference</th><th>Customer</th><th>Mobile</th><th>Pickup</th><th>Destination</th><th>Package</th><th>Weight</th><th>Service</th><th>COD</th><th>Type</th><th>Status</th><th>Best Price</th><th>Created</th></tr></thead>
        <tbody>{visibleRows.map((quote) => <tr key={quote.id}>
          <td><Link to={`/customer-quotes/${quote.id}`}>{quote.reference_number}</Link></td>
          <td>{quote.requester_name ?? "—"}</td>
          <td>{quote.requester_mobile ?? "—"}</td>
          <td>{locationLabel(quote, "pickup")}</td>
          <td>{locationLabel(quote, "delivery")}</td>
          <td>{label(quote.package_type)}</td>
          <td>{quote.weight_kg} kg</td>
          <td>{label(quote.requested_service_type)}</td>
          <td>{quote.cod_required ? "Yes" : "No"}</td>
          <td>{label(quote.quote_type)}</td>
          <td><span className="platform-badge">{label(quote.status)}</span></td>
          <td>{quote.best_price ? `AED ${quote.best_price}` : "—"}</td>
          <td>{new Date(quote.created_at).toLocaleString()}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function Detail({ id }: { id: string }) {
  const [data, setData] = useState<any>();
  const [companyId, setCompanyId] = useState("");
  const [price, setPrice] = useState("");
  const session = usePlatformSession();

  useEffect(() => { void platformApi.customerQuote(id).then(setData); }, [id]);
  if (!data) return <section className="platform-panel">Loading…</section>;
  const q = data.quote;
  return <section className="platform-panel">
    <Link to="/customer-quotes">← Customer Quotes</Link>
    <h2>{q.reference_number}</h2>
    <span className="platform-badge">{label(q.status)}</span>
    <div className="lead-detail-grid">
      <Card title="Requester" rows={[["Name", q.requester_name], ["Mobile", q.requester_mobile], ["Email", q.requester_email]]} />
      <Card title="Pickup" rows={[["Route", locationLabel(q, "pickup")], ["Address", q.pickup_address], ["Contact", q.pickup_contact_name], ["Mobile", q.pickup_mobile]]} />
      <Card title="Delivery" rows={[["Route", locationLabel(q, "delivery")], ["Address", q.delivery_address], ["Recipient", q.recipient_name], ["Mobile", q.recipient_mobile]]} />
      <Card title="Package & Service" rows={[["Package", label(q.package_type)], ["Description", q.description], ["Weight", `${q.weight_kg} kg`], ["Dimensions", q.length_cm && q.width_cm && q.height_cm ? `${q.length_cm} × ${q.width_cm} × ${q.height_cm} ${q.dimension_unit ?? "cm"}` : "—"], ["Declared value", q.declared_value ? `${q.declared_value_currency ?? ""} ${q.declared_value}`.trim() : "—"], ["Service", label(q.requested_service_type)], ["COD", q.cod_required ? `AED ${q.cod_amount}` : "No"], ["Custom reason", q.custom_quote_reason]]} />
      <Card title="Marketing Attribution" rows={[["Source", q.source], ["Landing page", q.landing_page], ["Referrer", q.referrer], ["UTM source", q.utm_source], ["UTM medium", q.utm_medium], ["UTM campaign", q.utm_campaign], ["UTM term", q.utm_term], ["UTM content", q.utm_content], ["Google click ID", q.gclid]]} />
    </div>
    <h3>Matching Result</h3>
    <div className="platform-table-scroll">
      <table className="platform-table">
        <thead><tr><th>Delivery Company</th><th>Profile</th><th>Gross</th><th>Commission</th><th>Company Net</th><th>Status</th></tr></thead>
        <tbody>{data.offers.map((offer: any) => <tr key={offer.id}><td>{offer.company_name}</td><td>{offer.profile_name ?? "Manual"}</td><td>AED {offer.gross_customer_price}</td><td>AED {offer.commission_amount}</td><td>AED {offer.company_net_amount}</td><td>{label(offer.status)}</td></tr>)}</tbody>
      </table>
    </div>
    {session.can("platform.customer_quotes.manage") && <div className="lead-workflow">
      <h3>Publish anonymous custom offer</h3>
      <div className="platform-filters">
        <label>Delivery Company UUID<input value={companyId} onChange={(event) => setCompanyId(event.target.value)} /></label>
        <label>Customer price<input type="number" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
        <button onClick={() => void platformApi.createManualCustomerOffer(id, { companyId, customerPrice: Number(price), serviceType: q.requested_service_type, validityMinutes: 30 }).then(() => platformApi.customerQuote(id).then(setData))}>Publish Offer</button>
      </div>
    </div>}
  </section>;
}

function Card({ title, rows }: { title: string; rows: any[] }) {
  return <article className="lead-detail-card"><h3>{title}</h3><dl>{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? "—"}</dd></div>)}</dl></article>;
}
