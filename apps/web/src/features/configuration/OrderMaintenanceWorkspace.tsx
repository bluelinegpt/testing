import { useState } from "react";
import { ApiError, type ApiClient } from "../../api/api-client.js";
import type { OperationsOrder, OperationsOrderPage } from "../../api/contracts.js";

/**
 * Order Maintenance -- repairs an Order's financial records without touching
 * normal Order data.
 *
 * Two actions were removed from this screen on 2 Oct 2026 and must not come
 * back in the shape they had:
 *
 *   - "Reverse Trader settlement" showed a Receivable-scoped dialog naming one
 *     Order and one amount, then POSTed to
 *     `operations/settlements/payments/{settlementId}/reverse`. That mutation
 *     takes no Receivable id and is scoped to the whole Settlement, so on
 *     `SET-000007` it would have unwound AED 108.00 across six offsets and the
 *     payment to the Trader while the dialog said AED 18.00. There is no
 *     receivable-scoped reversal operation to call instead -- see
 *     `receivable-offset-reversal-guard.ts` for why one cannot simply be
 *     written. The preview is kept, read-only, because knowing which
 *     Settlement cleared a Receivable is genuinely useful.
 *
 *   - "Set Delivered & Collect from Trader" PATCHed the delivery status and
 *     then PATCHed the payment condition (which can itself raise a Receivable)
 *     behind a single confirm, in two separate requests with no transaction. A
 *     failure after the first left the Order delivered under the old
 *     condition. Delivery status belongs to the Orders workflow, which records
 *     who changed it and why.
 */
