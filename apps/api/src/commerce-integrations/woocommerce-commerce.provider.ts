import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { CommerceProvider, CommerceProviderCapability, CommerceWebhookHeaders, NormalizedCommerceEvent, NormalizedCommerceOrder } from "./commerce-integration.types.js";

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const asString = (value: unknown, fallback = ""): string => typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : fallback;
const optionalString = (values: readonly unknown[]): string | undefined => values.map((value) => asString(value)).find(Boolean) || undefined;
const firstString = (values: readonly unknown[], fallback = "") => optionalString(values) ?? fallback;
const asNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

function safeCompareBase64(provided: string, expected: string): boolean {
  const cleanProvided = provided.trim();
  if (!cleanProvided || !expected) return false;
  const providedBuffer = Buffer.from(cleanProvided, "base64");
  const expectedBuffer = Buffer.from(expected, "base64");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function signWooCommerceWebhookPayload(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function wooCommerceWebhookSecret(connectionReference: string): string | undefined {
  const seed = process.env.WOOCOMMERCE_WEBHOOK_SECRET_SEED?.trim() || process.env.COMMERCE_WEBHOOK_SECRET_SEED?.trim();
  if (!seed) return undefined;
  return createHmac("sha256", seed).update(`woocommerce:${connectionReference}`).digest("hex");
}

export function verifyWooCommerceWebhookSignature(rawBody: Buffer | string, signature: string, secret: string): boolean {
  return safeCompareBase64(signature, signWooCommerceWebhookPayload(rawBody, secret));
}

export function normalizeWooCommerceStoreUrl(input: string, options: { readonly allowPrivate?: boolean; readonly production?: boolean } = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(input.normalize("NFKC").trim());
  } catch {
    throw new Error("woocommerce_store_url_invalid");
  }
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("woocommerce_store_url_invalid");
  if (options.production !== false && parsed.protocol !== "https:") throw new Error("woocommerce_https_required");
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "";
  const hostname = parsed.hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.+$/u, "");
  if (!options.allowPrivate && (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))) {
    throw new Error("woocommerce_store_url_private");
  }
  if (!options.allowPrivate && isBlockedIp(hostname)) throw new Error("woocommerce_store_url_private");
  parsed.hostname = hostname;
  return parsed.origin.replace(/\/$/u, "");
}

