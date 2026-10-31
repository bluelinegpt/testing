import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { OperationsTrader } from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { PageHeader } from "../../components/PageHeader.js";
import { formatCurrency } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { OneScreenSettlementDialog, UnpostSettlementDialog } from "./OneScreenSettlementDialog.js";
import { type PdfAction, useReconciliationPdfActions } from "./reconciliation-pdf.js";
import { TraderAccountStatementDialog } from "./TraderSettlementsWorkspace.js";

export interface TraderAccountRow {
  readonly traderId: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly isActive: boolean;
  /** Signed: positive = the Company owes the Trader; negative = the Trader owes. */
  readonly balance: string;
  readonly openReceivables: string;
  readonly ordersWaiting: number;
  readonly awaitingDriverCash: number;
  readonly lastPaymentDate: string | null;
  readonly lastPaymentNumber: string | null;
  readonly lastPaymentAmount: string | null;
  readonly paidInPeriod?: string;
  readonly collectedInPeriod?: string;
}

export interface TraderReferenceLookupRow {
  readonly requested: string;
  readonly found: boolean;
  readonly orderNumber: string | null;
  readonly referenceNumber: string | null;
  readonly traderId: string | null;
  readonly traderCode: string | null;
  readonly traderNameEn: string | null;
  readonly traderNameAr: string | null;
  readonly orderDate: string | null;
  readonly deliveryDate: string | null;
  readonly deliveryStatus: string | null;
  readonly traderAmount: string | null;
  readonly traderOutstanding: string | null;
  readonly settledIn: readonly string[];
  readonly feeNumbers: readonly string[];
}

interface TraderAccountList {
  readonly items: readonly TraderAccountRow[];
  readonly totals: { readonly owedToTraders: string; readonly owedByTraders: string };
}

export interface TraderAccountDocument {
  readonly kind: "settlement" | "zero_invoice" | "collection";
  readonly id: string;
  readonly number: string;
  readonly date: string;
  readonly amount: string;
  readonly orderCount: number;
  readonly reversed: boolean;
  readonly draftId: string | null;
}

function failure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

/**
 * Trader Account / حساب التاجر (Aiman, 31 Oct 2026). One screen for a
 * Trader's money: what we owe him or he owes us, his statement, his documents
 * (SET / INV / COL) and "Settle now", which opens the one-screen settlement
 * that nets both directions. Replaces Trader Settlements + Trader Receivables
 * + Collections for everyday users; those stay under "Advanced (Accountant)".
 */