export function OrderMaintenanceWorkspace({ api }: { api: ApiClient }) {
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<OperationsOrderPage>();
  const [selectedId, setSelectedId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [offsetInfo, setOffsetInfo] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [verification, setVerification] = useState<{
    classification: string; reason: string; order: Record<string, string | null>;
    traderOwes: string; receivables: Record<string, string | null>[];
    physicalCollectionAmount: string; settlementOffsetAmount: string;
    settlementNumbers: string[]; journals: Record<string, string | null>[];
    recommendedAction: string;
  }>();
  const reset = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const preview = await api.get<{ action: string; receivableNumber: string; amount: string; physicalDeletePossible: boolean }>(`operations/orders/${selectedId}/trader-receivable-reset-preview`);
      const action = preview.action === "physical_delete" ? "Physical Delete" : "Financial Reset / Archive";
      if (!window.confirm(`${action}: ${preview.receivableNumber} — AED ${preview.amount}. Continue?`)) return;
      const reason = window.prompt("Reason (required):")?.trim();
      if (!reason) { setMessage("A reason is required."); return; }
      await api.post(`operations/orders/${selectedId}/reset-trader-receivable`, { reason });
      setMessage(`${action} completed for ${preview.receivableNumber}.`);
      await find();
      await verify(selectedId);
    } catch (error) { showError(error, "Trader receivable reset failed."); }
    finally { setBusy(false); }
  };
  const showError = (error: unknown, fallback: string) => {
    setMessage(error instanceof ApiError ? `${error.message} (${error.code})` : fallback);
  };
  const find = async () => {
    setMessage(undefined);
    setOffsetInfo(undefined);
    setResult(await api.get<OperationsOrderPage>(`operations/orders?page=1&pageSize=25&quickView=all&search=${encodeURIComponent(search)}`));
  };
  const repair = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const response = await api.post<{ created: boolean; amount: string }>(`operations/orders/${selectedId}/repair-trader-receivable`, {});
      setMessage(response.created ? `Trader receivable created: AED ${response.amount}` : "No repair was needed.");
      await find();
      await verify(selectedId);
    } finally { setBusy(false); }
  };
  const verify = async (orderId: string) => {
    try {
      setVerification(await api.get(`operations/orders/${orderId}/financial-verification`));
    } catch (error) { showError(error, "Financial verification failed."); }
  };
  /**
   * Read-only. Reports how the Receivable was settled and, when it was settled
   * by a Settlement offset, why that cannot be reversed from here. Issues one
   * GET and no mutation of any kind.
   */
  const inspectOffset = async (order: OperationsOrder) => {
    setMessage(undefined);
    setOffsetInfo(undefined);
    if (!order.traderReceivableId) {
      setMessage("No Trader receivable is linked to this order.");
      return;
    }
    setInspecting(true);
    try {
      const preview = await api.get<{
        readonly orderNumber: string;
        readonly orderStatus: string;
        readonly receivableNumber: string;
        readonly offsetAmount: string;
        readonly settlementNumber: string;
        readonly physicalCollectionCount: number;
        readonly settlementOffsetCount: number;
        readonly executionAvailable: boolean;
        readonly blockedReason: string | null;
      }>(`operations/trader-receivables/${encodeURIComponent(order.traderReceivableId)}/reversal-preview`);
      const settledBy = preview.physicalCollectionCount > 0
        ? `physical collection (${preview.physicalCollectionCount})`
        : "settlement offset";
      setOffsetInfo(
        `${preview.receivableNumber} — AED ${preview.offsetAmount} — settled by ${settledBy} in ${preview.settlementNumber}, ` +
        `which carries ${preview.settlementOffsetCount} receivable offset(s). ` +
        `Order ${preview.orderNumber} is ${preview.orderStatus}. ` +
        (preview.executionAvailable
          ? "It can be reversed from the Trader Receivable's detail (Reverse Trader Receivable)."
          : `Reversal unavailable: ${preview.blockedReason ?? ""}`),
      );
    } catch (error) {
      showError(error, "The Trader receivable settlement could not be read.");
    } finally { setInspecting(false); }
  };
  return <main className="workspace configuration-workspace">
    <header className="workspace-header"><div><span className="eyebrow">Configuration</span><h1>Order Maintenance</h1><p>Repair approved order financial records without changing normal order data.</p></div></header>
    <section className="configuration-panel">
      <label>Search order number, serial number, or reference<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ORD-000007" /></label>
      <button className="button button-primary" type="button" onClick={() => void find()}>Find order</button>
      {result?.items.map((order) => <button className={`maintenance-order ${selectedId === order.id ? "selected" : ""}`} key={order.id} type="button" onClick={() => { setSelectedId(order.id); void verify(order.id); }}>{order.orderNumber} — serial {order.serialNumber ?? "-"} — {order.customerName} — AED {order.serviceFee}</button>)}
      {verification ? <section className="configuration-panel" aria-label="Financial Verification">
        <h2>Financial Verification</h2>
        <p><strong>{verification.classification}</strong></p>
        <p>{verification.reason}</p>
        <p>Order: {verification.order.orderNumber} ({verification.order.orderId}) — Serial: {verification.order.serialNumber ?? "-"}</p>
        <p>Trader: {verification.order.trader ?? "-"} — Delivery: {verification.order.deliveryStatus}</p>
        <p>Trader owes: AED {verification.traderOwes}</p>
        {verification.receivables.map((r) => <p key={r.id}>Receivable {r.receivableNumber}: AED {r.amount}, status {r.status}, outstanding AED {r.outstanding}</p>)}
        <p>Physical collections: AED {verification.physicalCollectionAmount}</p>
        <p>Settlement offsets: AED {verification.settlementOffsetAmount} ({verification.settlementNumbers.join(", ") || "none"})</p>
        <p>Journals: {verification.journals.map((j) => j.journalNumber ?? "none").join(", ") || "none"}</p>
        <p>Recommended action: {verification.recommendedAction}</p>
      </section> : null}
      {selectedId ? <div className="maintenance-actions">
        <button className="button button-secondary" disabled={busy || inspecting || !verification || !["repair", "reset_then_repair"].includes(verification.recommendedAction)} type="button" onClick={() => void repair()}>{busy ? "Working…" : "Repair Trader receivable"}</button>
        <button className="button button-danger" disabled={busy || inspecting || !verification || verification.recommendedAction !== "reset_then_repair"} type="button" onClick={() => void reset()}>{busy ? "Working…" : "Delete / Reset Trader receivable"}</button>
        <button className="button button-secondary" disabled={busy || inspecting} type="button" onClick={() => {
          const order = result?.items.find((item) => item.id === selectedId);
          if (order) void inspectOffset(order);
        }}>{inspecting ? "Reading…" : "How was the Trader fee settled?"}</button>
      </div> : null}
      {offsetInfo ? <p role="status">{offsetInfo}</p> : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  </main>;
}
