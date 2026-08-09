import { MessageSquare, Mic, Search, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

export function CommunicationCenter() {
  const { t } = useTranslation();
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
        <aside aria-label={t("communication.conversations")} className="communication-panel">
          <label className="communication-search">
            <Search aria-hidden="true" />
            <span>{t("communication.search")}</span>
            <input disabled type="search" />
          </label>
          <div className="communication-empty">
            <MessageSquare aria-hidden="true" />
            <strong>{t("communication.noConversations")}</strong>
          </div>
        </aside>
        <main className="communication-panel communication-thread" role="status">
          <MessageSquare aria-hidden="true" />
          <h2>{t("communication.unavailableTitle")}</h2>
          <p>{t("communication.unavailableDescription")}</p>
          <button disabled type="button">
            <Mic aria-hidden="true" />
            {t("communication.voiceUnavailable")}
          </button>
        </main>
        <aside aria-label={t("communication.orderContext")} className="communication-panel">
          <h2>{t("communication.orderContext")}</h2>
          <p>{t("communication.noContext")}</p>
        </aside>
      </div>
    </section>
  );
}
