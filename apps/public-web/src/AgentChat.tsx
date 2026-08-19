import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { buildWhatsAppMessageUrl, createAgentConversation, getAgentConversation, getWhatsAppSettings, sendAgentMessage, type AgentMessage, type WhatsAppPublicSettings } from './agent-client';
import { trackEvent } from './analytics';
import './agent-chat.css';

type Language = 'en' | 'ar';

const fallbackQuickActions = ['Send a Package', 'Register as Trader', 'Delivery Company Demo', 'Learn About Tawseelhub'] as const;
const visitorIdKey = 'tawseelhub-agent-visitor-id';

function visitorId() {
  const existing = window.localStorage.getItem(visitorIdKey);
  if (existing) return existing;
  const created = window.crypto?.randomUUID?.() ?? `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(visitorIdKey, created);
  return created;
}

export function AgentChat() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<Language>('en');
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whatsapp, setWhatsapp] = useState<WhatsAppPublicSettings | null>(null);
  const [handoffRequested, setHandoffRequested] = useState(false);
  const [humanState, setHumanState] = useState<'ai_active' | 'waiting_for_human' | 'human_active'>('ai_active');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRtl = language === 'ar';
  const launcherLabel = isRtl ? 'اسأل توصيل هب' : 'Ask Tawseelhub';
  const welcome = useMemo(() => messages.length > 0 ? messages : [], [messages]);
  const visibleQuickActions = useMemo(() => {
    const payload = messages[0]?.structuredPayload;
    return Array.isArray(payload?.quickActions) ? payload.quickActions.filter((item): item is string => typeof item === 'string') : [...fallbackQuickActions];
  }, [messages]);

  useEffect(() => {
    const id = window.setTimeout(() => setMounted(true), 700);
    void getWhatsAppSettings().then(setWhatsapp);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  function scrollMessagesToBottom(behavior: ScrollBehavior = 'smooth') {
    window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: 'end', behavior });
      if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    });
  }

  function focusInput() {
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  useEffect(() => {
    if (!open) return;
    scrollMessagesToBottom(messages.length <= 1 ? 'auto' : 'smooth');
  }, [busy, error, messages, open]);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const updated = await getAgentConversation(token);
        if (cancelled) return;
        setMessages(updated.messages ?? []);
        setHumanState(updated.humanState ?? (updated.conversationMode === 'human_active' ? 'human_active' : updated.conversationMode === 'paused' ? 'waiting_for_human' : 'ai_active'));
        if (updated.humanState === 'waiting_for_human' || updated.conversationMode === 'paused') setHandoffRequested(true);
      } catch {
        // Keep the current transcript; normal send errors still show the user-facing message.
      }
    };
    const interval = window.setInterval(() => { void refresh(); }, humanState === 'ai_active' ? 5000 : 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [humanState, open, token]);

  async function ensureConversation(nextLanguage = language) {
    if (token) return token;
    const created = await createAgentConversation(nextLanguage, visitorId());
    setToken(created.conversationToken ?? null);
    setMessages(created.messages ?? [{ senderType: 'assistant', content: created.message ?? '', createdAt: new Date().toISOString() }]);
    setHumanState(created.humanState ?? 'ai_active');
    trackEvent('agent_conversation_started', { channel: 'website', language: nextLanguage, page: window.location.pathname });
    return created.conversationToken ?? null;
  }

  async function openChat() {
    setOpen(true);
    trackEvent('agent_opened', { channel: 'website', language, page: window.location.pathname });
    try {
      setBusy(true);
      await ensureConversation();
    } catch (err) {
      setHandoffRequested(true);
      setError(isRtl ? 'يوسف غير متصل الآن. يمكنك المتابعة معنا على واتساب.' : 'Yousef is temporarily unavailable. Please continue with us on WhatsApp.');
      trackEvent('agent_error', { channel: 'website', language, page: window.location.pathname, actionResult: 'conversation_create_failed' });
    } finally {
      setBusy(false);
      focusInput();
    }
  }

  async function submitMessage(message: string) {
    const text = message.trim();
    if (!text || busy) return;
    setError(null);
    setInput('');
    const optimistic: AgentMessage = { senderType: 'user', content: text, createdAt: new Date().toISOString() };
    setMessages((items) => [...items, optimistic]);
    scrollMessagesToBottom();
    try {
      setBusy(true);
      const currentToken = await ensureConversation();
      if (!currentToken) throw new Error('The Assistant could not start a secure session.');
      const result = await sendAgentMessage(currentToken, text, language);
      setMessages(result.messages ?? []);
      setHumanState(result.humanState ?? (result.conversationMode === 'human_active' ? 'human_active' : result.conversationMode === 'paused' ? 'waiting_for_human' : 'ai_active'));
      if (result.intent) {
        trackEvent('agent_intent_detected', { channel: 'website', language: result.language, intent: result.intent, page: window.location.pathname });
        if (['customer_quote', 'trader', 'delivery_company_demo', 'handoff'].includes(result.intent)) trackEvent('agent_business_intent_detected', { channel: 'website', language: result.language, intent: result.intent, classification: result.intent, page: window.location.pathname });
      }
      if (result.intent === 'customer_quote') trackEvent('agent_quote_started', { channel: 'website', language: result.language, intent: result.intent, page: window.location.pathname });
      if (result.intent === 'trader') trackEvent('agent_trader_application_started', { channel: 'website', language: result.language, intent: result.intent, page: window.location.pathname });
      if (result.intent === 'delivery_company_demo') trackEvent('agent_demo_request_started', { channel: 'website', language: result.language, intent: result.intent, page: window.location.pathname });
      if (result.intent === 'handoff') trackEvent('agent_handoff_requested', { channel: 'website', language: result.language, intent: result.intent, page: window.location.pathname });
      if (result.humanState === 'waiting_for_human' || result.conversationMode === 'paused' || /whatsapp|واتساب/i.test(text)) setHandoffRequested(true);
    } catch (err) {
      setHandoffRequested(true);
      setError(isRtl ? 'يوسف غير متصل الآن. يمكنك المتابعة معنا على واتساب.' : 'Yousef is temporarily unavailable. Please continue with us on WhatsApp.');
      trackEvent('agent_error', { channel: 'website', language, page: window.location.pathname, actionResult: 'message_failed' });
    } finally {
      setBusy(false);
      focusInput();
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitMessage(input);
  }

  async function changeLanguage() {
    const nextLanguage = language === 'en' ? 'ar' : 'en';
    setLanguage(nextLanguage);
    setToken(null);
    setMessages([]);
    setHumanState('ai_active');
    setInput('');
    setError(null);
    if (!open) return;
    try {
      setBusy(true);
      const created = await createAgentConversation(nextLanguage, visitorId());
      setToken(created.conversationToken ?? null);
      setMessages(created.messages ?? [{ senderType: 'assistant', content: created.message ?? '', createdAt: new Date().toISOString() }]);
      setHumanState(created.humanState ?? 'ai_active');
      trackEvent('agent_conversation_started', { channel: 'website', language: nextLanguage, page: window.location.pathname });
    } catch (err) {
      setHandoffRequested(true);
      setError(nextLanguage === 'ar' ? 'يوسف غير متصل الآن. يمكنك المتابعة معنا على واتساب.' : 'Yousef is temporarily unavailable. Please continue with us on WhatsApp.');
      trackEvent('agent_error', { channel: 'website', language: nextLanguage, page: window.location.pathname, actionResult: 'conversation_create_failed' });
    } finally {
      setBusy(false);
      focusInput();
    }
  }

  if (!mounted) return null;

  return (
    <div className={`agent-chat ${isRtl ? 'agent-chat--rtl' : ''}`} dir={isRtl ? 'rtl' : 'ltr'}>
      {!open ? (
        <div className="agent-chat__floating-actions">
          {whatsapp?.enabled && whatsapp.url ? (
            <a
              className="agent-chat__floating-whatsapp"
              href={buildWhatsAppMessageUrl(whatsapp.url, isRtl ? 'مرحباً، أود التواصل مع Tawseelhub على واتساب.' : 'Hi, I would like to contact Tawseelhub on WhatsApp.')}
              target="_blank"
              rel="noreferrer"
              aria-label={isRtl ? 'تواصل مع Tawseelhub عبر واتساب' : 'Chat with Tawseelhub on WhatsApp'}
              onClick={() => trackEvent('whatsapp_contact_started', { page: window.location.pathname, initiated_from: 'floating_website_cta', channel: 'website', language })}
            >
              <img src="/whatsapp-icon.png" alt="" aria-hidden="true" />
            </a>
          ) : null}
          <button className="agent-chat__launcher" type="button" onClick={() => void openChat()} aria-label={launcherLabel}>
            <span aria-hidden="true">T</span>
            <b>{launcherLabel}</b>
          </button>
        </div>
      ) : (
        <section className="agent-chat__panel clarity-mask" data-clarity-mask="true" aria-label="Tawseelhub Assistant" ref={panelRef}>
          <header className="agent-chat__header">
            <img src="/tawseelhub-logo.png" alt="" />
            <div>
              <strong>{isRtl ? 'مساعد توصيل هب' : 'Tawseelhub Assistant'}</strong>
              <span>{isRtl ? 'لا تشارك معلومات حساسة غير مطلوبة' : 'Do not share unnecessary sensitive details'}</span>
            </div>
            <button type="button" onClick={() => void changeLanguage()} aria-label="Change chat language">{language.toUpperCase()}</button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Minimize chat">_</button>
            <button type="button" onClick={() => { setOpen(false); setMessages([]); setToken(null); }} aria-label="Close chat">x</button>
          </header>
          <div className="agent-chat__messages" role="log" aria-live="polite" aria-relevant="additions" ref={messagesRef}>
            {humanState !== 'ai_active' ? (
              <p className="agent-chat__status">
                {humanState === 'human_active'
                  ? (isRtl ? 'فريق Tawseelhub موجود الآن في المحادثة.' : 'Tawseelhub Team is now in this chat.')
                  : (isRtl ? 'بانتظار انضمام فريق Tawseelhub. يمكنك الاستمرار في الكتابة هنا.' : 'Waiting for the Tawseelhub Team. You can continue typing here.')}
              </p>
            ) : null}
            {welcome.map((message, index) => (
              <div className={`agent-chat__bubble agent-chat__bubble--${message.senderType}`} key={`${message.createdAt}-${index}`}>
                {message.senderType === 'platform_staff' ? <strong>{isRtl ? 'فريق Tawseelhub' : 'Tawseelhub Team'}</strong> : null}
                {message.content.split('\n').map((line) => <p key={line}>{line}</p>)}
              </div>
            ))}
            {messages.length <= 1 ? (
              <div className="agent-chat__quick-actions" aria-label="Quick actions">
                {visibleQuickActions.map((action) => <button key={action} type="button" onClick={() => void submitMessage(action)}>{action}</button>)}
              </div>
            ) : null}
            {busy ? <div className="agent-chat__typing">{isRtl ? 'يكتب...' : 'Typing...'}</div> : null}
            {error ? <p className="agent-chat__error">{error}</p> : null}
            {handoffRequested && whatsapp?.enabled && whatsapp.url ? (
              <a className="agent-chat__whatsapp" href={buildWhatsAppMessageUrl(whatsapp.url, isRtl ? 'مرحباً، أود المتابعة مع فريق Tawseelhub على واتساب.' : `Hi, I’m contacting Tawseelhub about this website conversation.`)} target="_blank" rel="noreferrer" onClick={() => trackEvent('agent_whatsapp_handoff_started', { page: window.location.pathname, channel: 'website', initiated_from: 'agent', language })}>
                {isRtl ? 'المتابعة على واتساب' : 'Continue on WhatsApp'}
              </a>
            ) : null}
            {humanState === 'waiting_for_human' ? (
              <button className="agent-chat__link-button" type="button" onClick={() => void submitMessage(isRtl ? 'كمل مع يوسف' : 'Continue with Yousef')}>
                {isRtl ? 'العودة إلى يوسف' : 'Continue with Yousef'}
              </button>
            ) : null}
            <div ref={messagesEndRef} aria-hidden="true" />
          </div>
          <form className="agent-chat__form" onSubmit={onSubmit}>
            <label htmlFor="agent-chat-input">{isRtl ? 'رسالتك' : 'Your message'}</label>
            <input
              id="agent-chat-input"
              ref={inputRef}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                scrollMessagesToBottom();
              }}
              onFocus={() => scrollMessagesToBottom('auto')}
              placeholder={isRtl ? 'اكتب رسالتك' : 'Type your message'}
              maxLength={1200}
              readOnly={busy}
              aria-busy={busy}
            />
            <button type="submit" disabled={busy || !input.trim()} aria-label={isRtl ? 'إرسال' : 'Send'}>{isRtl ? 'إرسال' : 'Send'}</button>
          </form>
          <a className="agent-chat__privacy" href="/resources">{isRtl ? 'الخصوصية' : 'Privacy notice'}</a>
        </section>
      )}
    </div>
  );
}
