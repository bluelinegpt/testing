import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { platformApi } from "../api/platform-client.js";
import { platformConfiguration } from "../config/environment.js";

type Tab = "conversations" | "handoffs" | "knowledge" | "settings";
type ConversationFilters = {
  assignedToAccountId: string;
  audience: string;
  channel: string;
  classification: string;
  conversationMode: string;
  datePreset: string;
  from: string;
  needsReply: string;
  page: number;
  pageSize: number;
  search: string;
  status: string;
  to: string;
  unread: string;
  visibility: string;
};

const emptyKnowledge = { audience: "all", featureStatus: "informational", language: "en", title: "", content: "", category: "Tawseelhub Overview", status: "draft", sortOrder: 100, visibility: "public_agent" };
const statusOptions = ["new", "open", "in_progress", "waiting_for_customer", "follow_up", "resolved", "closed"] as const;
const classificationOptions = ["shipment_quote", "trader_lead", "delivery_company_lead", "demo_request", "product_question", "storefront_commerce", "support", "general_enquiry", "pricing_enquiry", "partnership_enquiry"] as const;

function titleize(value: string | undefined) {
  return (value ?? "unknown").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDiagnosticTime(value: string | undefined) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function formatDateOnly(value: unknown, fallback?: unknown) {
  const raw = typeof value === "string" && value ? value : typeof fallback === "string" && fallback ? fallback : "";
  if (!raw) return "—";
  const datePart = raw.includes("T") ? raw.slice(0, 10) : raw;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  return match ? `${Number(match[2])}/${Number(match[3])}/${match[1]}` : raw;
}

function formatDubaiTime(value: unknown) {
  if (typeof value !== "string" || !value) return "";
  return new Intl.DateTimeFormat("en-AE", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Dubai" }).format(new Date(value));
}

function formatWaitingDuration(value: unknown, now: number) {
  if (typeof value !== "string" || !value) return "";
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `Waiting 00:${String(seconds).padStart(2, "0")}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) return `Waiting 0${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  if (minutes < 60) return `Waiting ${minutes}m`;
  return `Waiting ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function messageAuthor(message: any, customerName?: string | null) {
  if (message.senderType === "assistant") return "Yousef";
  if (message.senderType === "platform_staff") return "Tawseelhub Team";
  if (message.senderType === "user") return customerName || "Customer";
  return "System";
}

function messageClass(message: any) {
  if (message.senderType === "assistant") return "agent-chat-message agent-chat-message--yousef";
  if (message.senderType === "platform_staff") return "agent-chat-message agent-chat-message--staff";
  if (message.senderType === "user") return "agent-chat-message agent-chat-message--customer";
  return "agent-chat-message agent-chat-message--system";
}

function textDirection(value: string | undefined) {
  return /[\u0600-\u06ff]/u.test(value ?? "") ? "rtl" : "ltr";
}

function conversationChannel(conversation: any) {
  return conversation?.channel === "website" && conversation?.state?.entrySurface === "website_avatar"
    ? "Website Avatar"
    : titleize(conversation?.channel ?? "website");
}

type WebsiteMedia = {
  id?: string;
  publicUrl: string;
  originalFilename?: string;
  mediaType?: string;
  sizeBytes?: number;
  createdAt?: string;
};

function websiteMediaPreviewUrl(value: string | undefined) {
  const path = String(value ?? "").trim();
  if (!path || /^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/api/"))
    return `${platformConfiguration.apiBaseUrl.replace(/\/$/, "")}${path.replace(/^\/api\/v1/, "")}`;
  return path;
}

function formatMediaSize(value: number | undefined) {
  if (!value) return "Not available";
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(2)} MB`
    : `${Math.ceil(value / 1024)} KB`;
}

function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "Not available";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

function AvatarMediaControl({
  kind,
  language,
  media,
  onChange,
  onUploaded,
  purpose = "intro",
  value,
}: {
  kind: "video" | "image";
  language: "English" | "Arabic";
  media: WebsiteMedia[];
  onChange: (value: string) => void;
  onUploaded: (item: WebsiteMedia) => void;
  purpose?: string;
  value: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const expectedPrefix = kind === "video" ? "video/" : "image/";
  const choices = media.filter((item) => item.mediaType?.startsWith(expectedPrefix));
  const current = media.find((item) => item.publicUrl === value);
  const accept = kind === "video" ? "video/mp4" : "image/jpeg,image/png,image/webp";
  const maximumBytes = kind === "video" ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
  const previewUrl = websiteMediaPreviewUrl(value);

  useEffect(() => {
    setDuration(null);
    setPreviewFailed(false);
  }, [value]);

  async function upload() {
    if (!file) return;
    const extensionAccepted = kind === "video"
      ? /\.mp4$/i.test(file.name)
      : /\.(?:jpe?g|png|webp)$/i.test(file.name);
    if ((!file.type.startsWith(expectedPrefix) && !extensionAccepted) || (kind === "video" && file.type && file.type !== "video/mp4")) {
      setError(kind === "video" ? "Select an MP4 video." : "Select a JPG, PNG, or WebP image.");
      return;
    }
    if (file.size > maximumBytes) {
      setError(`${kind === "video" ? "Video" : "Image"} exceeds the ${maximumBytes / (1024 * 1024)} MB limit.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const uploaded = await platformApi.uploadWebsiteMedia(file, {
        altText: `${language} ${purpose} ${kind}`,
        caption: `${purpose} · ${language}`,
      }) as WebsiteMedia;
      onUploaded(uploaded);
      onChange(uploaded.publicUrl);
      setFile(null);
      setPreviewFailed(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Media upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="agent-avatar-media">
      <legend>{language} {purpose} {kind}</legend>
      <label>Current media URL/reference<input value={value} onChange={(event) => { onChange(event.target.value.trim()); setPreviewFailed(false); }} placeholder={kind === "video" ? "Upload or enter an HTTPS MP4 URL" : "Upload or enter an HTTPS image URL"} /></label>
      <div className="agent-avatar-media__actions">
        <label className="agent-avatar-media__file">Replace {kind}<input type="file" accept={accept} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
        <button type="button" disabled={!file || busy} onClick={() => void upload()}>{busy ? "Uploading…" : `Upload & preview ${kind}`}</button>
        <button type="button" disabled={!value} onClick={() => { onChange(""); setPreviewFailed(false); }}>Remove {kind}</button>
      </div>
      <label>Restore/select previous media<select value="" onChange={(event) => { onChange(event.target.value); setPreviewFailed(false); }}><option value="">Choose from Media Library…</option>{choices.map((item) => <option key={item.id ?? item.publicUrl} value={item.publicUrl}>{item.originalFilename ?? item.publicUrl}</option>)}</select></label>
      {error ? <p role="alert">{error}</p> : null}
      <dl className="agent-avatar-media__metadata">
        <div><dt>File name</dt><dd>{current?.originalFilename ?? (value ? "External/direct reference" : "None")}</dd></div>
        <div><dt>File size</dt><dd>{formatMediaSize(current?.sizeBytes)}</dd></div>
        {kind === "video" ? <div><dt>Duration</dt><dd>{formatDuration(duration)}</dd></div> : null}
        <div><dt>Last updated</dt><dd>{current?.createdAt ? new Date(current.createdAt).toLocaleString() : "Not available"}</dd></div>
      </dl>
      {previewUrl && !previewFailed ? kind === "video" ? (
        <video className="agent-avatar-media__preview" controls preload="metadata" src={previewUrl} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onError={() => setPreviewFailed(true)} />
      ) : (
        <img className="agent-avatar-media__preview" src={previewUrl} alt={`${language} intro preview`} onError={() => setPreviewFailed(true)} />
      ) : value ? <p role="alert">Current {kind} could not be previewed. Choose another file or reference before saving.</p> : <p className="platform-muted">No {kind} selected. The public avatar will use its safe fallback.</p>}
      <small className="platform-muted">Uploading creates a new Media Library item. Previous files are retained and can be selected again.</small>
    </fieldset>
  );
}

export function AgentAdminPage() {
  const [searchParams] = useSearchParams();
  const initialSearch = searchParams.get("search") ?? "";
  const [tab, setTab] = useState<Tab>("conversations");
  const [conversations, setConversations] = useState<any[]>([]);
  const [conversationPage, setConversationPage] = useState<any>({ counters: {}, page: 1, pageSize: 25, total: 0 });
  const [conversationFilters, setConversationFilters] = useState<ConversationFilters>({ assignedToAccountId: "all", audience: "all", channel: "all", classification: "all", conversationMode: "all", datePreset: "all", from: "", needsReply: "all", page: 1, pageSize: 25, search: initialSearch, status: "all", to: "", unread: "all", visibility: "active" });
  const [assignees, setAssignees] = useState<any[]>([]);
  const [handoffs, setHandoffs] = useState<any[]>([]);
  const [knowledge, setKnowledge] = useState<any[]>([]);
  const [settings, setSettings] = useState<any | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [websiteMedia, setWebsiteMedia] = useState<WebsiteMedia[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<any | null>(null);
  const [selectedConversationIds, setSelectedConversationIds] = useState<string[]>([]);
  const [reviewDraft, setReviewDraft] = useState({ action: "", assignedToAccountId: "", classification: "general_enquiry", comment: "", status: "new" });
  const [internalComment, setInternalComment] = useState("");
  const [replyText, setReplyText] = useState("");
  const [draft, setDraft] = useState<any>(emptyKnowledge);
  const [message, setMessage] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<"live" | "updating" | "reconnecting">("live");
  const [conversationLoading, setConversationLoading] = useState(true);
  const [conversationRefreshError, setConversationRefreshError] = useState<string | null>(null);
  const [lastLiveUpdate, setLastLiveUpdate] = useState<string | null>(null);
  const [inboxCollapsed, setInboxCollapsed] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [liveAgentSoundStatus, setLiveAgentSoundStatus] = useState<"ready" | "ringing" | "blocked" | "muted">("ready");
  const [liveAgentRingSilencedCount, setLiveAgentRingSilencedCount] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [hasNewMessageBelow, setHasNewMessageBelow] = useState(false);
  const liveAgentAudioContextRef = useRef<AudioContext | null>(null);
  const liveAgentRingIntervalRef = useRef<number | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const waitingForHumanCount = Number(conversationPage.counters?.waitingForHuman ?? 0);

  async function load() {
    const settingsRequest = loadSettings();
    const [nextConversationPage, nextHandoffs, nextKnowledge, nextAssignees] = await Promise.all([
      platformApi.agentConversations(conversationFilters),
      platformApi.agentHandoffs(),
      platformApi.agentKnowledge(),
      platformApi.agentAssignees(),
    ]);
    setConversationPage(nextConversationPage);
    if (Array.isArray(nextConversationPage.items)) setConversations(nextConversationPage.items);
    setConversationLoading(false);
    setConversationRefreshError(null);
    setHandoffs(nextHandoffs);
    setKnowledge(nextKnowledge);
    setAssignees(nextAssignees);
    await settingsRequest;
  }

  async function loadSettings() {
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const [nextSettings, cms] = await Promise.all([
        platformApi.agentSettings(),
        platformApi.websiteCms().catch(() => ({ media: [] })),
      ]);
      if (!nextSettings) throw new Error("missing_agent_settings");
      setSettings(nextSettings);
      setWebsiteMedia(Array.isArray(cms.media) ? cms.media : []);
    } catch {
      setSettingsError("Agent settings could not be loaded. Confirm the local API is running and the local database migrations are current, then retry.");
    } finally {
      setSettingsLoading(false);
    }
  }

  async function refreshSelectedConversation(id: string) {
    const transcript = transcriptRef.current;
    const nearBottom = transcript ? transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80 : true;
    const previousLastMessageId = lastMessageIdRef.current;
    const detail = await platformApi.agentConversation(id);
    const messages = Array.isArray(detail.messages) ? detail.messages : [];
    const nextLastMessageId = messages.length ? String(messages[messages.length - 1]?.id ?? `${messages[messages.length - 1]?.createdAt ?? ""}-${messages.length}`) : null;
    setSelectedConversation(detail);
    lastMessageIdRef.current = nextLastMessageId;
    if (nextLastMessageId && previousLastMessageId && nextLastMessageId !== previousLastMessageId) {
      if (nearBottom) {
        window.setTimeout(() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }), 0);
      } else {
        setHasNewMessageBelow(true);
      }
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (tab !== "conversations") return;
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        setLiveStatus("updating");
        const nextConversationPage = await platformApi.agentConversations(conversationFilters);
        if (cancelled) return;
        setConversationPage(nextConversationPage);
        if (Array.isArray(nextConversationPage.items)) setConversations(nextConversationPage.items);
        setLastLiveUpdate(new Date().toISOString());
        setConversationLoading(false);
        setConversationRefreshError(null);
        setLiveStatus("live");
      } catch {
        if (!cancelled) {
          setConversationLoading(false);
          setConversationRefreshError("Live refresh temporarily unavailable");
          setLiveStatus("reconnecting");
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 4000);
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [conversationFilters, tab]);

  useEffect(() => {
    if (tab !== "conversations" || !selectedConversation?.id) return;
    let cancelled = false;
    const id = selectedConversation.id;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        if (!cancelled) await refreshSelectedConversation(id);
      } catch {
        if (!cancelled) setLiveStatus("reconnecting");
      }
    };
    const interval = window.setInterval(() => void refresh(), 3000);
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [selectedConversation?.id, tab]);

  useEffect(() => {
    const visibleIds = new Set(conversations.map((item) => String(item.id)));
    setSelectedConversationIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [conversations]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      if (liveAgentRingIntervalRef.current !== null) window.clearInterval(liveAgentRingIntervalRef.current);
      liveAgentAudioContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (tab !== "conversations" || waitingForHumanCount <= 0) {
      stopLiveAgentRing();
      setLiveAgentRingSilencedCount(null);
      return;
    }
    if (liveAgentRingSilencedCount === waitingForHumanCount) {
      stopLiveAgentRing("muted");
      return;
    }
    startLiveAgentRing();
  }, [tab, waitingForHumanCount, liveAgentRingSilencedCount]);

  function audioContextConstructor() {
    return window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  }

  async function liveAgentAudioContext() {
    const AudioCtor = audioContextConstructor();
    if (!AudioCtor) throw new Error("audio_unavailable");
    if (!liveAgentAudioContextRef.current) liveAgentAudioContextRef.current = new AudioCtor();
    if (liveAgentAudioContextRef.current.state === "suspended") await liveAgentAudioContextRef.current.resume();
    return liveAgentAudioContextRef.current;
  }

  async function playLiveAgentRingTone() {
    try {
      const context = await liveAgentAudioContext();
      const start = context.currentTime;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
      gain.connect(context.destination);
      const firstTone = context.createOscillator();
      firstTone.type = "sine";
      firstTone.frequency.setValueAtTime(880, start);
      firstTone.connect(gain);
      firstTone.start(start);
      firstTone.stop(start + 0.42);
      const secondTone = context.createOscillator();
      secondTone.type = "sine";
      secondTone.frequency.setValueAtTime(660, start + 0.48);
      secondTone.connect(gain);
      secondTone.start(start + 0.48);
      secondTone.stop(start + 0.86);
      window.setTimeout(() => gain.disconnect(), 950);
      setLiveAgentSoundStatus("ringing");
    } catch {
      setLiveAgentSoundStatus("blocked");
    }
  }

  function startLiveAgentRing() {
    if (liveAgentRingIntervalRef.current !== null) return;
    void playLiveAgentRingTone();
    liveAgentRingIntervalRef.current = window.setInterval(() => void playLiveAgentRingTone(), 2200);
  }

  function stopLiveAgentRing(nextStatus: "ready" | "muted" = "ready") {
    if (liveAgentRingIntervalRef.current !== null) {
      window.clearInterval(liveAgentRingIntervalRef.current);
      liveAgentRingIntervalRef.current = null;
    }
    setLiveAgentSoundStatus(nextStatus);
  }

  function muteCurrentLiveAgentRing() {
    setLiveAgentRingSilencedCount(waitingForHumanCount);
    stopLiveAgentRing("muted");
  }

  async function enableLiveAgentSound() {
    setLiveAgentRingSilencedCount(null);
    await playLiveAgentRingTone();
    if (waitingForHumanCount > 0) startLiveAgentRing();
  }

  async function saveKnowledge(event: FormEvent) {
    event.preventDefault();
    await platformApi.createAgentKnowledge(draft);
    setDraft(emptyKnowledge);
    setMessage("Knowledge entry saved.");
    await load();
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    await platformApi.updateAgentSettings(settings);
    setMessage("Agent settings saved.");
    await load();
  }

  async function saveAvatarSettings() {
    if (!settings) return;
    const value = (key: string) => settings[key] || undefined;
    await platformApi.updateAgentAvatarSettings({
      enabled: Boolean(settings.avatarEnabled),
      displayName: settings.avatarDisplayName,
      titleEn: settings.avatarTitleEn,
      titleAr: settings.avatarTitleAr,
      imageUrl: value("avatarImageUrl"),
      introVideoUrlEn: value("avatarIntroVideoUrlEn"),
      introVideoUrlAr: value("avatarIntroVideoUrlAr"),
      introImageUrlEn: value("avatarIntroImageUrlEn"),
      introImageUrlAr: value("avatarIntroImageUrlAr"),
      homeOperationsImageUrlEn: value("avatarHomeOperationsImageUrlEn"),
      homeOperationsImageUrlAr: value("avatarHomeOperationsImageUrlAr"),
      introTranscriptEn: settings.avatarIntroTranscriptEn,
      introTranscriptAr: settings.avatarIntroTranscriptAr,
      showOnHomepage: Boolean(settings.avatarShowHomepage),
      showOnPricing: Boolean(settings.avatarShowPricing),
      showOnDeliveryCompany: Boolean(settings.avatarShowDeliveryCompany),
      showOnTrader: Boolean(settings.avatarShowTrader),
      showOnSendPackage: Boolean(settings.avatarShowSendPackage),
      autoOpen: Boolean(settings.avatarAutoOpen),
      provider: settings.avatarProvider,
      status: settings.avatarStatus,
      liveEnabled: Boolean(settings.avatarLiveEnabled),
      liveProvider: settings.avatarLiveProvider ?? "heygen_live",
      liveAvatarId: value("avatarLiveAvatarId"),
      liveVoiceIdEn: value("avatarLiveVoiceIdEn"),
      liveVoiceIdAr: value("avatarLiveVoiceIdAr"),
      liveVoiceAgentIdEn: value("avatarLiveVoiceAgentIdEn"),
      liveVoiceAgentIdAr: value("avatarLiveVoiceAgentIdAr"),
      liveMaxSessionSeconds: Number(settings.avatarLiveMaxSessionSeconds ?? 300),
      liveIdleTimeoutSeconds: Number(settings.avatarLiveIdleTimeoutSeconds ?? 60),
      liveMaxConcurrentSessions: Number(settings.avatarLiveMaxConcurrentSessions ?? 2),
      liveStartRateLimitPerMinute: Number(settings.avatarLiveStartRateLimitPerMinute ?? 3),
      liveDailyMinuteCap: settings.avatarLiveDailyMinuteCap ? Number(settings.avatarLiveDailyMinuteCap) : undefined,
      liveCostPerMinute: settings.avatarLiveCostPerMinute === "" || settings.avatarLiveCostPerMinute == null ? undefined : Number(settings.avatarLiveCostPerMinute),
    });
    setMessage("Avatar settings saved.");
    await load();
  }

  async function setHandoffStatus(id: string, status: string) {
    await platformApi.updateAgentHandoffStatus(id, status);
    await load();
  }

  async function openConversation(id: string) {
    const detail = await platformApi.agentConversation(id);
    const messages = Array.isArray(detail.messages) ? detail.messages : [];
    lastMessageIdRef.current = messages.length ? String(messages[messages.length - 1]?.id ?? `${messages[messages.length - 1]?.createdAt ?? ""}-${messages.length}`) : null;
    setSelectedConversation(detail);
    setHasNewMessageBelow(false);
    setReviewDraft({ action: detail.reviewAction ?? "", assignedToAccountId: detail.assignedToAccountId ?? "", classification: detail.operationalClassification ?? "general_enquiry", comment: detail.reviewComment ?? "", status: detail.reviewStatus ?? "new" });
    window.setTimeout(() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight }), 0);
  }

  async function saveConversationReview() {
    if (!selectedConversation) return;
    const detail = await platformApi.updateAgentConversationReview(selectedConversation.id, reviewDraft);
    setSelectedConversation(detail);
    setMessage("Conversation review saved.");
    await load();
  }

  async function addConversationComment() {
    if (!selectedConversation || !internalComment.trim()) return;
    const detail = await platformApi.addAgentConversationComment(selectedConversation.id, internalComment);
    setSelectedConversation(detail);
    setInternalComment("");
    setMessage("Internal comment saved.");
    await load();
  }

  async function sendWhatsAppReply() {
    if (!selectedConversation || !replyText.trim()) return;
    const detail = await platformApi.replyAgentWhatsApp(selectedConversation.id, replyText);
    setSelectedConversation(detail);
    setReplyText("");
    setMessage("WhatsApp reply saved and sent through the configured provider.");
    window.setTimeout(() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }), 0);
    await load();
  }

  async function sendWebsiteReply() {
    if (!selectedConversation || !replyText.trim()) return;
    const detail = await platformApi.replyAgentWebsite(selectedConversation.id, replyText);
    setSelectedConversation(detail);
    setReplyText("");
    setMessage("Website chat reply sent to the customer.");
    window.setTimeout(() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }), 0);
    await load();
  }

  async function setConversationMode(mode: "ai_active" | "human_active" | "ai_resume" | "paused") {
    if (!selectedConversation) return;
    const detail = await platformApi.setAgentConversationMode(selectedConversation.id, mode);
    setSelectedConversation(detail);
    setMessage(mode === "human_active" ? "Yousef is paused for this conversation." : "Yousef can respond again for this conversation.");
    window.setTimeout(() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }), 0);
    await load();
  }

  function setConversationFilter(key: keyof ConversationFilters, value: string | number) {
    setConversationFilters((current) => ({
      ...current,
      [key]: value,
      ...(key === "datePreset" && value !== "custom" ? { from: "", to: "" } : {}),
      ...(key === "conversationMode" && value !== "human_active" ? { needsReply: "all" } : {}),
      ...(key === "page" ? {} : { page: 1 }),
    }));
  }

  function applyConversationShortcut(filters: Partial<ConversationFilters>) {
    setConversationFilters((current) => ({
      assignedToAccountId: "all",
      audience: "all",
      channel: "all",
      classification: "all",
      conversationMode: "all",
      datePreset: "all",
      from: "",
      needsReply: "all",
      to: "",
      page: 1,
      pageSize: current.pageSize,
      search: "",
      status: "all",
      unread: "all",
      visibility: "active",
      ...filters,
    }));
  }

  async function openWaitingForHumanConversation() {
    const waitingFilters: ConversationFilters = {
      assignedToAccountId: "all",
      audience: "all",
      channel: "all",
      classification: "all",
      conversationMode: "paused",
      datePreset: "all",
      from: "",
      needsReply: "all",
      page: 1,
      pageSize: conversationFilters.pageSize,
      search: "",
      status: "all",
      to: "",
      unread: "all",
      visibility: "active",
    };
    setConversationFilters(waitingFilters);
    const page = await platformApi.agentConversations(waitingFilters);
    setConversationPage(page);
    const waitingItems = Array.isArray(page.items) ? page.items : [];
    setConversations(waitingItems);
    if (waitingItems[0]?.id) await openConversation(waitingItems[0].id);
  }

  function showTodayConversations() {
    applyConversationShortcut({ datePreset: "today" });
  }

  async function hideSelectedConversation() {
    if (!selectedConversation) return;
    await platformApi.hideAgentConversation(selectedConversation.id);
    setMessage("Conversation hidden. Use Hidden Chats to bring it back.");
    setSelectedConversation(null);
    await load();
  }

  async function unhideSelectedConversation() {
    if (!selectedConversation) return;
    const detail = await platformApi.unhideAgentConversation(selectedConversation.id);
    setSelectedConversation(detail);
    setMessage("Conversation restored to the active inbox.");
    await load();
  }

  async function deleteSelectedConversation() {
    if (!selectedConversation) return;
    const confirmed = window.confirm("Permanently delete this chat? Use Hide instead if you may need it later.");
    if (!confirmed) return;
    await platformApi.deleteAgentConversation(selectedConversation.id);
    setConversationPage((current: any) => ({
      ...current,
      items: (current.items ?? []).filter((item: any) => item.id !== selectedConversation.id),
      total: Math.max(Number(current.total ?? 0) - 1, 0),
    }));
    setMessage("Conversation deleted.");
    setSelectedConversation(null);
    await load();
  }

  function toggleConversationSelection(id: string, checked: boolean) {
    setSelectedConversationIds((current) => {
      if (checked) return current.includes(id) ? current : [...current, id];
      return current.filter((item) => item !== id);
    });
  }

  function toggleAllVisibleConversations(checked: boolean) {
    setSelectedConversationIds(checked ? conversations.map((item) => String(item.id)) : []);
  }

  async function deleteSelectedConversations() {
    if (!selectedConversationIds.length) return;
    const count = selectedConversationIds.length;
    const confirmed = window.confirm(`Permanently delete ${count} selected chat${count === 1 ? "" : "s"}? Use Hide instead if you may need them later.`);
    if (!confirmed) return;
    const idsToDelete = [...selectedConversationIds];
    let deletedCount = 0;
    for (const id of idsToDelete) {
      try {
        await platformApi.deleteAgentConversation(id);
        deletedCount += 1;
      } catch (error) {
        console.error("Failed to delete selected agent conversation", error);
      }
    }
    setSelectedConversationIds([]);
    if (selectedConversation?.id && idsToDelete.includes(String(selectedConversation.id))) setSelectedConversation(null);
    setConversationPage((current: any) => ({
      ...current,
      items: (current.items ?? []).filter((item: any) => !idsToDelete.includes(String(item.id))),
      total: Math.max(Number(current.total ?? 0) - deletedCount, 0),
    }));
    setConversations((current) => current.filter((item) => !idsToDelete.includes(String(item.id))));
    setMessage(deletedCount === count ? `Deleted ${deletedCount} selected chat${deletedCount === 1 ? "" : "s"}.` : `Deleted ${deletedCount} of ${count} selected chats. Refresh and try again for any remaining chats.`);
    await load();
  }

  const linkedLabel = (item: any) => [item.quoteReference ? `Quote ${item.quoteReference}` : item.hasQuote ? "Quote" : "", item.traderReference ? `Trader ${item.traderReference}` : item.hasTraderApplication ? "Trader" : "", item.demoReference ? `Demo ${item.demoReference}` : item.hasDemoRequest ? "Demo" : "", item.handoffStatus ? `Handoff ${item.handoffStatus}` : ""].filter(Boolean).join(", ") || "None";
  const modeLabel = (mode: string | undefined) => mode === "paused" ? "Waiting for Human" : mode === "human_active" ? "Human Active" : mode === "ai_resume" ? "Returned to Yousef" : "Yousef Active";
  const rowClass = (item: any) => [
    "agent-inbox-item",
    selectedConversation?.id === item.id ? "agent-inbox-item--selected" : "",
    item.conversationMode === "paused" ? "agent-inbox-item--waiting" : "",
    item.conversationMode === "human_active" ? "agent-inbox-item--human" : "",
    item.conversationMode === "human_active" && Number(item.waitingCustomerMessageCount ?? 0) > 0 ? "agent-inbox-item--needs-reply" : "",
  ].filter(Boolean).join(" ");
  const waitingDuration = (value: unknown) => formatWaitingDuration(value, now);
  const selectedMode = selectedConversation?.conversationMode;
  const selectedIsWebsite = selectedConversation?.channel === "website" || selectedConversation?.lastChannel === "website";
  const selectedIsWhatsApp = selectedConversation?.channel === "whatsapp" || selectedConversation?.lastChannel === "whatsapp";
  const selectedNeedsHumanControls = selectedMode === "paused" || selectedMode === "human_active";
  const selectedModeLabel = modeLabel(selectedMode);
  const selectedWaitingCount = Number(selectedConversation?.waitingCustomerMessageCount ?? 0);
  const selectedWaitingDuration = waitingDuration(selectedConversation?.waitingSince);
  const selectedIsHidden = Boolean(selectedConversation?.hiddenAt);
  const selectedIsDeleted = Boolean(selectedConversation?.deletedAt);
  const selectedConversationIdSet = new Set(selectedConversationIds);
  const visibleConversationCount = conversations.length;
  const allVisibleConversationsSelected = visibleConversationCount > 0 && conversations.every((item) => selectedConversationIdSet.has(String(item.id)));
  const openConversationFromRow = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void openConversation(id);
    }
  };

  return (
    <section className="platform-page agent-admin-page">
      <div className="platform-page__header">
        <div>
          <p className="platform-page__eyebrow">Website Content</p>
          <h1>Tawseelhub Agent</h1>
          <p>Shared Agent Core for website chat and the WhatsApp simulator.</p>
        </div>
      </div>
      {message ? <p className="platform-alert platform-alert--success">{message}</p> : null}
      <div className="platform-tabs" role="tablist" aria-label="Agent administration">
        {(["conversations", "handoffs", "knowledge", "settings"] as const).map((item) => (
          <button className={tab === item ? "platform-tab platform-tab--active" : "platform-tab"} key={item} onClick={() => setTab(item)} type="button">{item.replace("-", " ")}</button>
        ))}
      </div>

      {tab === "conversations" ? (
        <div className="agent-console-layout">
          <div className="platform-card agent-console-pane agent-console-pane--inbox">
            <div className="agent-console-title">
              <div>
                <h2>Conversation Inbox</h2>
                {!inboxCollapsed ? (
                  <>
                    <p className="platform-muted">Live support queue. Rows update automatically without refreshing the page.</p>
                    <p className="platform-muted">Last update: {lastLiveUpdate ? formatDubaiTime(lastLiveUpdate) : "starting…"}</p>
                  </>
                ) : null}
              </div>
              <div className="agent-live-status-stack">
                <span className={`agent-live-indicator agent-live-indicator--${liveStatus}`}>{liveStatus === "live" ? "Live" : liveStatus === "updating" ? "Updating…" : "Reconnecting…"}</span>
                {waitingForHumanCount > 0 ? (
                  liveAgentSoundStatus === "blocked" ? (
                    <button className="platform-button platform-button--primary agent-sound-button" type="button" onClick={() => void enableLiveAgentSound()}>Enable ring sound</button>
                  ) : liveAgentSoundStatus === "muted" ? (
                    <div className="agent-ring-actions">
                      <button className="agent-live-indicator agent-live-indicator--quiet" type="button" onClick={() => void openWaitingForHumanConversation()}>Ring stopped · {waitingForHumanCount}</button>
                      <button className="agent-live-indicator agent-live-indicator--ringing" type="button" onClick={() => void enableLiveAgentSound()}>Resume ring</button>
                    </div>
                  ) : (
                    <div className="agent-ring-actions">
                      <button className="agent-live-indicator agent-live-indicator--ringing" type="button" onClick={() => void openWaitingForHumanConversation()}>Ringing · {waitingForHumanCount}</button>
                      <button className="agent-live-indicator agent-live-indicator--quiet" type="button" onClick={muteCurrentLiveAgentRing}>Stop ring</button>
                    </div>
                  )
                ) : (
                  <span className="agent-live-indicator agent-live-indicator--quiet">Sound ready</span>
                )}
                <button className="platform-button platform-button--quiet agent-collapse-button" type="button" onClick={() => setInboxCollapsed((value) => !value)}>
                  {inboxCollapsed ? "Show filters" : "Collapse filters"}
                </button>
              </div>
            </div>
            {!inboxCollapsed ? (
              <>
              <div className="lead-action-grid">
              <button className="platform-badge agent-counter-button" type="button" onClick={() => applyConversationShortcut({ needsReply: "all", status: "new" })}>New {conversationPage.counters?.new ?? 0}</button>
              <button className="platform-badge agent-counter-button" type="button" onClick={() => applyConversationShortcut({ needsReply: "all", status: "open,in_progress" })}>Open {conversationPage.counters?.open ?? 0}</button>
              <button className="platform-badge agent-counter-button" type="button" onClick={() => applyConversationShortcut({ needsReply: "all", status: "waiting_for_customer" })}>Waiting {conversationPage.counters?.waitingForCustomer ?? 0}</button>
              <button className="platform-badge agent-counter-button" type="button" onClick={() => applyConversationShortcut({ conversationMode: "paused", needsReply: "all" })}>Waiting for Human {conversationPage.counters?.waitingForHuman ?? 0}</button>
              <button className="platform-badge agent-counter-button" type="button" onClick={() => applyConversationShortcut({ conversationMode: "human_active", needsReply: "all" })}>Human Active {conversationPage.counters?.humanActive ?? 0}</button>
              <button className="platform-badge agent-counter-button" type="button" onClick={() => applyConversationShortcut({ conversationMode: "human_active", needsReply: "true" })}>Needs Reply {conversationPage.counters?.needsReply ?? 0}</button>
              <button className="platform-badge agent-counter-button" type="button" onClick={() => applyConversationShortcut({ needsReply: "all", status: "follow_up" })}>Follow Up {conversationPage.counters?.followUp ?? 0}</button>
              <button className="platform-badge agent-counter-button" type="button" onClick={() => applyConversationShortcut({ needsReply: "all", status: "resolved", datePreset: "today" })}>Resolved Today {conversationPage.counters?.resolvedToday ?? 0}</button>
              <button className="platform-badge agent-counter-button" type="button" onClick={() => applyConversationShortcut({ needsReply: "all", unread: "unread" })}>Unread {conversationPage.counters?.unread ?? 0}</button>
              <button className="platform-badge agent-counter-button" type="button" onClick={() => applyConversationShortcut({ visibility: "hidden" })}>Hidden {conversationPage.counters?.hidden ?? 0}</button>
            </div>
            <div className="lead-contact-actions agent-list-shortcuts">
              <button className="platform-button platform-button--quiet" type="button" onClick={() => void openWaitingForHumanConversation()}>Open waiting chat</button>
              <button className="platform-button platform-button--quiet" type="button" onClick={showTodayConversations}>Today only</button>
              <button className="platform-button platform-button--quiet" type="button" onClick={() => applyConversationShortcut({ visibility: "hidden" })}>Hidden Chats</button>
              <button className="platform-button platform-button--quiet" type="button" onClick={() => applyConversationShortcut({ conversationMode: "all", datePreset: "all", needsReply: "all", status: "all", unread: "all" })}>Show all</button>
            </div>
            <div className="agent-inbox-filters">
              <input placeholder="Search AGT, QTE, name, mobile" value={conversationFilters.search} onChange={(event) => setConversationFilter("search", event.target.value)} />
              <select value={conversationFilters.datePreset} onChange={(event) => setConversationFilter("datePreset", event.target.value)}><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="this_week">This Week</option><option value="this_month">This Month</option><option value="custom">Custom From / To</option><option value="all">All Dates</option></select>
              {conversationFilters.datePreset === "custom" ? (
                <>
                  <label className="platform-inline-field">From<input aria-label="Conversation date from" type="date" value={conversationFilters.from} onChange={(event) => setConversationFilter("from", event.target.value)} /></label>
                  <label className="platform-inline-field">To<input aria-label="Conversation date to" type="date" value={conversationFilters.to} onChange={(event) => setConversationFilter("to", event.target.value)} /></label>
                </>
              ) : null}
              <select value={conversationFilters.status} onChange={(event) => setConversationFilter("status", event.target.value)}><option value="all">All Statuses</option><option value="open,in_progress">Open / In Progress</option>{statusOptions.map((status) => <option key={status} value={status}>{titleize(status)}</option>)}</select>
              <select value={conversationFilters.channel} onChange={(event) => setConversationFilter("channel", event.target.value)}><option value="all">All Channels</option><option value="website">Website</option><option value="website_avatar">Website Avatar</option><option value="whatsapp">WhatsApp</option><option value="simulator">WhatsApp Simulator</option></select>
              <select value={conversationFilters.conversationMode} onChange={(event) => setConversationFilter("conversationMode", event.target.value)}><option value="all">All Agent Modes</option><option value="paused">Waiting for Human</option><option value="human_active">Human Active</option><option value="ai_active">Yousef Active</option><option value="ai_resume">Returned to Yousef</option></select>
              <select value={conversationFilters.audience} onChange={(event) => setConversationFilter("audience", event.target.value)}><option value="all">All Audiences</option><option value="customer">Customer</option><option value="trader">Trader</option><option value="delivery_company">Delivery Company</option><option value="unknown">Unknown</option></select>
              <select value={conversationFilters.classification} onChange={(event) => setConversationFilter("classification", event.target.value)}><option value="all">All Classifications</option>{classificationOptions.map((classification) => <option key={classification} value={classification}>{titleize(classification)}</option>)}</select>
              <select value={conversationFilters.assignedToAccountId} onChange={(event) => setConversationFilter("assignedToAccountId", event.target.value)}><option value="all">All Assignees</option><option value="unassigned">Unassigned</option>{assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.username}</option>)}</select>
              <select value={conversationFilters.unread} onChange={(event) => setConversationFilter("unread", event.target.value)}><option value="all">All Read States</option><option value="unread">Unread</option><option value="read">Read</option></select>
              <select value={conversationFilters.visibility} onChange={(event) => setConversationFilter("visibility", event.target.value)}><option value="active">Active Chats</option><option value="hidden">Hidden Chats</option><option value="all">All Including Hidden</option></select>
              <select value={conversationFilters.pageSize} onChange={(event) => setConversationFilter("pageSize", Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select>
            </div>
            <p className="platform-muted">Use View, or click any conversation row, to open it.{conversationFilters.needsReply === "true" ? " Showing conversations that need a human reply." : ""}</p>
            <div className="agent-bulk-actions" aria-label="Bulk conversation actions">
              <label className="agent-bulk-select">
                <input
                  checked={allVisibleConversationsSelected}
                  disabled={!visibleConversationCount}
                  onChange={(event) => toggleAllVisibleConversations(event.target.checked)}
                  type="checkbox"
                />
                Select all visible chats
              </label>
              <button
                className="platform-button platform-button--danger"
                disabled={!selectedConversationIds.length}
                onClick={() => void deleteSelectedConversations()}
                type="button"
              >
                Delete selected{selectedConversationIds.length ? ` (${selectedConversationIds.length})` : ""}
              </button>
            </div>
              </>
            ) : null}
            {conversationRefreshError ? <p className="platform-alert platform-alert--warning">{conversationRefreshError}</p> : null}
            <div className="agent-inbox-list" aria-label="Conversation inbox">
              {conversationLoading && !conversations.length ? <p className="platform-muted">Loading conversations...</p> : null}
              {conversations.length ? conversations.map((item) => <article
                className={rowClass(item)}
                key={item.id}
                onClick={() => void openConversation(item.id)}
                onKeyDown={(event) => openConversationFromRow(event, item.id)}
                role="button"
                tabIndex={0}
                title="Open conversation detail"
              >
                <div className="agent-inbox-item__topline">
                  <label className="agent-row-select" onClick={(event) => event.stopPropagation()}>
                    <input
                      aria-label={`Select conversation ${item.referenceNumber ?? item.customerName ?? item.id}`}
                      checked={selectedConversationIdSet.has(String(item.id))}
                      onChange={(event) => toggleConversationSelection(String(item.id), event.target.checked)}
                      type="checkbox"
                    />
                    <span>Select</span>
                  </label>
                  <strong>{item.customerName ?? "Anonymous Visitor"}</strong>
                  <button className="platform-button platform-button--primary agent-view-button" type="button" onClick={(event) => { event.stopPropagation(); void openConversation(item.id); }}>View</button>
                </div>
                <div className="agent-inbox-item__meta">
                  <span>{titleize(item.operationalClassification)}</span>
                  <span>{conversationChannel(item)}</span>
                  <span>{item.mobileNumber ?? "No mobile"}</span>
                  {item.identityMatchType === "ip" && Number(item.conversationCount ?? 1) > 1 ? <span className="platform-badge agent-ip-badge">Same IP</span> : item.hasVisitorIp ? <span className="platform-badge agent-ip-badge">IP captured</span> : null}
                </div>
                <div className="agent-inbox-item__state">
                  <span className="agent-mode-pill">{modeLabel(item.conversationMode)}</span>
                  {Number(item.waitingCustomerMessageCount ?? 0) > 0 ? <span className="agent-waiting-pill">● {item.waitingCustomerMessageCount} waiting</span> : null}
                  {item.waitingSince ? <span className="agent-waiting-time">{waitingDuration(item.waitingSince)}</span> : null}
                  {Number(item.unreadCount ?? 0) > 0 ? <span className="platform-badge">{item.unreadCount} unread</span> : null}
                  {item.hiddenAt && !item.deletedAt ? <span className="platform-badge agent-hidden-badge">Hidden</span> : null}
                  {item.deletedAt ? <span className="platform-badge agent-deleted-badge">Deleted</span> : null}
                </div>
                <p className="agent-inbox-preview">{item.latestMessagePreview ?? item.lastUserMessage ?? item.lastAssistantMessage ?? "No message preview yet."}</p>
                <div className="agent-inbox-item__footer">
                  <span>{item.assignedToUsername ? `Assigned to ${item.assignedToUsername}` : "Unassigned"}</span>
                  <span>{item.messageCount ?? 0} total messages</span>
                  <span>{formatDubaiTime(item.lastMessageAt ?? item.updatedAt)}</span>
                </div>
              </article>) : !conversationLoading ? <p className="platform-muted">No conversations match the current filters.</p> : null}
            </div>
            <div className="lead-contact-actions">
              <button className="platform-button platform-button--quiet" disabled={conversationFilters.page <= 1} type="button" onClick={() => setConversationFilter("page", conversationFilters.page - 1)}>Previous</button>
              <span className="platform-muted">Page {conversationPage.page ?? 1} · {conversationPage.total ?? 0} total</span>
              <button className="platform-button platform-button--quiet" disabled={(conversationPage.page ?? 1) * (conversationPage.pageSize ?? 25) >= (conversationPage.total ?? 0)} type="button" onClick={() => setConversationFilter("page", conversationFilters.page + 1)}>Next</button>
            </div>
          </div>
          <div className="platform-card agent-console-pane agent-console-pane--detail">
            <div className="agent-console-title">
              <h2>Active Conversation</h2>
              <button className="platform-button platform-button--quiet agent-collapse-button" type="button" onClick={() => setDetailCollapsed((value) => !value)}>
                {detailCollapsed ? "Show details" : "Collapse details"}
              </button>
            </div>
            {!selectedConversation ? <p className="platform-muted">Select a conversation to see the full saved chat, actions, and internal review comment.</p> : null}
            {selectedConversation ? (
              <>
                {!detailCollapsed ? (
                  <div className="agent-detail-top">
                    <h3>{selectedConversation.customerName ?? "Anonymous"} · {selectedConversation.referenceNumber}</h3>
                    <p className="platform-muted">{selectedConversation.conversationCount ?? 1} session(s) in this Dubai business-day thread · {conversationChannel(selectedConversation)} · {selectedConversation.language} · Mode: {selectedModeLabel}</p>
                    <div className="lead-action-grid">
                      <span className="platform-badge">{selectedConversation.mobileNumber ?? "No mobile"}</span>
                      {selectedConversation.visitorIpHash ? <span className="platform-badge agent-ip-badge">IP captured</span> : null}
                      <span className="platform-badge">{titleize(selectedConversation.audience)}</span>
                      <span className="platform-badge">{titleize(selectedConversation.operationalClassification)}</span>
                      <span className="platform-badge">{selectedConversation.email ?? "No email"}</span>
                      <span className="platform-badge">Last channel {selectedConversation.state?.entrySurface === "website_avatar" ? "Website Avatar" : titleize(selectedConversation.lastChannel ?? selectedConversation.channel)}</span>
                      <span className="platform-badge">Assigned to {selectedConversation.assignedToUsername ?? "Unassigned"}</span>
                      {selectedIsHidden && !selectedIsDeleted ? <span className="platform-badge agent-hidden-badge">Hidden</span> : null}
                      {selectedIsDeleted ? <span className="platform-badge agent-deleted-badge">Deleted</span> : null}
                      {selectedConversation.previousDays?.length ? <span className="platform-badge">Related history {selectedConversation.previousDays.length} day(s)</span> : null}
                      {selectedWaitingCount > 0 ? <span className="agent-waiting-pill">● {selectedWaitingCount} waiting</span> : null}
                      {selectedWaitingDuration ? <span className="agent-waiting-time">{selectedWaitingDuration}</span> : null}
                    </div>
                    <div className="agent-management-actions">
                      {!selectedIsHidden && !selectedIsDeleted ? <button className="platform-button platform-button--quiet" type="button" onClick={() => void hideSelectedConversation()}>Hide this chat</button> : null}
                      {selectedIsHidden || selectedIsDeleted ? <button className="platform-button platform-button--quiet" type="button" onClick={() => void unhideSelectedConversation()}>Unhide / Restore</button> : null}
                      {!selectedIsDeleted ? <button className="platform-button platform-button--danger" type="button" onClick={() => void deleteSelectedConversation()}>Delete this chat</button> : null}
                    </div>
                  </div>
                ) : <p className="platform-muted">{selectedConversation.referenceNumber} details hidden. Conversation tools remain below.</p>}
                <div className={selectedNeedsHumanControls ? "agent-live-controls agent-live-controls--attention" : "agent-live-controls"}>
                  <div>
                    <h3>Live Agent Controls</h3>
                    <p className="platform-muted">
                      {selectedMode === "paused"
                        ? "This customer is waiting for a human. Take over to pause Yousef and reply from Platform."
                        : selectedMode === "human_active"
                          ? "A human is handling this conversation now. Reply here or return the conversation to Yousef."
                          : "Yousef is active. Take over only when you want Platform staff to handle the customer directly."}
                    </p>
                  </div>
                  <div className="lead-contact-actions">
                    {selectedMode !== "human_active" ? <button className="platform-button platform-button--primary" type="button" onClick={() => void setConversationMode("human_active")}>Take Over</button> : null}
                  </div>
                </div>
                <div className="lead-workflow">
                  <h3>Conversation Review</h3>
                  <p className="platform-muted">Status tracks business follow-up. Classification is what the conversation is about. Assignee is the Platform staff owner. Mode stays separate above because it controls whether Yousef or a human replies.</p>
                  <div className="agent-review-grid">
                    <label>Status<span>Status tracks the business follow-up state.</span><select value={reviewDraft.status} onChange={(event) => setReviewDraft({ ...reviewDraft, status: event.target.value })}>{statusOptions.map((status) => <option key={status} value={status}>{titleize(status)}</option>)}</select></label>
                    <label>Classification<span>Used for routing, filtering and reporting.</span><select value={reviewDraft.classification} onChange={(event) => setReviewDraft({ ...reviewDraft, classification: event.target.value })}>{classificationOptions.map((classification) => <option key={classification} value={classification}>{titleize(classification)}</option>)}</select></label>
                    <label>Assignee<span>Who owns or follows up this conversation.</span><select value={reviewDraft.assignedToAccountId} onChange={(event) => setReviewDraft({ ...reviewDraft, assignedToAccountId: event.target.value })}><option value="">Unassigned</option>{assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.username}</option>)}</select></label>
                  </div>
                  <label>Follow-up Action<input value={reviewDraft.action} onChange={(event) => setReviewDraft({ ...reviewDraft, action: event.target.value })} placeholder="Call customer, check quote, confirm pricing, follow up tomorrow…" /></label>
                  <label>Review Note<textarea rows={3} value={reviewDraft.comment} onChange={(event) => setReviewDraft({ ...reviewDraft, comment: event.target.value })} placeholder="Waiting for manual quote confirmation…" /></label>
                  <button className="platform-button platform-button--primary" type="button" onClick={() => void saveConversationReview()}>Save Review</button>
                </div>
                <h3>Internal Comments</h3>
                <div className="lead-workflow">
                  <p className="platform-muted">Private — Platform only. Never sent to customer.</p>
                  <label>Internal Comment<textarea rows={3} value={internalComment} onChange={(event) => setInternalComment(event.target.value)} placeholder="Customer called. Follow up tomorrow…" /></label>
                  <button className="platform-button platform-button--primary" disabled={!internalComment.trim()} type="button" onClick={() => void addConversationComment()}>Add Comment</button>
                </div>
                <div className="platform-list">{selectedConversation.comments?.length ? selectedConversation.comments.map((item: any) => <article key={item.id}><strong>{item.authorUsername ?? "Platform"} · {new Date(item.createdAt).toLocaleString()}</strong><p>{item.comment}</p></article>) : <p className="platform-muted">No internal comments yet.</p>}</div>
                <h3>Conversation Transcript</h3>
                <div className="agent-transcript-panel" ref={transcriptRef}>
                  {selectedConversation.messages?.map((item: any, index: number) => <article className={messageClass(item)} dir={textDirection(item.content)} key={item.id ?? `${item.createdAt}-${index}`}>
                    <div className="agent-chat-bubble">
                      <strong>{messageAuthor(item, selectedConversation.customerName)}</strong>
                      <p>{item.content}</p>
                      <span>{formatDubaiTime(item.createdAt)} · {titleize(item.channel)}</span>
                    </div>
                  </article>)}
                </div>
                {hasNewMessageBelow ? <button className="platform-button platform-button--primary agent-new-message" type="button" onClick={() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }); setHasNewMessageBelow(false); }}>New message ↓</button> : null}
                {selectedIsWebsite ? (
                  <div className="lead-workflow agent-live-reply agent-chat-composer">
                    <h3>Reply to Customer</h3>
                    <p className="platform-muted">{selectedMode === "human_active" ? "This reply appears in the customer's website chat. Internal comments are never sent to the customer." : "Take over first to enable website chat replies."}</p>
                    <label>Message<textarea rows={2} maxLength={1200} value={replyText} onChange={(event) => setReplyText(event.target.value)} /></label>
                    <div className="agent-chat-composer-actions">
                      <button className="platform-button platform-button--primary" disabled={!replyText.trim() || selectedMode !== "human_active"} type="button" onClick={() => void sendWebsiteReply()}>Send Website Chat Reply</button>
                      {selectedMode === "human_active" ? <button className="platform-button platform-button--quiet" type="button" onClick={() => void setConversationMode("ai_resume")}>Return to Yousef</button> : null}
                    </div>
                  </div>
                ) : null}
                {selectedIsWhatsApp ? (
                  <div className="lead-workflow agent-live-reply agent-chat-composer">
                    <h3>Reply to Customer</h3>
                    <p className="platform-muted">Sends through the configured WhatsApp provider. Internal comments are never sent to the customer.</p>
                    <label>Message<textarea rows={2} maxLength={1200} value={replyText} onChange={(event) => setReplyText(event.target.value)} /></label>
                    <div className="agent-chat-composer-actions">
                      <button className="platform-button platform-button--primary" disabled={!replyText.trim()} type="button" onClick={() => void sendWhatsAppReply()}>Send WhatsApp Reply</button>
                      {selectedMode === "human_active" ? <button className="platform-button platform-button--quiet" type="button" onClick={() => void setConversationMode("ai_resume")}>Return to Yousef</button> : null}
                    </div>
                  </div>
                ) : null}
                <details className="agent-secondary-detail">
                  <summary>Customer info, linked actions and history</summary>
                  <h3>Linked Actions</h3>
                  <div className="platform-list">{selectedConversation.actions?.length ? selectedConversation.actions.map((item: any, index: number) => <article key={`${item.createdAt}-${index}`}><strong>{item.actionType} · {item.status}</strong><span>{new Date(item.createdAt).toLocaleString()}</span><p>{item.safeErrorCode ?? JSON.stringify(item.responseSnapshot ?? {})}</p></article>) : <p className="platform-muted">No action created yet.</p>}</div>
                  <h3>History</h3>
                  <div className="platform-list">{selectedConversation.history?.length ? selectedConversation.history.map((item: any) => <article key={item.id}><strong>{item.oldStatus ?? "—"} → {item.newStatus}</strong><span>{new Date(item.createdAt).toLocaleString()} · {item.actorUsername ?? "Platform"} · Assignee {item.oldAssigneeUsername ?? "Unassigned"} → {item.newAssigneeUsername ?? "Unassigned"}</span><p>{item.comment ?? ""}</p></article>) : <p className="platform-muted">No status or assignment changes yet.</p>}</div>
                  <h3>Previous Customer Days</h3>
                  <div className="platform-list">{selectedConversation.previousDays?.length ? selectedConversation.previousDays.map((item: any) => <article key={String(item.businessDate)}><strong>{formatDateOnly(item.businessDate)}</strong><span>{item.conversationCount} session(s) · {item.messageCount} messages · last {new Date(item.lastActivityAt).toLocaleString()} · matched by {(item.matchSignals ?? []).join(", ") || "known identity"}</span></article>) : <p className="platform-muted">No earlier identified history for this customer/contact.</p>}</div>
                </details>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "handoffs" ? (
        <div className="platform-card">
          <h2>Agent Handoffs</h2>
          <table className="platform-table">
            <thead><tr><th>Reference</th><th>Reason</th><th>Channel</th><th>Contact</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
            <tbody>{handoffs.map((item) => <tr key={item.id}><td>{item.referenceNumber}</td><td>{item.reason}</td><td>{item.channel}</td><td>{item.contactName ?? item.mobile ?? item.email ?? "Not provided"}</td><td>{item.status}</td><td>{new Date(item.createdAt).toLocaleString()}</td><td><select value={item.status} onChange={(event) => void setHandoffStatus(item.id, event.target.value)}><option value="new">new</option><option value="reviewing">reviewing</option><option value="contacted">contacted</option><option value="resolved">resolved</option><option value="closed">closed</option></select></td></tr>)}</tbody>
          </table>
        </div>
      ) : null}

      {tab === "knowledge" ? (
        <div className="platform-grid platform-grid--two">
          <form className="platform-card platform-form" onSubmit={saveKnowledge}>
            <h2>Agent Knowledge</h2>
            <label>Language<select value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.target.value })}><option value="en">English</option><option value="ar">Arabic</option></select></label>
            <label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label>Category<input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} /></label>
            <label>Audience<select value={draft.audience} onChange={(event) => setDraft({ ...draft, audience: event.target.value })}><option value="all">All</option><option value="public">Public</option><option value="delivery_company">Delivery Company</option><option value="trader">Trader</option><option value="customer">Customer</option></select></label>
            <label>Feature Status<select value={draft.featureStatus} onChange={(event) => setDraft({ ...draft, featureStatus: event.target.value })}><option value="informational">informational</option><option value="live">live</option><option value="planned">planned</option><option value="on_hold">on_hold</option><option value="future">future</option><option value="internal_only">internal_only</option></select></label>
            <label>Visibility<select value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: event.target.value })}><option value="public_agent">public_agent</option><option value="internal_only">internal_only</option></select></label>
            <label>Status<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}><option value="draft">draft</option><option value="published">published</option><option value="archived">archived</option></select></label>
            <label>Content<textarea rows={8} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>
            <button className="platform-button platform-button--primary" type="submit">Save knowledge</button>
          </form>
          <div className="platform-card">
            <h2>Published Sources</h2>
            <div className="platform-list">{knowledge.map((item) => <article key={item.id}><strong>{item.title}</strong><span>{item.language} · {item.category} · {item.audience ?? "all"} · {item.featureStatus ?? "informational"} · {item.visibility ?? "public_agent"} · {item.status}</span><p>{item.content}</p></article>)}</div>
          </div>
        </div>
      ) : null}

      {tab === "settings" && settingsLoading ? (
        <div className="platform-card" role="status">
          <h2>Agent Settings</h2>
          <p className="platform-muted">Loading settings…</p>
        </div>
      ) : null}

      {tab === "settings" && !settingsLoading && settingsError ? (
        <div className="platform-card" role="alert">
          <h2>Agent Settings unavailable</h2>
          <p>{settingsError}</p>
          <button className="platform-button platform-button--primary" type="button" onClick={() => void loadSettings()}>Retry settings</button>
        </div>
      ) : null}

      {tab === "settings" && !settingsLoading && !settingsError && settings ? (
        <div className="platform-grid platform-grid--two">
          <form className="platform-card platform-form" onSubmit={saveSettings}>
            <h2>Agent Settings</h2>
            <label><input type="checkbox" checked={settings.agentEnabled} onChange={(event) => setSettings({ ...settings, agentEnabled: event.target.checked })} /> Agent Enabled</label>
            <label><input type="checkbox" checked={settings.websiteChatEnabled} onChange={(event) => setSettings({ ...settings, websiteChatEnabled: event.target.checked })} /> Website Chat Enabled</label>
            <label><input type="checkbox" checked={settings.whatsappAgentEnabled} onChange={(event) => setSettings({ ...settings, whatsappAgentEnabled: event.target.checked })} /> WhatsApp Agent Enabled</label>
            <label><input type="checkbox" checked={settings.whatsappPublicCtaEnabled ?? true} onChange={(event) => setSettings({ ...settings, whatsappPublicCtaEnabled: event.target.checked })} /> Public WhatsApp CTA Enabled</label>
            <label>WhatsApp Provider<select value={settings.whatsappProvider ?? "meta_cloud"} onChange={(event) => setSettings({ ...settings, whatsappProvider: event.target.value })}><option value="meta_cloud">Meta Cloud API</option><option value="sandbox">Sandbox / Local Test</option><option value="disabled">Disabled</option></select></label>
            <label>WhatsApp Business Number<input value={settings.whatsappBusinessNumber ?? ""} onChange={(event) => setSettings({ ...settings, whatsappBusinessNumber: event.target.value })} /></label>
            <label className={settings.humanHandoffEnabled ? "agent-availability-toggle agent-availability-toggle--online" : "agent-availability-toggle agent-availability-toggle--offline"}>
              <input type="checkbox" checked={settings.humanHandoffEnabled} onChange={(event) => setSettings({ ...settings, humanHandoffEnabled: event.target.checked })} />
              <span aria-hidden="true" />
              <strong>{settings.humanHandoffEnabled ? "Human support available" : "Human support unavailable"}</strong>
              <small>{settings.humanHandoffEnabled ? "Public chat shows green. Yousef can tell customers someone will reply soon." : "Public chat shows red. Yousef collects name and mobile for operations follow-up."}</small>
            </label>
            <label>Assistant Display Name<input value={settings.assistantDisplayName} onChange={(event) => setSettings({ ...settings, assistantDisplayName: event.target.value })} /></label>
            <label>Default Language<select value={settings.defaultLanguage} onChange={(event) => setSettings({ ...settings, defaultLanguage: event.target.value })}><option value="en">English</option><option value="ar">Arabic</option></select></label>
            <label>Fallback Message<textarea rows={4} value={settings.generalFallbackMessage} onChange={(event) => setSettings({ ...settings, generalFallbackMessage: event.target.value })} /></label>
            <p className="platform-muted">Safety rules such as private company identity, pricing, and arbitrary database access are enforced in server code and are not editable here.</p>
            <button className="platform-button platform-button--primary" type="submit">Save settings</button>
          </form>
          <div className="platform-card">
            <h2>Runtime Diagnostics</h2>
            <table className="platform-table">
              <tbody>
                <tr><th>Provider</th><td>{settings.diagnostics?.providerType ?? "unknown"}</td></tr>
                <tr><th>Configured</th><td>{settings.diagnostics?.configured ? "Yes" : "No"}</td></tr>
                <tr><th>Model</th><td>{settings.diagnostics?.model ?? "Not available"}</td></tr>
                <tr><th>Last Success</th><td>{formatDiagnosticTime(settings.diagnostics?.lastSuccess?.at)}</td></tr>
                <tr><th>Last Latency</th><td>{typeof settings.diagnostics?.lastSuccess?.latencyMs === "number" ? `${settings.diagnostics.lastSuccess.latencyMs} ms` : "Not available"}</td></tr>
                <tr><th>Last Error</th><td>{settings.diagnostics?.lastError ? `${settings.diagnostics.lastError.code} · ${formatDiagnosticTime(settings.diagnostics.lastError.at)}` : "None"}</td></tr>
                <tr><th>WhatsApp Provider</th><td>{settings.whatsappDiagnostics?.provider ?? settings.whatsappProvider ?? "unknown"}</td></tr>
                <tr><th>WhatsApp Configured</th><td>{settings.whatsappDiagnostics?.configured ? "Yes" : "No"}</td></tr>
                <tr><th>Last WhatsApp Webhook</th><td>{formatDiagnosticTime(settings.whatsappLastWebhookAt)}</td></tr>
                <tr><th>Last WhatsApp Outbound</th><td>{formatDiagnosticTime(settings.whatsappLastOutboundAt)}</td></tr>
                <tr><th>WhatsApp Last Error</th><td>{settings.whatsappLastErrorCode ?? "None"}</td></tr>
              </tbody>
            </table>
            <p className="platform-muted">Diagnostics intentionally show provider state only. API keys and raw model payloads are never exposed in Platform.</p>
          </div>
          <div className="platform-card platform-form agent-avatar-settings">
            <h2>Website AI Avatar</h2>
            <p className="platform-muted">Phase 1 uses a prerecorded introduction and the existing Yousef text conversation. It never requests camera or microphone access.</p>
            <label className="agent-avatar-settings__checkbox"><input type="checkbox" checked={settings.avatarEnabled ?? false} onChange={(event) => setSettings({ ...settings, avatarEnabled: event.target.checked })} /> Avatar enabled</label>
            <label>Status<select value={settings.avatarStatus ?? "active"} onChange={(event) => setSettings({ ...settings, avatarStatus: event.target.value })}><option value="active">Active</option><option value="offline">Offline / text fallback</option></select></label>
            <label>Provider<select value={settings.avatarProvider ?? "prerecorded"} onChange={(event) => setSettings({ ...settings, avatarProvider: event.target.value })}><option value="prerecorded">Prerecorded (Phase 1)</option><option value="heygen">HeyGen (not connected)</option><option value="tavus">Tavus (not connected)</option><option value="future_provider">Future provider (not connected)</option></select></label>
            <fieldset className="agent-avatar-settings__fieldset agent-avatar-settings__live"><legend>Real-time avatar pilot</legend>
              <label className="agent-avatar-settings__checkbox"><input type="checkbox" checked={settings.avatarLiveEnabled ?? false} onChange={(event) => setSettings({ ...settings, avatarLiveEnabled: event.target.checked })} /> Enable real-time avatar after the visitor asks a question</label>
              <label>Live provider<select value={settings.avatarLiveProvider ?? "heygen_live"} onChange={(event) => setSettings({ ...settings, avatarLiveProvider: event.target.value })}><option value="heygen_live">HeyGen LiveAvatar</option><option value="tavus_live">Tavus live (not connected)</option><option value="future_provider">Future provider (not connected)</option></select></label>
              <label>Final Yousef LiveAvatar ID<input value={settings.avatarLiveAvatarId ?? ""} onChange={(event) => setSettings({ ...settings, avatarLiveAvatarId: event.target.value })} placeholder="Required before production" /></label>
              <label>English voice ID<input value={settings.avatarLiveVoiceIdEn ?? ""} onChange={(event) => setSettings({ ...settings, avatarLiveVoiceIdEn: event.target.value })} /></label>
              <label>Arabic voice ID<input value={settings.avatarLiveVoiceIdAr ?? ""} onChange={(event) => setSettings({ ...settings, avatarLiveVoiceIdAr: event.target.value })} /></label>
              <label>English voice-agent ID<input value={settings.avatarLiveVoiceAgentIdEn ?? ""} onChange={(event) => setSettings({ ...settings, avatarLiveVoiceAgentIdEn: event.target.value })} /></label>
              <label>Arabic voice-agent ID<input value={settings.avatarLiveVoiceAgentIdAr ?? ""} onChange={(event) => setSettings({ ...settings, avatarLiveVoiceAgentIdAr: event.target.value })} /></label>
              <label>Maximum session seconds<input type="number" min="30" max="1800" value={settings.avatarLiveMaxSessionSeconds ?? 300} onChange={(event) => setSettings({ ...settings, avatarLiveMaxSessionSeconds: Number(event.target.value) })} /></label>
              <label>Idle timeout seconds<input type="number" min="15" max="300" value={settings.avatarLiveIdleTimeoutSeconds ?? 60} onChange={(event) => setSettings({ ...settings, avatarLiveIdleTimeoutSeconds: Number(event.target.value) })} /></label>
              <label>Maximum concurrent sessions<input type="number" min="1" max="100" value={settings.avatarLiveMaxConcurrentSessions ?? 2} onChange={(event) => setSettings({ ...settings, avatarLiveMaxConcurrentSessions: Number(event.target.value) })} /></label>
              <label>Starts per IP per minute<input type="number" min="1" max="60" value={settings.avatarLiveStartRateLimitPerMinute ?? 3} onChange={(event) => setSettings({ ...settings, avatarLiveStartRateLimitPerMinute: Number(event.target.value) })} /></label>
              <label>Daily minute cap (blank = unlimited)<input type="number" min="1" value={settings.avatarLiveDailyMinuteCap ?? ""} onChange={(event) => setSettings({ ...settings, avatarLiveDailyMinuteCap: event.target.value })} /></label>
              <label>Estimated provider cost per minute<input type="number" min="0" step="0.000001" value={settings.avatarLiveCostPerMinute ?? ""} onChange={(event) => setSettings({ ...settings, avatarLiveCostPerMinute: event.target.value })} /></label>
              <p className="platform-muted">Server credential: {settings.avatarLiveConfigured ? "Configured" : "Not configured"}. The pilot is OFF by default and falls back to browser speech if unavailable.</p>
              <table className="platform-table"><tbody>
                <tr><th>Today's live sessions</th><td>{settings.avatarLiveUsage?.todaySessions ?? 0}</td></tr>
                <tr><th>Today's live minutes</th><td>{settings.avatarLiveUsage?.todayMinutes ?? 0}</td></tr>
                <tr><th>Active sessions</th><td>{settings.avatarLiveUsage?.activeSessions ?? 0}</td></tr>
                <tr><th>Responses</th><td>{settings.avatarLiveUsage?.responseCount ?? 0}</td></tr>
                <tr><th>Fallbacks</th><td>{settings.avatarLiveUsage?.fallbackCount ?? 0}</td></tr>
                <tr><th>Provider errors</th><td>{settings.avatarLiveUsage?.providerErrorCount ?? 0}</td></tr>
                <tr><th>Estimated cost</th><td>{settings.avatarLiveUsage?.estimatedCost ?? 0}</td></tr>
              </tbody></table>
            </fieldset>
            <label>Avatar display name<input value={settings.avatarDisplayName ?? "Yousef"} onChange={(event) => setSettings({ ...settings, avatarDisplayName: event.target.value })} /></label>
            <label>Avatar title EN<input value={settings.avatarTitleEn ?? "Tawseelhub AI Advisor"} onChange={(event) => setSettings({ ...settings, avatarTitleEn: event.target.value })} /></label>
            <label>Avatar title AR<input dir="rtl" value={settings.avatarTitleAr ?? "مستشار توصيل هب الذكي"} onChange={(event) => setSettings({ ...settings, avatarTitleAr: event.target.value })} /></label>
            <label>Built-in/default avatar image<input type="url" placeholder="HTTPS or first-party image path" value={settings.avatarImageUrl ?? ""} onChange={(event) => setSettings({ ...settings, avatarImageUrl: event.target.value })} /><small>Used only when the selected language has no working intro image or video.</small></label>
            <div className="agent-avatar-settings__media-grid">
              <section className="agent-avatar-settings__language-media">
                <h3>English media</h3>
                <AvatarMediaControl kind="video" language="English" media={websiteMedia} value={settings.avatarIntroVideoUrlEn ?? ""} onChange={(value) => setSettings({ ...settings, avatarIntroVideoUrlEn: value })} onUploaded={(item) => setWebsiteMedia((current) => [item, ...current])} />
                <AvatarMediaControl kind="image" language="English" media={websiteMedia} value={settings.avatarIntroImageUrlEn ?? ""} onChange={(value) => setSettings({ ...settings, avatarIntroImageUrlEn: value })} onUploaded={(item) => setWebsiteMedia((current) => [item, ...current])} />
              </section>
              <section className="agent-avatar-settings__language-media" dir="rtl">
                <h3>Arabic media · الوسائط العربية</h3>
                <AvatarMediaControl kind="video" language="Arabic" media={websiteMedia} value={settings.avatarIntroVideoUrlAr ?? ""} onChange={(value) => setSettings({ ...settings, avatarIntroVideoUrlAr: value })} onUploaded={(item) => setWebsiteMedia((current) => [item, ...current])} />
                <AvatarMediaControl kind="image" language="Arabic" media={websiteMedia} value={settings.avatarIntroImageUrlAr ?? ""} onChange={(value) => setSettings({ ...settings, avatarIntroImageUrlAr: value })} onUploaded={(item) => setWebsiteMedia((current) => [item, ...current])} />
              </section>
            </div>
            <section className="agent-avatar-settings__homepage-media">
              <h3>Homepage · Delivery Operating System visual</h3>
              <p className="platform-muted">Optional language-specific image shown with the operational capability card. Removing it restores the built-in visual.</p>
              <div className="agent-avatar-settings__media-grid">
                <AvatarMediaControl kind="image" language="English" purpose="Delivery OS" media={websiteMedia} value={settings.avatarHomeOperationsImageUrlEn ?? ""} onChange={(value) => setSettings({ ...settings, avatarHomeOperationsImageUrlEn: value })} onUploaded={(item) => setWebsiteMedia((current) => [item, ...current])} />
                <div dir="rtl"><AvatarMediaControl kind="image" language="Arabic" purpose="Delivery OS" media={websiteMedia} value={settings.avatarHomeOperationsImageUrlAr ?? ""} onChange={(value) => setSettings({ ...settings, avatarHomeOperationsImageUrlAr: value })} onUploaded={(item) => setWebsiteMedia((current) => [item, ...current])} /></div>
              </div>
            </section>
            <label>English transcript<textarea rows={4} value={settings.avatarIntroTranscriptEn ?? ""} onChange={(event) => setSettings({ ...settings, avatarIntroTranscriptEn: event.target.value })} /></label>
            <label>Arabic transcript<textarea dir="rtl" rows={4} value={settings.avatarIntroTranscriptAr ?? ""} onChange={(event) => setSettings({ ...settings, avatarIntroTranscriptAr: event.target.value })} /></label>
            <fieldset className="agent-avatar-settings__fieldset agent-avatar-settings__visibility"><legend>Page visibility</legend>
              <label className="agent-avatar-settings__checkbox"><input type="checkbox" checked={settings.avatarShowHomepage ?? true} onChange={(event) => setSettings({ ...settings, avatarShowHomepage: event.target.checked })} /> Show on Homepage</label>
              <label className="agent-avatar-settings__checkbox"><input type="checkbox" checked={settings.avatarShowPricing ?? true} onChange={(event) => setSettings({ ...settings, avatarShowPricing: event.target.checked })} /> Show on Pricing</label>
              <label className="agent-avatar-settings__checkbox"><input type="checkbox" checked={settings.avatarShowDeliveryCompany ?? true} onChange={(event) => setSettings({ ...settings, avatarShowDeliveryCompany: event.target.checked })} /> Show on Delivery Company pages</label>
              <label className="agent-avatar-settings__checkbox"><input type="checkbox" checked={settings.avatarShowTrader ?? true} onChange={(event) => setSettings({ ...settings, avatarShowTrader: event.target.checked })} /> Show on Trader pages</label>
              <label className="agent-avatar-settings__checkbox"><input type="checkbox" checked={settings.avatarShowSendPackage ?? true} onChange={(event) => setSettings({ ...settings, avatarShowSendPackage: event.target.checked })} /> Show on Send a Package pages</label>
            </fieldset>
            <label className="agent-avatar-settings__checkbox"><input type="checkbox" checked={settings.avatarAutoOpen ?? false} onChange={(event) => setSettings({ ...settings, avatarAutoOpen: event.target.checked })} /> Auto-open panel (video still requires visitor play)</label>
            <button className="platform-button platform-button--primary" type="button" onClick={() => void saveAvatarSettings()}>Save avatar settings</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
