import type { ApiClient } from "../../api/api-client.js";

export type ConversationParticipantContext = "trader" | "driver" | "customer";
export type ConversationStatus =
  "active" | "waiting_for_office" | "waiting_for_user" | "resolved" | "reopened";
export type ConversationPriority = "normal" | "high" | "urgent";

export interface ConversationSummary {
  readonly id: string;
  readonly type: "order" | "general_support";
  readonly participantContextType: ConversationParticipantContext;
  readonly participantName: string | null;
  readonly orderId: string | null;
  readonly orderNumber: string | null;
  readonly subject: string | null;
  readonly status: ConversationStatus;
  readonly priority: ConversationPriority;
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly unreadCount: number;
  /** `null` when unassigned. Always `null` on the Customer-facing view. */
  readonly assignedOperatorAccountId: string | null;
  readonly assignedOperatorName: string | null;
}

export interface ConversationListFilters {
  readonly cursor?: string;
  readonly limit?: number;
  readonly participantContextType?: ConversationParticipantContext;
  readonly priority?: ConversationPriority;
  readonly search?: string;
  readonly status?: ConversationStatus;
  readonly unreadOnly?: boolean;
}

export interface CommunicationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly senderRole: "office" | "trader" | "driver" | "customer" | "system";
  readonly messageType: "text" | "system" | "voice_placeholder" | "voice";
  readonly text: string | null;
  readonly clientMessageId: string | null;
  readonly systemEventType: string | null;
  readonly sequence: number;
  readonly createdAt: string;
  /** Present (non-null) only when `messageType === "voice"`. */
  readonly mediaMimeType: string | null;
  readonly mediaDurationSeconds: number | null;
  readonly mediaSizeBytes: number | null;
}

export interface CommunicationEvent {
  readonly sequence: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export class CommunicationApi {
  public constructor(private readonly api: ApiClient) {}

  public resolveOrderConversation(input: {
    readonly orderId: string;
    readonly participantContextType?: ConversationParticipantContext;
    readonly subject?: string;
  }): Promise<ConversationSummary> {
    return this.api.post("communication/conversations/resolve", {
      conversationType: "order",
      ...input,
    });
  }

  public conversations(filters: ConversationListFilters = {}): Promise<Page<ConversationSummary>> {
    const query = new URLSearchParams();
    if (filters.cursor !== undefined) query.set("cursor", filters.cursor);
    if (filters.limit !== undefined) query.set("limit", String(filters.limit));
    if (filters.status !== undefined) query.set("status", filters.status);
    if (filters.participantContextType !== undefined) {
      query.set("participantContextType", filters.participantContextType);
    }
    if (filters.priority !== undefined) query.set("priority", filters.priority);
    if (filters.search !== undefined && filters.search.trim() !== "") {
      query.set("search", filters.search.trim());
    }
    if (filters.unreadOnly === true) query.set("unreadOnly", "true");
    return this.api.get(`communication/conversations?${query.toString()}`);
  }

  public messages(
    conversationId: string,
    query: URLSearchParams = new URLSearchParams(),
  ): Promise<Page<CommunicationMessage>> {
    return this.api.get(
      `communication/conversations/${conversationId}/messages?${query.toString()}`,
    );
  }

  public sendText(input: {
    readonly conversationId: string;
    readonly text: string;
    readonly clientMessageId: string;
    readonly idempotencyKey: string;
    readonly originalClientTime?: string;
  }): Promise<CommunicationMessage> {
    return this.api.post(`communication/conversations/${input.conversationId}/messages`, {
      text: input.text,
      clientMessageId: input.clientMessageId,
      idempotencyKey: input.idempotencyKey,
      originalClientTime: input.originalClientTime,
    });
  }

  /** Extension guess only used for the multipart filename; the server trusts
   *  the declared MIME type, not the filename, for validation. */
  public sendVoice(input: {
    readonly conversationId: string;
    readonly file: Blob;
    readonly durationSeconds: number;
    readonly clientMessageId: string;
    readonly idempotencyKey: string;
    readonly originalClientTime?: string;
  }): Promise<CommunicationMessage> {
    const extension = input.file.type.includes("ogg") ? "ogg" : "webm";
    const form = new FormData();
    form.append("file", input.file, `voice.${extension}`);
    form.append("clientMessageId", input.clientMessageId);
    form.append("idempotencyKey", input.idempotencyKey);
    form.append("durationSeconds", String(input.durationSeconds));
    if (input.originalClientTime !== undefined) {
      form.append("originalClientTime", input.originalClientTime);
    }
    return this.api.postMultipart(
      `communication/conversations/${input.conversationId}/voice-messages`,
      form,
    );
  }

  /** Authenticated audio fetch — never expose this as a raw `<audio src>` URL. */
  public messageMedia(messageId: string): Promise<Blob> {
    return this.api.getBinary(`communication/messages/${messageId}/media`);
  }

  public markRead(
    conversationId: string,
    throughMessageId: string,
  ): Promise<{ unreadCount: number }> {
    return this.api.post(`communication/conversations/${conversationId}/read`, {
      throughMessageId,
    });
  }

  public unreadCount(): Promise<{ unreadMessages: number; unreadConversations: number }> {
    return this.api.get("communication/messages/unread-count");
  }

  public resolveStatus(conversationId: string): Promise<ConversationSummary> {
    return this.api.post(`communication/conversations/${conversationId}/resolve`);
  }

  public reopen(conversationId: string): Promise<ConversationSummary> {
    return this.api.post(`communication/conversations/${conversationId}/reopen`);
  }

  public setPriority(
    conversationId: string,
    priority: ConversationPriority,
  ): Promise<ConversationSummary> {
    return this.api.patch(`communication/conversations/${conversationId}/priority`, {
      priority,
    });
  }

  public assign(conversationId: string, operatorAccountId?: string): Promise<ConversationSummary> {
    return this.api.patch(`communication/conversations/${conversationId}/assign`, {
      operatorAccountId,
    });
  }

  public recoverEvents(query: URLSearchParams = new URLSearchParams()): Promise<{
    readonly events: readonly CommunicationEvent[];
    readonly nextCursor: string | null;
    readonly fullRefreshRequired: boolean;
  }> {
    return this.api.get(`communication/realtime/events?${query.toString()}`);
  }
}
