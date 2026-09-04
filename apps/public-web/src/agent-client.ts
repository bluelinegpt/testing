import { apiBase, publicAssetUrl } from "./api-base";

const base = () => apiBase();

export interface AgentMessage {
  readonly id?: string;
  readonly senderType: "user" | "assistant" | "system" | "platform_staff";
  readonly content: string;
  readonly displayName?: string;
  readonly structuredPayload?: Record<string, unknown> | null;
  readonly createdAt: string;
}

export interface AgentConversation {
  readonly conversationToken?: string;
  readonly reference: string;
  readonly channel?: string;
  readonly conversationMode?: "ai_active" | "human_active" | "paused" | "ai_resume";
  readonly humanState?: "ai_active" | "waiting_for_human" | "human_active";
  readonly language: "en" | "ar";
  readonly intent?: string;
  readonly status?: string;
  readonly message?: string;
  readonly reply?: string;
  readonly quickActions?: string[];
  readonly messages?: AgentMessage[];
}

export interface WhatsAppPublicSettings {
  readonly enabled: boolean;
  readonly label: string;
  readonly number: string;
  readonly url: string | null;
}

export interface AgentAvailability {
  readonly assistantAvailable: boolean;
  readonly humanAvailable: boolean;
  readonly status: "available" | "unavailable";
}

export interface AgentAvatarSettings {
  readonly enabled: boolean;
  readonly displayName: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly imageUrl?: string;
  readonly introVideoUrlEn?: string;
  readonly introVideoUrlAr?: string;
  readonly introImageUrlEn?: string;
  readonly introImageUrlAr?: string;
  readonly homeOperationsImageUrlEn?: string;
  readonly homeOperationsImageUrlAr?: string;
  readonly introTranscriptEn: string;
  readonly introTranscriptAr: string;
  readonly showOnHomepage: boolean;
  readonly showOnPricing: boolean;
  readonly showOnDeliveryCompany: boolean;
  readonly showOnTrader: boolean;
  readonly showOnSendPackage: boolean;
  readonly autoOpen: boolean;
  readonly provider: "prerecorded" | "heygen" | "tavus" | "future_provider";
  readonly status: "active" | "offline";
  readonly liveEnabled: boolean;
  readonly liveProvider: "heygen_live" | "tavus_live" | "future_provider";
  readonly liveConfigured: boolean;
}

export const fallbackAvatarSettings: AgentAvatarSettings = {
  enabled: false,
  displayName: "Yousef",
  titleEn: "Tawseelhub AI Advisor",
  titleAr: "مستشار توصيل هب الذكي",
  imageUrl: "/yousef-ai-advisor.svg",
  introTranscriptEn: "Hi, I’m Yousef, Tawseelhub’s AI advisor. Ask me anything about Tawseelhub and I’ll guide you.",
  introTranscriptAr: "مرحباً، أنا يوسف، المستشار الذكي لمنصة توصيل هب. اسألني عن أي شيء يخص توصيل هب وسأساعدك.",
  showOnHomepage: true,
  showOnPricing: true,
  showOnDeliveryCompany: true,
  showOnTrader: true,
  showOnSendPackage: true,
  autoOpen: false,
  provider: "prerecorded",
  status: "active",
  liveEnabled: false,
  liveProvider: "heygen_live",
  liveConfigured: false,
};

export type LiveAvatarSessionToken = {
  readonly provider: "heygen_live";
  readonly token: string;
  readonly sandbox: boolean;
  readonly idleTimeoutSeconds: number;
  readonly maxSessionSeconds: number;
  readonly usageId: string;
};

export type LiveAvatarUsageEvent = "response_completed" | "fallback" | "provider_error" | "ended";

// Exported so the chat widget can render its WhatsApp CTA instantly from
// this, keeping the settings request out of the page-load network chain --
// the live settings are fetched on first user interaction instead.
export const fallbackWhatsAppSettings: WhatsAppPublicSettings = {
  enabled: true,
  label: "Chat on WhatsApp",
  number: "971506898604",
  url: "https://wa.me/971506898604",
};

