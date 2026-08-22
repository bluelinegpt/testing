import { apiBase } from "./api-base";

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

const fallbackWhatsAppSettings: WhatsAppPublicSettings = {
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

export async function createAgentConversation(language: "en" | "ar", visitorId?: string): Promise<AgentConversation> {
  const response = await fetch(`${base()}/public/agent/conversations`, {
    body: JSON.stringify({ language, ...(visitorId === undefined ? {} : { visitorId }) }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return parse(response);
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
