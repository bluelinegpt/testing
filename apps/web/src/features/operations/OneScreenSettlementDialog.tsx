import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type { CompanyBankAccount, OperationsTrader } from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { formatMoneyValue, parseMoneyInput, safeMoneyValue } from "../../utils/numeric-input.js";
import { useReconciliationPdfActions } from "./reconciliation-pdf.js";

/**
 * One-screen Trader Settlement (Aiman, 22 Oct 2026; per Company switch).
 *
 * Every open line of one Trader in ONE table -- orders to pay (+), Trader fees
 * (−), Trader credits (+) and delivered orders with nothing to pay (0.00) --
 * ticked like a list, with the totals at the end. No amount to type: a ticked
 * line counts in full unless "Edit amounts" is on (partial payment).
 *
 * Draft -> Preview invoice (marked DRAFT) -> Post. Posting is the existing
 * draft confirmation, so every server-side check of a settlement still applies.
 */

type LineKind = "pay" | "fee" | "credit" | "zero";

interface Line {
  readonly area: string;
  readonly cod: string | null;
  readonly customer: string;
  readonly date: string | null;
  readonly emirate: string;
  readonly fees: string | null;
  /** Full amount of the line, as a positive figure. */
  readonly full: number;
  readonly id: string;
  readonly key: string;
  readonly kind: LineKind;
  readonly mobile: string;
  /** Receivable / credit number, or the invoice a 0-due order prints on now. */
  readonly note: string;
  readonly orderNumber: string;
  readonly reference: string;
}

interface Paged<T> {
  readonly items: readonly T[];
  readonly total: number;
}

interface EligibleOrder {
  readonly additionalFees: string;
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly deliveryDate: string | null;
  readonly emirateName: string | null;
  readonly id: string;
  readonly orderNumber: string;
  readonly outstandingBalance: string;
  readonly referenceNumber: string | null;
  readonly totalDeductions: string;
}

interface EligibleReceivable {
  readonly areaName?: string | null;
  readonly businessDate: string;
  readonly customerMobileNumber?: string | null;
  readonly customerName?: string | null;
  readonly emirateName?: string | null;
  readonly id: string;
  readonly orderNumber?: string | null;
  readonly outstandingAmount: string;
  readonly reason: string;
  readonly receivableNumber: string;
  readonly sourceReference: string | null;
}

interface OpenCredit {
  readonly businessDate: string;
  readonly creditId: string;
  readonly creditNumber: string;
  readonly reason: string;
  readonly remainingAmount: string;
  readonly sourceOrderNumber: string | null;
  readonly sourceReferenceNumber: string | null;
}

interface ZeroDueOrder {
  readonly additionalFees: string;
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly deliveryDate: string | null;
  readonly emirateName: string | null;
  readonly id: string;
  readonly orderNumber: string;
  readonly printedOnSettlementNumber: string | null;
  readonly referenceNumber: string | null;
  readonly serviceFee: string;
}

interface DraftPayload {
  readonly allocations?: readonly { amount: number | string; orderId: string }[];
  readonly bankAccountId?: string;
  readonly bankReference?: string;
  readonly cashAccountId?: string;
  readonly creditApplications?: readonly { amount: number | string; creditId: string }[];
  readonly notes?: string;
  readonly paymentDate?: string;
  readonly paymentMethod?: string;
  readonly receivableOffsets?: readonly { amount: number | string; receivableId: string }[];
  readonly traderBankAccountId?: string;
  readonly traderId?: string;
  readonly zeroDueOrderIds?: readonly string[];
}

interface DraftRow {
  readonly id: string;
  readonly payload: DraftPayload;
  readonly status: "draft" | "confirmed";
  readonly traderId: string;
  readonly traderName: string;
}

interface TraderBank {
  readonly accountName: string;
  readonly bankName: string;
  readonly id: string;
  readonly isActive: boolean;
  readonly isDefault: boolean;
}