export function buildWhatsAppMessageUrl(url: string, message: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}text=${encodeURIComponent(message)}`;
}

async function parse(response: Response): Promise<AgentConversation> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("I'm having trouble connecting right now. Please try again, or choose Contact Tawseelhub.");
  return body as AgentConversation;
}

export async function createAgentConversation(language: "en" | "ar", visitorId?: string, surface: "website" | "website_avatar" = "website"): Promise<AgentConversation> {
  const response = await fetch(`${base()}/public/agent/conversations`, {
    body: JSON.stringify({ language, surface, ...(visitorId === undefined ? {} : { visitorId }) }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return parse(response);
}

export async function getAvatarSettings(): Promise<AgentAvatarSettings> {
  try {
    const response = await fetch(`${base()}/public/agent/avatar/settings`, { method: "GET" });
    if (!response.ok) return fallbackAvatarSettings;
    const settings = { ...fallbackAvatarSettings, ...(await response.json()) };
    return {
      ...settings,
      imageUrl: publicAssetUrl(settings.imageUrl),
      introVideoUrlEn: publicAssetUrl(settings.introVideoUrlEn),
      introVideoUrlAr: publicAssetUrl(settings.introVideoUrlAr),
      introImageUrlEn: publicAssetUrl(settings.introImageUrlEn),
      introImageUrlAr: publicAssetUrl(settings.introImageUrlAr),
      homeOperationsImageUrlEn: publicAssetUrl(settings.homeOperationsImageUrlEn),
      homeOperationsImageUrlAr: publicAssetUrl(settings.homeOperationsImageUrlAr),
    };
  } catch {
    return fallbackAvatarSettings;
  }
}

export async function getAgentConversation(token: string): Promise<AgentConversation> {
  const response = await fetch(`${base()}/public/agent/conversations/${encodeURIComponent(token)}`, { method: "GET" });
  return parse(response);
}

export async function sendAgentMessage(token: string, message: string, language: "en" | "ar"): Promise<AgentConversation> {
  const response = await fetch(`${base()}/public/agent/conversations/${encodeURIComponent(token)}/messages`, {
    body: JSON.stringify({ language, message }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return parse(response);
}

export async function createLiveAvatarSession(token: string, language: "en" | "ar"): Promise<LiveAvatarSessionToken> {
  const response = await fetch(`${base()}/public/agent/conversations/${encodeURIComponent(token)}/avatar/live-session`, {
    body: JSON.stringify({ language }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw new Error("live_avatar_unavailable");
  return response.json() as Promise<LiveAvatarSessionToken>;
}

export async function reportLiveAvatarUsage(token: string, usageId: string, event: LiveAvatarUsageEvent, durationSeconds?: number, reason?: string) {
  await fetch(`${base()}/public/agent/conversations/${encodeURIComponent(token)}/avatar/live-usage/${encodeURIComponent(usageId)}`, {
    body: JSON.stringify({ event, ...(durationSeconds === undefined ? {} : { durationSeconds }), ...(reason ? { reason } : {}) }),
    headers: { "content-type": "application/json" },
    keepalive: event === "ended",
    method: "POST",
  }).catch(() => undefined);
}

export async function getWhatsAppSettings(): Promise<WhatsAppPublicSettings> {
  try {
    const response = await fetch(`${base()}/public/agent/whatsapp/settings`, { method: "GET" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return fallbackWhatsAppSettings;
    const settings = body as WhatsAppPublicSettings;
    return settings.enabled && settings.url ? settings : fallbackWhatsAppSettings;
  } catch {
    return fallbackWhatsAppSettings;
  }
}

export async function getAgentAvailability(): Promise<AgentAvailability> {
  try {
    const response = await fetch(`${base()}/public/agent/availability`, { method: "GET" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("availability_unavailable");
    return body as AgentAvailability;
  } catch {
    return { assistantAvailable: false, humanAvailable: false, status: "unavailable" };
  }
}
