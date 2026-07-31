import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import {
  AccountingTable,
  DirectionalText,
  LoadPanel,
  SummaryCards,
  formatAed,
} from "./AccountingComponents.js";
import { AccountingApi } from "./accounting-api.js";
import type { AccountingRecord } from "./accounting-types.js";
import { useAccountingResource } from "./use-accounting-resource.js";

const reportKinds = [
  "trial-balance",
  "general-ledger",
  "account-statement",
  "profit-and-loss",
  "balance-sheet",
  "cash-movement",
  "general-expenses",
  "vat",
] as const;
type ReportKind = (typeof reportKinds)[number];

interface ReportEnvelope {
  readonly columns: readonly string[];
  readonly currency: "AED";
  readonly dataSource: string;
  readonly filters: Readonly<Record<string, string | undefined>>;
  readonly items: readonly AccountingRecord[];
  readonly page: number;
  readonly pageSize: number;
  readonly provisional: boolean;
  readonly snapshotAt: string;
  readonly title: string;
  readonly total: number;
  readonly totalPages: number;
  readonly totals: AccountingRecord;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  readonly warningCodes: readonly string[];
}

interface ReportFilters {
  readonly accountId: string;
  readonly asOfDate: string;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly includeZero: boolean;
  readonly page?: number;
}

function localDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function previewBlob(blob: Blob, print = false): void {
  const url = URL.createObjectURL(blob);
  const opened = globalThis.open(url, "_blank", "noopener,noreferrer");
  if (print && opened !== null) opened.addEventListener("load", () => opened.print(), { once: true });
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function reportPath(kind: string, filters: Readonly<Record<string, string | boolean | undefined>>): string {
  const query = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") query.set(key, String(value));
  });
  return `operations/accounting/reports/${kind}?${query.toString()}`;
}

