import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";

type Action = "track" | "request_delivery" | "services" | "coverage" | "contact" | "whatsapp";
type Message = { role: "assistant" | "user"; content: string };

const labels = {
  en: {
    launcher: "Open website assistant",
    close: "Close assistant",
    title: "Website assistant",
    placeholder: "Ask about delivery…",
    send: "Send",
    unavailable:
      "The assistant is temporarily unavailable. You can still track a shipment, request delivery, or contact us.",
    actions: {
      track: "Track Shipment",
      request_delivery: "Request Delivery",
      services: "Services",
      coverage: "Coverage Areas",
      contact: "Contact Us",
      whatsapp: "WhatsApp",
    },
  },
  ar: {
    launcher: "فتح مساعد الموقع",
    close: "إغلاق المساعد",
    title: "مساعد الموقع",
    placeholder: "اسأل عن التوصيل…",
    send: "إرسال",
    unavailable: "المساعد غير متاح مؤقتاً. لا يزال بإمكانك تتبع شحنة أو طلب توصيل أو التواصل معنا.",
    actions: {
      track: "تتبع الشحنة",
      request_delivery: "اطلب توصيلاً",
      services: "الخدمات",
      coverage: "مناطق التغطية",
      contact: "اتصل بنا",
      whatsapp: "واتساب",
    },
  },
} as const;

export default function CompanyWebsiteAgent({
  agent,
  apiBase,
  language,
  overrideHost,
}: {
  agent: { displayName?: string; suggestedActions: Action[] };
  apiBase: string;
  language: "en" | "ar";
  overrideHost?: string;
}): ReactElement {
  const t = labels[language];
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string>();
  const [name, setName] = useState(agent.displayName ?? t.title);
  const [messages, setMessages] = useState<Message[]>([]);
  const [actions, setActions] = useState<Action[]>(agent.suggestedActions);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const headers = {
    "Content-Type": "application/json",
    ...(overrideHost ? { "x-blueline-tenant-host": overrideHost } : {}),
  };

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  async function begin(): Promise<void> {
    if (token || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`${apiBase}/public/company-website/agent/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ language }),
      });
      if (!response.ok) throw new Error("agent_unavailable");
      const result = (await response.json()) as {
        conversationToken: string;
        assistantName: string;
        message: string;
        suggestedActions: Action[];
      };
      setToken(result.conversationToken);
      setName(result.assistantName);
      setMessages([{ role: "assistant", content: result.message }]);
      setActions(result.suggestedActions);
    } catch {
      setFailed(true);
      setMessages([{ role: "assistant", content: t.unavailable }]);
    } finally {
      setBusy(false);
    }
  }
  function toggle(): void {
    const next = !open;
    setOpen(next);
    if (next) void begin();
  }
  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const message = String(data.get("message") ?? "").trim();
    if (!message) return;
    setMessages((current) => [...current, { role: "user", content: message }]);
    form.reset();
    setBusy(true);
    try {
      const response = await fetch(
        `${apiBase}/public/company-website/agent/conversations/${encodeURIComponent(token)}/messages`,
        { method: "POST", headers, body: JSON.stringify({ message, language }) },
      );
      if (!response.ok) throw new Error("agent_unavailable");
      const result = (await response.json()) as {
        reply: string;
        assistantName: string;
        suggestedActions: Action[];
      };
      setName(result.assistantName);
      setActions(result.suggestedActions);
      setMessages((current) => [...current, { role: "assistant", content: result.reply }]);
    } catch {
      setFailed(true);
      setMessages((current) => [...current, { role: "assistant", content: t.unavailable }]);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }
  function action(action: Action): void {
    const target =
      action === "track" ? "tracking" : action === "request_delivery" ? "request-delivery" : action;
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setOpen(false);
  }
  return (
    <aside className="company-agent" dir={language === "ar" ? "rtl" : "ltr"}>
      {open ? (
        <section
          aria-label={name}
          aria-modal="false"
          className="company-agent__panel"
          role="dialog"
        >
          <header>
            <strong>{name}</strong>
            <button aria-label={t.close} onClick={() => setOpen(false)} type="button">
              ×
            </button>
          </header>
          <div aria-live="polite" className="company-agent__messages">
            {messages.map((message, index) => (
              <p
                className={`company-agent__message company-agent__message--${message.role}`}
                key={`${message.role}-${index}`}
              >
                {message.content}
              </p>
            ))}
          </div>
          {!failed && actions.length ? (
            <nav aria-label="Suggested actions">
              {actions.map((item) => (
                <button key={item} onClick={() => action(item)} type="button">
                  {t.actions[item]}
                </button>
              ))}
            </nav>
          ) : null}
          <form onSubmit={(event) => void send(event)}>
            <label className="sr-only" htmlFor="company-agent-message">
              {t.placeholder}
            </label>
            <input
              autoComplete="off"
              disabled={!token || busy}
              id="company-agent-message"
              maxLength={1000}
              name="message"
              placeholder={t.placeholder}
              ref={input}
            />
            <button disabled={!token || busy} type="submit">
              {t.send}
            </button>
          </form>
        </section>
      ) : null}
      <button
        aria-expanded={open}
        aria-label={t.launcher}
        className="company-agent__launcher"
        onClick={toggle}
        type="button"
      >
        {open ? "×" : "AI"}
      </button>
    </aside>
  );
}
