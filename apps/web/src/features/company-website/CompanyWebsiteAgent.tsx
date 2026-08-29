import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";

type Action = "track" | "request_delivery" | "services" | "coverage" | "contact" | "whatsapp";
type Message = { role: "assistant" | "user"; content: string };

const labels = {
  en: {
    launcher: "Open website assistant",
    close: "Close assistant",
    title: "Website assistant",
    placeholder: "Ask about delivery…",
    send: "Send",
    contact: "Contact number (optional)",
    contactHint: "Share only if you want this company to contact you.",
    saveContact: "Share contact",
    contactSaved: "Contact shared with this company.",
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
    contact: "رقم التواصل (اختياري)",
    contactHint: "شاركه فقط إذا رغبت أن تتواصل معك هذه الشركة.",
    saveContact: "مشاركة الرقم",
    contactSaved: "تمت مشاركة الرقم مع هذه الشركة.",
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
  preview = false,
}: {
  agent: {
    displayName?: string;
    welcomeMessage?: { en?: string; ar?: string };
    suggestedActions: Action[];
  };
  apiBase: string;
  language: "en" | "ar";
  overrideHost?: string;
  preview?: boolean;
}): ReactElement {
  const t = labels[language];
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string>();
  const [name, setName] = useState(agent.displayName ?? t.title);
  const [messages, setMessages] = useState<Message[]>([]);
  const [actions, setActions] = useState<Action[]>(agent.suggestedActions);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [contactSaved, setContactSaved] = useState(false);
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
    if (preview) {
      setToken("preview");
      setMessages([
        {
          role: "assistant",
          content:
            agent.welcomeMessage?.[language] ??
            agent.welcomeMessage?.en ??
            (language === "ar"
              ? `مرحباً، أنا ${name}. كيف يمكنني مساعدتك؟`
              : `Hi, I'm ${name}. How can I help with your delivery?`),
        },
      ]);
      return;
    }
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
      const result = preview
        ? await previewAgentMessage(message, language)
        : ((await fetch(
            `${apiBase}/public/company-website/agent/conversations/${encodeURIComponent(token)}/messages`,
            { method: "POST", headers, body: JSON.stringify({ message, language }) },
          ).then(async (response) => {
            if (!response.ok) throw new Error("agent_unavailable");
            return await response.json();
          })) as {
            reply: string;
            assistantName: string;
            suggestedActions: Action[];
          });
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
  async function saveContact(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || busy) return;
    const form = event.currentTarget;
    const contactNumber = String(new FormData(form).get("contactNumber") ?? "").trim();
    if (!contactNumber) return;
    setBusy(true);
    try {
      const response = await fetch(
        `${apiBase}/public/company-website/agent/conversations/${encodeURIComponent(token)}/contact`,
        { method: "PATCH", headers, body: JSON.stringify({ contactNumber }) },
      );
      if (!response.ok) throw new Error("contact_invalid");
      setContactSaved(true);
      form.reset();
    } finally {
      setBusy(false);
    }
  }
  function action(action: Action): void {
    const target =
      action === "track" ? "tracking" : action === "request_delivery" ? "request-delivery" : action;
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setOpen(false);
  }
  return createPortal(
    <aside
      className={`company-agent${open ? " company-agent--open" : ""}`}
      dir={language === "ar" ? "rtl" : "ltr"}
      style={{ zIndex: 2_147_483_000 }}
    >
      {open ? (
        <section
          aria-label={name}
          aria-modal="false"
          className="company-agent__panel"
          role="dialog"
        >
          <header>
            <strong>
              {name}
              {preview ? <small>Preview</small> : null}
            </strong>
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
          {!preview && !failed && token && !contactSaved ? (
            <form className="company-agent__contact" onSubmit={(event) => void saveContact(event)}>
              <label htmlFor="company-agent-contact">{t.contact}</label>
              <small>{t.contactHint}</small>
              <div>
                <input
                  autoComplete="tel"
                  id="company-agent-contact"
                  inputMode="tel"
                  maxLength={32}
                  name="contactNumber"
                  type="tel"
                />
                <button disabled={busy} type="submit">
                  {t.saveContact}
                </button>
              </div>
            </form>
          ) : null}
          {contactSaved ? (
            <p className="company-agent__contact-saved" role="status">
              {t.contactSaved}
            </p>
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
        {open ? (
          "×"
        ) : (
          <svg aria-hidden="true" viewBox="0 0 32 32">
            <path d="M7 7.5h18a3.5 3.5 0 0 1 3.5 3.5v9A3.5 3.5 0 0 1 25 23.5H14l-6.5 4v-4H7A3.5 3.5 0 0 1 3.5 20v-9A3.5 3.5 0 0 1 7 7.5Z" />
            <path
              className="spark"
              d="m17 11 1.1 2.9L21 15l-2.9 1.1L17 19l-1.1-2.9L13 15l2.9-1.1L17 11Z"
            />
          </svg>
        )}
      </button>
    </aside>,
    document.body,
  );
}

function previewAgentMessage(
  message: string,
  language: "en" | "ar",
): Promise<{ reply: string; assistantName: string; suggestedActions: Action[] }> {
  const requestId = crypto.randomUUID();
  const parentOrigin = new URL(document.referrer).origin;
  if (
    !["http://127.0.0.1:5176", "http://localhost:5176", "https://platform.tawseelhub.com"].includes(
      parentOrigin,
    )
  )
    return Promise.reject(new Error("preview_parent_not_allowed"));
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      globalThis.removeEventListener("message", receive);
      reject(new Error("preview_timeout"));
    }, 30_000);
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== globalThis.parent ||
        event.origin !== parentOrigin ||
        !event.data ||
        typeof event.data !== "object"
      )
        return;
      const response = event.data as {
        type?: string;
        requestId?: string;
        result?: { reply: string; assistantName: string; suggestedActions: Action[] };
        error?: boolean;
      };
      if (
        response.type !== "tawseelhub:preview-agent-request:result" ||
        response.requestId !== requestId
      )
        return;
      globalThis.clearTimeout(timeout);
      globalThis.removeEventListener("message", receive);
      if (response.error || !response.result) reject(new Error("preview_agent_failed"));
      else resolve(response.result);
    };
    globalThis.addEventListener("message", receive);
    globalThis.parent.postMessage(
      { type: "tawseelhub:preview-agent-request", requestId, message, language },
      parentOrigin,
    );
  });
}
