import { useState } from "react";
import type { ApiClient } from "../../api/api-client.js";
import type { OperationsOrder, OperationsOrderPage } from "../../api/contracts.js";

export function OrderMaintenanceWorkspace({ api }: { api: ApiClient }) {
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<OperationsOrderPage>();
  const [selectedId, setSelectedId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reversing, setReversing] = useState(false);
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
  const reverseSettlement = async (order: OperationsOrder) => {
    setMessage(undefined);
    const detail = await api.get<{
      readonly confirmableSettlementId?: string | null;
      readonly confirmableSettlementCount?: number;
    }>(`operations/orders/${order.id}`);
    if (!detail.confirmableSettlementId) {
      setMessage("No reversible confirmed Trader settlement was found for this order.");
      return;
    }
    const reason = window.prompt("Reason for reversing the Trader settlement:");
    if (!reason?.trim()) return;
    setReversing(true);
    try {
      const response = await api.post<{ readonly reversalSettlementNumber: string }>(
        `operations/settlements/payments/${detail.confirmableSettlementId}/reverse`,
        { reason: reason.trim() },
      );
      setMessage(`Settlement reversed: ${response.reversalSettlementNumber}`);
      await find();
    } finally { setReversing(false); }
  };
  const setDeliveredAndCollectFromTrader = async () => {
    if (!selectedId) return;
    if (!window.confirm("Set this order to Delivered and Collect from Trader?")) return;
    setMessage(undefined);
    setBusy(true);
    try {
      await api.patch<OperationsOrder>(`operations/orders/${selectedId}/status`, {
        status: "delivered",
        reason: "Approved order maintenance correction",
      });
      await api.patch<OperationsOrder>(`operations/orders/${selectedId}`, {
        paymentCondition: "customer_pays_cod_trader_pays_fee",
      });
      setMessage("Order set to Delivered and Collect from Trader.");
      await find();
    } finally { setBusy(false); }
  };
  return <main className="workspace configuration-workspace">
    <header className="workspace-header"><div><span className="eyebrow">Configuration</span><h1>Order Maintenance</h1><p>Repair approved order financial records without changing normal order data.</p></div></header>
    <section className="configuration-panel">
      <label>Search order number, serial number, or reference<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ORD-000007" /></label>
      <button className="button button-primary" type="button" onClick={() => void find()}>Find order</button>
      {result?.items.map((order) => <button className={`maintenance-order ${selectedId === order.id ? "selected" : ""}`} key={order.id} type="button" onClick={() => setSelectedId(order.id)}>{order.orderNumber} — serial {order.serialNumber ?? "-"} — {order.customerName} — AED {order.serviceFee}</button>)}
      {selectedId ? <div className="maintenance-actions">
        <button className="button button-secondary" disabled={busy || reversing} type="button" onClick={() => void repair()}>{busy ? "Working…" : "Repair Trader receivable"}</button>
        <button className="button button-danger" disabled={busy || reversing} type="button" onClick={() => {
          const order = result?.items.find((item) => item.id === selectedId);
          if (order) void reverseSettlement(order);
        }}>{reversing ? "Reversing…" : "Reverse Trader settlement"}</button>
        <button className="button button-secondary" disabled={busy || reversing} type="button" onClick={() => void setDeliveredAndCollectFromTrader()}>
          Set Delivered &amp; Collect from Trader
        </button>
      </div> : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  </main>;
}