export function isBlockedIp(value: string): boolean {
  const version = isIP(value);
  if (version === 4) {
    const parts = value.split(".").map((part) => Number(part));
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (version === 6) {
    const normalized = value.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized === "::";
  }
  return false;
}

function header(headers: CommerceWebhookHeaders | undefined, key: string): string {
  return headers?.[key.toLowerCase()] ?? headers?.[key] ?? "";
}

function wooTopic(headers: CommerceWebhookHeaders | undefined, body: Record<string, unknown>): string {
  return firstString([header(headers, "x-wc-webhook-topic"), body.topic, body.event, body.eventType], "order.created").toLowerCase();
}

function wooEventType(topic: string, order: Record<string, unknown>): NormalizedCommerceEvent["eventType"] {
  const status = asString(order.status).toLowerCase();
  if (topic === "order.deleted" || ["cancelled", "refunded", "failed", "trash"].includes(status)) return "order.cancelled";
  if (topic === "order.updated") return "order.updated";
  return "order.created";
}

function wooEventId(headers: CommerceWebhookHeaders | undefined, topic: string, order: Record<string, unknown>): string {
  return firstString([
    header(headers, "x-wc-delivery-id"),
    header(headers, "x-wc-webhook-delivery-id"),
    header(headers, "x-wc-webhook-id") && `${header(headers, "x-wc-webhook-id")}:${topic}:${order.id ?? ""}:${order.date_modified_gmt ?? order.date_modified ?? order.status ?? ""}`,
    order.id && `${topic}:${order.id}:${order.date_modified_gmt ?? order.date_modified ?? order.status ?? ""}`,
  ], `woocommerce-${Date.now()}`);
}

function addressText(address: Record<string, unknown>): string {
  const parts = [address.address_1, address.address_2, address.city, address.state, address.postcode, address.country]
    .map((part) => asString(part))
    .filter(Boolean);
  return parts.length ? parts.join(", ") : "WooCommerce order address";
}

function locationValue(address: Record<string, unknown>): string {
  return firstString([
    [asString(address.state), asString(address.city), asString(address.address_2)].filter(Boolean).join(" / "),
    address.city,
    address.state,
  ], "WooCommerce location");
}

function customerName(order: Record<string, unknown>, address: Record<string, unknown>, billing: Record<string, unknown>): string {
  return firstString([
    [address.first_name, address.last_name].map((part) => asString(part)).filter(Boolean).join(" "),
    [billing.first_name, billing.last_name].map((part) => asString(part)).filter(Boolean).join(" "),
    address.company,
    billing.company,
    order.customer_note,
  ], "WooCommerce Customer");
}

function paymentText(order: Record<string, unknown>): string {
  return `${asString(order.payment_method)} ${asString(order.payment_method_title)} ${asString(order.status)}`.toLowerCase();
}

function isCod(order: Record<string, unknown>): boolean {
  const text = paymentText(order);
  return /(^|\W)(cod|cash on delivery|cash.?on.?delivery|الدفع عند الاستلام|عند الاستلام)(\W|$)/iu.test(text);
}

function normalizeWooItems(order: Record<string, unknown>): NormalizedCommerceOrder["items"] {
  if (!Array.isArray(order.line_items) || order.line_items.length === 0) return [{ title: "WooCommerce package", quantity: 1 }];
  return order.line_items.map((item) => {
    const row = asRecord(item);
    const externalProductId = optionalString([row.variation_id, row.product_id, row.id]);
    const sku = optionalString([row.sku]);
    return {
      ...(externalProductId ? { externalProductId } : {}),
      ...(sku ? { sku } : {}),
      quantity: Math.max(1, Math.trunc(asNumber(row.quantity, 1))),
      title: firstString([row.name, row.sku], "WooCommerce item"),
    };
  });
}

function normalizeWooOrder(order: Record<string, unknown>): NormalizedCommerceOrder {
  const shipping = asRecord(order.shipping);
  const billing = asRecord(order.billing);
  const deliveryAddress = Object.keys(shipping).length ? shipping : billing;
  const total = asNumber(order.total, 0);
  const currency = asString(order.currency, "AED").toUpperCase();
  const codRequired = isCod(order);
  const items = normalizeWooItems(order);
  const customerEmail = optionalString([billing.email, order.billing_email]);
  const emirate = optionalString([deliveryAddress.state, deliveryAddress.city]);
  const notes = optionalString([order.customer_note]);
  const updatedAt = optionalString([order.date_modified_gmt, order.date_modified]);

  return {
    address: addressText(deliveryAddress),
    area: locationValue(deliveryAddress),
    codAmount: codRequired ? total : 0,
    codRequired,
    countryCode: firstString([deliveryAddress.country, billing.country], "AE").toUpperCase(),
    currency,
    ...(customerEmail ? { customerEmail } : {}),
    customerMobile: firstString([deliveryAddress.phone, billing.phone], ""),
    customerName: customerName(order, deliveryAddress, billing),
    ...(emirate ? { emirate } : {}),
    externalOrderId: firstString([order.id], ""),
    externalOrderNumber: firstString([order.number, order.id], ""),
    items,
    ...(notes ? { notes } : {}),
    packageCount: Math.max(1, Math.trunc(asNumber(order.package_count, 1))),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export class WooCommerceCommerceProvider implements CommerceProvider {
  public readonly key = "woocommerce" as const;
  public readonly label = "WooCommerce";
  public readonly productionEnabled = true;

  public capabilities(): Readonly<Record<CommerceProviderCapability, boolean>> {
    return {
      api_keys: true,
      customers: true,
      inbound_cancellations: true,
      inbound_order_updates: true,
      inbound_orders: true,
      inventory: false,
      oauth: false,
      outbound_fulfillment: false,
      outbound_status: false,
      polling: true,
      products: true,
      webhooks: true,
    };
  }

  public verifyWebhook(input: { readonly rawBody?: Buffer; readonly signature?: string; readonly connectionReference: string }): boolean {
    const secret = wooCommerceWebhookSecret(input.connectionReference);
    if (!secret || !input.rawBody || !input.signature) return false;
    return verifyWooCommerceWebhookSignature(input.rawBody, input.signature, secret);
  }

  public parseWebhook(input: { readonly body: unknown; readonly headers?: CommerceWebhookHeaders }): NormalizedCommerceEvent {
    const body = asRecord(input.body);
    const order = asRecord(body.order ?? body);
    const topic = wooTopic(input.headers, body);
    const eventType = wooEventType(topic, order);
    return {
      eventType,
      externalEventId: wooEventId(input.headers, topic, order),
      ...(() => {
        const externalReference = optionalString([order.number, order.id]);
        return externalReference ? { externalReference } : {};
      })(),
      ...(eventType.startsWith("order.") ? { order: normalizeWooOrder(order) } : {}),
    };
  }

  public healthCheck(input: { readonly requestedState?: "healthy" | "degraded" | "unauthorized" }) {
    const status = input.requestedState ?? "healthy";
    return {
      status,
      message: status === "healthy" ? "WooCommerce connection can be verified with store REST API credentials." : status === "unauthorized" ? "WooCommerce credentials were rejected." : "WooCommerce store is unavailable or degraded.",
    };
  }

  public pushOrderStatus(input: { readonly externalOrderId: string; readonly status: string }) {
    return {
      externalStatus: input.status,
      providerMessage: `WooCommerce outbound status is not enabled by default for ${input.externalOrderId}; merchant status mapping must be configured first.`,
    };
  }
}
