import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  buildWhatsAppMessageUrl,
  createAgentConversation,
  createLiveAvatarSession,
  fallbackWhatsAppSettings,
  fallbackAvatarSettings,
  getAgentAvailability,
  getAvatarSettings,
  getAgentConversation,
  getWhatsAppSettings,
  reportLiveAvatarUsage,
  sendAgentMessage,
  type AgentAvailability,
  type AgentAvatarSettings,
  type AgentMessage,
  type WhatsAppPublicSettings,
} from "./agent-client";
import {
  createAvatarProvider,
  HeyGenLiveAvatarProvider,
  transcriptTrackUrl,
  type AvatarState,
} from "./avatar-provider";
import { trackEvent } from "./analytics";
import {
  createSpeechToTextProvider,
  createTextToSpeechProvider,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
} from "./voice-provider";
import {
  getStoredPublicLocale,
  publicLocaleChangeEvent,
  savePublicLocale,
} from "./public-localization";
import "./agent-chat.css";

type Language = "en" | "ar";

// Shown instantly when the chat opens, before the backend's own greeting
// (with its own quickActions) has come back -- must match agentQuickActions
// / agentQuickActionsArabic in apps/api/src/agent/agent-instructions.ts
// exactly, or a button appears to "pop in" once the network reply lands.
const fallbackQuickActions = {
  en: [
    "Send a Package",
    "Track Shipment",
    "Register as Trader",
    "Delivery Company Demo",
    "Learn About Tawseelhub",
  ],
  ar: [
    "إرسال شحنة",
    "تتبع شحنة",
    "التسجيل كتاجر",
    "طلب عرض لنظام شركة توصيل",
    "معرفة المزيد عن Tawseelhub",
  ],
} as const;
const avatarQuickActions = {
  en: [
    "How Tawseelhub Works",
    "Get a Delivery Quote",
    "Register as Trader",
    "Request a Demo",
    "Send a Package",
  ],
  ar: [
    "كيف تعمل Tawseelhub",
    "احصل على عرض توصيل",
    "التسجيل كتاجر",
    "طلب عرض توضيحي",
    "إرسال شحنة",
  ],
} as const;
const visitorIdKey = "tawseelhub-agent-visitor-id";
const linkPattern = /(https?:\/\/[^\s،]+)/g;

