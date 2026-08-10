import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MessageSquare,
  Mic,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  UserCog,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type { OperationsOrderDetail } from "../../api/contracts.js";
import {
  CommunicationApi,
  type CommunicationEvent,
  type CommunicationMessage,
  type ConversationListFilters,
  type ConversationParticipantContext,
  type ConversationPriority,
  type ConversationStatus,
  type ConversationSummary,
} from "./communication-api.js";
import {
  CommunicationRealtimeConnection,
  communicationRealtimeUrl,
  type CommunicationRealtimeStatus,
} from "./communication-realtime.js";
import { VoiceMessagePlayer, VoiceRecorderControl } from "./communication-voice.js";

const PAGE_SIZE = 25;
// Company-wide badges/preview text have no per-conversation push channel (the
// realtime gateway is scoped to one open conversation) — a light poll is the
// documented fallback for that, never a parallel primary architecture.
const LIST_POLL_INTERVAL_MS = 20_000;

const STATUS_VALUES: readonly ConversationStatus[] = [
  "active",
  "waiting_for_office",
  "waiting_for_user",
  "resolved",
  "reopened",
];
const PRIORITY_VALUES: readonly ConversationPriority[] = ["normal", "high", "urgent"];
const CONTEXT_VALUES: readonly ConversationParticipantContext[] = ["trader", "driver", "customer"];

function requestMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.details === undefined || error.details.length === 0
      ? error.message
      : `${error.message}\n${error.details.join("\n")}`;
  }
  return error instanceof Error ? error.message : fallback;
}

