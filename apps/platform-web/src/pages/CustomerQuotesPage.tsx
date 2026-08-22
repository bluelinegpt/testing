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
  const [fees, setFees] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>();
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState("");
  const session = usePlatformSession();

  useEffect(() => {
    void platformApi.customerQuotes().then(setRows);
    void platformApi.platformFeeReceivables().then(setFees);
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
  const selectedSet = new Set(selectedIds);
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((quote) => selectedSet.has(String(quote.id)));
  const toggleSelected = (id: string, checked: boolean) => setSelectedIds((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id));
  const toggleAllVisible = (checked: boolean) => setSelectedIds(checked ? visibleRows.map((quote) => String(quote.id)) : []);
  const deleteSelected = async () => {
    if (!selectedIds.length) return;
    if (!window.confirm(`Delete ${selectedIds.length} selected customer quote(s)? This cannot be undone.`)) return;
    setDeleteError("");
    try {
      await platformApi.deleteCustomerQuotes(selectedIds);
      setRows((current) => current.filter((quote) => !selectedIds.includes(String(quote.id))));
      setSelectedIds([]);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Selected quotes could not be deleted.");
    }
  };

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
    <PlatformFeesPanel canManage={session.can("platform.customer_quotes.manage")} fees={fees} onReload={() => void platformApi.platformFeeReceivables().then(setFees)} />
    <div className="platform-filters">
      <label>Search quotes<input placeholder="QTE reference, customer name or mobile" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>
    {session.can("platform.customer_quotes.manage") ? <div className="lead-contact-actions">
      <label className="agent-row-select"><input checked={allVisibleSelected} onChange={(event) => toggleAllVisible(event.target.checked)} type="checkbox" /> <span>Select all visible</span></label>
      <button className="platform-button platform-button--danger" disabled={!selectedIds.length} onClick={() => void deleteSelected()} type="button">Delete selected{selectedIds.length ? ` (${selectedIds.length})` : ""}</button>
    </div> : null}
    {deleteError ? <p role="alert">{deleteError}</p> : null}
    <div className="platform-table-scroll">
      <table className="platform-table">
        <thead><tr>{session.can("platform.customer_quotes.manage") ? <th>Select</th> : null}<th>Reference</th><th>Customer</th><th>Mobile</th><th>Pickup</th><th>Destination</th><th>Package</th><th>Weight</th><th>Service</th><th>COD</th><th>Type</th><th>Status</th><th>Best Price</th><th>Created</th></tr></thead>
        <tbody>{visibleRows.map((quote) => <tr key={quote.id}>
          {session.can("platform.customer_quotes.manage") ? <td><input aria-label={`Select ${quote.reference_number}`} checked={selectedSet.has(String(quote.id))} onChange={(event) => toggleSelected(String(quote.id), event.target.checked)} type="checkbox" /></td> : null}
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

function PlatformFeesPanel({ canManage, fees, onReload }: { canManage: boolean; fees: any[]; onReload: () => void }) {
  const [payingId, setPayingId] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const pay = async () => {
    if (!payingId || !amount) return;
    setMessage("");
    setError("");
    try {
      const result = await platformApi.recordPlatformFeePayment(payingId, { amount: Number(amount), paymentDate, paymentMethod, referenceNumber, notes });
      setMessage(`Payment recorded. New status: ${label(result.status)}. Balance AED ${result.balanceAmount}.`);
      setPayingId("");
      setAmount("");
      setPaymentMethod("");
      setReferenceNumber("");
      setNotes("");
      onReload();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Payment could not be recorded.");
    }
  };
  const selected = fees.find((fee) => fee.id === payingId);
  const totals = fees.reduce((acc, fee) => {
    acc.amount += Number(fee.amount ?? 0);
    acc.paid += Number(fee.paid_amount ?? 0);
    acc.balance += Number(fee.balance_amount ?? 0);
    return acc;
  }, { amount: 0, paid: 0, balance: 0 });
  return <article className="lead-workflow">
    <h3>Tawseelhub Platform Fee Payments</h3>
    <p className="platform-muted">Track the separate platform fee owed to Tawseelhub by each Delivery Company.</p>
    <div className="platform-kpi-grid">
      <span className="platform-badge">Total AED {totals.amount.toFixed(2)}</span>
      <span className="platform-badge">Paid AED {totals.paid.toFixed(2)}</span>
      <span className="platform-badge">Unpaid AED {totals.balance.toFixed(2)}</span>
    </div>
    {message ? <p>{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="platform-table-scroll">
      <table className="platform-table">
        <thead><tr><th>Company</th><th>Quote</th><th>Order</th><th>Platform Fee</th><th>Paid</th><th>Balance</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{fees.length ? fees.map((fee) => <tr key={fee.id}>
          <td>{fee.company_name}</td>
          <td>{fee.quote_reference ?? "—"}</td>
          <td>{fee.order_number}</td>
          <td>AED {fee.amount}</td>
          <td>AED {fee.paid_amount}</td>
          <td>AED {fee.balance_amount}</td>
          <td><span className="platform-badge">{label(fee.status)}</span></td>
          <td>{canManage && fee.status !== "paid" ? <button onClick={() => { setPayingId(fee.id); setAmount(fee.balance_amount); }} type="button">Record Payment</button> : "—"}</td>
        </tr>) : <tr><td colSpan={8}>No platform fees yet.</td></tr>}</tbody>
      </table>
    </div>
    {canManage && payingId ? <div className="platform-filters">
      <strong>Record payment for {selected?.company_name} · {selected?.order_number}</strong>
      <label>Amount (AED)<input min="0.01" step=".01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <label>Payment date<input type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} /></label>
      <label>Method<input placeholder="Bank transfer, cash, card..." value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} /></label>
      <label>Reference<input placeholder="Receipt / bank ref" value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} /></label>
      <label>Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <button disabled={!amount || Number(amount) <= 0} onClick={() => void pay()} type="button">Save Payment</button>
      <button onClick={() => setPayingId("")} type="button">Cancel</button>
    </div> : null}
  </article>;
}

function Detail({ id }: { id: string }) {
  const [data, setData] = useState<any>();
  const [companies, setCompanies] = useState<any[]>([]);
  const [companySearch, setCompanySearch] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [deliveryFee, setDeliveryFee] = useState("");
  const [platformFee, setPlatformFee] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [conversionMessage, setConversionMessage] = useState("");
  const [conversionError, setConversionError] = useState("");
  const [converting, setConverting] = useState(false);
  const session = usePlatformSession();

  useEffect(() => { void platformApi.customerQuote(id).then(setData); }, [id]);
  useEffect(() => { if (session.can("platform.customer_quotes.manage")) void platformApi.companies({ pageSize: 100, sort: "name", direction: "asc" }).then((page) => setCompanies([...(page.items ?? [])])); }, [session]);
  if (!data) return <section className="platform-panel">Loading…</section>;
  const q = data.quote;
  const companyNeedle = companySearch.trim().toLowerCase();
  const filteredCompanies = companyNeedle ? companies.filter((company) => [company.nameEn, company.code, company.subdomain].join(" ").toLowerCase().includes(companyNeedle)) : companies;
  const convertQuote = async () => {
    if (!companyId || !deliveryFee) return;
    setConversionError("");
    setConversionMessage("");
    setConverting(true);
    try {
      const result = await platformApi.convertCustomerQuoteToOrder(id, {
        companyId,
        deliveryFee: Number(deliveryFee),
        internalNotes,
        platformFee: Number(platformFee || 0),
      });
      setConversionMessage(`Created company order ${result.orderNumber} for ${result.companyName}.`);
      await platformApi.customerQuote(id).then(setData);
    } catch (error) {
      setConversionError(error instanceof Error ? error.message : "Could not create the company order.");
    } finally {
      setConverting(false);
    }
  };
  return <section className="platform-panel">
    <Link to="/customer-quotes">← Customer Quotes</Link>
    <h2>{q.reference_number}</h2>
    <span className="platform-badge">{label(q.status)}</span>
    <div className="lead-detail-grid">
      <Card title="Requester" rows={[["Name", q.requester_name], ["Mobile", q.requester_mobile], ["Email", q.requester_email]]} />
      <Card title="Pickup" rows={[["Route", locationLabel(q, "pickup")], ["Address", q.pickup_address], ["Contact", q.pickup_contact_name], ["Mobile", q.pickup_mobile]]} />
      <Card title="Delivery" rows={[["Route", locationLabel(q, "delivery")], ["Address", q.delivery_address], ["Recipient", q.recipient_name], ["Mobile", q.recipient_mobile]]} />
      <Card title="Package & Service" rows={[["Package", label(q.package_type)], ["Description", q.description], ["Weight", `${q.weight_kg} kg`], ["Dimensions", q.length_cm && q.width_cm && q.height_cm ? `${q.length_cm} × ${q.width_cm} × ${q.height_cm} ${q.dimension_unit ?? "cm"}` : "—"], ["Declared value", q.declared_value ? `${q.declared_value_currency ?? ""} ${q.declared_value}`.trim() : "—"], ["Service", label(q.requested_service_type)], ["COD", q.cod_required ? `AED ${q.cod_amount}` : "No"], ["Custom reason", q.custom_quote_reason]]} />
      <Card title="Company Order" rows={[["Assigned company", q.assigned_company_name ?? q.assigned_company_id], ["Created order", q.converted_order_number ?? q.converted_order_id], ["Delivery fee", q.delivery_fee_amount ? `AED ${q.delivery_fee_amount}` : "—"], ["Platform fee", q.platform_fee_amount ? `AED ${q.platform_fee_amount}` : "—"], ["Converted at", q.converted_at ? new Date(q.converted_at).toLocaleString() : "—"]]} />
      <Card title="Tawseelhub Platform Fee Payment" rows={[["Company", data.platformFee?.company_name], ["Order", data.platformFee?.order_number], ["Fee", data.platformFee ? `AED ${data.platformFee.amount}` : "—"], ["Paid", data.platformFee ? `AED ${data.platformFee.paid_amount}` : "—"], ["Balance", data.platformFee ? `AED ${data.platformFee.balance_amount}` : "—"], ["Status", data.platformFee ? label(data.platformFee.status) : "—"], ["Payments", data.platformFeePayments?.length ? data.platformFeePayments.map((payment: any) => `${payment.payment_date}: AED ${payment.amount}${payment.reference_number ? ` · ${payment.reference_number}` : ""}`).join("\n") : "—"]]} />
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
      <h3>Create company order</h3>
      <p className="platform-muted">Select the Delivery Company, enter the delivery fee and Tawseelhub platform fee, then create a real order for that company. This does not send a message to the customer.</p>
      {q.converted_order_id ? <p className="platform-badge">Already converted to company order</p> : null}
      {conversionMessage ? <p>{conversionMessage}</p> : null}
      {conversionError ? <p role="alert">{conversionError}</p> : null}
      <div className="platform-filters">
        <label>Search company<input placeholder="Company name, code or subdomain" value={companySearch} onChange={(event) => setCompanySearch(event.target.value)} /></label>
        <label>Delivery Company<select disabled={Boolean(q.converted_order_id)} value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
          <option value="">Select company…</option>
          {filteredCompanies.map((company) => <option key={company.id} value={company.id}>{company.nameEn} · {company.code} · {company.subdomain}</option>)}
        </select></label>
        <label>Delivery fee (AED)<input disabled={Boolean(q.converted_order_id)} min="0.01" step=".01" type="number" value={deliveryFee} onChange={(event) => setDeliveryFee(event.target.value)} /></label>
        <label>Platform fee (AED)<input disabled={Boolean(q.converted_order_id)} min="0" step=".01" type="number" value={platformFee} onChange={(event) => setPlatformFee(event.target.value)} /></label>
        <label>Internal note<textarea disabled={Boolean(q.converted_order_id)} value={internalNotes} onChange={(event) => setInternalNotes(event.target.value)} /></label>
        <button disabled={Boolean(q.converted_order_id) || converting || !companyId || !deliveryFee} onClick={() => void convertQuote()} type="button">{converting ? "Creating…" : "Create Order for Company"}</button>
      </div>
    </div>}
  </section>;
}

function Card({ title, rows }: { title: string; rows: any[] }) {
  return <article className="lead-detail-card"><h3>{title}</h3><dl>{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? "—"}</dd></div>)}</dl></article>;
}
