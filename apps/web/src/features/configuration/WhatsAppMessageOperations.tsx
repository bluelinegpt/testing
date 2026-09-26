import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { shortGroupId } from "./WhatsAppConfigurationWorkspace.js";

interface MessageListItem {
  readonly id: string;
  readonly createdAt: string;
  readonly traderName: string | null;
  readonly orderNumber: string | null;
  readonly orderStatus: string | null;
  readonly groupNameSnapshot: string | null;
  readonly messageType: string;
  readonly messageLanguage: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly failureCode: string | null;
  readonly nextAttemptAt: string | null;
  readonly sentAt: string | null;
}

interface MessageAttempt {
  readonly attemptNumber: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly result: string | null;
  readonly failureClassification: string | null;
  readonly providerResponseSummary: string | null;
}

interface MessageDetail extends MessageListItem {
  readonly providerGroupId: string;
  readonly messageBody: string;
  readonly providerMessageId: string | null;
  readonly queuedAt: string;
  readonly failureReason: string | null;
  readonly attempts: readonly MessageAttempt[];
}

interface MessagePage {
  readonly items: readonly MessageListItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

const statusFilters = ["pending", "processing", "sent", "failed", "requires_review", "cancelled"];

/** Backend failure codes → operational, human categories. Never implies
 *  "not delivered" when the true state is uncertain. */
export function failureCategoryKey(failureCode: string | null): string | null {
  if (failureCode === null) return null;
  switch (failureCode) {
    case "whatsapp_not_connected":
      return "not_connected";
    case "whatsapp_provider_unavailable":
      return "provider_unavailable";
    case "whatsapp_group_not_found":
      return "group_unavailable";
    case "notification_expired":
      return "expired";
    case "provider_timeout":
    case "whatsapp_send_rejected":
      return "uncertain";
    case "processing_interrupted":
      return "interrupted";
    case "superseded_by_newer_status":
      return "superseded";
    default:
      return "generic";
  }
}

/**
 * The Company-scoped WhatsApp message operations table: filter, inspect a
 * message with its attempt history, and — with the messages-manage
 * permission — resolve stuck messages. `Retry Anyway` on an unconfirmed
 * message always passes through the explicit duplicate-risk warning; the
 * backend independently enforces the same rules.
 */
export function WhatsAppMessageOperations({
  api,
  canManage,
}: {
  api: ApiClient;
  canManage: boolean;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [orderFilter, setOrderFilter] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<MessagePage>();
  const [detail, setDetail] = useState<MessageDetail>();
  const [confirmingRetry, setConfirmingRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (statusFilter) params.set("status", statusFilter);
      if (typeFilter) params.set("messageType", typeFilter);
      if (orderFilter.trim()) params.set("orderNumber", orderFilter.trim());
      setData(await api.get<MessagePage>(`whatsapp/messages?${params.toString()}`));
      setError(undefined);
    } catch {
      setError(t("common.loadFailed"));
    }
  }, [api, orderFilter, page, statusFilter, t, typeFilter]);
  useEffect(() => void load(), [load]);

  const openDetail = useCallback(
    async (id: string) => {
      try {
        setDetail(await api.get<MessageDetail>(`whatsapp/messages/${encodeURIComponent(id)}`));
      } catch {
        setError(t("common.loadFailed"));
      }
    },
    [api, t],
  );

