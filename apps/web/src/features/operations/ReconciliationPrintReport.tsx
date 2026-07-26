import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { OperationsDriverReconciliationDetail } from "../../api/contracts.js";

/**
 * Print-only reconciliation report.
 *
 * This is a document, not the interactive workspace with its chrome removed.
 * It is rendered through a portal directly under `body` so the print stylesheet
 * can hide every other top-level node without depending on application class
 * names — the previous attempt relied on selectors such as `.app-shell` and
 * `.workspace` that matched nothing, so the screen layout survived onto paper.
 */
export function ReconciliationPrintReport({
  companyName,
  detail,
}: {
  companyName: string;
  detail: OperationsDriverReconciliationDetail;
}) {
  return createPortal(
    <div className="print-report" id="print-root">
      <ReconciliationPrintDocument companyName={companyName} detail={detail} />
    </div>,
    document.body,
  );
}

/** Exported separately so the document can be tested without the portal. */
export function ReconciliationPrintDocument({
  companyName,
  detail,
}: {
  companyName: string;
  detail: OperationsDriverReconciliationDetail;
}) {
  const { t } = useTranslation();
  const { overview } = detail;

  return (
    <article aria-label={t("operations.printReportTitle")} className="print-document">
      <header className="print-document-header">
        <p className="print-company" data-print="company">{companyName}</p>
        <h1>{t("operations.printReportTitle")}</h1>
        <dl className="print-meta">
          <div>
            <dt>{t("operations.reconciliation")}</dt>
            {/* Generated references are never translated or reformatted. */}
            <dd data-print="reference">{overview.reconciliationNumber}</dd>
          </div>
          <div>
            <dt>{t("operations.status")}</dt>
            <dd data-print="status">{overview.statusLabel}</dd>
          </div>
          <div>
            <dt>{t("operations.businessDate")}</dt>
            <dd data-print="business-date">{overview.businessDate}</dd>
          </div>
          <div>
            <dt>{t("operations.confirmedBy")}</dt>
            <dd data-print="confirmed-by">
              {overview.confirmedBy} {overview.confirmedAt ?? ""}
            </dd>
          </div>
          <div>
            <dt>{t("operations.driver")}</dt>
            <dd data-print="driver">
              {overview.driverName} ({overview.driverType})
            </dd>
          </div>
        </dl>
      </header>

      {/* Kept together so the figures never split across a page boundary. */}
      <section className="print-totals">
        <h2>{t("operations.financialSummary")}</h2>
        <table>
          <tbody>
            <tr>
              <th scope="row">{t("operations.selectedCollections")}</th>
              <td data-print="collections">{overview.grossCollections}</td>
            </tr>
            <tr>
              <th scope="row">{t("operations.driverPayableDeduction")}</th>
              <td data-print="deduction">0.00</td>
            </tr>
            <tr>
              <th scope="row">{t("operations.expenses")}</th>
              <td data-print="expenses">{overview.expenseTotal}</td>
            </tr>
            <tr className="print-total-row">
              <th scope="row">{t("operations.netExpected")}</th>
              <td data-print="net">{overview.netAmountReceived}</td>
            </tr>
            <tr>
              <th scope="row">{t("operations.paymentTotal")}</th>
              <td data-print="paid">{overview.paymentTotal}</td>
            </tr>
            <tr>
              <th scope="row">{t("operations.difference")}</th>
              <td data-print="difference">
                {(Number(overview.paymentTotal) - Number(overview.netAmountReceived)).toFixed(2)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="print-section">
        <h2>
          {t("operations.orders")} ({detail.orders.length})
        </h2>
        <table data-print="orders">
          <thead>
            <tr>
              <th scope="col">{t("operations.order")}</th>
              <th scope="col">{t("operations.customer")}</th>
              <th scope="col">{t("operations.cashStatus")}</th>
              <th scope="col">{t("operations.amount")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.orders.map((order) => (
              <tr key={order.id}>
                <td>{order.orderNumber}</td>
                <td>{order.customerName}</td>
                <td>{order.cashStatusLabel}</td>
                <td>{order.amountCollected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="print-section">
        <h2>
          {t("operations.payments")} ({detail.payments.length})
        </h2>
        <table data-print="payments">
          <thead>
            <tr>
              <th scope="col">{t("operations.paymentMethod")}</th>
              <th scope="col">{t("operations.bankAccount")}</th>
              <th scope="col">{t("operations.bankReference")}</th>
              <th scope="col">{t("operations.confirmedBy")}</th>
              <th scope="col">{t("operations.amount")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.payments.map((payment) => (
              <tr key={payment.id}>
                <td>{payment.paymentMethodLabel}</td>
                <td>{[payment.bankName, payment.bankAccountName].filter(Boolean).join(" — ")}</td>
                <td>{payment.bankReference ?? ""}</td>
                <td>{payment.recordedBy}</td>
                <td>{payment.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="print-section">
        <h2>
          {t("operations.expenses")} ({detail.expenses.length})
        </h2>
        <table data-print="expense-lines">
          <thead>
            <tr>
              <th scope="col">{t("operations.expenseType")}</th>
              <th scope="col">{t("operations.description")}</th>
              <th scope="col">{t("operations.reference")}</th>
              <th scope="col">{t("operations.confirmedBy")}</th>
              <th scope="col">{t("operations.amount")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.expenses.map((expense) => (
              <tr key={expense.id}>
                <td>{expense.expenseType}</td>
                <td>{expense.description ?? ""}</td>
                <td>{expense.reference ?? ""}</td>
                <td>{expense.recordedBy}</td>
                <td>{expense.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="print-section">
        <h2>{t("operations.historyAudit")}</h2>
        <table data-print="audit">
          <thead>
            <tr>
              <th scope="col">{t("operations.action")}</th>
              <th scope="col">{t("operations.actor")}</th>
              <th scope="col">{t("operations.occurredAt")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.audit.map((entry, index) => (
              <tr key={`${entry.action}-${index}`}>
                <td>{entry.action}</td>
                <td>{entry.actor}</td>
                <td>{entry.occurredAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="print-document-footer">
        <span data-print="footer-reference">{overview.reconciliationNumber}</span>
        <span>{companyName}</span>
      </footer>
    </article>
  );
}
