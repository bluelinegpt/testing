import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { formatCurrency, formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { type PdfAction, useReconciliationPdfActions } from "./reconciliation-pdf.js";

/**
 * Order corrections (DCX), Aiman 23 Oct 2026: "Correct a wrongly delivered
 * Order". The dialog previews exactly what will be taken off which document
 * and only then lets an administrator confirm; the history section shows, on
 * the Order itself, every document it was taken off -- clearly marked as no
 * longer valid for this Order -- with a print of that document as it was.
 */

interface Issue {
  readonly code: string;
  readonly message: string;
}

export interface OrderCorrectionPreview {
  readonly orderNumber: string;
  readonly serialNumber: string;
  readonly referenceNumber: string | null;
  readonly traderName: string;
  readonly driverName: string | null;
  readonly canCorrect: boolean;
  readonly blockers: readonly Issue[];
  readonly warnings: readonly Issue[];
  readonly collection: {
    readonly reconciliationNumber: string;
    readonly amount: string;
    readonly paymentMethod: "cash" | "visa" | "none";
    readonly otherOrderCount: number;
    readonly receivedAsConfirmed: string;
    readonly receivedAfterCorrection: string;
  } | null;
  readonly settlements: readonly {
    readonly settlementNumber: string;
    readonly amountPaid: string;
    readonly otherOrderCount: number;
  }[];
  readonly zeroDueDocuments: readonly string[];
  readonly recoveryTotal: string;
}

export interface OrderCorrectionHistoryRow {
  readonly correctionId: string;
  readonly correctionNumber: string;
  readonly correctedAt: string;
  readonly correctedBy: string;
  readonly reason: string;
  readonly collectionAmount: string;
  readonly recoveredAmount: string;
  readonly lines: readonly {
    readonly kind: "driver_collection" | "trader_settlement" | "zero_due";
    readonly documentId: string | null;
    readonly documentNumber: string | null;
    readonly amount: string;
    readonly recoveryReceivableNumber: string | null;
  }[];
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

export function OrderCorrectionDialog({
  api,
  onClose,
  onCorrected,
  orderId,
}: {
  readonly api: ApiClient;
  readonly onClose: () => void;
  readonly onCorrected: (notice: string) => void;
  readonly orderId: string;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.language);
  const money = (value: string) => formatCurrency(value, "AED", locale);
  const [preview, setPreview] = useState<OrderCorrectionPreview>();
  const [error, setError] = useState<string>();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .get<OrderCorrectionPreview>(`operations/orders/${orderId}/correction-preview`)
      .then((data) => active && setPreview(data))
      .catch((requestError: unknown) => {
        if (active) setError(errorText(requestError, t("orderCorrection.loadFailed")));
      });
    return () => {
      active = false;
    };
  }, [api, orderId, t]);

  const submit = () => {
    setBusy(true);
    setError(undefined);
    void api
      .post<{ correctionNumber: string; recoveryReceivableNumbers: readonly string[] }>(
        `operations/orders/${orderId}/corrections`,
        { reason: reason.trim() },
      )
      .then((result) =>
        onCorrected(
          t("orderCorrection.done", {
            number: result.correctionNumber,
            receivables:
              result.recoveryReceivableNumbers.length === 0
                ? ""
                : t("orderCorrection.doneRecovery", {
                    numbers: result.recoveryReceivableNumbers.join(", "),
                  }),
          }),
        ),
      )
      .catch((requestError: unknown) =>
        setError(errorText(requestError, t("orderCorrection.failed"))),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      className="order-correction-dialog"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("orderCorrection.title")}
      titleId="order-correction-title"
    >
      {preview === undefined ? (
        error === undefined ? (
          <div className="loading-row">{t("common.loading")}</div>
        ) : null
      ) : (
        <div className="order-correction-body">
          <p>
            {t("orderCorrection.intro", {
              order: preview.serialNumber,
              reference: preview.referenceNumber ?? "—",
              trader: preview.traderName,
            })}
          </p>
          <ol className="order-correction-steps">
            {preview.collection === null ? null : (
              <li>
                <strong>{t("orderCorrection.collectionStep", { number: preview.collection.reconciliationNumber })}</strong>
                <div>
                  {preview.collection.paymentMethod === "none"
                    ? t("orderCorrection.collectionNoMoney")
                    : t("orderCorrection.collectionMoney", {
                        amount: money(preview.collection.amount),
                        method: t(
                          preview.collection.paymentMethod === "visa"
                            ? "orderCorrection.methodBank"
                            : "orderCorrection.methodCash",
                        ),
                      })}
                </div>
                <div>
                  {t("orderCorrection.collectionTotals", {
                    after: money(preview.collection.receivedAfterCorrection),
                    before: money(preview.collection.receivedAsConfirmed),
                    others: preview.collection.otherOrderCount,
                  })}
                </div>
              </li>
            )}
            {preview.settlements.map((settlement) => (
              <li key={settlement.settlementNumber}>
                <strong>{t("orderCorrection.settlementStep", { number: settlement.settlementNumber })}</strong>
                <div>
                  {t("orderCorrection.settlementMoney", {
                    amount: money(settlement.amountPaid),
                    others: settlement.otherOrderCount,
                  })}
                </div>
              </li>
            ))}
            {preview.zeroDueDocuments.length === 0 ? null : (
              <li>
                <strong>
                  {t("orderCorrection.zeroDueStep", { numbers: preview.zeroDueDocuments.join(", ") })}
                </strong>
              </li>
            )}
            <li>
              <strong>{t("orderCorrection.reopenStep")}</strong>
              <div>{t("orderCorrection.reopenHint")}</div>
            </li>
          </ol>
          {preview.settlements.length === 0 ? null : (
            <div className="alert alert-info">
              {t("orderCorrection.recoveryTotal", { amount: money(preview.recoveryTotal) })}
            </div>
          )}
          {preview.warnings.map((warning) => (
            <div className="alert alert-warning" key={warning.code}>
              {warning.message}
            </div>
          ))}
          {preview.blockers.map((blocker) => (
            <div className="alert alert-error" key={blocker.code} role="alert">
              {blocker.message}
            </div>
          ))}
          {!preview.canCorrect ? null : (
            <>
              <label className="field">
                <span>{t("orderCorrection.reason")}</span>
                <textarea
                  autoFocus
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                  value={reason}
                />
              </label>
              <label className="checkbox-field">
                <input
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>{t("orderCorrection.confirmFinal")}</span>
              </label>
            </>
          )}
        </div>
      )}
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        {preview?.canCorrect !== true ? null : (
          <button
            className="button button-primary"
            disabled={busy || reason.trim().length < 3 || !confirmed}
            onClick={submit}
            type="button"
          >
            {busy ? t("common.working") : t("orderCorrection.submit")}
          </button>
        )}
      </div>
    </Modal>
  );
}

