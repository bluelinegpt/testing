/**
 * Shared Commerce Foundation Prompt 3D, Part I: a domain-neutral push
 * notification ABSTRACTION only.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 *
 * This is an event contract and a publish interface -- nothing here talks to
 * Firebase, APNs, email, or WhatsApp. No SDK is installed, no permission is
 * requested, no device token is ever stored. The one concrete implementation
 * registered today (`NoopNotificationPublisher`) does nothing but log at
 * debug level, so the contract is real and testable without a single
 * notification ever actually being sent (§38).
 *
 * ---------------------------------------------------------------------------
 * WHY THE STORE ORDER DOMAIN DEPENDS ON THIS INTERFACE, NOT A CHANNEL
 * ---------------------------------------------------------------------------
 *
 * `StoreOrderService` calls `publish()` with a channel-neutral event; it has
 * no idea whether that becomes a push notification, an email, or nothing at
 * all. A future `FirebasePushPublisher`/`WhatsAppNotificationPublisher` only
 * has to implement this one interface -- the Store Order domain never
 * changes, and no notification-preference model needs to exist yet (§40).
 */
export type NotificationEventType =
  | "store_order_submitted"
  | "store_order_confirmed"
  | "store_order_cancelled"
  | "delivery_started"
  | "delivery_delivered";

/**
 * Deliberately narrow: identifiers and a timestamp only. No Customer PII,
 * no channel-specific payload (no push title/body, no email template id) --
 * a future provider derives its own presentation from `type` + these ids by
 * reading the Store Order/Delivery domain itself, keeping this contract
 * stable regardless of how any one channel chooses to word a message.
 */
export interface NotificationEvent {
  readonly deliveryOrderId?: string;
  readonly occurredAt: string;
  readonly storeOrderId: string;
  readonly storeOrderNumber: string;
  readonly type: NotificationEventType;
}

export abstract class NotificationPublisher {
  public abstract publish(event: NotificationEvent): Promise<void>;
}
