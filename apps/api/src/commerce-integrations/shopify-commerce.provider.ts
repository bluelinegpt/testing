import { createHmac, timingSafeEqual } from "node:crypto";

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
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return asNumber(record.amount ?? record.value, fallback);
  }
  return fallback;
};

function shopifySecret(): string | undefined {
  return process.env.SHOPIFY_WEBHOOK_SECRET?.trim() || process.env.SHOPIFY_CLIENT_SECRET?.trim() || undefined;
}

function safeCompareBase64(provided: string, expected: string): boolean {
  const cleanProvided = provided.trim();
  if (!cleanProvided || !expected) return false;
  const providedBuffer = Buffer.from(cleanProvided, "base64");
  const expectedBuffer = Buffer.from(expected, "base64");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function safeCompareHex(provided: string, expected: string): boolean {
  const cleanProvided = provided.trim();
  if (!/^[a-f0-9]{64}$/i.test(cleanProvided) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const providedBuffer = Buffer.from(cleanProvided, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function signShopifyWebhookPayload(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function verifyShopifyWebhookHmac(rawBody: Buffer | string, signature: string, secret: string): boolean {
  return safeCompareBase64(signature, signShopifyWebhookPayload(rawBody, secret));
}

export function verifyShopifyCallbackHmac(query: Record<string, string | readonly string[] | undefined>, clientSecret: string): boolean {
  const provided = typeof query.hmac === "string" ? query.hmac : "";
  if (!provided) return false;
  const message = Object.entries(query)
    .filter(([key, value]) => key !== "hmac" && key !== "signature" && value !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = createHmac("sha256", clientSecret).update(message).digest("hex");
  return safeCompareHex(provided, expected);
}

export function normalizeShopifyShopDomain(input: string): string {
  const trimmed = input.normalize("NFKC").trim().toLowerCase();
  if (!trimmed || /^javascript:/i.test(trimmed)) throw new Error("shopify_shop_domain_invalid");
  let hostname = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    hostname = parsed.hostname.toLowerCase();
  }
  hostname = hostname.replace(/\/.*$/u, "").replace(/\.+$/u, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(hostname)) throw new Error("shopify_shop_domain_invalid");
  return hostname;
}

function header(headers: CommerceWebhookHeaders | undefined, key: string): string {
  return headers?.[key.toLowerCase()] ?? headers?.[key] ?? "";
}

function shopifyTopic(headers: CommerceWebhookHeaders | undefined, body: Record<string, unknown>): string {
  return firstString([header(headers, "x-shopify-topic"), body.topic, body.event, body.eventType], "orders/create").toLowerCase();
}

function shopifyEventType(topic: string, order: Record<string, unknown>): NormalizedCommerceEvent["eventType"] {
  const normalized = topic.replace(/_/g, "/").toLowerCase();
  if (normalized === "app/uninstalled") return "connection.revoked";
  if (normalized === "orders/cancelled" || order.cancelled_at) return "order.cancelled";
  if (normalized === "orders/updated") return "order.updated";
  return "order.created";
}

function shopifyEventId(headers: CommerceWebhookHeaders | undefined, topic: string, order: Record<string, unknown>): string {
  return firstString([
    header(headers, "x-shopify-event-id"),
    header(headers, "x-shopify-webhook-id"),
    order.webhook_id,
    order.id && `${topic}:${order.id}:${order.updated_at ?? order.cancelled_at ?? order.created_at ?? ""}`,
  ], `shopify-${Date.now()}`);
}

function shopifyAddressText(address: Record<string, unknown>): string {
  const parts = [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.country,
    address.zip,
  ].map((part) => asString(part)).filter(Boolean);
  return parts.length ? parts.join(", ") : "Shopify order address";
}

function shopifyLocation(order: Record<string, unknown>, address: Record<string, unknown>): string {
  return firstString([
    [asString(address.city), asString(address.province), asString(address.address2)].filter(Boolean).join(" / "),
    [asString(order.shipping_address_name), asString(order.location_name)].filter(Boolean).join(" / "),
    address.city,
    address.province,
  ], "Shopify location");
}

function shopifyCustomerName(order: Record<string, unknown>, address: Record<string, unknown>, customer: Record<string, unknown>): string {
  return firstString([
    address.name,
    order.name,
    [customer.first_name, customer.last_name].map((part) => asString(part)).filter(Boolean).join(" "),
    customer.name,
  ], "Shopify Customer");
}

function gatewayText(order: Record<string, unknown>): string {
  const gateways = Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names.map((value) => asString(value)).join(" ") : "";
  return `${gateways} ${asString(order.gateway)} ${asString(order.processing_method)} ${asString(order.payment_terms)}`.toLowerCase();
}

function isCod(order: Record<string, unknown>): boolean {
  const text = gatewayText(order);
  return /(^|\W)(cod|cash on delivery|cash.?on.?delivery|الدفع عند الاستلام|عند الاستلام)(\W|$)/iu.test(text);
}

function shopifyMoney(order: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = order[key];
    if (value !== undefined && value !== null) return asNumber(value);
  }
  return 0;
}

function normalizeShopifyItems(order: Record<string, unknown>): NormalizedCommerceOrder["items"] {
  if (!Array.isArray(order.line_items) || order.line_items.length === 0) return [{ title: "Shopify package", quantity: 1 }];
  return order.line_items.map((item) => {
    const row = asRecord(item);
    const title = firstString([row.title, row.name, row.sku], "Shopify item");
    const quantity = Math.max(1, Math.trunc(asNumber(row.quantity, 1)));
    const grams = asNumber(row.grams, 0);
    return {
      ...(() => {
        const externalProductId = optionalString([row.product_id, row.productId]);
        return externalProductId ? { externalProductId } : {};
      })(),
      quantity,
      ...(() => {
        const sku = optionalString([row.sku]);
        return sku ? { sku } : {};
      })(),
      title,
      ...(grams > 0 ? { weightKg: grams / 1000 } : {}),
    };
  });
}

function normalizeShopifyOrder(order: Record<string, unknown>): NormalizedCommerceOrder {
  const customer = asRecord(order.customer);
  const shipping = asRecord(order.shipping_address);
  const billing = asRecord(order.billing_address);
  const address = Object.keys(shipping).length ? shipping : billing;
  const codRequired = isCod(order);
  const total = shopifyMoney(order, ["current_total_price", "total_price"]);
  const outstanding = shopifyMoney(order, ["total_outstanding", "current_total_outstanding"]);
  const currency = firstString([order.presentment_currency, order.currency, asRecord(order.current_total_price_set).shop_money && asRecord(asRecord(order.current_total_price_set).shop_money).currency_code], "AED").toUpperCase();
  const items = normalizeShopifyItems(order);
  const notes = optionalString([order.note, order.customer_locale && `Shopify locale: ${order.customer_locale}`]);
  const customerEmail = optionalString([order.email, order.contact_email, customer.email]);
  const emirate = optionalString([shipping.province, shipping.province_code, shipping.city]);
  const updatedAt = optionalString([order.updated_at]);

  return {
    address: shopifyAddressText(address),
    area: shopifyLocation(order, address),
    codAmount: codRequired ? (outstanding > 0 ? outstanding : total) : 0,
    codRequired,
    countryCode: firstString([shipping.country_code, address.country_code, billing.country_code], "AE").toUpperCase(),
    currency,
    ...(customerEmail ? { customerEmail } : {}),
    customerMobile: firstString([shipping.phone, order.phone, customer.phone, billing.phone], ""),
    customerName: shopifyCustomerName(order, address, customer),
    ...(emirate ? { emirate } : {}),
    externalOrderId: firstString([order.admin_graphql_api_id, order.id], ""),
    externalOrderNumber: firstString([order.name, order.order_number, order.id], ""),
    items,
    ...(notes ? { notes } : {}),
    packageCount: Math.max(1, Math.trunc(asNumber(order.package_count, 1))),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export class ShopifyCommerceProvider implements CommerceProvider {
  public readonly key = "shopify" as const;
  public readonly label = "Shopify";
  public readonly productionEnabled = true;

  public capabilities(): Readonly<Record<CommerceProviderCapability, boolean>> {
    return {
      api_keys: false,
      customers: true,
      inbound_cancellations: true,
      inbound_order_updates: true,
      inbound_orders: true,
      inventory: false,
      oauth: true,
      outbound_fulfillment: true,
      outbound_status: true,
      polling: true,
      products: true,
      webhooks: true,
    };
  }

  public verifyWebhook(input: { readonly body?: unknown; readonly connectionReference?: string; readonly rawBody?: Buffer; readonly signature?: string; readonly headers?: CommerceWebhookHeaders }): boolean {
    const secret = shopifySecret();
    if (!secret || !input.rawBody || !input.signature) return false;
    return verifyShopifyWebhookHmac(input.rawBody, input.signature, secret);
  }

  public parseWebhook(input: { readonly body: unknown; readonly headers?: CommerceWebhookHeaders }): NormalizedCommerceEvent {
    const body = asRecord(input.body);
    const topic = shopifyTopic(input.headers, body);
    const order = asRecord(body.order ?? body);
    const eventType = shopifyEventType(topic, order);
    return {
      eventType,
      externalEventId: shopifyEventId(input.headers, topic, order),
      ...(() => {
        const externalReference = optionalString([order.name, order.order_number, order.id]);
        return externalReference ? { externalReference } : {};
      })(),
      ...(eventType.startsWith("order.") ? { order: normalizeShopifyOrder(order) } : {}),
      ...(eventType === "connection.revoked" ? { providerState: "unauthorized" as const } : {}),
    };
  }

  public healthCheck(input: { readonly requestedState?: "healthy" | "degraded" | "unauthorized" }) {
    const status = input.requestedState ?? (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET ? "healthy" : "degraded");
    return { status, message: status === "healthy" ? "Shopify configuration is present." : status === "unauthorized" ? "Shopify authorization failed or the app was uninstalled." : "Shopify app credentials are not fully configured." };
  }

  public pushOrderStatus(input: { readonly externalOrderId: string; readonly status: string }) {
    return {
      externalStatus: input.status,
      providerMessage: `Shopify fulfillment sync ${input.status} queued for ${input.externalOrderId}; real fulfillmentCreate requires connected token retrieval from the secure credential store.`,
    };
  }
}