export function TraderAccountWorkspace({
  api,
  onNavigate,
  permissions,
}: {
  api: ApiClient;
  onNavigate: (target: string) => void;
  permissions: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage ?? i18n.language);
  const reportLanguage = locale;
  const isAdministrator = permissions.includes("users_roles.manage");
  const canSettle = isAdministrator || permissions.includes("settlements.create");
  const canReverse = isAdministrator || permissions.includes("settlements.reverse");

  const [search, setSearch] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  // Filters as on the settlement screens (Aiman, 31 Oct 2026): Trader,
  // date range, and the reference lookup.
  const [traderFilter, setTraderFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [traders, setTraders] = useState<readonly OperationsTrader[]>([]);
  const [references, setReferences] = useState("");
  const [lookup, setLookup] = useState<readonly TraderReferenceLookupRow[]>();
  const [lookupBusy, setLookupBusy] = useState(false);
  // Traders the settlement has something for -- to pay, fees to collect or
  // 0.00 Orders to invoice. "Settle" shows only for them (Aiman, 31 Oct
  // 2026: a settled Trader's button only confused users).
  const [settleable, setSettleable] = useState<ReadonlySet<string>>(new Set());
  const hasPeriod = from !== "" || to !== "";
  const [list, setList] = useState<TraderAccountList>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [reload, setReload] = useState(0);
  const [statementFor, setStatementFor] = useState<string>();
  const [documentsFor, setDocumentsFor] = useState<TraderAccountRow>();
  const [settle, setSettle] = useState<{ traderId?: string; draftId?: string }>();

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    if (search.trim() !== "") params.set("search", search.trim());
    if (openOnly && !hasPeriod) params.set("openOnly", "true");
    if (traderFilter !== "") params.set("traderId", traderFilter);
    if (from !== "") params.set("from", from);
    if (to !== "") params.set("to", to);
    const timer = window.setTimeout(() => {
      void api
        .get<TraderAccountList>(`operations/trader-accounts?${params.toString()}`)
        .then((result) => {
          if (!active) return;
          setList(result);
          setError(undefined);
        })
        .catch((requestError: unknown) => {
          if (active) setError(failure(requestError, t("traderAccount.loadFailed")));
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, from, hasPeriod, openOnly, reload, search, t, to, traderFilter]);

  useEffect(() => {
    if (!canSettle) return;
    let active = true;
    void Promise.resolve(
      api.get<readonly { readonly traderId: string }[]>("operations/settlements/payments/open-traders"),
    )
      .then((rows) => {
        if (active) setSettleable(new Set((Array.isArray(rows) ? rows : []).map((row) => row.traderId)));
      })
      .catch(() => {
        if (active) setSettleable(new Set());
      });
    return () => {
      active = false;
    };
  }, [api, canSettle, reload]);

  useEffect(() => {
    void Promise.resolve(api.get<readonly OperationsTrader[]>("operations/traders"))
      .then((result) => setTraders(Array.isArray(result) ? result : []))
      .catch(() => setTraders([]));
  }, [api]);

  const findReferences = async () => {
    if (references.trim() === "") {
      setLookup(undefined);
      return;
    }
    setLookupBusy(true);
    try {
      setLookup(
        await api.get<readonly TraderReferenceLookupRow[]>(
          `operations/trader-accounts/lookup?${new URLSearchParams({ references }).toString()}`,
        ),
      );
      setError(undefined);
    } catch (requestError) {
      setError(failure(requestError, t("traderAccount.lookupFailed")));
    } finally {
      setLookupBusy(false);
    }
  };

  const refresh = () => setReload((value) => value + 1);
  const money = (value: string) => formatCurrency(Math.abs(Number(value)).toFixed(2), "AED", locale);
  const name = (row: TraderAccountRow) => (locale === "ar" ? (row.nameAr ?? row.nameEn) : row.nameEn);

  return (
    <>
      <PageHeader
        actions={
          <>
            {canSettle ? (
              <button className="button button-primary" onClick={() => setSettle({})} type="button">
                {t("traderAccount.settleNow")}
              </button>
            ) : null}
            <button className="button button-secondary" onClick={refresh} type="button">
              {t("common.refresh")}
            </button>
          </>
        }
        description={t("traderAccount.subtitle")}
        title={t("traderAccount.title")}
      />
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {notice === undefined ? null : (
        <div className="alert alert-info" role="status">
          {notice}
        </div>
      )}
      {list === undefined ? null : (
        <div className="summary-primary">
          <article className="kpi-card">
            <span>{t("traderAccount.owedToTraders")}</span>
            <strong>{money(list.totals.owedToTraders)}</strong>
            <small>{t("traderAccount.owedToTradersHint")}</small>
          </article>
          <article className="kpi-card">
            <span>{t("traderAccount.owedByTraders")}</span>
            <strong>{money(list.totals.owedByTraders)}</strong>
            <small>{t("traderAccount.owedByTradersHint")}</small>
          </article>
        </div>
      )}
      <div className="compact-filters">
        <label className="field">
          <span>{t("traderAccount.search")}</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("traderAccount.searchPlaceholder")}
            type="search"
            value={search}
          />
        </label>
        <label className="field">
          <span>{t("traderAccount.trader")}</span>
          <select onChange={(event) => setTraderFilter(event.target.value)} value={traderFilter}>
            <option value="">{t("traderAccount.allTraders")}</option>
            {traders.map((trader) => (
              <option key={trader.id} value={trader.id}>
                {trader.name} ({trader.code})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("traderAccount.dateFrom")}</span>
          <input onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </label>
        <label className="field">
          <span>{t("traderAccount.dateTo")}</span>
          <input onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </label>
        <label className="checkbox-field">
          <input
            checked={openOnly && !hasPeriod}
            disabled={hasPeriod}
            onChange={(event) => setOpenOnly(event.target.checked)}
            type="checkbox"
          />
          <span>{t("traderAccount.openOnly")}</span>
        </label>
        {traderFilter !== "" || from !== "" || to !== "" || search !== "" ? (
          <button
            onClick={() => {
              setTraderFilter("");
              setFrom("");
              setTo("");
              setSearch("");
            }}
            type="button"
          >
            {t("traderAccount.clearFilters")}
          </button>
        ) : null}
      </div>
      {hasPeriod ? <p className="field-hint">{t("traderAccount.periodHint")}</p> : null}
      <section aria-labelledby="trader-account-lookup-heading" className="card trader-account-lookup">
        <h3 id="trader-account-lookup-heading">{t("traderAccount.lookupTitle")}</h3>
        <p className="field-hint">{t("traderAccount.lookupHint")}</p>
        <div className="compact-filters">
          <label className="field trader-account-lookup-input">
            <span>{t("traderAccount.references")}</span>
            <textarea
              onChange={(event) => setReferences(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void findReferences();
              }}
              placeholder="4265, 4283"
              rows={2}
              value={references}
            />
          </label>
          <button
            className="button button-primary"
            disabled={lookupBusy}
            onClick={() => void findReferences()}
            type="button"
          >
            {lookupBusy ? t("common.loading") : t("traderAccount.find")}
          </button>
          {lookup === undefined ? null : (
            <button
              onClick={() => {
                setLookup(undefined);
                setReferences("");
              }}
              type="button"
            >
              {t("traderAccount.clearLookup")}
            </button>
          )}
        </div>
        {lookup === undefined ? null : (
          <div className="table-scroll-x">
            <table data-testid="trader-account-lookup">
              <thead>
                <tr>
                  <th>{t("traderAccount.reference")}</th>
                  <th>{t("traderAccount.trader")}</th>
                  <th>{t("traderAccount.delivered")}</th>
                  <th>{t("traderAccount.orderStatus")}</th>
                  <th>{t("traderAccount.dueToTrader")}</th>
                  <th>{t("traderAccount.settledIn")}</th>
                </tr>
              </thead>
              <tbody>
                {lookup.map((row, index) => (
                  <tr key={`${row.requested}-${row.orderNumber ?? index}`}>
                    <td>
                      <bdi>{row.referenceNumber ?? row.requested}</bdi>
                      {row.orderNumber === null ? null : <div className="field-hint">{row.orderNumber}</div>}
                    </td>
                    {!row.found ? (
                      <td colSpan={5}>{t("traderAccount.notFound")}</td>
                    ) : (
                      <>
                        <td>
                          {locale === "ar" ? (row.traderNameAr ?? row.traderNameEn) : row.traderNameEn}
                          <div className="field-hint">{row.traderCode}</div>
                        </td>
                        <td>
                          <bdi>{row.deliveryDate ?? "—"}</bdi>
                        </td>
                        <td>{t(`statuses.${row.deliveryStatus ?? ""}`, row.deliveryStatus ?? "")}</td>
                        <td>{row.traderAmount ?? "—"}</td>
                        <td>
                          {row.settledIn.length > 0 ? (
                            row.settledIn.map((entry) => (
                              <div key={entry}>
                                <bdi>{entry}</bdi>
                              </div>
                            ))
                          ) : row.deliveryDate === null ? (
                            <span className="field-hint">{t("traderAccount.notDeliveredYet")}</span>
                          ) : (
                            <strong className="amount-negative">{t("traderAccount.notSettledYet")}</strong>
                          )}
                          {row.feeNumbers.map((fee) => (
                            <div className="field-hint" key={fee}>
                              {t("traderAccount.fee")}: <bdi>{fee}</bdi>
                            </div>
                          ))}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {list === undefined ? (
        error === undefined ? (
          <div className="loading-row">{t("common.loading")}</div>
        ) : null
      ) : list.items.length === 0 ? (
        <p className="field-hint">{t("traderAccount.empty")}</p>
      ) : (
        <div className="table-scroll-x">
          <table className="trader-account-table">
            <thead>
              <tr>
                <th>{t("traderAccount.trader")}</th>
                <th>{t("traderAccount.balance")}</th>
                <th>{t("traderAccount.openFees")}</th>
                <th>{t("traderAccount.ordersWaiting")}</th>
                <th>{t("traderAccount.awaitingDriverCash")}</th>
                <th>{t("traderAccount.lastPayment")}</th>
                {hasPeriod ? <th>{t("traderAccount.paidInPeriod")}</th> : null}
                {hasPeriod ? <th>{t("traderAccount.collectedInPeriod")}</th> : null}
                <th>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((row) => {
                const balance = Number(row.balance);
                return (
                  <tr key={row.traderId}>
                    <td>
                      <strong>{name(row)}</strong>
                      <div className="field-hint">{row.code}</div>
                    </td>
                    <td data-testid={`trader-account-balance-${row.code}`}>
                      {balance === 0 ? (
                        <span className="field-hint">{t("traderAccount.settled")}</span>
                      ) : (
                        <>
                          <strong className={balance < 0 ? "amount-negative" : "amount-positive"}>
                            {money(row.balance)}
                          </strong>
                          <div className="field-hint">
                            {balance > 0 ? t("traderAccount.weOweTrader") : t("traderAccount.traderOwesUs")}
                          </div>
                        </>
                      )}
                    </td>
                    <td>{Number(row.openReceivables) === 0 ? "—" : money(row.openReceivables)}</td>
                    <td>{row.ordersWaiting}</td>
                    <td>{row.awaitingDriverCash}</td>
                    <td>
                      {row.lastPaymentNumber === null ? (
                        "—"
                      ) : (
                        <>
                          <bdi>{row.lastPaymentDate}</bdi>
                          <div className="field-hint">
                            {row.lastPaymentNumber} · {money(row.lastPaymentAmount ?? "0")}
                          </div>
                        </>
                      )}
                    </td>
                    {hasPeriod ? <td>{money(row.paidInPeriod ?? "0")}</td> : null}
                    {hasPeriod ? <td>{money(row.collectedInPeriod ?? "0")}</td> : null}
                    <td>
                      <div className="row-actions">
                        <button onClick={() => setStatementFor(row.traderId)} type="button">
                          {t("traderAccount.statement")}
                        </button>
                        <button onClick={() => setDocumentsFor(row)} type="button">
                          {t("traderAccount.documents")}
                        </button>
                        {canSettle && settleable.has(row.traderId) ? (
                          <button
                            className="button button-primary"
                            onClick={() => setSettle({ traderId: row.traderId })}
                            type="button"
                          >
                            {t("traderAccount.settle")}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {statementFor === undefined ? null : (
        <TraderAccountStatementDialog
          api={api}
          autoLoad
          initialFrom={from}
          initialTo={to}
          initialTraderId={statementFor}
          onClose={() => setStatementFor(undefined)}
          reportLanguage={reportLanguage}
        />
      )}
      {documentsFor === undefined ? null : (
        <TraderDocumentsDialog
          api={api}
          canReverse={canReverse}
          onClose={() => setDocumentsFor(undefined)}
          onNavigate={onNavigate}
          from={from}
          to={to}
          onUnposted={(result) => {
            setDocumentsFor(undefined);
            setNotice(result.notice);
            refresh();
            setSettle({ draftId: result.draftId });
          }}
          reportLanguage={reportLanguage}
          trader={documentsFor}
          traderName={name(documentsFor)}
        />
      )}
      {settle === undefined ? null : (
        <OneScreenSettlementDialog
          api={api}
          draftId={settle.draftId}
          initialTraderId={settle.traderId}
          onClose={() => {
            setSettle(undefined);
            refresh();
          }}
          onDraftSaved={(traderName) => {
            setSettle(undefined);
            setNotice(t("traderAccount.draftSaved", { trader: traderName }));
            refresh();
          }}
          onPosted={(result) => {
            setSettle(undefined);
            setNotice(result.notice ?? t("traderAccount.posted"));
            refresh();
          }}
          reportLanguage={reportLanguage}
        />
      )}
    </>
  );
}

function documentPdfPath(document: TraderAccountDocument, language: "ar" | "en"): string | null {
  switch (document.kind) {
    case "settlement":
      return `operations/settlements/payments/${document.id}/pdf?language=${language}`;
    case "collection":
      return `operations/trader-receivables/collections/${document.id}/pdf?language=${language}`;
    case "zero_invoice":
      return document.draftId === null
        ? null
        : `operations/settlements/drafts/${document.draftId}/pdf?language=${language}`;
  }
}

function documentDetailPath(document: TraderAccountDocument): string | null {
  switch (document.kind) {
    case "settlement":
      return `/trader-settlements/${document.id}`;
    case "collection":
      return `/trader-receivables/collections/${document.id}`;
    case "zero_invoice":
      return null;
  }
}

/** Un-post & adjust: a Settlement reverses itself; a posted collection or 0.00 invoice through its draft. */
function documentUnpostPath(document: TraderAccountDocument): string | null {
  if (document.reversed) return null;
  if (document.kind === "settlement") return `operations/settlements/payments/${document.id}/unpost`;
  return document.draftId === null ? null : `operations/settlements/drafts/${document.draftId}/unpost`;
}

function TraderDocumentsDialog({
  api,
  canReverse,
  from,
  to,
  onClose,
  onNavigate,
  onUnposted,
  reportLanguage,
  trader,
  traderName,
}: {
  api: ApiClient;
  canReverse: boolean;
  /** Trader Account's date range, when set: documents dated in it. */
  from: string;
  to: string;
  onClose: () => void;
  onNavigate: (target: string) => void;
  onUnposted: (result: { draftId: string; notice: string }) => void;
  reportLanguage: "ar" | "en";
  trader: TraderAccountRow;
  traderName: string;
}) {
  const { t } = useTranslation();
  const [documents, setDocuments] = useState<readonly TraderAccountDocument[]>();
  const [error, setError] = useState<string>();
  const [unpost, setUnpost] = useState<TraderAccountDocument>();
  const pdf = useReconciliationPdfActions(api);

  const load = useCallback(() => {
    void api
      .get<readonly TraderAccountDocument[]>(`operations/trader-accounts/${trader.traderId}/documents`)
      .then((result) =>
        setDocuments(
          result.filter(
            (document) => (from === "" || document.date >= from) && (to === "" || document.date <= to),
          ),
        ),
      )
      .catch((requestError: unknown) => setError(failure(requestError, t("traderAccount.loadFailed"))));
  }, [api, from, t, to, trader.traderId]);
  useEffect(() => load(), [load]);

  const runPdf = async (document: TraderAccountDocument, mode: PdfAction) => {
    const path = documentPdfPath(document, reportLanguage);
    if (path === null) return;
    setError(undefined);
    const requestError = await pdf.run(path, `${document.number}.pdf`, mode);
    if (requestError !== undefined) setError(failure(requestError, t("traderAccount.pdfFailed")));
  };

  return (
    <Modal
      className="modal-extra-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderAccount.documentsTitle", { trader: traderName })}
      titleId="trader-account-documents-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {documents === undefined ? (
        error === undefined ? (
          <div className="loading-row">{t("common.loading")}</div>
        ) : null
      ) : documents.length === 0 ? (
        <p className="field-hint">{t("traderAccount.noDocuments")}</p>
      ) : (
        <div className="table-scroll-x">
          <table>
            <thead>
              <tr>
                <th>{t("traderAccount.documentNumber")}</th>
                <th>{t("traderAccount.documentType")}</th>
                <th>{t("common.date")}</th>
                <th>{t("traderAccount.documentAmount")}</th>
                <th>{t("traderAccount.documentOrders")}</th>
                <th>{t("traderAccount.documentStatus")}</th>
                <th>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => {
                const detail = documentDetailPath(document);
                const unpostPath = canReverse ? documentUnpostPath(document) : null;
                return (
                  <tr key={`${document.kind}-${document.id}`}>
                    <td>
                      <bdi>{document.number}</bdi>
                    </td>
                    <td>{t(`traderAccount.kind_${document.kind}`)}</td>
                    <td>
                      <bdi>{document.date}</bdi>
                    </td>
                    <td>{document.amount}</td>
                    <td>{document.orderCount}</td>
                    <td>
                      {document.reversed ? t("traderAccount.statusReversed") : t("traderAccount.statusPosted")}
                    </td>
                    <td>
                      <div className="row-actions">
                        {detail === null ? null : (
                          <button onClick={() => onNavigate(detail)} type="button">
                            {t("traderAccount.view")}
                          </button>
                        )}
                        {documentPdfPath(document, reportLanguage) === null ? null : (
                          <button
                            disabled={pdf.busy !== undefined}
                            onClick={() => void runPdf(document, "print")}
                            type="button"
                          >
                            {t("traderAccount.print")}
                          </button>
                        )}
                        {unpostPath === null ? null : (
                          <button onClick={() => setUnpost(document)} type="button">
                            {t("traderAccount.unpost")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="modal-actions">
        <button className="button button-primary" onClick={onClose} type="button">
          {t("common.close")}
        </button>
      </div>
      {unpost === undefined ? null : (
        <UnpostSettlementDialog
          api={api}
          onClose={() => setUnpost(undefined)}
          onUnposted={onUnposted}
          {...(documentUnpostPath(unpost) === null ? {} : { path: documentUnpostPath(unpost)! })}
          settlementId={unpost.id}
          settlementNumber={unpost.number}
        />
      )}
    </Modal>
  );
}
