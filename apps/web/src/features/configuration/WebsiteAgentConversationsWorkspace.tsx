import { Bot, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { PageHeader } from "../../components/PageHeader.js";

type ConversationSummary = {
  id: string;
  contactNumber: string | null;
  language: "en" | "ar";
  messageCount: number;
  handoffState: string;
  sourceHostname: string | null;
  createdAt: string;
  updatedAt: string;
};
type ConversationDetail = ConversationSummary & {
  messages: readonly { role: "user" | "assistant"; content: string }[];
};

export function WebsiteAgentConversationsWorkspace({ api }: { api: ApiClient }) {
  const { i18n, t } = useTranslation();
  const [items, setItems] = useState<readonly ConversationSummary[]>([]);
  const [selected, setSelected] = useState<ConversationDetail>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void api
      .get<readonly ConversationSummary[]>(
        "configuration/website-agent/conversations",
        controller.signal,
      )
      .then(setItems)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [api, refresh]);

  async function open(id: string) {
    setFailed(false);
    try {
      setSelected(
        await api.get<ConversationDetail>(`configuration/website-agent/conversations/${id}`),
      );
    } catch {
      setFailed(true);
    }
  }

  const locale = i18n.resolvedLanguage?.startsWith("ar") ? "ar-AE" : "en-AE";
  return (
    <section>
      <PageHeader
        eyebrow={t("nav.configuration")}
        title={t("websiteAgentInbox.title")}
        actions={
          <button
            className="button button-secondary"
            onClick={() => setRefresh((value) => value + 1)}
            type="button"
          >
            <RefreshCw size={17} /> {t("common.refresh")}
          </button>
        }
      />
      <p className="page-description">{t("websiteAgentInbox.description")}</p>
      {failed ? (
        <p className="form-error" role="alert">
          {t("websiteAgentInbox.loadError")}
        </p>
      ) : null}
      <div className="agent-inbox">
        <section
          className="detail-panel agent-inbox__list"
          aria-label={t("websiteAgentInbox.conversations")}
        >
          {loading ? (
            <p>{t("common.loading")}</p>
          ) : items.length === 0 ? (
            <p>{t("websiteAgentInbox.empty")}</p>
          ) : (
            items.map((item) => (
              <button
                className={
                  selected?.id === item.id ? "agent-inbox__item is-active" : "agent-inbox__item"
                }
                key={item.id}
                onClick={() => void open(item.id)}
                type="button"
              >
                <span>
                  <strong>{item.contactNumber ?? t("websiteAgentInbox.notProvided")}</strong>
                  <small>{item.sourceHostname ?? t("websiteAgentInbox.websiteVisitor")}</small>
                </span>
                <span>
                  <small>
                    {item.language.toUpperCase()} · {item.messageCount}
                  </small>
                  <time>{new Date(item.updatedAt).toLocaleString(locale)}</time>
                </span>
              </button>
            ))
          )}
        </section>
        <section
          className="detail-panel agent-inbox__detail"
          aria-label={t("websiteAgentInbox.transcript")}
        >
          {!selected ? (
            <div className="empty-state">
              <Bot size={28} />
              <p>{t("websiteAgentInbox.select")}</p>
            </div>
          ) : (
            <>
              <header>
                <h2>{selected.contactNumber ?? t("websiteAgentInbox.notProvided")}</h2>
                <p>
                  {selected.sourceHostname} · {selected.language.toUpperCase()} ·{" "}
                  {new Date(selected.createdAt).toLocaleString(locale)}
                </p>
              </header>
              <div className="agent-inbox__messages">
                {selected.messages.length === 0 ? (
                  <p>{t("websiteAgentInbox.noMessages")}</p>
                ) : (
                  selected.messages.map((message, index) => (
                    <article
                      className={`agent-inbox__message agent-inbox__message--${message.role}`}
                      key={`${message.role}-${index}`}
                    >
                      <strong>
                        {message.role === "user"
                          ? t("websiteAgentInbox.customer")
                          : t("websiteAgentInbox.assistant")}
                      </strong>
                      <p>{message.content}</p>
                    </article>
                  ))
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