  const act = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      if (detail === undefined || busy) return;
      setBusy(true);
      setNotice(undefined);
      try {
        await api.post(`whatsapp/messages/${encodeURIComponent(detail.id)}/${path}`, body);
        setNotice(t("whatsapp.opsActionDone"));
        setDetail(undefined);
        setConfirmingRetry(false);
        await load();
      } catch {
        setError(t("common.operationFailed"));
      } finally {
        setBusy(false);
      }
    },
    [api, busy, detail, load, t],
  );

  const pageCount = data === undefined ? 1 : Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <section className="detail-panel">
      <h2>{t("whatsapp.opsMessagesTitle")}</h2>
      {error ? <p className="alert alert-error">{error}</p> : null}
      {notice ? <p className="alert alert-info">{notice}</p> : null}
      <div className="row-actions">
        <label className="field">
          <span>{t("common.status")}</span>
          <select
            onChange={(event) => {
              setPage(1);
              setStatusFilter(event.target.value);
            }}
            value={statusFilter}
          >
            <option value="">{t("whatsapp.opsAllStatuses")}</option>
            {statusFilters.map((status) => (
              <option key={status} value={status}>
                {t(`whatsapp.messageStatus.${status}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("whatsapp.historyType")}</span>
          <select
            onChange={(event) => {
              setPage(1);
              setTypeFilter(event.target.value);
            }}
            value={typeFilter}
          >
            <option value="">{t("whatsapp.opsAllTypes")}</option>
            <option value="order_status">{t("whatsapp.typeOrderStatus")}</option>
            <option value="test">{t("whatsapp.typeTest")}</option>
          </select>
        </label>
        <label className="field">
          <span className="sr-only">{t("whatsapp.opsSearchOrder")}</span>
          <input
            onChange={(event) => {
              setPage(1);
              setOrderFilter(event.target.value);
            }}
            placeholder={t("whatsapp.opsSearchOrder")}
            type="search"
            value={orderFilter}
          />
        </label>
        <button className="button button-secondary" onClick={() => void load()} type="button">
          <RefreshCw size={17} aria-hidden="true" />
          {t("common.refresh")}
        </button>
      </div>

      {data !== undefined && data.items.length === 0 ? (
        <p className="empty-state">{t("whatsapp.historyEmpty")}</p>
      ) : null}
      {data !== undefined && data.items.length > 0 ? (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("common.date")}</th>
                  <th scope="col">{t("operations.trader", { defaultValue: "Trader" })}</th>
                  <th scope="col">{t("whatsapp.opsOrder")}</th>
                  <th scope="col">{t("whatsapp.historyGroup")}</th>
                  <th scope="col">{t("whatsapp.historyType")}</th>
                  <th scope="col">{t("common.status")}</th>
                  <th scope="col">{t("whatsapp.opsAttempts")}</th>
                  <th scope="col">{t("whatsapp.opsNextAttempt")}</th>
                  <th scope="col">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  const category = failureCategoryKey(item.failureCode);
                  return (
                    <tr key={item.id}>
                      <td>{formatDateTime(item.createdAt, locale)}</td>
                      <td>{item.traderName ?? "—"}</td>
                      <td>
                        {item.orderNumber ?? "—"}
                        {item.orderStatus ? (
                          <span className="form-hint">
                            {" "}
                            {t(`statuses.${item.orderStatus}`, { defaultValue: item.orderStatus })}
                          </span>
                        ) : null}
                      </td>
                      <td>{item.groupNameSnapshot ?? "—"}</td>
                      <td>
                        {item.messageType === "test"
                          ? t("whatsapp.typeTest")
                          : t("whatsapp.typeOrderStatus")}
                      </td>
                      <td>
                        <span className={`status-badge status-${item.status.replaceAll("_", "-")}`}>
                          {t(`whatsapp.messageStatus.${item.status}`)}
                        </span>
                        {category !== null && item.status !== "sent" ? (
                          <div className="form-hint">{t(`whatsapp.failure.${category}`)}</div>
                        ) : null}
                      </td>
                      <td>{item.attemptCount}</td>
                      <td>
                        {item.sentAt
                          ? formatDateTime(item.sentAt, locale)
                          : item.nextAttemptAt
                            ? formatDateTime(item.nextAttemptAt, locale)
                            : "—"}
                      </td>
                      <td>
                        <button
                          className="link-button"
                          onClick={() => void openDetail(item.id)}
                          type="button"
                        >
                          {t("common.open")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row-actions">
            <button
              className="button button-secondary"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
              type="button"
            >
              {t("whatsapp.opsPrevious")}
            </button>
            <span>{t("common.pageOf", { page, pageCount })}</span>
            <button
              className="button button-secondary"
              disabled={page >= pageCount}
              onClick={() => setPage((current) => current + 1)}
              type="button"
            >
              {t("whatsapp.opsNext")}
            </button>
          </div>
        </>
      ) : null}

      {detail !== undefined && !confirmingRetry ? (
        <Modal
          closeLabel={t("common.close")}
          onRequestClose={() => setDetail(undefined)}
          title={t("whatsapp.opsDetailTitle")}
          titleId="whatsapp-message-detail-title"
        >
          <dl>
            <div className="detail-line">
              <dt>{t("whatsapp.opsMessageId")}</dt>
              <dd className="mono" dir="ltr">
                {detail.id}
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.trader", { defaultValue: "Trader" })}</dt>
              <dd>{detail.traderName ?? "—"}</dd>
            </div>
            {detail.orderNumber ? (
              <div className="detail-line">
                <dt>{t("whatsapp.opsOrder")}</dt>
                <dd>
                  {detail.orderNumber}
                  {detail.orderStatus
                    ? ` · ${t(`statuses.${detail.orderStatus}`, { defaultValue: detail.orderStatus })}`
                    : ""}
                </dd>
              </div>
            ) : null}
            <div className="detail-line">
              <dt>{t("whatsapp.historyGroup")}</dt>
              <dd>
                {detail.groupNameSnapshot ?? "—"}{" "}
                <span className="mono" dir="ltr">
                  {shortGroupId(detail.providerGroupId)}
                </span>
              </dd>
            </div>
            <div className="detail-line">
              <dt>{t("whatsapp.messageLanguage")}</dt>
              <dd>{t(`whatsapp.language.${detail.messageLanguage}`)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("common.status")}</dt>
              <dd>
                <span className={`status-badge status-${detail.status.replaceAll("_", "-")}`}>
                  {t(`whatsapp.messageStatus.${detail.status}`)}
                </span>
              </dd>
            </div>
            {failureCategoryKey(detail.failureCode) !== null && detail.status !== "sent" ? (
              <div className="detail-line">
                <dt>{t("whatsapp.opsFailure")}</dt>
                <dd>{t(`whatsapp.failure.${failureCategoryKey(detail.failureCode)}`)}</dd>
              </div>
            ) : null}
            <div className="detail-line">
              <dt>{t("whatsapp.opsQueued")}</dt>
              <dd>{formatDateTime(detail.queuedAt, locale)}</dd>
            </div>
            {detail.sentAt ? (
              <div className="detail-line">
                <dt>{t("whatsapp.opsSentAt")}</dt>
                <dd>{formatDateTime(detail.sentAt, locale)}</dd>
              </div>
            ) : null}
            {detail.providerMessageId ? (
              <div className="detail-line">
                <dt>{t("whatsapp.opsProviderMessageId")}</dt>
                <dd className="mono" dir="ltr">
                  {detail.providerMessageId}
                </dd>
              </div>
            ) : null}
          </dl>
          <h3>{t("whatsapp.opsBody")}</h3>
          <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>
            {detail.messageBody}
          </pre>
          <h3>{t("whatsapp.opsAttemptHistory")}</h3>
          {detail.attempts.length === 0 ? (
            <p className="empty-state">{t("whatsapp.opsNoAttempts")}</p>
          ) : (
            <ul>
              {detail.attempts.map((attempt) => (
                <li key={attempt.attemptNumber}>
                  {t("whatsapp.opsAttemptLine", {
                    number: attempt.attemptNumber,
                    time: formatDateTime(attempt.completedAt ?? attempt.startedAt, locale),
                  })}{" "}
                  —{" "}
                  {attempt.result === "sent"
                    ? t("whatsapp.opsAttemptAccepted")
                    : t("whatsapp.opsAttemptFailed")}
                </li>
              ))}
            </ul>
          )}
          {canManage ? (
            <div className="modal-actions">
              {detail.status === "failed" ? (
                <button
                  className="button button-primary"
                  disabled={busy}
                  onClick={() => void act("retry", {})}
                  type="button"
                >
                  {t("whatsapp.opsRetry")}
                </button>
              ) : null}
              {detail.status === "requires_review" ? (
                <>
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => setConfirmingRetry(true)}
                    type="button"
                  >
                    {t("whatsapp.opsRetryAnyway")}
                  </button>
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => void act("resolve", { action: "mark_resolved" })}
                    type="button"
                  >
                    {t("whatsapp.opsMarkResolved")}
                  </button>
                </>
              ) : null}
              {["pending", "failed", "requires_review"].includes(detail.status) ? (
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void act("resolve", { action: "cancel" })}
                  type="button"
                >
                  {t("whatsapp.opsCancelMessage")}
                </button>
              ) : null}
            </div>
          ) : null}
        </Modal>
      ) : null}

      {detail !== undefined && confirmingRetry ? (
        <Modal
          closeLabel={t("common.close")}
          onRequestClose={() => setConfirmingRetry(false)}
          title={t("whatsapp.opsRetryWarningTitle")}
          titleId="whatsapp-retry-warning-title"
        >
          <p>{t("whatsapp.opsRetryWarningBody1")}</p>
          <p className="alert alert-warning">{t("whatsapp.opsRetryWarningBody2")}</p>
          <div className="modal-actions">
            <button
              className="button button-secondary"
              onClick={() => setConfirmingRetry(false)}
              type="button"
            >
              {t("common.cancel")}
            </button>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void act("retry", { confirmDuplicateRisk: true })}
              type="button"
            >
              {t("whatsapp.opsRetryAnyway")}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