function formatTimestamp(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/** Best-effort readable label for a System message's raw event type
 *  (`order.driver_assigned` → `Order driver assigned`) — a full per-event
 *  translation table is out of Prompt 13's scope. */
function formatSystemEventType(eventType: string | null): string {
  if (eventType === null) return "";
  return eventType.replaceAll(/[._]/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function CommunicationCenter({
  accessToken,
  api,
  currentAccountId,
  onNavigate,
  permissions,
}: {
  readonly accessToken: string;
  readonly api: ApiClient;
  readonly currentAccountId: string;
  readonly onNavigate: (target: string) => void;
  readonly permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new CommunicationApi(api), [api]);

  const canSend = permissions.includes("communication.operator.send");
  const canResolve = permissions.includes("communication.operator.resolve");
  const canReopen = permissions.includes("communication.operator.reopen");
  const canSetPriority = permissions.includes("communication.operator.priority");
  const canAssign = permissions.includes("communication.operator.assign");

  // --- Filters ----------------------------------------------------------
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ConversationStatus | "">("");
  const [contextFilter, setContextFilter] = useState<ConversationParticipantContext | "">("");
  const [priorityFilter, setPriorityFilter] = useState<ConversationPriority | "">("");
  const [unreadOnly, setUnreadOnly] = useState(false);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => globalThis.clearTimeout(timer);
  }, [searchInput]);

  const filters = useMemo<ConversationListFilters>(
    () => ({
      limit: PAGE_SIZE,
      ...(contextFilter === "" ? {} : { participantContextType: contextFilter }),
      ...(priorityFilter === "" ? {} : { priority: priorityFilter }),
      ...(search === "" ? {} : { search }),
      ...(statusFilter === "" ? {} : { status: statusFilter }),
      ...(unreadOnly ? { unreadOnly: true } : {}),
    }),
    [contextFilter, priorityFilter, search, statusFilter, unreadOnly],
  );

  // --- Conversation list --------------------------------------------------
  const [items, setItems] = useState<readonly ConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listError, setListError] = useState<string>();
  const [sessionExpired, setSessionExpired] = useState(false);
  const [activeId, setActiveId] = useState<string>();

  const loadList = useCallback(
    async (cursor?: string) => {
      if (cursor !== undefined) setListLoadingMore(true);
      else setListLoading(true);
      try {
        const page = await client.conversations(
          cursor === undefined ? filters : { ...filters, cursor },
        );
        setItems((previous) => (cursor === undefined ? page.items : [...previous, ...page.items]));
        setNextCursor(page.nextCursor);
        setListError(undefined);
        setSessionExpired(false);
        if (cursor === undefined) {
          setActiveId((previous) =>
            previous !== undefined && page.items.some((item) => item.id === previous)
              ? previous
              : page.items[0]?.id,
          );
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) setSessionExpired(true);
        else setListError(requestMessage(error, t("communication.errors.listFailed")));
      } finally {
        setListLoading(false);
        setListLoadingMore(false);
      }
    },
    [client, filters, t],
  );

  // Filters changed: always a fresh, first-page load (never appends).
  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    const timer = globalThis.setInterval(() => void loadList(), LIST_POLL_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, [loadList]);

  // Deriving `active` from the just-refreshed `items` (rather than holding a
  // separate copy) means every list refresh — polled or event-triggered —
  // automatically keeps the open conversation's status/priority/assignee in
  // sync with no separate "refetch this one conversation" endpoint needed.
  const active = useMemo(() => items.find((item) => item.id === activeId), [items, activeId]);

  const patchActiveInList = useCallback((updated: ConversationSummary) => {
    setItems((previous) => previous.map((item) => (item.id === updated.id ? updated : item)));
  }, []);

  // --- Messages for the open conversation ---------------------------------
  const [messages, setMessages] = useState<readonly CommunicationMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string>();
  const [earlierCursor, setEarlierCursor] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const deliveredIds = useRef(new Set<string>());

  const markReadThrough = useCallback(
    (conversationId: string, messageId: string) => {
      void client.markRead(conversationId, messageId).catch(() => undefined);
    },
    [client],
  );

  useEffect(() => {
    deliveredIds.current = new Set();
    setMessages([]);
    setEarlierCursor(null);
    setMessagesError(undefined);
    if (active === undefined) return;
    let alive = true;
    setMessagesLoading(true);
    void client
      .messages(active.id)
      .then((page) => {
        if (!alive) return;
        for (const item of page.items) deliveredIds.current.add(item.id);
        setMessages(page.items);
        setEarlierCursor(page.nextCursor);
        const last = page.items.at(-1);
        if (last !== undefined) markReadThrough(active.id, last.id);
      })
      .catch((error: unknown) => {
        if (alive)
          setMessagesError(requestMessage(error, t("communication.errors.messagesFailed")));
      })
      .finally(() => {
        if (alive) setMessagesLoading(false);
      });
    return () => {
      alive = false;
    };
    // Re-run only when the open conversation actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, client]);

  const loadEarlierMessages = useCallback(async () => {
    if (active === undefined || earlierCursor === null || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const query = new URLSearchParams({ before: earlierCursor, limit: String(PAGE_SIZE) });
      const page = await client.messages(active.id, query);
      setMessages((previous) => {
        const fresh = page.items.filter((item) => !deliveredIds.current.has(item.id));
        for (const item of fresh) deliveredIds.current.add(item.id);
        return [...fresh, ...previous];
      });
      setEarlierCursor(page.nextCursor);
    } catch (error) {
      setMessagesError(requestMessage(error, t("communication.errors.messagesFailed")));
    } finally {
      setLoadingEarlier(false);
    }
  }, [active, client, earlierCursor, loadingEarlier, t]);

  // --- Realtime: one live socket for the currently open conversation ------
  const [realtimeStatus, setRealtimeStatus] = useState<CommunicationRealtimeStatus>("closed");
  const [realtimeStale, setRealtimeStale] = useState(false);

  useEffect(() => {
    if (active === undefined) {
      setRealtimeStatus("closed");
      return;
    }
    setRealtimeStale(false);
    const url = communicationRealtimeUrl(active.id, accessToken);
    const connection = new CommunicationRealtimeConnection(url, {
      onEvent: (event: CommunicationEvent) => {
        if (event.type === "message.created") {
          // The event carries only identifiers by design (never message text
          // over the notification channel) — re-fetch the newest page and
          // append whatever wasn't already delivered (REST or a prior event).
          void client
            .messages(active.id)
            .then((page) => {
              setMessages((previous) => {
                const fresh = page.items.filter((item) => !deliveredIds.current.has(item.id));
                for (const item of fresh) deliveredIds.current.add(item.id);
                return fresh.length === 0 ? previous : [...previous, ...fresh];
              });
              const last = page.items.at(-1);
              if (last !== undefined) markReadThrough(active.id, last.id);
            })
            .catch(() => undefined);
        }
        // Status/priority/assignment/unread changes all resolve the same
        // way: refresh the list, which re-derives `active` with fresh data.
        void loadList();
      },
      onFullRefreshRequired: () => {
        setRealtimeStale(true);
        void loadList();
      },
      onStatusChange: setRealtimeStatus,
    });
    connection.connect();
    return () => connection.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, active?.id, client]);

  // --- Composer -------------------------------------------------------------
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string>();
  const sendKeys = useRef<{ clientMessageId: string; idempotencyKey: string } | undefined>(
    undefined,
  );
  const sending = useRef(false);

  const send = useCallback(async () => {
    if (active === undefined || !canSend || sending.current) return;
    const body = text.trim();
    if (body === "") return;
    // The same idempotency pair is reused across retries of the same draft —
    // a resend after a network failure can never create a duplicate message —
    // and only cleared once a send actually succeeds.
    sendKeys.current ??= {
      clientMessageId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    };
    const keys = sendKeys.current;
    sending.current = true;
    setSendError(undefined);
    try {
      const sent = await client.sendText({
        conversationId: active.id,
        idempotencyKey: keys.idempotencyKey,
        originalClientTime: new Date().toISOString(),
        text: body,
        clientMessageId: keys.clientMessageId,
      });
      if (!deliveredIds.current.has(sent.id)) {
        deliveredIds.current.add(sent.id);
        setMessages((previous) => [...previous, sent]);
      }
      markReadThrough(active.id, sent.id);
      sendKeys.current = undefined;
      setText("");
      void loadList();
    } catch (error) {
      setSendError(requestMessage(error, t("communication.errors.sendFailed")));
    } finally {
      sending.current = false;
    }
  }, [active, canSend, client, loadList, markReadThrough, t, text]);

  // --- Office actions: resolve / reopen / priority / assign -----------------
  const [actionError, setActionError] = useState<string>();
  const [actionPending, setActionPending] = useState(false);

  const runAction = useCallback(
    async (action: () => Promise<ConversationSummary>) => {
      setActionPending(true);
      setActionError(undefined);
      try {
        const updated = await action();
        patchActiveInList(updated);
      } catch (error) {
        setActionError(requestMessage(error, t("communication.errors.actionFailed")));
      } finally {
        setActionPending(false);
      }
    },
    [patchActiveInList, t],
  );

  // --- Order context panel ---------------------------------------------------
  const [orderDetail, setOrderDetail] = useState<OperationsOrderDetail>();
  const [orderContextError, setOrderContextError] = useState<"denied" | "failed">();
  const [orderContextLoading, setOrderContextLoading] = useState(false);

  useEffect(() => {
    setOrderDetail(undefined);
    setOrderContextError(undefined);
    if (active?.orderNumber === null || active?.orderNumber === undefined) return;
    let alive = true;
    setOrderContextLoading(true);
    void api
      .get<OperationsOrderDetail>(
        `operations/order-details/${encodeURIComponent(active.orderNumber)}`,
      )
      .then((detail) => {
        if (alive) setOrderDetail(detail);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setOrderContextError(
          error instanceof ApiError && error.status === 403 ? "denied" : "failed",
        );
      })
      .finally(() => {
        if (alive) setOrderContextLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, active?.orderNumber]);

  // --- Render -----------------------------------------------------------------
  if (sessionExpired) {
    return (
      <section aria-labelledby="communication-title" className="communication-center">
        <header className="communication-heading">
          <h1 id="communication-title">{t("communication.title")}</h1>
        </header>
        <div className="communication-panel communication-empty" role="alert">
          <AlertTriangle aria-hidden="true" />
          <h2>{t("communication.sessionExpiredTitle")}</h2>
          <p>{t("communication.sessionExpiredDescription")}</p>
          <button
            className="button button-primary"
            onClick={() => globalThis.location.reload()}
            type="button"
          >
            {t("communication.reload")}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="communication-title" className="communication-center">
      <header className="communication-heading">
        <div>
          <h1 id="communication-title">{t("communication.title")}</h1>
          <p>{t("communication.description")}</p>
        </div>
        <span className="status-badge">
          <ShieldCheck aria-hidden="true" />
          {t("communication.secure")}
        </span>
      </header>

      <div className="communication-layout">
        {/* --- Left: conversation list --- */}
        <aside
          aria-label={t("communication.conversations")}
          className="communication-panel communication-list-panel"
        >
          <div className="communication-search">
            <Search aria-hidden="true" />
            <input
              aria-label={t("communication.search")}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t("communication.search")}
              type="search"
              value={searchInput}
            />
            <button
              aria-label={t("communication.refresh")}
              className="icon-button"
              onClick={() => void loadList()}
              type="button"
            >
              <RefreshCw aria-hidden="true" />
            </button>
          </div>

          <div className="communication-filters">
            <select
              aria-label={t("communication.filters.status")}
              onChange={(event) => setStatusFilter(event.target.value as ConversationStatus | "")}
              value={statusFilter}
            >
              <option value="">{t("communication.filters.allStatuses")}</option>
              {STATUS_VALUES.map((value) => (
                <option key={value} value={value}>
                  {t(`communication.status.${value}`)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("communication.filters.type")}
              onChange={(event) =>
                setContextFilter(event.target.value as ConversationParticipantContext | "")
              }
              value={contextFilter}
            >
              <option value="">{t("communication.filters.allTypes")}</option>
              {CONTEXT_VALUES.map((value) => (
                <option key={value} value={value}>
                  {t(`communication.participantType.${value}`)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("communication.filters.priority")}
              onChange={(event) =>
                setPriorityFilter(event.target.value as ConversationPriority | "")
              }
              value={priorityFilter}
            >
              <option value="">{t("communication.filters.allPriorities")}</option>
              {PRIORITY_VALUES.map((value) => (
                <option key={value} value={value}>
                  {t(`communication.priority.${value}`)}
                </option>
              ))}
            </select>
            <label className="communication-unread-toggle">
              <input
                checked={unreadOnly}
                onChange={(event) => setUnreadOnly(event.target.checked)}
                type="checkbox"
              />
              {t("communication.filters.unreadOnly")}
            </label>
          </div>

          {listError !== undefined && (
            <p className="communication-error" role="alert">
              {listError}
            </p>
          )}

          {listLoading ? (
            <p className="communication-loading">
              <Loader2 aria-hidden="true" className="spin" />
              {t("communication.loadingConversations")}
            </p>
          ) : items.length === 0 ? (
            <p className="communication-empty-note">{t("communication.noConversations")}</p>
          ) : (
            <ul className="communication-conversation-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    aria-current={item.id === active?.id}
                    className={
                      item.id === active?.id
                        ? "communication-conversation active"
                        : "communication-conversation"
                    }
                    onClick={() => setActiveId(item.id)}
                    type="button"
                  >
                    <span className="communication-conversation-top">
                      <strong>
                        {item.orderNumber ?? item.subject ?? t("communication.generalSupport")}
                      </strong>
                      {item.unreadCount > 0 && (
                        <b
                          aria-label={t("communication.unreadBadge", { count: item.unreadCount })}
                          className="communication-unread-badge"
                        >
                          {item.unreadCount}
                        </b>
                      )}
                    </span>
                    <span className="communication-conversation-meta">
                      {t(`communication.participantType.${item.participantContextType}`)}
                      {item.participantName !== null ? ` · ${item.participantName}` : ""}
                    </span>
                    <small className="communication-conversation-preview">
                      {item.lastMessagePreview === "voice_message" ? (
                        <span className="communication-voice-preview-label">
                          <Mic aria-hidden="true" />
                          {t("communication.voice.messageLabel")}
                        </span>
                      ) : (
                        (item.lastMessagePreview ?? t("communication.noMessagesYet"))
                      )}
                    </small>
                    <span className="communication-conversation-badges">
                      <span className={`status-pill communication-status-${item.status}`}>
                        {t(`communication.status.${item.status}`)}
                      </span>
                      {item.priority !== "normal" && (
                        <span className={`status-pill communication-priority-${item.priority}`}>
                          {t(`communication.priority.${item.priority}`)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {nextCursor !== null && (
            <button
              className="button button-secondary button-compact"
              disabled={listLoadingMore}
              onClick={() => void loadList(nextCursor)}
              type="button"
            >
              {listLoadingMore ? t("communication.loading") : t("communication.loadMore")}
            </button>
          )}
        </aside>

        {/* --- Center: active chat --- */}
        <main
          aria-label={t("communication.activeConversation")}
          className="communication-panel communication-thread-panel"
        >
          {active === undefined ? (
            <div className="communication-empty">
              <MessageSquare aria-hidden="true" />
              <p>{t("communication.selectConversation")}</p>
            </div>
          ) : (
            <>
              <header className="communication-thread-header">
                <div>
                  <h2>
                    {active.orderNumber ?? active.subject ?? t("communication.generalSupport")}
                  </h2>
                  <small>
                    {t(`communication.participantType.${active.participantContextType}`)}
                    {active.participantName !== null ? ` · ${active.participantName}` : ""}
                  </small>
                </div>
                <div className="communication-thread-status">
                  {realtimeStatus === "open" && (
                    <span className="communication-realtime-indicator communication-realtime-live">
                      {t("communication.realtime.live")}
                    </span>
                  )}
                  {(realtimeStatus === "connecting" || realtimeStatus === "reconnecting") && (
                    <span className="communication-realtime-indicator communication-realtime-pending">
                      <WifiOff aria-hidden="true" />
                      {t(`communication.realtime.${realtimeStatus}`)}
                    </span>
                  )}
                  {realtimeStatus === "closed" && (
                    <span className="communication-realtime-indicator communication-realtime-pending">
                      <WifiOff aria-hidden="true" />
                      {t("communication.realtime.offline")}
                    </span>
                  )}
                </div>
              </header>

              {realtimeStale && (
                <p className="communication-notice" role="status">
                  {t("communication.realtime.fullRefreshNotice")}
                </p>
              )}

              {(canResolve || canReopen || canSetPriority || canAssign) && (
                <div className="communication-actions">
                  {canResolve && active.status !== "resolved" && (
                    <button
                      className="button button-secondary button-compact"
                      disabled={actionPending}
                      onClick={() => void runAction(() => client.resolveStatus(active.id))}
                      type="button"
                    >
                      <CheckCircle2 aria-hidden="true" />
                      {t("communication.actions.resolve")}
                    </button>
                  )}
                  {canReopen && active.status === "resolved" && (
                    <button
                      className="button button-secondary button-compact"
                      disabled={actionPending}
                      onClick={() => void runAction(() => client.reopen(active.id))}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" />
                      {t("communication.actions.reopen")}
                    </button>
                  )}
                  {canSetPriority && (
                    <select
                      aria-label={t("communication.actions.setPriority")}
                      disabled={actionPending}
                      onChange={(event) =>
                        void runAction(() =>
                          client.setPriority(active.id, event.target.value as ConversationPriority),
                        )
                      }
                      value={active.priority}
                    >
                      {PRIORITY_VALUES.map((value) => (
                        <option key={value} value={value}>
                          {t(`communication.priority.${value}`)}
                        </option>
                      ))}
                    </select>
                  )}
                  {canAssign &&
                    (active.assignedOperatorAccountId === currentAccountId ? (
                      <button
                        className="button button-secondary button-compact"
                        disabled={actionPending}
                        onClick={() => void runAction(() => client.assign(active.id, undefined))}
                        type="button"
                      >
                        <UserCog aria-hidden="true" />
                        {t("communication.actions.unassign")}
                      </button>
                    ) : (
                      <button
                        className="button button-secondary button-compact"
                        disabled={actionPending}
                        onClick={() =>
                          void runAction(() => client.assign(active.id, currentAccountId))
                        }
                        type="button"
                      >
                        <UserCog aria-hidden="true" />
                        {t("communication.actions.assignToMe")}
                      </button>
                    ))}
                  {active.assignedOperatorName !== null && (
                    <small className="communication-assignee">
                      {t("communication.actions.assignedTo", { name: active.assignedOperatorName })}
                    </small>
                  )}
                </div>
              )}

              {actionError !== undefined && (
                <p className="communication-error" role="alert">
                  {actionError}
                </p>
              )}

              <div aria-live="polite" className="communication-messages">
                {earlierCursor !== null && (
                  <button
                    className="button button-secondary button-compact"
                    disabled={loadingEarlier}
                    onClick={() => void loadEarlierMessages()}
                    type="button"
                  >
                    {loadingEarlier ? t("communication.loading") : t("communication.loadEarlier")}
                  </button>
                )}
                {messagesLoading ? (
                  <p className="communication-loading">
                    <Loader2 aria-hidden="true" className="spin" />
                  </p>
                ) : messagesError !== undefined ? (
                  <p className="communication-error" role="alert">
                    {messagesError}
                  </p>
                ) : messages.length === 0 ? (
                  <p className="communication-empty-note">{t("communication.noMessagesYet")}</p>
                ) : (
                  messages.map((item) =>
                    item.messageType === "system" ? (
                      <p className="communication-system-message" key={item.id}>
                        {formatSystemEventType(item.systemEventType)}
                      </p>
                    ) : (
                      <article
                        className={
                          item.senderRole === "office"
                            ? "communication-message sent"
                            : "communication-message received"
                        }
                        key={item.id}
                      >
                        <small>
                          {t(`communication.senderRole.${item.senderRole}`)} ·{" "}
                          {formatTimestamp(item.createdAt)}
                        </small>
                        {item.messageType === "voice" ? (
                          <VoiceMessagePlayer client={client} message={item} />
                        ) : (
                          <p>
                            {item.messageType === "voice_placeholder"
                              ? t("communication.voiceUnavailable")
                              : item.text}
                          </p>
                        )}
                      </article>
                    ),
                  )
                )}
              </div>

              {canSend ? (
                <footer className="communication-composer">
                  {sendError !== undefined && (
                    <p className="communication-error" role="alert">
                      {sendError}
                    </p>
                  )}
                  <div className="communication-composer-row">
                    <textarea
                      aria-label={t("communication.composerPlaceholder")}
                      disabled={active.status === "resolved"}
                      onChange={(event) => setText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                      placeholder={t("communication.composerPlaceholder")}
                      value={text}
                    />
                    <button
                      className="button button-primary"
                      disabled={text.trim() === "" || active.status === "resolved"}
                      onClick={() => void send()}
                      type="button"
                    >
                      <Send aria-hidden="true" />
                      {t("communication.send")}
                    </button>
                  </div>
                  {active.status === "resolved" && (
                    <small>{t("communication.resolvedComposerHint")}</small>
                  )}
                  <VoiceRecorderControl
                    client={client}
                    conversationId={active.id}
                    disabled={active.status === "resolved"}
                    onSent={(sent) => {
                      if (!deliveredIds.current.has(sent.id)) {
                        deliveredIds.current.add(sent.id);
                        setMessages((previous) => [...previous, sent]);
                      }
                      markReadThrough(active.id, sent.id);
                      void loadList();
                    }}
                  />
                </footer>
              ) : (
                <p className="communication-notice">{t("communication.sendPermissionDenied")}</p>
              )}
            </>
          )}
        </main>

        {/* --- Right: Order context --- */}
        <aside
          aria-label={t("communication.orderContext")}
          className="communication-panel communication-context-panel"
        >
          <h2>{t("communication.orderContext")}</h2>
          {active?.orderNumber === null || active?.orderNumber === undefined ? (
            <p className="communication-empty-note">{t("communication.noContext")}</p>
          ) : orderContextLoading ? (
            <p className="communication-loading">
              <Loader2 aria-hidden="true" className="spin" />
            </p>
          ) : orderContextError === "denied" ? (
            <p className="communication-empty-note">{t("communication.contextPermissionDenied")}</p>
          ) : orderContextError === "failed" ? (
            <p className="communication-error" role="alert">
              {t("communication.contextLoadFailed")}
            </p>
          ) : orderDetail === undefined ? (
            <p className="communication-empty-note">{t("communication.noContext")}</p>
          ) : (
            <dl className="communication-context-fields">
              <div>
                <dt>{t("communication.context.orderNumber")}</dt>
                <dd>{orderDetail.orderNumber}</dd>
              </div>
              {orderDetail.referenceNumber !== undefined &&
                orderDetail.referenceNumber !== null && (
                  <div>
                    <dt>{t("communication.context.reference")}</dt>
                    <dd>{orderDetail.referenceNumber}</dd>
                  </div>
                )}
              <div>
                <dt>{t("communication.context.customer")}</dt>
                <dd>{orderDetail.customerName}</dd>
              </div>
              <div>
                <dt>{t("communication.context.mobile")}</dt>
                <dd>{orderDetail.customerMobileNumber}</dd>
              </div>
              {(orderDetail.emirateNameEn !== undefined ||
                orderDetail.emirateNameAr !== undefined) && (
                <div>
                  <dt>{t("communication.context.emirate")}</dt>
                  <dd>{orderDetail.emirateNameEn ?? orderDetail.emirateNameAr}</dd>
                </div>
              )}
              <div>
                <dt>{t("communication.context.area")}</dt>
                <dd>{orderDetail.areaName}</dd>
              </div>
              <div>
                <dt>{t("communication.context.address")}</dt>
                <dd>{orderDetail.customerAddress}</dd>
              </div>
              <div>
                <dt>{t("communication.context.deliveryStatus")}</dt>
                <dd>{orderDetail.deliveryStatus}</dd>
              </div>
              <div>
                <dt>{t("communication.context.cod")}</dt>
                <dd>{orderDetail.codAmount}</dd>
              </div>
              <div>
                <dt>{t("communication.context.trader")}</dt>
                <dd>{orderDetail.traderName}</dd>
              </div>
              <div>
                <dt>{t("communication.context.driver")}</dt>
                <dd>
                  {orderDetail.assignedDriverName ?? t("communication.context.driverUnassigned")}
                </dd>
              </div>
              <button
                className="button button-secondary button-compact"
                onClick={() => onNavigate(`/orders/${encodeURIComponent(orderDetail.orderNumber)}`)}
                type="button"
              >
                <ExternalLink aria-hidden="true" />
                {t("communication.context.viewOrder")}
              </button>
            </dl>
          )}
        </aside>
      </div>
    </section>
  );
}