/**
 * On the Order: every document a correction took it off, marked "removed --
 * no longer valid for this Order", each with a print of that document as it
 * was first issued.
 */
export function OrderCorrectionHistorySection({
  api,
  orderId,
  refreshKey,
  reportLanguage,
}: {
  readonly api: ApiClient;
  readonly orderId: string;
  readonly refreshKey?: number;
  readonly reportLanguage: "ar" | "en";
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.language);
  const money = (value: string) => formatCurrency(value, "AED", locale);
  const [rows, setRows] = useState<readonly OrderCorrectionHistoryRow[]>([]);
  const [error, setError] = useState<string>();
  const pdf = useReconciliationPdfActions(api);

  useEffect(() => {
    let active = true;
    void api
      .get<readonly OrderCorrectionHistoryRow[]>(`operations/orders/${orderId}/corrections`)
      .then((data) => active && setRows(Array.isArray(data) ? data : []))
      .catch(() => active && setRows([]));
    return () => {
      active = false;
    };
  }, [api, orderId, refreshKey]);

  if (rows.length === 0) return null;

  const printOriginal = async (
    line: OrderCorrectionHistoryRow["lines"][number],
    mode: PdfAction,
  ) => {
    if (line.documentId === null || line.documentNumber === null) return;
    setError(undefined);
    const path =
      line.kind === "driver_collection"
        ? `operations/cash/reconciliations/${line.documentId}/pdf?language=${reportLanguage}&version=original`
        : `operations/settlements/payments/${line.documentId}/pdf?language=${reportLanguage}&version=original`;
    const filename =
      line.kind === "driver_collection"
        ? `Driver-Collection-${line.documentNumber}-original.pdf`
        : `Trader-Settlement-${line.documentNumber}-original.pdf`;
    const failure = await pdf.run(path, filename, mode);
    if (failure !== undefined) setError(errorText(failure, t("operations.pdfGenerationFailed")));
  };

  return (
    <section className="order-detail-section order-correction-history">
      <h2>{t("orderCorrection.historyTitle")}</h2>
      {rows.map((row) => (
        <div className="order-correction-record" key={row.correctionId}>
          <div className="order-correction-record-head">
            <strong>{row.correctionNumber}</strong>
            <span>{formatDateTime(row.correctedAt, locale)}</span>
            <span>{row.correctedBy}</span>
          </div>
          <div>
            {t("orderCorrection.historyReason")}: {row.reason}
          </div>
          <ul className="order-correction-lines">
            {row.lines.map((line, index) => (
              <li key={`${row.correctionId}-${index}`}>
                <span className="status-badge order-correction-removed">
                  {t("orderCorrection.removedBadge")}
                </span>{" "}
                <strong>{line.documentNumber ?? "—"}</strong>{" "}
                {t(
                  line.kind === "driver_collection"
                    ? "orderCorrection.historyCollection"
                    : line.kind === "trader_settlement"
                      ? "orderCorrection.historySettlement"
                      : "orderCorrection.historyZeroDue",
                  { amount: money(line.amount) },
                )}
                {line.recoveryReceivableNumber === null
                  ? null
                  : ` ${t("orderCorrection.historyRecovery", { number: line.recoveryReceivableNumber })}`}
                {line.kind === "zero_due" || line.documentId === null ? null : (
                  <span className="order-correction-print">
                    <button
                      disabled={pdf.busy !== undefined}
                      onClick={() => void printOriginal(line, "preview")}
                      type="button"
                    >
                      {t("orderCorrection.viewOriginal")}
                    </button>
                    <button
                      disabled={pdf.busy !== undefined}
                      onClick={() => void printOriginal(line, "print")}
                      type="button"
                    >
                      {t("orderCorrection.printOriginal")}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