function visitorId() {
  const existing = window.localStorage.getItem(visitorIdKey);
  if (existing) return existing;
  const created =
    window.crypto?.randomUUID?.() ?? `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(visitorIdKey, created);
  return created;
}

export function renderAgentMessageLine(line: string) {
  const parts = line.split(linkPattern);
  return parts.map((part, index) => {
    if (/^https?:\/\//.test(part)) {
      return (
        <a href={part} key={`${part}-${index}`} target="_blank" rel="noreferrer">
          {part}
        </a>
      );
    }
    return part;
  });
}

export function AgentChat() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<Language>(() => getStoredPublicLocale());
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Starts from the built-in fallback so the WhatsApp CTA renders with zero
  // network requests at page load; live settings replace it on the visitor's
  // first interaction (see the effect below).
  const [whatsapp, setWhatsapp] = useState<WhatsAppPublicSettings | null>(fallbackWhatsAppSettings);
  const [availability, setAvailability] = useState<AgentAvailability>({
    assistantAvailable: false,
    humanAvailable: false,
    status: "unavailable",
  });
  const [avatar, setAvatar] = useState<AgentAvatarSettings>(fallbackAvatarSettings);
  const [avatarState, setAvatarState] = useState<AvatarState>("idle");
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceSpeaking, setVoiceSpeaking] = useState(false);
  const [voiceRepliesEnabled, setVoiceRepliesEnabled] = useState(false);
  const [liveSessionActive, setLiveSessionActive] = useState(false);
  const [lastSpokenAnswer, setLastSpokenAnswer] = useState("");
  const [introVideoFailed, setIntroVideoFailed] = useState(false);
  const [introImageFailed, setIntroImageFailed] = useState(false);
  const [defaultImageFailed, setDefaultImageFailed] = useState(false);
  const [handoffRequested, setHandoffRequested] = useState(false);
  const [humanState, setHumanState] = useState<"ai_active" | "waiting_for_human" | "human_active">(
    "ai_active",
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const liveAvatarProviderRef = useRef<HeyGenLiveAvatarProvider | null>(null);
  const liveUsageRef = useRef<{ token: string; usageId: string } | null>(null);
  const introStartedRef = useRef(false);
  const speechToTextRef = useRef<SpeechToTextProvider | null>(null);
  const textToSpeechRef = useRef<TextToSpeechProvider | null>(null);
  const autoOpenedRef = useRef(false);
  const widgetDataLoaderRef = useRef<(() => void) | null>(null);
  const isRtl = language === "ar";
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  const avatarAllowedOnPage =
    (path === "/" && avatar.showOnHomepage) ||
    (path === "/pricing" && avatar.showOnPricing) ||
    (["/delivery-companies", "/delivery-company"].includes(path) && avatar.showOnDeliveryCompany) ||
    (["/traders", "/trader"].includes(path) && avatar.showOnTrader) ||
    (["/send-a-package", "/send-package"].includes(path) && avatar.showOnSendPackage);
  const avatarMode = avatar.enabled && avatar.status === "active" && avatarAllowedOnPage;
  const avatarTitle = isRtl ? avatar.titleAr : avatar.titleEn;
  const introTranscript = isRtl ? avatar.introTranscriptAr : avatar.introTranscriptEn;
  const introVideoUrl = isRtl ? avatar.introVideoUrlAr : avatar.introVideoUrlEn;
  const introImageUrl = isRtl ? avatar.introImageUrlAr : avatar.introImageUrlEn;
  const launcherLabel = isRtl ? "اسأل Tawseelhub" : "Ask Tawseelhub";
  const humanAvailable = availability.humanAvailable;
  const humanStatusLabel = humanAvailable
    ? isRtl
      ? "الدعم البشري متاح"
      : "Human support available"
    : isRtl
      ? "لا يوجد دعم بشري الآن"
      : "Human support unavailable now";
  speechToTextRef.current ??= createSpeechToTextProvider("browser");
  textToSpeechRef.current ??= createTextToSpeechProvider("browser");
  const welcome = useMemo(() => (messages.length > 0 ? messages : []), [messages]);

  useEffect(() => {
    introStartedRef.current = false;
    setIntroVideoFailed(false);
    setIntroImageFailed(false);
    setDefaultImageFailed(false);
  }, [introImageUrl, introVideoUrl]);

  useEffect(
    () => () => {
      void liveAvatarProviderRef.current?.endSession();
      liveAvatarProviderRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const stop = () => void liveAvatarProviderRef.current?.endSession();
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, []);
  // Reads the LATEST assistant message, not just the first one -- so quick
  // actions correctly disappear once a real question is pending (that
  // message carries no quickActions) and can reappear later (e.g. after
  // typing "menu" to start over) without needing a special case here.
  const visibleQuickActions = useMemo(() => {
    if (avatarMode && !messages.some((message) => message.senderType === "user"))
      return [...avatarQuickActions[language]];
    const latestAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.senderType === "assistant");
    if (latestAssistantMessage) {
      const payload = latestAssistantMessage.structuredPayload;
      return Array.isArray(payload?.quickActions)
        ? payload.quickActions.filter((item): item is string => typeof item === "string")
        : [];
    }
    // No assistant message yet (still waiting on the network) -- show the
    // fallback list so quick actions never visibly "pop in" once it lands.
    return [...fallbackQuickActions[language]];
  }, [avatarMode, language, messages]);

  useEffect(() => {
    const id = window.setTimeout(() => setMounted(true), 700);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getAvatarSettings().then((next) => {
      if (!cancelled) setAvatar(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Zero widget requests during page load (Lighthouse network-dependency
    // finding): the WhatsApp CTA renders from the built-in fallback, and the
    // live settings + availability load on the visitor's FIRST interaction
    // (scroll/pointer/key/touch -- every real visitor produces one within
    // moments, lab page-load traces never do). Opening the chat also
    // triggers it, so the panel always shows live availability.
    let cancelled = false;
    let loaded = false;
    const loadWidgetData = () => {
      if (loaded || cancelled) return;
      loaded = true;
      remove();
      void getWhatsAppSettings().then((next) => {
        if (!cancelled) setWhatsapp(next);
      });
      void getAgentAvailability().then((next) => {
        if (!cancelled) setAvailability(next);
      });
    };
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    const remove = () => events.forEach((name) => window.removeEventListener(name, loadWidgetData));
    events.forEach((name) =>
      window.addEventListener(name, loadWidgetData, { once: true, passive: true }),
    );
    widgetDataLoaderRef.current = loadWidgetData;
    return () => {
      cancelled = true;
      remove();
      widgetDataLoaderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!avatarMode || !avatar.autoOpen || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    void openChat();
  }, [avatar.autoOpen, avatarMode]);

  useEffect(() => {
    // Availability polling only while the panel is open -- a closed widget
    // has no reason to keep hitting the API every 30 seconds.
    if (!open) return;
    let cancelled = false;
    const refreshAvailability = async () => {
      const nextAvailability = await getAgentAvailability();
      if (!cancelled) setAvailability(nextAvailability);
    };
    const interval = window.setInterval(() => void refreshAvailability(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open]);

  useEffect(() => {
    const syncLanguage = () => setLanguage(getStoredPublicLocale());
    window.addEventListener(publicLocaleChangeEvent, syncLanguage);
    window.addEventListener("storage", syncLanguage);
    return () => {
      window.removeEventListener(publicLocaleChangeEvent, syncLanguage);
      window.removeEventListener("storage", syncLanguage);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const handler = () => {
      void openChat();
    };
    window.addEventListener("tawseelhub:open-agent", handler);
    return () => window.removeEventListener("tawseelhub:open-agent", handler);
  });

  function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") {
    window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: "end", behavior });
      if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    });
  }

  function focusInput() {
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  useEffect(() => {
    if (!open) return;
    scrollMessagesToBottom(messages.length <= 1 ? "auto" : "smooth");
  }, [busy, error, messages, open]);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const updated = await getAgentConversation(token);
        if (cancelled) return;
        setMessages(updated.messages ?? []);
        setHumanState(
          updated.humanState ??
            (updated.conversationMode === "human_active"
              ? "human_active"
              : updated.conversationMode === "paused"
                ? "waiting_for_human"
                : "ai_active"),
        );
        if (updated.humanState === "waiting_for_human" || updated.conversationMode === "paused")
          setHandoffRequested(true);
      } catch {
        // Keep the current transcript; normal send errors still show the user-facing message.
      }
    };
    const interval = window.setInterval(
      () => {
        void refresh();
      },
      humanState === "ai_active" ? 5000 : 2500,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [humanState, open, token]);

  async function ensureConversation(nextLanguage = language) {
    if (token) return token;
    const created = await createAgentConversation(
      nextLanguage,
      visitorId(),
      avatarMode ? "website_avatar" : "website",
    );
    setToken(created.conversationToken ?? null);
    // `createAgentConversation` returns quickActions as a top-level field,
    // not nested in a message -- unlike every later turn's response, which
    // always carries a real `messages` array from the database with the
    // payload attached to each row. Carry it over the same way here so the
    // very first greeting isn't a special case for visibleQuickActions.
    setMessages(
      created.messages ?? [
        {
          senderType: "assistant",
          content: created.message ?? "",
          createdAt: new Date().toISOString(),
          structuredPayload: { quickActions: created.quickActions },
        },
      ],
    );
    setHumanState(created.humanState ?? "ai_active");
    trackEvent("agent_conversation_started", {
      channel: avatarMode ? "website_avatar" : "website",
      language: nextLanguage,
      page: window.location.pathname,
    });
    return created.conversationToken ?? null;
  }

  async function openChat() {
    setOpen(true);
    widgetDataLoaderRef.current?.();
    trackEvent("agent_opened", { channel: "website", language, page: window.location.pathname });
    if (avatarMode)
      trackEvent("avatar_opened", { channel: "website_avatar", language, page: path });
    try {
      setBusy(true);
      await ensureConversation();
    } catch {
      setHandoffRequested(true);
      setError(
        isRtl
          ? "يوسف غير متصل الآن. يمكنك المتابعة معنا على واتساب."
          : "Yousef is temporarily unavailable. Please continue with us on WhatsApp.",
      );
      trackEvent("agent_error", {
        channel: "website",
        language,
        page: window.location.pathname,
        actionResult: "conversation_create_failed",
      });
    } finally {
      setBusy(false);
      focusInput();
    }
  }

  async function submitMessage(message: string) {
    const text = message.trim();
    if (!text || busy) return;
    setError(null);
    setInput("");
    const optimistic: AgentMessage = {
      senderType: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((items) => [...items, optimistic]);
    if (avatarMode) {
      setAvatarState("thinking");
      trackEvent("question_asked", { channel: "website_avatar", language, page: path });
    }
    scrollMessagesToBottom();
    try {
      setBusy(true);
      const currentToken = await ensureConversation();
      if (!currentToken) throw new Error("The Assistant could not start a secure session.");
      const result = await sendAgentMessage(currentToken, text, language);
      setMessages(result.messages ?? []);
      const assistantAnswer = [...(result.messages ?? [])]
        .reverse()
        .find((item) => item.senderType === "assistant")?.content;
      setHumanState(
        result.humanState ??
          (result.conversationMode === "human_active"
            ? "human_active"
            : result.conversationMode === "paused"
              ? "waiting_for_human"
              : "ai_active"),
      );
      if (result.intent) {
        trackEvent("agent_intent_detected", {
          channel: "website",
          language: result.language,
          intent: result.intent,
          page: window.location.pathname,
        });
        if (
          ["customer_quote", "trader", "delivery_company_demo", "handoff"].includes(result.intent)
        )
          trackEvent("agent_business_intent_detected", {
            channel: "website",
            language: result.language,
            intent: result.intent,
            classification: result.intent,
            page: window.location.pathname,
          });
      }
      if (result.intent === "customer_quote")
        if (avatarMode)
          trackEvent("quote_started_from_avatar", {
            channel: "website_avatar",
            language,
            page: path,
          });
      if (result.intent === "customer_quote")
        trackEvent("agent_quote_started", {
          channel: "website",
          language: result.language,
          intent: result.intent,
          page: window.location.pathname,
        });
      if (result.intent === "trader")
        if (avatarMode)
          trackEvent("trader_registration_started_from_avatar", {
            channel: "website_avatar",
            language,
            page: path,
          });
      if (result.intent === "trader")
        trackEvent("agent_trader_application_started", {
          channel: "website",
          language: result.language,
          intent: result.intent,
          page: window.location.pathname,
        });
      if (result.intent === "delivery_company_demo")
        if (avatarMode)
          trackEvent("demo_started_from_avatar", {
            channel: "website_avatar",
            language,
            page: path,
          });
      if (result.intent === "delivery_company_demo")
        trackEvent("agent_demo_request_started", {
          channel: "website",
          language: result.language,
          intent: result.intent,
          page: window.location.pathname,
        });
      if (result.intent === "handoff")
        trackEvent("agent_handoff_requested", {
          channel: "website",
          language: result.language,
          intent: result.intent,
          page: window.location.pathname,
        });
      if (
        result.humanState === "waiting_for_human" ||
        result.conversationMode === "paused" ||
        /whatsapp|واتساب/i.test(text)
      )
        setHandoffRequested(true);
      if (assistantAnswer && voiceRepliesEnabled)
        await speakAnswer(assistantAnswer, currentToken);
      return assistantAnswer;
    } catch {
      setHandoffRequested(true);
      setError(
        isRtl
          ? "يوسف غير متصل الآن. يمكنك المتابعة معنا على واتساب."
          : "Yousef is temporarily unavailable. Please continue with us on WhatsApp.",
      );
      trackEvent("agent_error", {
        channel: "website",
        language,
        page: window.location.pathname,
        actionResult: "message_failed",
      });
    } finally {
      setBusy(false);
      if (avatarMode) setAvatarState("intro_finished");
      focusInput();
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitMessage(input);
  }

  async function changeLanguage() {
    speechToTextRef.current?.cancel();
    textToSpeechRef.current?.stop();
    await liveAvatarProviderRef.current?.endSession();
    liveAvatarProviderRef.current = null;
    setLiveSessionActive(false);
    setVoiceListening(false);
    setVoiceSpeaking(false);
    const nextLanguage = language === "en" ? "ar" : "en";
    savePublicLocale(nextLanguage);
    setLanguage(nextLanguage);
    setToken(null);
    setMessages([]);
    setHumanState("ai_active");
    setInput("");
    setError(null);
    if (!open) return;
    try {
      setBusy(true);
      const created = await createAgentConversation(
        nextLanguage,
        visitorId(),
        avatarMode ? "website_avatar" : "website",
      );
      setToken(created.conversationToken ?? null);
      setMessages(
        created.messages ?? [
          {
            senderType: "assistant",
            content: created.message ?? "",
            createdAt: new Date().toISOString(),
            structuredPayload: { quickActions: created.quickActions },
          },
        ],
      );
      setHumanState(created.humanState ?? "ai_active");
      trackEvent("agent_conversation_started", {
        channel: "website",
        language: nextLanguage,
        page: window.location.pathname,
      });
    } catch {
      setHandoffRequested(true);
      setError(
        nextLanguage === "ar"
          ? "يوسف غير متصل الآن. يمكنك المتابعة معنا على واتساب."
          : "Yousef is temporarily unavailable. Please continue with us on WhatsApp.",
      );
      trackEvent("agent_error", {
        channel: "website",
        language: nextLanguage,
        page: window.location.pathname,
        actionResult: "conversation_create_failed",
      });
    } finally {
      setBusy(false);
      focusInput();
    }
  }

  async function playIntro() {
    setAvatarState("intro_playing");
    const result = await createAvatarProvider(avatar.provider, videoRef.current).playIntro();
    if (result.status === "not_supported") setAvatarState("offline");
    if (result.status === "error") setAvatarState("error");
  }

  function voiceFailure(code: string) {
    setAvatarState("error");
    setError(
      isRtl
        ? "تعذر استخدام الصوت الآن. يمكنك المحاولة مرة أخرى أو متابعة الكتابة."
        : "Voice is unavailable right now. Try again or continue typing.",
    );
    trackEvent("voice_error", {
      channel: "website_avatar",
      language,
      page: path,
      provider: "browser",
      error_code: code,
    });
  }

  async function speakAnswer(answer: string, conversationToken = token) {
    if (
      avatarMode &&
      avatar.liveEnabled &&
      avatar.liveProvider === "heygen_live" &&
      avatar.liveConfigured
    ) {
      const currentLiveSettings = await getAvatarSettings();
      if (!currentLiveSettings.liveEnabled) {
        await liveAvatarProviderRef.current?.endSession("kill_switch");
        liveAvatarProviderRef.current = null;
      } else {
        const liveVideo = liveVideoRef.current;
        const currentToken = conversationToken;
        if (liveVideo && currentToken) {
          liveAvatarProviderRef.current ??= new HeyGenLiveAvatarProvider({
            video: liveVideo,
            createToken: async () => {
              const created = await createLiveAvatarSession(currentToken, language);
              liveUsageRef.current = { token: currentToken, usageId: created.usageId };
              return created;
            },
            onSessionStarted: (metrics) => {
              setLiveSessionActive(true);
              trackEvent("live_avatar_session_started", {
                channel: "website_avatar",
                language,
                page: path,
                provider: "heygen_live",
                duration_seconds: Math.round(metrics.initializationMs) / 1000,
              });
            },
            onResponseStarted: (metrics) => {
              setAvatarState("speaking");
              setVoiceSpeaking(true);
              trackEvent("live_avatar_response_started", {
                channel: "website_avatar",
                language,
                page: path,
                provider: "heygen_live",
                duration_seconds: Math.round((metrics.responseFirstFrameMs ?? 0) / 10) / 100,
              });
            },
            onResponseCompleted: () => {
              setAvatarState("idle");
              setVoiceSpeaking(false);
              trackEvent("live_avatar_response_completed", {
                channel: "website_avatar",
                language,
                page: path,
                provider: "heygen_live",
              });
              const usage = liveUsageRef.current;
              if (usage)
                void reportLiveAvatarUsage(usage.token, usage.usageId, "response_completed");
            },
            onSessionEnded: (metrics) => {
              setLiveSessionActive(false);
              trackEvent("live_avatar_session_seconds", {
                channel: "website_avatar",
                language,
                page: path,
                provider: "heygen_live",
                duration_seconds: Math.round(metrics.sessionDurationSeconds * 100) / 100,
              });
              const usage = liveUsageRef.current;
              liveUsageRef.current = null;
              if (usage)
                void reportLiveAvatarUsage(
                  usage.token,
                  usage.usageId,
                  "ended",
                  metrics.sessionDurationSeconds,
                  metrics.endReason,
                );
            },
            onError: (code) => {
              trackEvent("live_avatar_error", {
                channel: "website_avatar",
                language,
                page: path,
                provider: "heygen_live",
                error_code: code.slice(0, 80),
              });
              const usage = liveUsageRef.current;
              if (usage)
                void reportLiveAvatarUsage(
                  usage.token,
                  usage.usageId,
                  "provider_error",
                  undefined,
                  code.slice(0, 80),
                );
            },
          });
          setLastSpokenAnswer(answer);
          const result = await liveAvatarProviderRef.current.speakResponse(answer);
          if (result.status === "ok") return;
          trackEvent("live_avatar_fallback_used", {
            channel: "website_avatar",
            language,
            page: path,
            provider: "heygen_live",
            error_code: result.status === "error" ? result.reason : "not_supported",
          });
          const usage = liveUsageRef.current;
          if (usage)
            void reportLiveAvatarUsage(
              usage.token,
              usage.usageId,
              "fallback",
              undefined,
              result.status === "error" ? result.reason : "not_supported",
            );
        }
      }
    }
    const provider = textToSpeechRef.current;
    if (!provider?.isSupported()) {
      voiceFailure("tts_unsupported");
      return;
    }
    setVoiceSpeaking(true);
    setAvatarState("speaking");
    setLastSpokenAnswer(answer);
    trackEvent("text_to_speech_characters", {
      channel: "website_avatar",
      language,
      page: path,
      provider: provider.id,
      character_count: answer.length,
    });
    try {
      await provider.speak(answer, language);
      trackEvent("voice_response_completed", {
        channel: "website_avatar",
        language,
        page: path,
        provider: provider.id,
      });
      setAvatarState("idle");
    } catch {
      voiceFailure("tts_failed");
    } finally {
      setVoiceSpeaking(false);
    }
  }

  async function toggleListening() {
    const provider = speechToTextRef.current;
    if (voiceListening) {
      setVoiceListening(false);
      setAvatarState("thinking");
      provider?.stop();
      return;
    }
    if (!provider?.isSupported()) {
      voiceFailure("stt_unsupported");
      return;
    }
    textToSpeechRef.current?.stop();
    videoRef.current?.pause();
    setVoiceSpeaking(false);
    setVoiceListening(true);
    setAvatarState("listening");
    setError(null);
    trackEvent("voice_session_started", {
      channel: "website_avatar",
      language,
      page: path,
      provider: provider.id,
    });
    try {
      const result = await provider.listen(language);
      setVoiceListening(false);
      trackEvent("speech_to_text_seconds", {
        channel: "website_avatar",
        language,
        page: path,
        provider: provider.id,
        duration_seconds: Math.round(result.durationSeconds * 100) / 100,
      });
      await submitMessage(result.transcript);
    } catch (caught) {
      setVoiceListening(false);
      const code = caught instanceof Error ? caught.message : "stt_failed";
      if (code === "speech_recognition_cancelled") return;
      voiceFailure(code === "not-allowed" ? "microphone_denied" : "stt_failed");
    }
  }

  function stopVoice() {
    speechToTextRef.current?.cancel();
    textToSpeechRef.current?.stop();
    (liveAvatarProviderRef.current as HeyGenLiveAvatarProvider | null)?.interrupt();
    setVoiceListening(false);
    setVoiceSpeaking(false);
    setAvatarState("idle");
  }

  function toggleVoiceReplies(enabled: boolean) {
    setVoiceRepliesEnabled(enabled);
    if (enabled) return;
    stopVoice();
    void liveAvatarProviderRef.current?.endSession("voice_disabled");
    liveAvatarProviderRef.current = null;
    setLiveSessionActive(false);
  }

  function closeAvatar() {
    stopVoice();
    void createAvatarProvider(avatar.provider, videoRef.current).endSession();
    void liveAvatarProviderRef.current?.endSession();
    liveAvatarProviderRef.current = null;
    setLiveSessionActive(false);
    if (avatarMode)
      trackEvent("avatar_closed", { channel: "website_avatar", language, page: path });
    setOpen(false);
  }

  function submitQuickAction(action: string) {
    if (avatarMode)
      trackEvent("quick_action_clicked", { channel: "website_avatar", language, page: path });
    void submitMessage(action);
  }

  if (!mounted) return null;

  return (
    <div
      className={`agent-chat ${isRtl ? "agent-chat--rtl" : ""} ${avatarMode ? "agent-chat--avatar" : ""}`}
      dir={isRtl ? "rtl" : "ltr"}
      data-avatar-state={avatarMode ? avatarState : undefined}
    >
      {!open ? (
        <div className="agent-chat__floating-actions">
          {whatsapp?.enabled && whatsapp.url ? (
            <a
              className="agent-chat__floating-whatsapp"
              href={buildWhatsAppMessageUrl(
                whatsapp.url,
                isRtl
                  ? "مرحباً، أود التواصل مع Tawseelhub على واتساب."
                  : "Hi, I would like to contact Tawseelhub on WhatsApp.",
              )}
              target="_blank"
              rel="noreferrer"
              aria-label={
                isRtl ? "تواصل مع Tawseelhub عبر واتساب" : "Chat with Tawseelhub on WhatsApp"
              }
              onClick={() =>
                trackEvent("whatsapp_contact_started", {
                  page: window.location.pathname,
                  initiated_from: "floating_website_cta",
                  channel: "website",
                  language,
                })
              }
            >
              <img src="/whatsapp-icon.png" alt="" aria-hidden="true" />
            </a>
          ) : null}
          <button
            className={`agent-chat__launcher ${avatarMode ? "agent-chat__avatar-launcher" : ""}`}
            type="button"
            onClick={() => void openChat()}
            aria-label={launcherLabel}
          >
            <span aria-hidden="true">
              {avatarMode && avatar.imageUrl ? (
                <img src={avatar.imageUrl} alt="" />
              ) : avatarMode ? (
                "Y"
              ) : (
                "T"
              )}
            </span>
            <b>
              {avatarMode ? (
                <>
                  <small>{isRtl ? "قابل يوسف" : "Meet Yousef"}</small>
                  {avatarTitle}
                  <em>{isRtl ? "مستشار ذكي" : "AI Advisor"}</em>
                </>
              ) : (
                launcherLabel
              )}
            </b>
            <i
              className={
                humanAvailable
                  ? "agent-chat__availability-dot agent-chat__availability-dot--online"
                  : "agent-chat__availability-dot agent-chat__availability-dot--offline"
              }
              title={humanStatusLabel}
              aria-label={humanStatusLabel}
            />
          </button>
        </div>
      ) : (
        <section
          className="agent-chat__panel clarity-mask"
          data-clarity-mask="true"
          aria-label={isRtl ? "مساعد Tawseelhub" : "Tawseelhub Assistant"}
          ref={panelRef}
        >
          <header className="agent-chat__header">
            <img src="/tawseelhub-logo-web.png" alt="" />
            <div>
              <strong>{isRtl ? "مساعد Tawseelhub" : "Tawseelhub Assistant"}</strong>
              <span>
                {isRtl
                  ? "لا تشارك معلومات حساسة غير مطلوبة"
                  : "Do not share unnecessary sensitive details"}
              </span>
              <em
                className={
                  humanAvailable
                    ? "agent-chat__availability agent-chat__availability--online"
                    : "agent-chat__availability agent-chat__availability--offline"
                }
              >
                <i aria-hidden="true" />
                {humanStatusLabel}
              </em>
            </div>
            <button
              type="button"
              onClick={() => void changeLanguage()}
              aria-label={
                isRtl ? "تغيير لغة المحادثة إلى الإنجليزية" : "Change chat language to Arabic"
              }
            >
              {language === "en" ? "AR" : "EN"}
            </button>
            <button
              type="button"
              onClick={closeAvatar}
              aria-label={isRtl ? "تصغير المحادثة" : "Minimize chat"}
            >
              <span aria-hidden="true">−</span>
            </button>
            <button
              type="button"
              onClick={() => {
                closeAvatar();
                if (!avatarMode) {
                  setMessages([]);
                  setToken(null);
                }
              }}
              aria-label={isRtl ? "إغلاق المحادثة" : "Close chat"}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          {avatarMode ? (
            <div className="agent-chat__avatar-stage">
              <div className="agent-chat__avatar-media">
                <video
                  className={
                    liveSessionActive
                      ? "agent-chat__live-avatar"
                      : "agent-chat__live-avatar agent-chat__avatar-media--inactive"
                  }
                  ref={liveVideoRef}
                  autoPlay
                  playsInline
                  aria-label={isRtl ? "فيديو يوسف المباشر" : "Live Yousef video"}
                />
                {introVideoUrl && !introVideoFailed && avatar.provider === "prerecorded" ? (
                  <video
                    className={
                      !liveSessionActive
                        ? "agent-chat__intro-avatar"
                        : "agent-chat__intro-avatar agent-chat__avatar-media--inactive"
                    }
                    ref={videoRef}
                    controls
                    playsInline
                    preload="metadata"
                    poster={!introImageFailed ? introImageUrl ?? avatar.imageUrl : avatar.imageUrl}
                    src={introVideoUrl}
                    onPlay={() => {
                      setAvatarState("intro_playing");
                      if (!introStartedRef.current) {
                        introStartedRef.current = true;
                        trackEvent("intro_started", {
                          channel: "website_avatar",
                          language,
                          page: path,
                        });
                      }
                    }}
                    onEnded={() => {
                      setAvatarState("intro_finished");
                      trackEvent("intro_completed", {
                        channel: "website_avatar",
                        language,
                        page: path,
                      });
                    }}
                    onError={() => {
                      setIntroVideoFailed(true);
                      setAvatarState("error");
                    }}
                  >
                    <track
                      kind="captions"
                      src={transcriptTrackUrl(introTranscript)}
                      srcLang={language}
                      label={language === "ar" ? "العربية" : "English"}
                    />
                  </video>
                ) : introImageUrl && !introImageFailed ? (
                  <img src={introImageUrl} alt="" onError={() => setIntroImageFailed(true)} />
                ) : avatar.imageUrl && !defaultImageFailed ? (
                  <img src={avatar.imageUrl} alt="" onError={() => setDefaultImageFailed(true)} />
                ) : (
                  <div className="agent-chat__avatar-fallback" aria-hidden="true">
                    Y
                  </div>
                )}
              </div>
              <div className="agent-chat__avatar-status">
                <span>
                  {avatar.displayName} · {isRtl ? "مستشار ذكي" : "AI Advisor"}
                </span>
                {introVideoUrl && !introVideoFailed &&
                avatar.provider === "prerecorded" &&
                !liveSessionActive &&
                avatarState !== "intro_playing" ? (
                  <button type="button" onClick={() => void playIntro()}>
                    {isRtl ? "تشغيل المقدمة" : "Play introduction"}
                  </button>
                ) : null}
                {avatarState === "error" || avatarState === "offline" ? (
                  <small>
                    {isRtl
                      ? "الفيديو غير متاح. يمكنك متابعة المحادثة النصية أدناه."
                      : "Video is unavailable. Continue with the text conversation below."}
                  </small>
                ) : null}
              </div>
            </div>
          ) : null}
          <div
            className="agent-chat__messages"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            ref={messagesRef}
          >
            {humanState !== "ai_active" ? (
              <p className="agent-chat__status">
                {humanState === "human_active"
                  ? isRtl
                    ? "فريق Tawseelhub موجود الآن في المحادثة."
                    : "Tawseelhub Team is now in this chat."
                  : isRtl
                    ? "بانتظار انضمام فريق Tawseelhub. يمكنك الاستمرار في الكتابة هنا."
                    : "Waiting for the Tawseelhub Team. You can continue typing here."}
              </p>
            ) : null}
            {welcome.map((message, index) => (
              <div
                className={`agent-chat__bubble agent-chat__bubble--${message.senderType}`}
                key={`${message.createdAt}-${index}`}
              >
                {message.senderType === "platform_staff" ? (
                  <strong>{isRtl ? "فريق Tawseelhub" : "Tawseelhub Team"}</strong>
                ) : null}
                {message.content.split("\n").map((line) => (
                  <p key={line}>{renderAgentMessageLine(line)}</p>
                ))}
              </div>
            ))}
            {visibleQuickActions.length > 0 ? (
              <div
                className="agent-chat__quick-actions"
                aria-label={isRtl ? "إجراءات سريعة" : "Quick actions"}
              >
                {visibleQuickActions.map((action) => (
                  <button key={action} type="button" onClick={() => submitQuickAction(action)}>
                    {action}
                  </button>
                ))}
              </div>
            ) : null}
            {busy ? (
              <div className="agent-chat__typing">{isRtl ? "يكتب..." : "Typing..."}</div>
            ) : null}
            {error ? <p className="agent-chat__error">{error}</p> : null}
            {handoffRequested && whatsapp?.enabled && whatsapp.url ? (
              <a
                className="agent-chat__whatsapp"
                href={buildWhatsAppMessageUrl(
                  whatsapp.url,
                  isRtl
                    ? "مرحباً، أود المتابعة مع فريق Tawseelhub على واتساب."
                    : `Hi, I’m contacting Tawseelhub about this website conversation.`,
                )}
                target="_blank"
                rel="noreferrer"
                onClick={() =>
                  trackEvent("agent_whatsapp_handoff_started", {
                    page: window.location.pathname,
                    channel: "website",
                    initiated_from: "agent",
                    language,
                  })
                }
              >
                {isRtl ? "المتابعة على واتساب" : "Continue on WhatsApp"}
              </a>
            ) : null}
            {humanState === "waiting_for_human" ? (
              <button
                className="agent-chat__link-button"
                type="button"
                onClick={() => void submitMessage(isRtl ? "كمل مع يوسف" : "Continue with Yousef")}
              >
                {isRtl ? "العودة إلى يوسف" : "Continue with Yousef"}
              </button>
            ) : null}
            <div ref={messagesEndRef} aria-hidden="true" />
          </div>
          <div className="agent-chat__controls">
            {avatarMode ? (
              <label className="agent-chat__voice-toggle">
                <span>{isRtl ? "الردود الصوتية" : "Voice replies"}</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={voiceRepliesEnabled}
                  onChange={(event) => toggleVoiceReplies(event.target.checked)}
                  aria-label={isRtl ? "تفعيل الردود الصوتية" : "Enable voice replies"}
                />
                <span aria-hidden="true" className="agent-chat__voice-toggle-track" />
                <span className="agent-chat__voice-toggle-state">
                  {voiceRepliesEnabled
                    ? isRtl
                      ? "مفعّل"
                      : "On"
                    : isRtl
                      ? "متوقف"
                      : "Off"}
                </span>
              </label>
            ) : null}
            <form className="agent-chat__form" onSubmit={onSubmit}>
              <label htmlFor="agent-chat-input">{isRtl ? "رسالتك" : "Your message"}</label>
              <input
                id="agent-chat-input"
                ref={inputRef}
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  scrollMessagesToBottom();
                }}
                onFocus={() => scrollMessagesToBottom("auto")}
                placeholder={isRtl ? "اكتب رسالتك" : "Type your message"}
                maxLength={1200}
                readOnly={busy}
                aria-busy={busy}
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                aria-label={isRtl ? "إرسال" : "Send"}
              >
                {isRtl ? "إرسال" : "Send"}
              </button>
              {avatarMode ? (
                <button
                  className={`agent-chat__microphone ${voiceListening ? "agent-chat__microphone--listening" : ""}`}
                  type="button"
                  onClick={() => void toggleListening()}
                  disabled={busy || voiceSpeaking}
                  aria-pressed={voiceListening}
                  aria-label={
                    voiceListening
                      ? isRtl
                        ? "إيقاف الاستماع"
                        : "Stop listening"
                      : isRtl
                        ? "اسأل يوسف بصوتك"
                        : "Ask Yousef by voice"
                  }
                >
                  <span aria-hidden="true">🎙</span>
                </button>
              ) : null}
            </form>
            {avatarMode && (voiceListening || voiceSpeaking || lastSpokenAnswer) ? (
              <div className="agent-chat__voice-controls" role="status" aria-live="polite">
                <span>
                  {voiceListening
                    ? isRtl
                      ? "أستمع الآن… اضغط الميكروفون للإيقاف"
                      : "Listening… press the microphone to stop"
                    : voiceSpeaking
                      ? isRtl
                        ? "يوسف يتحدث…"
                        : "Yousef is speaking…"
                      : isRtl
                        ? "الرد الصوتي جاهز"
                        : "Voice answer ready"}
                </span>
                {voiceSpeaking ? (
                  <button type="button" onClick={stopVoice}>
                    {isRtl ? "إيقاف الصوت" : "Stop audio"}
                  </button>
                ) : null}
                {!voiceListening && !voiceSpeaking && lastSpokenAnswer ? (
                  <button type="button" onClick={() => void speakAnswer(lastSpokenAnswer)}>
                    {isRtl ? "إعادة التشغيل" : "Replay"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <a className="agent-chat__privacy" href="/privacy">
            {isRtl ? "الخصوصية" : "Privacy notice"}
          </a>
        </section>
      )}
    </div>
  );
}