export function AccountingReportsWorkspace({
  api,
  companyId,
  kind,
  onNavigate,
}: {
  readonly api: ApiClient;
  readonly companyId: string;
  readonly kind?: string;
  readonly onNavigate: (path: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const accounting = useMemo(() => new AccountingApi(api), [api]);
  const selected = reportKinds.includes(kind as ReportKind) ? kind as ReportKind : undefined;
  const readiness = useAccountingResource(
    `accounting-report-readiness:${companyId}`,
    (signal) => accounting.get<AccountingRecord>("reports/readiness", undefined, signal),
  );
  if (selected === undefined) {
    return (
      <section className="accounting-page accounting-report-overview">
        <header className="accounting-page-header">
          <div><h1>{t("accounting.reports.title")}</h1><p>{t("accounting.reports.subtitle")}</p></div>
        </header>
        <LoadPanel error={readiness.error} loading={readiness.loading} onRefresh={readiness.refresh}>
          {readiness.data === undefined ? null : (
            <>
              {(readiness.data.warnings as readonly string[] | undefined)?.map((warning) =>
                <div className="accounting-warning" key={warning}>{warning}</div>)}
              <SummaryCards items={[
                { label: t("accounting.reports.readiness.accounting"), value: readiness.data.accountingEnabled === true ? t("common.yes") : t("common.no") },
                { label: t("accounting.reports.readiness.posted"), value: readiness.data.hasPostedJournals === true ? t("common.yes") : t("common.no") },
                { label: t("accounting.reports.readiness.unclassified"), value: readiness.data.unclassifiedAccountCount },
              ]} />
            </>
          )}
        </LoadPanel>
        <div className="accounting-report-grid">
          {reportKinds.map((report) => (
            <button className="accounting-report-card" key={report}
              onClick={() => onNavigate(`/accounting/reports/${report}`)} type="button">
              <strong>{t(`accounting.reports.kinds.${report}`)}</strong>
              <span>{t(`accounting.reports.descriptions.${report}`)}</span>
            </button>
          ))}
        </div>
      </section>
    );
  }
  return (
    <ReportPage
      accounting={accounting}
      api={api}
      companyId={companyId}
      kind={selected}
      language={i18n.language.startsWith("ar") ? "ar" : "en"}
      onNavigate={onNavigate}
    />
  );
}

function ReportPage({
  accounting,
  api,
  companyId,
  kind,
  language,
  onNavigate,
}: {
  readonly accounting: AccountingApi;
  readonly api: ApiClient;
  readonly companyId: string;
  readonly kind: ReportKind;
  readonly language: "en" | "ar";
  readonly onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const today = localDate();
  const [draft, setDraft] = useState<ReportFilters>({ accountId: "", asOfDate: today, dateFrom: "", dateTo: today, includeZero: false });
  const [filters, setFilters] = useState<ReportFilters>();
  const [report, setReport] = useState<ReportEnvelope>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [binaryBusy, setBinaryBusy] = useState<string>();
  const accounts = useAccountingResource(
    `accounting-report-accounts:${companyId}`,
    (signal) => accounting.get<readonly AccountingRecord[]>("accounts", { activeOnly: false }, signal),
  );
  const needsAccount = kind === "general-ledger" || kind === "account-statement";

  useEffect(() => { setReport(undefined); setError(undefined); setFilters(undefined); }, [kind]);

  const apply = async (next = draft) => {
    if (needsAccount && next.accountId === "") {
      setError("accounting_report_account_required");
      return;
    }
    setLoading(true); setError(undefined); setFilters(next);
    try {
      setReport(await accounting.get<ReportEnvelope>(`reports/${kind}`, next));
    } catch (issue) {
      setError(issue instanceof ApiError ? issue.code : "request_failed");
    } finally {
      setLoading(false);
    }
  };

  const runBinary = async (format: "csv" | "xlsx" | "pdf" | "print") => {
    if (filters === undefined) return;
    setBinaryBusy(format); setError(undefined);
    try {
      const path = format === "pdf" || format === "print"
        ? reportPath(`${kind}/pdf`, { ...filters, language })
        : reportPath(`${kind}/export`, { ...filters, format });
      const blob = await api.getBinary(path);
      if (format === "pdf") previewBlob(blob);
      else if (format === "print") previewBlob(blob, true);
      else saveBlob(blob, `${kind}-${today}.${format}`);
    } catch (issue) {
      setError(issue instanceof ApiError ? issue.code : "request_failed");
    } finally {
      setBinaryBusy(undefined);
    }
  };

  const columns = report?.columns.map((key) => ({
    key,
    label: t(`accounting.reports.columns.${key}`, { defaultValue: key.replaceAll(/([A-Z])/g, " $1") }),
    money: /amount|debit|credit|balance|revenue|expense|profit|vat/i.test(key),
    technical: /code|number|reference|date/i.test(key),
  })) ?? [];
  const summary = report === undefined ? [] : Object.entries(report.totals).map(([key, value]) => ({
    label: t(`accounting.reports.columns.${key}`, { defaultValue: key.replaceAll(/([A-Z])/g, " $1") }),
    money: /amount|debit|credit|balance|revenue|expense|profit|earnings|difference|vat/i.test(key)
      && typeof value === "string",
    value,
  }));
  return (
    <section className="accounting-page accounting-report-page">
      <header className="accounting-page-header">
        <div><button className="button button-link" onClick={() => onNavigate("/accounting/reports")} type="button">← {t("common.back")}</button>
          <h1>{t(`accounting.reports.kinds.${kind}`)}</h1>
          <p>{t("accounting.reports.postedOnly")}</p>
        </div>
      </header>
      <div className="accounting-report-filters">
        {needsAccount ? <label><span>{t("accounting.fields.account")}</span><select value={draft.accountId}
          onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}>
          <option value="">{t("common.select")}</option>
          {accounts.data?.filter((account) => account.isPostingAccount === true).map((account) => <option key={String(account.id)} value={String(account.id)}>
            {String(account.code)} — {String(language === "ar" ? account.nameAr ?? account.nameEn : account.nameEn)}
          </option>)}
        </select></label> : null}
        {kind === "balance-sheet" ? <label><span>{t("accounting.reports.asOf")}</span><input type="date" value={draft.asOfDate}
          onChange={(event) => setDraft({ ...draft, asOfDate: event.target.value })} /></label> : <>
          <label><span>{t("accounting.fields.dateFrom")}</span><input type="date" value={draft.dateFrom}
            onChange={(event) => setDraft({ ...draft, dateFrom: event.target.value })} /></label>
          <label><span>{t("accounting.fields.dateTo")}</span><input type="date" value={draft.dateTo}
            onChange={(event) => setDraft({ ...draft, dateTo: event.target.value })} /></label>
        </>}
        {kind === "trial-balance" ? <label className="accounting-check"><input checked={draft.includeZero} type="checkbox"
          onChange={(event) => setDraft({ ...draft, includeZero: event.target.checked })} />{t("accounting.reports.includeZero")}</label> : null}
        <button className="button button-primary" disabled={loading} onClick={() => void apply()} type="button">{t("common.apply")}</button>
      </div>
      {error === undefined ? null : <div className="form-error" role="alert">
        {t(`accounting.errors.codes.${error}`, { defaultValue: t("accounting.errors.safe") })}
      </div>}
      {report === undefined ? <div className="accounting-empty">{loading ? t("common.loading") : t("accounting.reports.applyPrompt")}</div> : <>
        <div className="accounting-report-toolbar">
          <span>{t("accounting.reports.snapshot")}: <DirectionalText>{report.snapshotAt}</DirectionalText></span>
          <span>{t("accounting.reports.rows", { count: report.total })}</span>
          {(["csv","xlsx","pdf","print"] as const).map((format) =>
            <button className="button button-secondary" disabled={binaryBusy !== undefined} key={format}
              onClick={() => void runBinary(format)} type="button">{t(`accounting.reports.actions.${format}`)}</button>)}
        </div>
        {report.provisional ? <div className="accounting-warning">{t("accounting.reports.provisional")}</div> : null}
        {(report.warningCodes.length > 0 ? report.warningCodes : report.warnings).map((warning) =>
          <div className="accounting-warning" key={warning}>
            {report.warningCodes.length > 0
              ? t(`accounting.reports.warnings.${warning}`, { defaultValue: warning })
              : warning}
          </div>)}
        {summary.length === 0 ? null : <SummaryCards items={summary} />}
        <AccountingTable columns={columns} empty={t("accounting.reports.noActivity")} items={report.items}
          onOpen={(row) => typeof row.journalId === "string" ? onNavigate(`/accounting/journals/${row.journalId}`) : undefined} />
        {report.totalPages > 1 ? <div className="accounting-pagination">
          <button disabled={report.page <= 1} onClick={() => void apply({ ...filters!, page: report.page - 1 })} type="button">{t("common.previous")}</button>
          <span>{report.page} / {report.totalPages}</span>
          <button disabled={report.page >= report.totalPages} onClick={() => void apply({ ...filters!, page: report.page + 1 })} type="button">{t("common.next")}</button>
        </div> : null}
        {kind === "vat" ? <div className="accounting-warning">{t("accounting.reports.vatDisclaimer")}</div> : null}
      </>}
    </section>
  );
}
