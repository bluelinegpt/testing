import { createHmac, timingSafeEqual } from "node:crypto";

import type { CommerceProvider, CommerceProviderCapability, NormalizedCommerceEvent, NormalizedCommerceOrder } from "./commerce-integration.types.js";

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const asString = (value: unknown, fallback = ""): string => typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : fallback;
const asNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return asNumber(record.amount ?? record.value, fallback);
  }
  return fallback;
};
const firstString = (values: readonly unknown[], fallback = "") => values.map((value) => asString(value)).find(Boolean) ?? fallback;
const optionalString = (values: readonly unknown[]): string | undefined => firstString(values) || undefined;

function sallaWebhookSecret(): string | undefined {
  return process.env.SALLA_WEBHOOK_SECRET?.trim() || undefined;
}

export function signSallaWebhookPayload(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function safeCompareHex(provided: string, expected: string): boolean {
  const normalized = provided.replace(/^sha256=/i, "").trim();
  if (!/^[a-f0-9]{64}$/i.test(normalized) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const providedBuffer = Buffer.from(normalized, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function sallaData(body: Record<string, unknown>): Record<string, unknown> {
  return asRecord(body.data ?? body.order ?? body);
}

function sallaEventId(body: Record<string, unknown>, order: Record<string, unknown>): string {
  return firstString([body.id, body.event_id, body.eventId, body.webhook_id, body.webhookId, body.created_at && `${body.event}-${body.created_at}`, order.id && `${body.event ?? "order"}-${order.id}-${order.updated_at ?? order.status ?? ""}`], `salla-${Date.now()}`);
}

function sallaEventType(body: Record<string, unknown>): NormalizedCommerceEvent["eventType"] {
  const event = asString(body.event ?? body.eventType).toLowerCase();
  if (event === "order.cancelled") return "order.cancelled";
  if (event === "order.updated" || event === "order.status.updated" || event === "order.payment.updated" || event === "order.shipping.address.updated" || event === "order.products.updated" || event === "order.total.price.updated") return "order.updated";
  if (event === "app.store.authorize" || event === "app.store.authorized") return "sync.requested";
  if (event === "app.uninstalled" || event === "app.store.deleted") return "connection.revoked";
  return "order.created";
}

function money(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return asNumber(value);
  }
  return 0;
}

function customerName(customer: Record<string, unknown>): string {
  return firstString([
    customer.name,
    [customer.first_name, customer.last_name].map((part) => asString(part)).filter(Boolean).join(" "),
    customer.full_name,
  ], "Salla Customer");
}

function addressText(address: Record<string, unknown>): string {
  const parts = [
    address.shipping_address,
    address.address,
    address.street,
    address.district,
    address.city,
    asRecord(address.region).name ?? address.region,
    asRecord(address.country).name ?? address.country,
    address.postal_code,
  ].map((part) => asString(part)).filter(Boolean);
  return parts.length ? parts.join(", ") : "Salla order address";
}

function locationValue(order: Record<string, unknown>, address: Record<string, unknown>): string {
  return firstString([
    [asString(asRecord(address.region).name ?? address.region), asString(address.city), asString(address.district)].filter(Boolean).join(" / "),
    [asString(order.region), asString(order.city), asString(order.district)].filter(Boolean).join(" / "),
    address.city,
    address.district,
  ], "Salla location");
}

function paymentIsCod(order: Record<string, unknown>, payment: Record<string, unknown>): boolean {
  const method = `${asString(payment.method)} ${asString(payment.name)} ${asString(payment.slug)} ${asString(order.payment_method)} ${asString(order.payment_method_name)}`.toLowerCase();
  if (/cod|cash.?on.?delivery|الدفع عند الاستلام|عند الاستلام/.test(method)) return true;
  const status = `${asString(payment.status)} ${asString(order.payment_status)}`.toLowerCase();
  return /pending|not_paid|unpaid/.test(status) && !/paid|captured|completed/.test(status);
}

function normalizeSallaOrder(order: Record<string, unknown>): NormalizedCommerceOrder {
  const customer = asRecord(order.customer);
  const shipping = asRecord(order.shipping);
  const address = asRecord(order.shipping_address ?? shipping.address ?? order.address);
  const payment = asRecord(order.payment_method ?? order.payment);
  const currency = asString(asRecord(order.currency).code ?? order.currency, "AED").toUpperCase();
  const total = money(order, ["amounts", "total", "total_amount", "price"]);
  const paid = money(order, ["paid_amount", "amount_paid"]);
  const remaining = Math.max(0, money(order, ["remaining_amount", "amount_due"]) || total - paid);
  const codRequired = paymentIsCod(order, payment);
  const items = Array.isArray(order.items) ? order.items.map((item) => {
    const row = asRecord(item);
    const product = asRecord(row.product);
    return {
      ...(() => {
        const externalProductId = optionalString([row.product_id, product.id]);
        return externalProductId ? { externalProductId } : {};
      })(),
      quantity: Math.max(1, Math.trunc(asNumber(row.quantity, 1))),
      ...(() => {
        const sku = optionalString([row.sku, product.sku]);
        return sku ? { sku } : {};
      })(),
      title: firstString([row.name, row.title, product.name], "Salla item"),
      ...(row.weight !== undefined || product.weight !== undefined ? { weightKg: asNumber(row.weight ?? product.weight, 0) } : {}),
    };
  }) : [{ title: "Salla package", quantity: 1 }];
  const packageCount = Math.max(1, items.reduce((sum, item) => sum + Math.max(1, Math.trunc(item.quantity)), 0));

  const customerEmail = optionalString([customer.email, order.customer_email]);
  const emirate = optionalString([asRecord(address.region).name, address.region, order.region]);
  const notes = optionalString([order.notes, order.customer_notes, order.note]);
  const updatedAt = optionalString([order.updated_at, order.date?.toString()]);

  return {
    address: addressText(address),
    area: locationValue(order, address),
    codAmount: codRequired ? remaining || total : 0,
    codRequired,
    countryCode: firstString([asRecord(address.country).code, address.country_code, order.country_code], "SA").toUpperCase(),
    currency,
    ...(customerEmail ? { customerEmail } : {}),
    customerMobile: firstString([customer.mobile, customer.phone, customer.mobile_code && `${customer.mobile_code}${customer.mobile}`, order.customer_mobile], ""),
    customerName: customerName(customer),
    ...(emirate ? { emirate } : {}),
    externalOrderId: firstString([order.id, order.order_id, order.reference_id], ""),
    externalOrderNumber: firstString([order.reference_id, order.number, order.id], ""),
    items,
    ...(notes ? { notes } : {}),
    packageCount,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export class SallaCommerceProvider implements CommerceProvider {
  public readonly key = "salla" as const;
  public readonly label = "Salla";
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
      outbound_fulfillment: false,
      outbound_status: true,
      polling: true,
      products: true,
      webhooks: true,
    };
  }

  public verifyWebhook(input: { readonly body?: unknown; readonly connectionReference?: string; readonly rawBody?: Buffer; readonly signature?: string }): boolean {
    const secret = sallaWebhookSecret();
    if (!secret || !input.rawBody || !input.signature) return false;
    return safeCompareHex(input.signature, signSallaWebhookPayload(input.rawBody, secret));
  }

  public parseWebhook(input: { readonly body: unknown }): NormalizedCommerceEvent {
    const body = asRecord(input.body);
    const order = sallaData(body);
    const eventType = sallaEventType(body);
    return {
      eventType,
      externalEventId: sallaEventId(body, order),
      ...(() => {
        const externalReference = optionalString([order.reference_id, order.number, order.id]);
        return externalReference ? { externalReference } : {};
      })(),
      ...(eventType.startsWith("order.") ? { order: normalizeSallaOrder(order) } : {}),
    };
  }

  public healthCheck(input: { readonly requestedState?: "healthy" | "degraded" | "unauthorized" }) {
    const status = input.requestedState ?? (process.env.SALLA_CLIENT_ID && process.env.SALLA_CLIENT_SECRET ? "healthy" : "degraded");
    return { status, message: status === "healthy" ? "Salla configuration is present." : status === "unauthorized" ? "Salla authorization failed." : "Salla app credentials are not fully configured." };
  }

  public pushOrderStatus(input: { readonly externalOrderId: string; readonly status: string }) {
    return { externalStatus: input.status, providerMessage: `Salla outbound status ${input.status} queued for ${input.externalOrderId}; real provider push requires connected credentials.` };
  }
}
