import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface WhatsAppProviderStatus {
  configured: boolean;
  provider: "meta_cloud" | "sandbox";
  phoneNumberIdConfigured: boolean;
  webhookSecretConfigured: boolean;
  outboundConfigured: boolean;
}

export interface NormalizedWhatsAppMessage {
  eventId: string;
  messageId: string;
  from: string;
  fromNormalized: string;
  text: string;
  timestamp: Date;
  language?: "en" | "ar";
  mediaType?: string;
}

export interface WhatsAppSendResult {
  providerMessageId: string | null;
  status: "queued" | "sent" | "failed";
  failureCode?: string;
}

export interface WhatsAppProvider {
  status(): WhatsAppProviderStatus;
  verifyWebhook(query: Record<string, unknown>): string | null;
  verifySignature(rawBody: Buffer | undefined, signature: string | undefined): boolean;
  normalizeWebhook(body: unknown): NormalizedWhatsAppMessage[];
  sendText(to: string, text: string): Promise<WhatsAppSendResult>;
}

function normalizedPhone(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function detectLanguage(text: string): "en" | "ar" {
  return /[\u0600-\u06ff]/.test(text) ? "ar" : "en";
}

export class SandboxWhatsAppProvider implements WhatsAppProvider {
  public status(): WhatsAppProviderStatus {
    return { configured: true, outboundConfigured: true, phoneNumberIdConfigured: true, provider: "sandbox", webhookSecretConfigured: true };
  }

  public verifyWebhook(query: Record<string, unknown>): string | null {
    return typeof query["hub.challenge"] === "string" ? query["hub.challenge"] : null;
  }

  public verifySignature(): boolean {
    return true;
  }

  public normalizeWebhook(body: unknown): NormalizedWhatsAppMessage[] {
    const input = body as { sender?: string; from?: string; message?: string; text?: string; inboundMessageId?: string; messageId?: string; timestamp?: string; language?: "en" | "ar" };
    const from = input.sender ?? input.from ?? "";
    const text = input.message ?? input.text ?? "";
    if (!from || !text) return [];
    return [{
      eventId: input.inboundMessageId ?? input.messageId ?? `sandbox-${randomUUID()}`,
      from,
      fromNormalized: normalizedPhone(from),
      language: input.language ?? detectLanguage(text),
      messageId: input.messageId ?? input.inboundMessageId ?? `sandbox-${randomUUID()}`,
      text,
      timestamp: input.timestamp ? new Date(input.timestamp) : new Date(),
    }];
  }

  public async sendText(): Promise<WhatsAppSendResult> {
    return { providerMessageId: `sandbox-out-${randomUUID()}`, status: "sent" };
  }
}

export class MetaWhatsAppCloudProvider implements WhatsAppProvider {
  public constructor(private readonly config: { accessToken: string | undefined; appSecret: string | undefined; phoneNumberId: string | undefined; verifyToken: string | undefined; graphApiBaseUrl: string }) {}

  public status(): WhatsAppProviderStatus {
    return {
      configured: Boolean(this.config.accessToken && this.config.phoneNumberId && this.config.verifyToken && this.config.appSecret),
      outboundConfigured: Boolean(this.config.accessToken && this.config.phoneNumberId),
      phoneNumberIdConfigured: Boolean(this.config.phoneNumberId),
      provider: "meta_cloud",
      webhookSecretConfigured: Boolean(this.config.verifyToken && this.config.appSecret),
    };
  }

  public verifyWebhook(query: Record<string, unknown>): string | null {
    if (query["hub.mode"] !== "subscribe") return null;
    if (!this.config.verifyToken || query["hub.verify_token"] !== this.config.verifyToken) return null;
    return typeof query["hub.challenge"] === "string" ? query["hub.challenge"] : null;
  }

  public verifySignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    if (!this.config.appSecret || !rawBody || !signature?.startsWith("sha256=")) return false;
    const expected = `sha256=${createHmac("sha256", this.config.appSecret).update(rawBody).digest("hex")}`;
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  public normalizeWebhook(body: unknown): NormalizedWhatsAppMessage[] {
    const messages: NormalizedWhatsAppMessage[] = [];
    const entries = Array.isArray((body as { entry?: unknown[] })?.entry) ? (body as { entry: unknown[] }).entry : [];
    for (const entry of entries) {
      const changes = Array.isArray((entry as { changes?: unknown[] })?.changes) ? (entry as { changes: unknown[] }).changes : [];
      for (const change of changes) {
        const value = (change as { value?: { messages?: unknown[] } }).value;
        const rawMessages = Array.isArray(value?.messages) ? value.messages : [];
        for (const raw of rawMessages) {
          const item = raw as { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; image?: unknown; document?: unknown; audio?: unknown };
          const text = item.text?.body;
          if (!item.id || !item.from || !text) continue;
          messages.push({
            eventId: item.id,
            from: `+${normalizedPhone(item.from)}`,
            fromNormalized: normalizedPhone(item.from),
            language: detectLanguage(text),
            ...(item.type && item.type !== "text" ? { mediaType: item.type } : {}),
            messageId: item.id,
            text,
            timestamp: item.timestamp ? new Date(Number(item.timestamp) * 1000) : new Date(),
          });
        }
      }
    }
    return messages;
  }

  public async sendText(to: string, text: string): Promise<WhatsAppSendResult> {
    if (!this.config.accessToken || !this.config.phoneNumberId) return { failureCode: "whatsapp_not_configured", providerMessageId: null, status: "failed" };
    const response = await fetch(`${this.config.graphApiBaseUrl.replace(/\/$/, "")}/${this.config.phoneNumberId}/messages`, {
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: normalizedPhone(to), type: "text", text: { preview_url: false, body: text } }),
      headers: { Authorization: `Bearer ${this.config.accessToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { code?: string; type?: string } };
    if (!response.ok) return { failureCode: String(payload.error?.code ?? payload.error?.type ?? response.status), providerMessageId: null, status: "failed" };
    return { providerMessageId: payload.messages?.[0]?.id ?? null, status: "sent" };
  }
}
