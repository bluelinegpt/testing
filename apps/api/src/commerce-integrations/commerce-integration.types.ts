export const commerceProviderCapabilities = [
  "inbound_orders",
  "outbound_fulfillment",
  "outbound_status",
  "inbound_cancellations",
  "inbound_order_updates",
  "products",
  "customers",
  "inventory",
  "webhooks",
  "polling",
  "oauth",
  "api_keys",
] as const;

export type CommerceProviderCapability = (typeof commerceProviderCapabilities)[number];
export type CommerceProviderKey = "mock_commerce" | "salla" | "shopify" | "woocommerce";
export type CommerceEventType =
  | "order.created"
  | "order.updated"
  | "order.cancelled"
  | "fulfillment.updated"
  | "connection.revoked"
  | "sync.requested";

export type CommerceWebhookHeaders = Readonly<Record<string, string | undefined>>;

export interface CommerceProvider {
  readonly key: CommerceProviderKey;
  readonly label: string;
  readonly productionEnabled: boolean;
  capabilities(): Readonly<Record<CommerceProviderCapability, boolean>>;
  verifyWebhook(input: { readonly body: unknown; readonly connectionReference: string; readonly rawBody?: Buffer; readonly signature?: string; readonly headers?: CommerceWebhookHeaders }): boolean;
  parseWebhook(input: { readonly body: unknown; readonly headers?: CommerceWebhookHeaders }): NormalizedCommerceEvent;
  healthCheck(input: { readonly requestedState?: "healthy" | "degraded" | "unauthorized" }): { readonly status: "healthy" | "degraded" | "unauthorized"; readonly message: string };
  pushOrderStatus(input: { readonly externalOrderId: string; readonly status: string }): { readonly externalStatus: string; readonly providerMessage: string };
}

export interface NormalizedCommerceOrder {
  readonly externalOrderId: string;
  readonly externalOrderNumber: string;
  readonly customerName: string;
  readonly customerMobile: string;
  readonly customerEmail?: string;
  readonly countryCode: string;
  readonly emirate?: string;
  readonly area: string;
  readonly address: string;
  readonly currency: string;
  readonly codRequired: boolean;
  readonly codAmount: number;
  readonly packageCount: number;
  readonly items: readonly { readonly externalProductId?: string; readonly sku?: string; readonly title: string; readonly quantity: number; readonly weightKg?: number }[];
  readonly updatedAt?: string;
  readonly notes?: string;
}

export interface NormalizedCommerceEvent {
  readonly externalEventId: string;
  readonly eventType: CommerceEventType;
  readonly externalReference?: string;
  readonly order?: NormalizedCommerceOrder;
  readonly providerState?: "healthy" | "degraded" | "unauthorized";
  readonly simulateFailure?: "timeout" | "processing_failure";
}
