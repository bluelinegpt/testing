import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient } from "../../api/api-client.js";
import { ApiError } from "../../api/api-client.js";
import type { OperationsTrader } from "../../api/contracts.js";
import { normalizeLocale } from "../../localization/locale.js";

const statuses = ["new", "in_branch", "assigned_to_driver", "out_for_delivery", "hold", "delivered", "returned_to_branch", "returned_to_trader", "cancelled", "closed", "collect_order"] as const;
type Row = { orderNumber:string; date:string; traderName:string; customer:string; customerMobile:string; emirates:string; area:string; cod:string; fee:string; status:string };
type Page = { items: Row[]; page: number; pageSize: number; totalCount: number };

export function OrdersReport({ api }: { api: ApiClient }) {
  const { t, i18n } = useTranslation();
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [trader, setTrader] = useState("");
  const [selected, setSelected] = useState<string[]>([]); const [page, setPage] = useState(1); const [data, setData] = useState<Page>();
  const [traders, setTraders] = useState<readonly OperationsTrader[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(false); const [exporting, setExporting] = useState(false); const [exportError, setExportError] = useState<string | null>(null);
  const query = useMemo(() => { const p = new URLSearchParams(); if (from) p.set("dateFrom", from); if (to) p.set("dateTo", to); if (trader) p.set("traderId", trader); if (selected.length) p.set("statuses", selected.join(",")); p.set("page", String(page)); p.set("pageSize", "25"); return p.toString(); }, [from,to,trader,selected,page]);
  useEffect(() => { void api.get<readonly OperationsTrader[]>("operations/traders").then(setTraders).catch(() => setError(true)); }, [api]);
  useEffect(() => { setLoading(true); setError(false); void api.get<Page>(`operations/reports/orders?${query}`).then(setData).catch(() => setError(true)).finally(() => setLoading(false)); }, [api, query]);
  const exportFile = async (format: "xlsx" | "pdf") => { if (exporting) return; setExporting(true); setExportError(null); try { const p = new URLSearchParams(query); p.delete("page"); p.delete("pageSize"); if (format === "pdf") p.set("language", normalizeLocale(i18n.resolvedLanguage)); const blob = await api.getBinary(`operations/reports/orders.${format}?${p}`); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href=url; a.download=`orders-report.${format}`; a.click(); URL.revokeObjectURL(url); } catch (error) { const detail = error instanceof ApiError && error.correlationId ? ` (${error.correlationId})` : ""; setExportError(`${error instanceof Error ? error.message : t("reports.orders.exportFailed")}${detail}`); } finally { setExporting(false); } };
  const toggle = (status: string) => setSelected((current) => current.includes(status) ? current.filter((v) => v !== status) : [...current, status]);
  const pages = Math.max(1, Math.ceil((data?.totalCount ?? 0) / 25));
  return <section className="reports-panel" aria-label={t("reports.orders.title")}>
    <div className="report-actions"><div><h2>{t("reports.orders.title")}</h2><p>{t("reports.orders.subtitle")}</p></div><div className="report-export-actions"><button className="button button-primary" disabled={exporting} onClick={() => void exportFile("xlsx")} type="button">{t("reports.orders.export")}</button><button className="button" disabled={exporting} onClick={() => void exportFile("pdf")} type="button">{t("reports.orders.exportPdf")}</button></div></div>
    {exportError ? <div className="alert alert-error" role="alert">{exportError}</div> : null}
    <div className="orders-report-filters"><label>{t("reports.orders.from")}<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></label><label>{t("reports.orders.to")}<input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></label><label>{t("reports.orders.trader")}<select value={trader} onChange={(e) => { setTrader(e.target.value); setPage(1); }}><option value="">{t("reports.orders.allTraders")}</option>{traders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    <fieldset className="orders-report-statuses"><legend>{t("reports.orders.status")}</legend><label><input type="checkbox" checked={selected.length === statuses.length} onChange={() => setSelected(selected.length === statuses.length ? [] : [...statuses])} />{t("reports.orders.allStatuses")}</label>{statuses.map((status) => <label key={status}><input type="checkbox" checked={selected.includes(status)} onChange={() => toggle(status)} />{t(`statuses.${status}`)}</label>)}</fieldset>
    {error ? <div className="alert alert-error" role="alert">{t("common.loadFailed")}</div> : null}{loading ? <div className="loading-row">{t("common.loading")}</div> : null}
    {!loading && !error && (data?.items.length ?? 0) === 0 ? <div className="empty-state">{t("reports.orders.empty")}</div> : null}
    {(data?.items.length ?? 0) > 0 ? <><p>{t("reports.orders.total", { count: data?.totalCount ?? 0 })}</p><div className="table-scroll"><table><thead><tr>{["orderNumber","date","traderName","customer","customerMobile","emirates","area","cod","fee","status"].map((key) => <th key={key}>{t(`reports.orders.columns.${key}`)}</th>)}</tr></thead><tbody>{data?.items.map((row) => <tr key={`${row.orderNumber}-${row.date}`}><td>{row.orderNumber}</td><td>{row.date}</td><td>{row.traderName}</td><td>{row.customer}</td><td>{row.customerMobile}</td><td>{row.emirates}</td><td>{row.area}</td><td>{row.cod}</td><td>{row.fee}</td><td>{t(`statuses.${row.status}`)}</td></tr>)}</tbody></table></div><div className="pagination"><button disabled={page<=1} onClick={() => setPage(page-1)} type="button">{t("common.previous")}</button><span>{page} / {pages}</span><button disabled={page>=pages} onClick={() => setPage(page+1)} type="button">{t("common.next")}</button></div></> : null}
  </section>;
}
