import { useCallback, useEffect, useState, type ReactElement } from "react";

import {
  PlatformApiError,
  platformApi,
  type CompanyWhatsAppMessagesPage,
  type CompanyWhatsAppOverview,
  type CompanyWhatsAppTemplate,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

const STATUS_LABELS: Record<string, string> = {
  assigned_to_driver: "Assigned to driver",
  cancelled: "Cancelled",
  delivered: "Delivered",
  out_for_delivery: "Out for delivery",
  returned_to_branch: "Returned to branch",
  returned_to_trader: "Returned to trader",
};

/**
 * Platform Administration → Company → WhatsApp: the per-Company
 * enable/disable switch, message-template overrides (per status, Arabic +
 * English, placeholder-based) and the Company's message history with a date
 * range and totals.
 */
export function CompanyWhatsAppPanel({ companyId }: { companyId: string }): ReactElement {
  const session = usePlatformSession();
  const canManage = session.can("platform.company_whatsapp.manage");
  const [overview, setOverview] = useState<CompanyWhatsAppOverview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [disableReason, setDisableReason] = useState("");
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [editingStatus, setEditingStatus] = useState<string>();
  const [draftAr, setDraftAr] = useState("");
  const [draftEn, setDraftEn] = useState("");

  const [messages, setMessages] = useState<CompanyWhatsAppMessagesPage>();
  const [messagesError, setMessagesError] = useState<string>();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    try {
      setOverview(await platformApi.companyWhatsApp(companyId));
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof PlatformApiError
          ? failure.message
          : "WhatsApp settings could not be loaded.",
      );
    }
  }, [companyId]);

  const loadMessages = useCallback(async () => {
    try {
      setMessages(
        await platformApi.companyWhatsAppMessages(companyId, {
          ...(fromDate ? { from: fromDate } : {}),
          ...(toDate ? { to: toDate } : {}),
          page,
          pageSize: 25,
        }),
      );
      setMessagesError(undefined);
    } catch (failure) {
      setMessagesError(
        failure instanceof PlatformApiError ? failure.message : "Messages could not be loaded.",
      );
    }
  }, [companyId, fromDate, toDate, page]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  async function run(
    work: () => Promise<CompanyWhatsAppOverview>,
    fallback: string,
  ): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setOverview(await work());
    } catch (failure) {
      setError(failure instanceof PlatformApiError ? failure.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  function startEditing(template: CompanyWhatsAppTemplate): void {
    setEditingStatus(template.status);
    setDraftAr(template.bodyAr);
    setDraftEn(template.bodyEn);
  }

  const enabled = overview?.enabled ?? true;

  return (
    <section aria-labelledby="company-whatsapp-heading" className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h3 id="company-whatsapp-heading">WhatsApp</h3>
          <p className="platform-muted">
            Trader group notifications: availability, message wording, and history
          </p>
        </div>
      </div>
      {error ? <p className="platform-warning">{error}</p> : null}
      {overview === undefined ? (
        <p>Loading WhatsApp settings…</p>
      ) : (
        <>
          <h4>Availability</h4>
          <p>
            WhatsApp is <strong>{enabled ? "enabled" : "disabled"}</strong> for this company.
            {!enabled && overview.disabledReason ? ` Reason: ${overview.disabledReason}` : ""}
          </p>
          <p className="platform-muted">
            Connection: {overview.connection?.status ?? "never configured"}
            {overview.connection?.connectedPhoneNumber
              ? ` · ${overview.connection.connectedPhoneNumber}`
              : ""}
          </p>
          {canManage ? (
            enabled ? (
              confirmingDisable ? (
                <div className="platform-form">
                  <label className="platform-field">
                    <span>Reason shown to the company (optional)</span>
                    <input
                      maxLength={500}
                      onChange={(event) => setDisableReason(event.target.value)}
                      value={disableReason}
                    />
                  </label>
                  <div className="platform-actions">
                    <button
                      className="platform-button platform-button--quiet"
                      onClick={() => setConfirmingDisable(false)}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="platform-button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            platformApi.setCompanyWhatsAppEnabled(
                              companyId,
                              false,
                              disableReason.trim() || undefined,
                            ),
                          "WhatsApp could not be disabled.",
                        ).then(() => setConfirmingDisable(false))
                      }
                      type="button"
                    >
                      Disable WhatsApp
                    </button>
                  </div>
                  <p className="platform-muted">
                    Disabling stops all notifications, test messages and connection actions for this
                    company. The paired session and Trader group mappings are kept, so re-enabling
                    restores service without re-scanning a QR code.
                  </p>
                </div>
              ) : (
                <div className="platform-actions">
                  <button
                    className="platform-button platform-button--quiet"
                    disabled={busy}
                    onClick={() => setConfirmingDisable(true)}
                    type="button"
                  >
                    Disable WhatsApp
                  </button>
                </div>
              )
            ) : (
              <div className="platform-actions">
                <button
                  className="platform-button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => platformApi.setCompanyWhatsAppEnabled(companyId, true),
                      "WhatsApp could not be enabled.",
                    )
                  }
                  type="button"
                >
                  Enable WhatsApp
                </button>
              </div>
            )
          ) : null}

          <h4>Message templates</h4>
          <p className="platform-muted">
            Each order status has a default bilingual message. Turn a status off and this company
            sends no notification for it; editing a template changes future messages for this
            company only — already-sent messages are never rewritten. Placeholders:{" "}
            {overview.placeholders.map((name) => `{{${name}}}`).join(", ")}
          </p>
          <table className="platform-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Sending</th>
                <th scope="col">Wording</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {overview.templates.map((template) => (
                <tr key={template.status}>
                  <td>{STATUS_LABELS[template.status] ?? template.status}</td>
                  <td>{template.enabled ? "On" : "Off"}</td>
                  <td>{template.isCustom ? "Custom" : "Default"}</td>
                  <td>
                    {canManage ? (
                      <div className="platform-actions">
                        <button
                          className="platform-button platform-button--quiet"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () =>
                                platformApi.setCompanyWhatsAppStatuses(
                                  companyId,
                                  overview.templates
                                    .filter((row) =>
                                      row.status === template.status
                                        ? !template.enabled
                                        : row.enabled,
                                    )
                                    .map((row) => row.status),
                                ),
                              "Status selection could not be saved.",
                            )
                          }
                          type="button"
                        >
                          {template.enabled ? "Turn off" : "Turn on"}
                        </button>
                        <button
                          className="platform-button platform-button--quiet"
                          onClick={() => startEditing(template)}
                          type="button"
                        >
                          Edit
                        </button>
                        {template.isCustom ? (
                          <button
                            className="platform-button platform-button--quiet"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  platformApi.resetCompanyWhatsAppTemplate(
                                    companyId,
                                    template.status,
                                  ),
                                "Template could not be reset.",
                              )
                            }
                            type="button"
                          >
                            Reset to default
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <span className="platform-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {editingStatus !== undefined ? (
            <div className="platform-form">
              <h4>Edit “{STATUS_LABELS[editingStatus] ?? editingStatus}” message</h4>
              <label className="platform-field">
                <span>Arabic message</span>
                <textarea
                  dir="rtl"
                  maxLength={2000}
                  onChange={(event) => setDraftAr(event.target.value)}
                  rows={6}
                  value={draftAr}
                />
              </label>
              <label className="platform-field">
                <span>English message</span>
                <textarea
                  maxLength={2000}
                  onChange={(event) => setDraftEn(event.target.value)}
                  rows={6}
                  value={draftEn}
                />
              </label>
              <div className="platform-actions">
                <button
                  className="platform-button platform-button--quiet"
                  onClick={() => setEditingStatus(undefined)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="platform-button"
                  disabled={busy || draftAr.trim() === "" || draftEn.trim() === ""}
                  onClick={() =>
                    void run(
                      () =>
                        platformApi.updateCompanyWhatsAppTemplate(companyId, editingStatus, {
                          bodyAr: draftAr,
                          bodyEn: draftEn,
                        }),
                      "Template could not be saved.",
                    ).then(() => setEditingStatus(undefined))
                  }
                  type="button"
                >
                  Save template
                </button>
              </div>
            </div>
          ) : null}

          <h4>Messages</h4>
          <div className="platform-actions">
            <label className="platform-field">
              <span>From</span>
              <input
                onChange={(event) => {
                  setFromDate(event.target.value);
                  setPage(1);
                }}
                type="date"
                value={fromDate}
              />
            </label>
            <label className="platform-field">
              <span>To</span>
              <input
                onChange={(event) => {
                  setToDate(event.target.value);
                  setPage(1);
                }}
                type="date"
                value={toDate}
              />
            </label>
          </div>
          {messagesError ? <p className="platform-warning">{messagesError}</p> : null}
          {messages === undefined ? (
            <p>Loading messages…</p>
          ) : (
            <>
              <p className="platform-muted">
                {messages.totals.total} message{messages.totals.total === 1 ? "" : "s"}
                {" · "}
                {messages.totals.sent} sent · {messages.totals.pending} pending ·{" "}
                {messages.totals.failed} failed
              </p>
              {messages.items.length === 0 ? (
                <p className="platform-muted">No messages in this period.</p>
              ) : (
                <table className="platform-table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Type</th>
                      <th scope="col">Order</th>
                      <th scope="col">Trader</th>
                      <th scope="col">Group</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.items.map((message) => (
                      <tr key={message.id}>
                        <td>{new Date(message.createdAt).toLocaleString()}</td>
                        <td>{message.messageType === "test" ? "Test" : "Order status"}</td>
                        <td>{message.orderNumber ?? "—"}</td>
                        <td>{message.traderName ?? "—"}</td>
                        <td>{message.groupNameSnapshot ?? "—"}</td>
                        <td>
                          {message.status}
                          {message.failureCode ? ` (${message.failureCode})` : ""}
                          <details>
                            <summary>Message text</summary>
                            <pre className="platform-muted" style={{ whiteSpace: "pre-wrap" }}>
                              {message.messageBody}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="platform-actions">
                <button
                  className="platform-button platform-button--quiet"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => current - 1)}
                  type="button"
                >
                  Previous
                </button>
                <span className="platform-muted">Page {messages.page}</span>
                <button
                  className="platform-button platform-button--quiet"
                  disabled={messages.page * messages.pageSize >= messages.totals.total}
                  onClick={() => setPage((current) => current + 1)}
                  type="button"
                >
                  Next
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