async function allPages<T>(api: ApiClient, base: string, pageSize: number): Promise<T[]> {
  const join = base.includes("?") ? "&" : "?";
  const first = await api.get<Paged<T>>(`${base}${join}page=1&pageSize=${pageSize}`);
  const pages = Math.ceil((first.total ?? 0) / pageSize);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      api.get<Paged<T>>(`${base}${join}page=${index + 2}&pageSize=${pageSize}`),
    ),
  );
  return [first, ...rest].flatMap((page) => [...(page.items ?? [])]);
}

const money = (value: number | string) => formatMoneyValue(value);

export function OneScreenSettlementDialog({
  api,
  draftId: initialDraftId,
  initialTraderId,
  onClose,
  onDraftSaved,
  onPosted,
  reportLanguage,
}: {
  api: ApiClient;
  draftId?: string | undefined;
  initialTraderId?: string | undefined;
  onClose: () => void;
  onDraftSaved: (traderName: string) => void;
  onPosted: (settlementId: string) => void;
  reportLanguage: "ar" | "en";
}) {
  const { t } = useTranslation();
  const pdf = useReconciliationPdfActions(api);
  const [traders, setTraders] = useState<readonly OperationsTrader[]>([]);
  const [traderId, setTraderId] = useState(initialTraderId ?? "");
  const [draftId, setDraftId] = useState(initialDraftId);
  const [draft, setDraft] = useState<DraftRow>();
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [amounts, setAmounts] = useState<Readonly<Record<string, string>>>({});
  const [editAmounts, setEditAmounts] = useState(false);
  const [kindFilter, setKindFilter] = useState<LineKind | "all">("all");
  const [search, setSearch] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState<"bank_transfer" | "cash">("cash");
  const [cashAccounts, setCashAccounts] = useState<readonly { id: string; name: string }[]>([]);
  const [cashAccountId, setCashAccountId] = useState("");
  const [companyBanks, setCompanyBanks] = useState<readonly CompanyBankAccount[]>([]);
  const [traderBanks, setTraderBanks] = useState<readonly TraderBank[]>([]);
  const [bankAccountId, setBankAccountId] = useState("");
  const [traderBankAccountId, setTraderBankAccountId] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Traders, cash accounts and company banks: once.
  useEffect(() => {
    void api
      .get<readonly OperationsTrader[]>("operations/traders")
      .then((rows) => setTraders(rows.filter((row) => row.status === "active")))
      .catch(() => setTraders([]));
    void api
      .get<readonly { id: string; name: string }[]>(
        "operations/accounting/cash-bank/cash-accounts?activeOnly=true",
      )
      .then((rows) => {
        setCashAccounts(rows);
        if (rows.length === 1) setCashAccountId((current) => current || rows[0]!.id);
      })
      .catch(() => setCashAccounts([]));
    void api
      .get<readonly CompanyBankAccount[]>("configuration/bank-accounts")
      .then((rows) => {
        const active = rows.filter((row) => row.isActive);
        setCompanyBanks(active);
        setBankAccountId((current) => current || (active[0]?.id ?? ""));
      })
      .catch(() => setCompanyBanks([]));
  }, [api]);

  // A saved draft: its Trader and payment details.
  useEffect(() => {
    if (initialDraftId === undefined) return;
    void api
      .get<DraftRow>(`operations/settlements/drafts/${initialDraftId}`)
      .then((row) => {
        setDraft(row);
        setTraderId(row.traderId);
        const payload = row.payload;
        if (payload.paymentDate) setPaymentDate(payload.paymentDate);
        setPaymentMethod(payload.paymentMethod === "bank_transfer" ? "bank_transfer" : "cash");
        if (payload.cashAccountId) setCashAccountId(payload.cashAccountId);
        if (payload.bankAccountId) setBankAccountId(payload.bankAccountId);
        if (payload.traderBankAccountId) setTraderBankAccountId(payload.traderBankAccountId);
        setBankReference(payload.bankReference ?? "");
        setNotes(payload.notes ?? "");
      })
      .catch((reason: unknown) => setError(errorText(reason, t("traderSettlements.oneScreen.loadFailed"))));
  }, [api, initialDraftId, t]);

  // Every open line of the chosen Trader.
  useEffect(() => {
    if (traderId === "") {
      setLines([]);
      return;
    }
    let active = true;
    setLoading(true);
    setError(undefined);
    void Promise.all([
      allPages<EligibleOrder>(api, `operations/settlements/payments/eligible-orders?traderId=${traderId}`, 200),
      allPages<EligibleReceivable>(
        api,
        `operations/trader-receivables/eligible?traderId=${traderId}&outstandingOnly=true&sortBy=businessDate&sortDirection=asc`,
        100,
      ),
      api
        .get<readonly OpenCredit[]>(`operations/settlements/payments/open-credits?traderId=${traderId}`)
        .catch((): readonly OpenCredit[] => []),
      api
        .get<readonly ZeroDueOrder[]>(`operations/settlements/payments/zero-due-orders?traderId=${traderId}`)
        .catch((): readonly ZeroDueOrder[] => []),
    ])
      .then(([orders, receivables, credits, zeroDue]) => {
        if (!active) return;
        const next: Line[] = [
          ...orders.map((order) => ({
            area: order.areaName,
            cod: order.codAmount,
            customer: order.customerName,
            date: order.deliveryDate,
            emirate: order.emirateName ?? "",
            fees: order.totalDeductions,
            full: safeMoneyValue(order.outstandingBalance),
            id: order.id,
            key: `pay:${order.id}`,
            kind: "pay" as const,
            mobile: order.customerMobileNumber,
            note: "",
            orderNumber: order.orderNumber,
            reference: order.referenceNumber ?? "",
          })),
          ...receivables.map((receivable) => ({
            area: receivable.areaName ?? "",
            cod: null,
            customer: receivable.customerName ?? receivable.reason,
            date: receivable.businessDate,
            emirate: receivable.emirateName ?? "",
            fees: receivable.outstandingAmount,
            full: safeMoneyValue(receivable.outstandingAmount),
            id: receivable.id,
            key: `fee:${receivable.id}`,
            kind: "fee" as const,
            mobile: receivable.customerMobileNumber ?? "",
            note: receivable.receivableNumber,
            orderNumber: receivable.orderNumber ?? receivable.sourceReference ?? "",
            reference: "",
          })),
          ...(Array.isArray(credits) ? credits : []).map((credit) => ({
            area: "",
            cod: null,
            customer: credit.reason,
            date: credit.businessDate,
            emirate: "",
            fees: null,
            full: safeMoneyValue(credit.remainingAmount),
            id: credit.creditId,
            key: `credit:${credit.creditId}`,
            kind: "credit" as const,
            mobile: "",
            note: credit.creditNumber,
            orderNumber: credit.sourceOrderNumber ?? "",
            reference: credit.sourceReferenceNumber ?? "",
          })),
          ...(Array.isArray(zeroDue) ? zeroDue : []).map((order) => ({
            area: order.areaName,
            cod: order.codAmount,
            customer: order.customerName,
            date: order.deliveryDate,
            emirate: order.emirateName ?? "",
            fees: formatMoneyValue(safeMoneyValue(order.serviceFee) + safeMoneyValue(order.additionalFees)),
            full: 0,
            id: order.id,
            key: `zero:${order.id}`,
            kind: "zero" as const,
            mobile: order.customerMobileNumber,
            note: order.printedOnSettlementNumber ?? "",
            orderNumber: order.orderNumber,
            reference: order.referenceNumber ?? "",
          })),
        ];
        setLines(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(reason, t("traderSettlements.oneScreen.loadFailed")));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    void api
      .get<readonly TraderBank[]>(`configuration/traders/${traderId}/bank-accounts`)
      .then((rows) => {
        const active = rows.filter((row) => row.isActive);
        setTraderBanks(active);
        setTraderBankAccountId(
          (current) => current || ((active.find((row) => row.isDefault) ?? active[0])?.id ?? ""),
        );
      })
      .catch(() => setTraderBanks([]));
    return () => {
      active = false;
    };
  }, [api, traderId, t]);

  // What is ticked: a draft's own lines, otherwise every order to pay and fee.
  useEffect(() => {
    if (lines.length === 0) {
      setSelected(new Set());
      return;
    }
    if (initialDraftId !== undefined) {
      if (draft === undefined) return;
      const payload = draft.payload;
      const keys = new Set<string>();
      const custom: Record<string, string> = {};
      const restore = (kind: LineKind, id: string, amount: number | string | undefined) => {
        const line = lines.find((candidate) => candidate.key === `${kind}:${id}`);
        if (line === undefined) return;
        keys.add(line.key);
        if (amount !== undefined && Math.abs(safeMoneyValue(amount) - line.full) > 0.004) {
          custom[line.key] = formatMoneyValue(amount);
        }
      };
      for (const line of payload.allocations ?? []) restore("pay", line.orderId, line.amount);
      for (const line of payload.receivableOffsets ?? []) restore("fee", line.receivableId, line.amount);
      for (const line of payload.creditApplications ?? []) restore("credit", line.creditId, line.amount);
      for (const id of payload.zeroDueOrderIds ?? []) restore("zero", id, undefined);
      setSelected(keys);
      setAmounts(custom);
      setEditAmounts(Object.keys(custom).length > 0);
      return;
    }
    setSelected(new Set(lines.filter((line) => line.kind === "pay" || line.kind === "fee").map((line) => line.key)));
    setAmounts({});
  }, [lines, draft, initialDraftId]);

  const amountOf = (line: Line): number => {
    if (line.kind === "zero") return 0;
    const typed = editAmounts ? amounts[line.key] : undefined;
    if (typed === undefined) return line.full;
    const parsed = parseMoneyInput(typed, { allowZero: false, required: true });
    return parsed.ok ? parsed.value : Number.NaN;
  };

  const ticked = lines.filter((line) => selected.has(line.key));
  const sumOf = (kind: LineKind) =>
    ticked.filter((line) => line.kind === kind).reduce((total, line) => total + amountOf(line), 0);
  const totals = {
    credit: sumOf("credit"),
    fee: sumOf("fee"),
    net: Math.round((sumOf("pay") - sumOf("fee") + sumOf("credit")) * 100) / 100,
    pay: sumOf("pay"),
    zero: ticked.filter((line) => line.kind === "zero"),
  };

  const amountErrors = ticked.filter((line) => {
    if (line.kind === "zero") return false;
    const value = amountOf(line);
    return !Number.isFinite(value) || value <= 0 || value > line.full + 0.004;
  });

  const visible = lines.filter((line) => {
    if (kindFilter !== "all" && line.kind !== kindFilter) return false;
    const term = search.trim().toLowerCase();
    if (term === "") return true;
    return [line.orderNumber, line.reference, line.customer, line.mobile, line.note]
      .some((value) => value.toLowerCase().includes(term));
  });
  const moneyLines = lines.filter((line) => line.kind === "pay" || line.kind === "fee");
  const allMoneyTicked = moneyLines.length > 0 && moneyLines.every((line) => selected.has(line.key));
  const count = (kind: LineKind) => lines.filter((line) => line.kind === kind).length;

  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const trader = traders.find((row) => row.id === traderId);
  const paymentReady =
    paymentMethod === "cash"
      ? cashAccountId !== ""
      : bankAccountId !== "" && traderBankAccountId !== "" && bankReference.trim() !== "";
  const hasPayLine = ticked.some((line) => line.kind === "pay");
  const canPost =
    traderId !== "" && hasPayLine && totals.net > 0 && amountErrors.length === 0 && paymentReady && !busy;

  const payload = () => ({
    allocations: ticked
      .filter((line) => line.kind === "pay")
      .map((line) => ({ amount: Math.round(amountOf(line) * 100) / 100, orderId: line.id })),
    amount: totals.net,
    ...(paymentMethod === "bank_transfer"
      ? { bankAccountId, bankReference: bankReference.trim(), traderBankAccountId }
      : { cashAccountId }),
    ...(totals.credit > 0
      ? {
          creditApplications: ticked
            .filter((line) => line.kind === "credit")
            .map((line) => ({ amount: Math.round(amountOf(line) * 100) / 100, creditId: line.id })),
        }
      : {}),
    notes: notes.trim() === "" ? undefined : notes.trim(),
    paymentDate,
    paymentMethod,
    receivableOffsets: ticked
      .filter((line) => line.kind === "fee")
      .map((line) => ({ amount: Math.round(amountOf(line) * 100) / 100, receivableId: line.id })),
    traderId,
    ...(totals.zero.length === 0 ? {} : { zeroDueOrderIds: totals.zero.map((line) => line.id) }),
  });

  const persist = async (): Promise<DraftRow> => {
    const body = payload();
    try {
      const saved =
        draftId === undefined
          ? await api.post<DraftRow>("operations/settlements/drafts", body)
          : await api.patch<DraftRow>(`operations/settlements/drafts/${draftId}`, body);
      setDraftId(saved.id);
      return saved;
    } catch (reason) {
      // This Trader already has a draft: save into it rather than refusing.
      if (reason instanceof ApiError && reason.code === "trader_settlement_draft_already_open") {
        const existing = Array.isArray(reason.details) ? String(reason.details[0] ?? "") : "";
        if (existing !== "") {
          const saved = await api.patch<DraftRow>(`operations/settlements/drafts/${existing}`, body);
          setDraftId(saved.id);
          return saved;
        }
      }
      throw reason;
    }
  };

  const saveDraft = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await persist();
      onDraftSaved(saved.traderName);
    } catch (reason) {
      setError(errorText(reason, t("traderSettlements.draftSaveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const previewInvoice = async () => {
    setError(undefined);
    const failure = await pdf.run(
      `operations/settlements/drafts/preview-pdf?language=${reportLanguage}`,
      "Trader-Settlement-DRAFT.pdf",
      "preview",
      payload(),
    );
    if (failure !== undefined) setError(errorText(failure, t("traderSettlements.pdfGenerationFailed")));
  };

  const post = async () => {
    if (!canPost) return;
    if (
      !window.confirm(
        t("traderSettlements.oneScreen.postConfirm", {
          amount: money(totals.net),
          trader: trader?.name ?? draft?.traderName ?? "",
        }),
      )
    ) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const saved = await persist();
      const result = await api.post<{ settlementId: string }>(
        `operations/settlements/drafts/${saved.id}/confirm`,
      );
      onPosted(result.settlementId);
    } catch (reason) {
      setError(errorText(reason, t("traderSettlements.settlementFailed")));
    } finally {
      setBusy(false);
    }
  };

  const kindLabel = (kind: LineKind) => t(`traderSettlements.oneScreen.kind.${kind}`);
  const chips: readonly (LineKind | "all")[] = ["all", "pay", "fee", "credit", "zero"];

  return (
    <Modal
      className="modal-extra-wide one-screen-settlement"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={
        draftId === undefined
          ? t("traderSettlements.newSettlement")
          : t("traderSettlements.oneScreen.draftTitle")
      }
      titleId="one-screen-settlement-title"
    >
      <div className="one-screen-settlement__top">
        <label className="field">
          <span>{t("traderSettlements.filterTrader")}</span>
          <select
            aria-label={t("traderSettlements.filterTrader")}
            disabled={initialDraftId !== undefined}
            onChange={(event) => {
              setTraderId(event.target.value);
              setDraftId(undefined);
            }}
            value={traderId}
          >
            <option value="">{t("traderSettlements.oneScreen.chooseTrader")}</option>
            {traders.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} ({row.code})
              </option>
            ))}
          </select>
        </label>
        <div aria-label={t("traderSettlements.oneScreen.show")} className="one-screen-settlement__chips" role="group">
          {chips.map((chip) => (
            <button
              aria-pressed={kindFilter === chip}
              className={kindFilter === chip ? "chip chip-on" : "chip"}
              key={chip}
              onClick={() => setKindFilter(chip)}
              type="button"
            >
              {chip === "all" ? t("traderSettlements.oneScreen.all") : kindLabel(chip)} (
              {chip === "all" ? lines.length : count(chip)})
            </button>
          ))}
        </div>
        <input
          aria-label={t("traderSettlements.oneScreen.search")}
          className="one-screen-settlement__search"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("traderSettlements.oneScreen.search")}
          value={search}
        />
        <label className="one-screen-settlement__edit-amounts">
          <input
            checked={editAmounts}
            onChange={(event) => {
              setEditAmounts(event.target.checked);
              if (!event.target.checked) setAmounts({});
            }}
            type="checkbox"
          />
          {t("traderSettlements.oneScreen.editAmounts")}
        </label>
      </div>

      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <div className="table-scroll one-screen-settlement__table">
        <table>
          <thead>
            <tr>
              <th scope="col">
                <input
                  aria-label={t("traderSettlements.oneScreen.selectAll")}
                  checked={allMoneyTicked}
                  disabled={moneyLines.length === 0}
                  onChange={(event) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      for (const line of moneyLines) {
                        if (event.target.checked) next.add(line.key);
                        else next.delete(line.key);
                      }
                      return next;
                    })
                  }
                  type="checkbox"
                />
              </th>
              <th scope="col">{t("traderSettlements.oneScreen.type")}</th>
              <th scope="col">{t("operations.orderNumber")}</th>
              <th scope="col">{t("traderSettlements.filterExternalReference")}</th>
              <th scope="col">{t("traderSettlements.oneScreen.date")}</th>
              <th scope="col">{t("traderSettlements.filterArea")}</th>
              <th scope="col">{t("common.name")}</th>
              <th className="numeric" scope="col">{t("operations.codAmount")}</th>
              <th className="numeric" scope="col">{t("traderSettlements.oneScreen.fees")}</th>
              <th className="numeric" scope="col">{t("traderSettlements.oneScreen.amount")}</th>
              <th scope="col">{t("traderSettlements.oneScreen.note")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((line) => {
              const on = selected.has(line.key);
              const amount = amountOf(line);
              const sign = line.kind === "fee" ? "−" : line.kind === "zero" ? "" : "+";
              return (
                <tr className={`one-line one-line--${line.kind}${on ? "" : " one-line--off"}`} key={line.key}>
                  <td>
                    <input
                      aria-label={t("traderSettlements.oneScreen.tick", {
                        number: line.reference || line.orderNumber || line.note,
                      })}
                      checked={on}
                      onChange={(event) => toggle(line.key, event.target.checked)}
                      type="checkbox"
                    />
                  </td>
                  <td>
                    <span className={`one-tag one-tag--${line.kind}`}>{kindLabel(line.kind)}</span>
                  </td>
                  <td className="mono">{line.orderNumber || "-"}</td>
                  <td className="mono">{line.reference || "-"}</td>
                  <td>{line.date === null ? "-" : line.date.slice(0, 10)}</td>
                  <td>{[line.emirate, line.area].filter((part) => part !== "").join(" - ") || "-"}</td>
                  <td>
                    {line.customer}
                    {line.mobile === "" ? null : <span className="cell-secondary">{line.mobile}</span>}
                  </td>
                  <td className="numeric">{line.cod === null ? "-" : money(line.cod)}</td>
                  <td className="numeric">{line.fees === null ? "-" : money(line.fees)}</td>
                  <td className="numeric one-amount">
                    {editAmounts && on && line.kind !== "zero" ? (
                      <input
                        aria-label={t("traderSettlements.oneScreen.amountFor", {
                          number: line.reference || line.orderNumber || line.note,
                        })}
                        className="no-spinner"
                        inputMode="decimal"
                        onChange={(event) =>
                          setAmounts((current) => ({ ...current, [line.key]: event.target.value }))
                        }
                        value={amounts[line.key] ?? formatMoneyValue(line.full)}
                      />
                    ) : (
                      `${sign}${money(line.kind === "zero" ? 0 : Number.isFinite(amount) ? amount : line.full)}`
                    )}
                  </td>
                  <td className="mono">
                    {line.kind === "zero" && line.note !== ""
                      ? t("traderSettlements.zeroDuePrintsOn", { number: line.note })
                      : line.note || "-"}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={11}>
                  {loading
                    ? t("common.loading")
                    : traderId === ""
                      ? t("traderSettlements.oneScreen.chooseTrader")
                      : t("traderSettlements.noEligibleOrders")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="one-screen-settlement__totals" role="status">
        <div className="one-total">
          <span>{t("traderSettlements.oneScreen.totalPay")}</span>
          <strong className="one-plus">{money(totals.pay)}</strong>
        </div>
        <div className="one-total">
          <span>{t("traderSettlements.oneScreen.totalFees")}</span>
          <strong className="one-minus">−{money(totals.fee)}</strong>
        </div>
        {totals.credit === 0 ? null : (
          <div className="one-total">
            <span>{t("traderSettlements.oneScreen.totalCredits")}</span>
            <strong className="one-plus">{money(totals.credit)}</strong>
          </div>
        )}
        <div className="one-total">
          <span>{t("traderSettlements.oneScreen.totalZero")}</span>
          <strong>{totals.zero.length}</strong>
          {totals.zero.length === 0 ? null : (
            <small>{totals.zero.map((line) => line.reference || line.orderNumber).join(", ")}</small>
          )}
        </div>
        <div className="one-total one-total--net">
          <span>{t("traderSettlements.oneScreen.net")}</span>
          <strong>{money(totals.net)}</strong>
          <small>{t("traderSettlements.oneScreen.linesTicked", { count: ticked.length })}</small>
        </div>
      </div>
      {totals.net < 0 ? (
        <div className="alert alert-warning" role="alert">
          {t("traderSettlements.oneScreen.traderOwes", { amount: money(-totals.net) })}
        </div>
      ) : null}
      {amountErrors.length === 0 ? null : (
        <div className="alert alert-error" role="alert">
          {t("traderSettlements.oneScreen.amountInvalid")}
        </div>
      )}

      <div className="one-screen-settlement__payment">
        <label className="field">
          <span>{t("traderSettlements.paymentDate")}</span>
          <input onChange={(event) => setPaymentDate(event.target.value)} type="date" value={paymentDate} />
        </label>
        <label className="field">
          <span>{t("traderSettlements.filterPaymentMethod")}</span>
          <select
            onChange={(event) =>
              setPaymentMethod(event.target.value === "bank_transfer" ? "bank_transfer" : "cash")
            }
            value={paymentMethod}
          >
            <option value="cash">{t("traderSettlements.paymentMethodCash")}</option>
            <option value="bank_transfer">{t("traderSettlements.paymentMethodBankTransfer")}</option>
          </select>
        </label>
        {paymentMethod === "cash" ? (
          <label className="field">
            <span>{t("traderSettlements.cashAccount")}</span>
            <select onChange={(event) => setCashAccountId(event.target.value)} value={cashAccountId}>
              <option value="">{t("traderSettlements.oneScreen.choose")}</option>
              {cashAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="field">
              <span>{t("traderSettlements.sourceBankAccount")}</span>
              <select onChange={(event) => setBankAccountId(event.target.value)} value={bankAccountId}>
                <option value="">{t("traderSettlements.oneScreen.choose")}</option>
                {companyBanks.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.bankName} — {account.accountName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("traderSettlements.beneficiaryBankAccount")}</span>
              <select onChange={(event) => setTraderBankAccountId(event.target.value)} value={traderBankAccountId}>
                <option value="">{t("traderSettlements.oneScreen.choose")}</option>
                {traderBanks.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.bankName} — {account.accountName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("traderSettlements.bankReference")}</span>
              <input onChange={(event) => setBankReference(event.target.value)} value={bankReference} />
            </label>
          </>
        )}
        <label className="field one-screen-settlement__notes">
          <span>{t("traderSettlements.notes")}</span>
          <input maxLength={1000} onChange={(event) => setNotes(event.target.value)} value={notes} />
        </label>
      </div>

      <div className="modal-actions">
        <button className="button button-secondary" disabled={busy} onClick={onClose} type="button">
          {t("common.close")}
        </button>
        <button
          className="button button-secondary"
          disabled={busy || !hasPayLine || totals.net <= 0 || amountErrors.length > 0}
          onClick={() => void previewInvoice()}
          type="button"
        >
          {pdf.busy === "preview" ? t("common.loading") : t("traderSettlements.oneScreen.previewInvoice")}
        </button>
        <button
          className="button button-secondary"
          disabled={busy || traderId === "" || amountErrors.length > 0}
          onClick={() => void saveDraft()}
          type="button"
        >
          {t("traderSettlements.saveDraft")}
        </button>
        <button className="button button-primary" disabled={!canPost} onClick={() => void post()} type="button">
          {t("traderSettlements.oneScreen.post", { amount: money(totals.net) })}
        </button>
      </div>
    </Modal>
  );
}

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError) {
    const details = Array.isArray(reason.details) ? reason.details.filter(Boolean) : [];
    return details.length > 0 && reason.code !== "trader_settlement_draft_already_open"
      ? `${reason.message}: ${details.join(" ")}`
      : reason.message;
  }
  return reason instanceof Error ? reason.message : fallback;
}

/** Whether this Company uses the one-screen settlement flow (per Company switch). */
export function useOneScreenSettlement(api: ApiClient): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    // Promise.resolve: a test double may answer with nothing at all.
    void Promise.resolve(api.get<{ oneScreen?: boolean }>("operations/settlements/payments/settings"))
      .then((settings) => {
        if (active) setEnabled(settings?.oneScreen === true);
      })
      .catch(() => {
        if (active) setEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  return enabled;
}

/** Un-post and adjust: reverse a posted settlement and reopen its lines as a draft. */
export function UnpostSettlementDialog({
  api,
  onClose,
  onUnposted,
  settlementId,
  settlementNumber,
}: {
  api: ApiClient;
  onClose: () => void;
  onUnposted: (result: { draftId: string; notice: string }) => void;
  settlementId: string;
  settlementNumber: string;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (reason.trim() === "") {
      setError(t("traderSettlements.reverseReasonRequired"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.post<{ draftId: string; reversalSettlementNumber: string; settlementNumber: string }>(
        `operations/settlements/payments/${settlementId}/unpost`,
        { reason: reason.trim() },
      );
      onUnposted({
        draftId: result.draftId,
        notice: t("traderSettlements.oneScreen.unpostDone", {
          number: result.settlementNumber,
          reversal: result.reversalSettlementNumber,
        }),
      });
    } catch (reasonError) {
      setError(errorText(reasonError, t("traderSettlements.oneScreen.unpostFailed")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("traderSettlements.oneScreen.unpostTitle", { number: settlementNumber })}
      titleId="unpost-settlement-title"
    >
      <p className="form-hint">{t("traderSettlements.oneScreen.unpostHelp", { number: settlementNumber })}</p>
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <label className="field required-field">
        <span>{t("traderSettlements.oneScreen.unpostReason")}</span>
        <input
          autoFocus
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          value={reason}
        />
      </label>
      <div className="modal-actions">
        <button className="button button-secondary" disabled={busy} onClick={onClose} type="button">
          {t("common.close")}
        </button>
        <button className="button button-primary" disabled={busy} onClick={() => void submit()} type="button">
          {busy ? t("common.loading") : t("traderSettlements.oneScreen.unpost")}
        </button>
      </div>
    </Modal>
  );
}
