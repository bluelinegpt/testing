import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { platformApi, type DemoRequestDetail, type DemoRequestPage, type DemoRequestStatus } from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

const statuses: readonly DemoRequestStatus[] = ["new", "reviewing", "contacted", "qualified", "demo_scheduled", "converted", "not_interested", "rejected", "closed"];
const countries = ["United Arab Emirates", "Saudi Arabia", "Oman", "Qatar", "Kuwait", "Bahrain", "Jordan", "Egypt", "Iraq", "Lebanon", "Morocco", "Pakistan", "India", "United Kingdom", "United States", "Other"];
const emirates = ["abu_dhabi", "dubai", "sharjah", "ajman", "umm_al_quwain", "ras_al_khaimah", "fujairah"];
const label = (value: string | null | undefined) => value ? value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "—";

export function DemoRequestsPage(): ReactElement {
  const { demoRequestId } = useParams();
  return demoRequestId ? <DemoRequestDetailPage id={demoRequestId} /> : <DemoRequestListPage />;
}

function DemoRequestListPage(): ReactElement {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [country, setCountry] = useState("");
  const [emirate, setEmirate] = useState("");
  const [contact, setContact] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DemoRequestPage>();
  const [error, setError] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const session = usePlatformSession();

  const load = useCallback(() => {
    setError(false);
    void platformApi.demoRequests({ search, status, country, emirate, preferredContactMethod: contact, sort, page }).then((result) => {
      setData(result);
      setSelectedIds([]);
    }).catch(() => setError(true));
  }, [contact, country, emirate, page, search, sort, status]);

  useEffect(load, [load]);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 25)));
  const canManage = session.can("platform.leads.manage");
  const selectedSet = new Set(selectedIds);
  const allVisibleSelected = Boolean(data?.items.length) && (data?.items ?? []).every((item) => selectedSet.has(String(item.id)));
  const toggleSelected = (id: string, checked: boolean) => setSelectedIds((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id));
  const toggleAllVisible = (checked: boolean) => setSelectedIds(checked ? (data?.items ?? []).map((item) => String(item.id)) : []);
  async function deleteSelected() {
    if (!selectedIds.length) return;
    if (!window.confirm(`Delete ${selectedIds.length} selected website lead(s)? This cannot be undone.`)) return;
    setDeleteError("");
    try {
      await platformApi.deleteDemoRequests(selectedIds);
      load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Selected leads could not be deleted.");
    }
  }

  return (
    <section className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h2>Website Leads</h2>
          <p className="platform-muted">Demo requests from the public Tawseelhub website.</p>
        </div>
      </div>
      <div className="platform-filters">
        <Field label="Search"><input onChange={(event) => { setPage(1); setSearch(event.target.value); }} placeholder="Reference, company, contact, mobile, email or Agent ref" type="search" value={search} /></Field>
        <Field label="Status"><select onChange={(event) => { setPage(1); setStatus(event.target.value); }} value={status}><option value="">All statuses</option>{statuses.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></Field>
        <Field label="Country"><select onChange={(event) => { setPage(1); setCountry(event.target.value); }} value={country}><option value="">All countries</option>{countries.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
        <Field label="Emirate"><select onChange={(event) => { setPage(1); setEmirate(event.target.value); }} value={emirate}><option value="">All Emirates</option>{emirates.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></Field>
        <Field label="Preferred contact"><select onChange={(event) => { setPage(1); setContact(event.target.value); }} value={contact}><option value="">All methods</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select></Field>
        <Field label="Sort"><select onChange={(event) => setSort(event.target.value as typeof sort)} value={sort}><option value="newest">Newest</option><option value="oldest">Oldest</option></select></Field>
      </div>
      {canManage && data ? <div className="lead-contact-actions">
        <label className="agent-row-select"><input checked={allVisibleSelected} onChange={(event) => toggleAllVisible(event.target.checked)} type="checkbox" /> <span>Select all visible</span></label>
        <button className="platform-button platform-button--danger" disabled={!selectedIds.length} onClick={() => void deleteSelected()} type="button">Delete selected{selectedIds.length ? ` (${selectedIds.length})` : ""}</button>
      </div> : null}
      {deleteError ? <p role="alert">{deleteError}</p> : null}
      {error ? <p role="alert">The lead list could not be loaded.</p> : !data ? <p>Loading…</p> : data.items.length === 0 ? <p className="platform-muted">No leads match these filters.</p> : (
        <>
          <div className="platform-table-scroll">
            <table className="platform-table">
              <thead><tr>{canManage ? <th>Select</th> : null}<th>Reference</th><th>Company</th><th>Contact</th><th>Mobile</th><th>Email</th><th>Country</th><th>Monthly Orders</th><th>Drivers</th><th>Preferred Contact</th><th>Status</th><th>CRM Link</th><th>Created</th></tr></thead>
              <tbody>{data.items.map((item) => <tr key={item.id}>{canManage ? <td><input aria-label={`Select ${item.referenceNumber}`} checked={selectedSet.has(String(item.id))} onChange={(event) => toggleSelected(String(item.id), event.target.checked)} type="checkbox" /></td> : null}<td><Link to={`/demo-requests/${item.id}`}>{item.referenceNumber}</Link></td><td>{item.companyName}</td><td>{item.contactPerson}</td><td>{item.mobileNumber}</td><td>{item.email}</td><td>{item.country}{item.emirate ? <><br /><span className="platform-muted">{label(item.emirate)}</span></> : null}</td><td>{item.approximateMonthlyOrders ?? "—"}</td><td>{item.approximateDriverCount ?? "—"}</td><td>{label(item.preferredContactMethod)}</td><td><span className="platform-badge">{label(item.status)}</span></td><td>{item.agentConversationReference ? <Link to={`/agent?search=${encodeURIComponent(item.agentConversationReference)}`}>{item.agentConversationReference}</Link> : "—"}</td><td>{new Date(item.createdAt).toLocaleString()}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="platform-pager"><button className="platform-button platform-button--quiet" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page} of {pages} · {data.total} leads</span><button className="platform-button platform-button--quiet" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next</button></div>
        </>
      )}
    </section>
  );
}

function DemoRequestDetailPage({ id }: { id: string }): ReactElement {
  const session = usePlatformSession();
  const [lead, setLead] = useState<DemoRequestDetail>();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => void platformApi.demoRequest(id).then(setLead).catch(() => setError("The lead could not be loaded.")), [id]);
  useEffect(load, [load]);

  async function transition(status: DemoRequestStatus) {
    if (!lead) return;
    setBusy(true);
    setError("");
    try {
      setLead(await platformApi.updateDemoRequestStatus(id, { status, ...(reason ? { reason } : {}) }));
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The status could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await platformApi.addDemoRequestNote(id, note);
      setNote("");
      load();
    } catch {
      setError("The internal note could not be added.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !lead) return <section className="platform-panel"><p role="alert">{error}</p></section>;
  if (!lead) return <section className="platform-panel"><p>Loading…</p></section>;

  return (
    <section className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <Link to="/demo-requests">← Website Leads</Link>
          <h2>{lead.referenceNumber} · {lead.companyName}</h2>
          <p><span className="platform-badge">{label(lead.status)}</span></p>
        </div>
        <div className="lead-contact-actions">
          <a className="platform-button platform-button--quiet" href={`tel:${lead.mobileNumber}`}>Call</a>
          <a className="platform-button platform-button--quiet" href={`https://wa.me/${lead.mobileNumber.replace(/\D/g, "")}`} rel="noreferrer" target="_blank">WhatsApp</a>
          <a className="platform-button platform-button--quiet" href={`mailto:${lead.email}`}>Email</a>
        </div>
      </div>
      <div className="lead-detail-grid">
        <Details title="Company Information" rows={[["Company", lead.companyName], ["Country", lead.country], ["Emirate", label(lead.emirate)], ["CRM conversation", lead.agentConversationReference ? <Link to={`/agent?search=${encodeURIComponent(lead.agentConversationReference)}`}>{lead.agentConversationReference}</Link> : "—"]]} />
        <Details title="Contact" rows={[["Contact person", lead.contactPerson], ["Mobile", lead.mobileNumber], ["Email", lead.email], ["Preferred method", label(lead.preferredContactMethod)]]} />
        <Details title="Business Size" rows={[["Drivers", lead.approximateDriverCount], ["Monthly orders", lead.approximateMonthlyOrders]]} />
        <Details title="Requirements" rows={[["Challenges", lead.mainChallenges], ["Interested features", lead.featuresOfInterest.map(label).join(", ")]]} />
        <Details title="Marketing Attribution" rows={[["Source", lead.source], ["Landing page", lead.landingPage], ["Referrer", lead.referrer], ["UTM source", lead.utmSource], ["UTM medium", lead.utmMedium], ["UTM campaign", lead.utmCampaign], ["UTM term", lead.utmTerm], ["UTM content", lead.utmContent], ["Google click ID", lead.gclid]]} />
      </div>
      {session.can("platform.leads.manage") && <div className="lead-workflow"><h3>Workflow</h3><Field label="Reason (required when closing/rejecting)"><textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></Field><div className="lead-action-grid">{statuses.filter((item) => item !== "new" && item !== lead.status).map((item) => <button className="platform-button platform-button--quiet" disabled={busy} key={item} onClick={() => void transition(item)}>{label(item)}</button>)}</div><h3>Internal Notes</h3><Field label="Add an append-only note"><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></Field><button className="platform-button" disabled={busy || !note.trim()} onClick={() => void addNote()}>Add Note</button></div>}
      {error && <p role="alert">{error}</p>}
      <div className="lead-timeline"><h3>Timeline</h3>{lead.history.map((item, index) => <article key={String(item.id ?? index)}><span>{new Date(String(item.createdAt)).toLocaleString()}</span><strong>{label(String(item.toStatus))}</strong><p>{String(item.actorUsername ?? "System")}</p></article>)}{lead.internalNotes.map((item) => <article key={item.id}><span>{new Date(item.createdAt).toLocaleString()}</span><strong>Internal note · {item.authorUsername ?? "Unknown"}</strong><p>{item.noteText}</p></article>)}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="platform-field"><span>{label}</span>{children}</label>; }
function Details({ title, rows }: { title: string; rows: readonly (readonly [string, ReactNode])[] }) { return <article className="lead-detail-card"><h3>{title}</h3><dl>{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value === null || value === "" ? "—" : value}</dd></div>)}</dl></article>; }
