import { useState } from "react";
import type { ApiClient } from "../../api/api-client.js";
import type { OperationsOrderPage } from "../../api/contracts.js";

export function OrderMaintenanceWorkspace({ api }: { api: ApiClient }) {
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<OperationsOrderPage>();
  const [selectedId, setSelectedId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const find = async () => {
    setMessage(undefined);
    setResult(await api.get<OperationsOrderPage>(`operations/orders?page=1&pageSize=25&quickView=all&search=${encodeURIComponent(search)}`));
  };
  const repair = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const response = await api.post<{ created: boolean; amount: string }>(`operations/orders/${selectedId}/repair-trader-receivable`, {});
      setMessage(response.created ? `Trader receivable created: AED ${response.amount}` : "No repair was needed.");
      await find();
    } finally { setBusy(false); }
  };
  return <main className="workspace configuration-workspace">
    <header className="workspace-header"><div><span className="eyebrow">Configuration</span><h1>Order Maintenance</h1><p>Repair approved order financial records without changing normal order data.</p></div></header>
    <section className="configuration-panel">
      <label>Search order number, serial number, or reference<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ORD-000007" /></label>
      <button className="button button-primary" type="button" onClick={() => void find()}>Find order</button>
      {result?.items.map((order) => <button className={`maintenance-order ${selectedId === order.id ? "selected" : ""}`} key={order.id} type="button" onClick={() => setSelectedId(order.id)}>{order.orderNumber} — {order.customerName} — AED {order.serviceFee}</button>)}
      {selectedId ? <button className="button button-secondary" disabled={busy} type="button" onClick={() => void repair()}>{busy ? "Working…" : "Repair Trader receivable"}</button> : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  </main>;
}
