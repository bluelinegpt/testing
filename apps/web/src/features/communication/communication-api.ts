import type { ApiClient } from "../../api/api-client.js";

export type ConversationParticipantContext = "trader" | "driver" | "customer";
export type ConversationStatus =
  "active" | "waiting_for_office" | "waiting_for_user" | "resolved" | "reopened";
export type ConversationPriority = "normal" | "high" | "urgent";

export interface ConversationSummary {
  readonly id: string;
  readonly type: "order" | "general_support";
  readonly participantContextType: ConversationParticipantContext;
  readonly orderId: string | null;
  readonly orderNumber: string | null;
  readonly subject: string | null;
  readonly status: ConversationStatus;
  readonly priority: ConversationPriority;
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly unreadCount: number;
}

export interface CommunicationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly senderRole: "office" | "trader" | "driver" | "customer" | "system";
  readonly messageType: "text" | "system" | "voice_placeholder";
  readonly text: string | null;
  readonly clientMessageId: string | null;
  readonly systemEventType: string | null;
  readonly sequence: number;
  readonly createdAt: string;
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

  public conversations(
    query: URLSearchParams = new URLSearchParams(),
  ): Promise<Page<ConversationSummary>> {
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

  public recoverEvents(query: URLSearchParams = new URLSearchParams()): Promise<{
    readonly events: readonly CommunicationEvent[];
    readonly nextCursor: string | null;
    readonly fullRefreshRequired: boolean;
  }> {
    return this.api.get(`communication/realtime/events?${query.toString()}`);
  }
}
