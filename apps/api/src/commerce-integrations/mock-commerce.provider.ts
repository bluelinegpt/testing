import { createHmac, timingSafeEqual } from "node:crypto";

import type { CommerceProvider, CommerceProviderCapability, NormalizedCommerceEvent, NormalizedCommerceOrder } from "./commerce-integration.types.js";

export const mockCommerceSecretFor = (connectionReference: string) => `mock-commerce:${connectionReference}`;

export function signMockCommercePayload(connectionReference: string, body: unknown): string {
  return createHmac("sha256", mockCommerceSecretFor(connectionReference))
    .update(JSON.stringify(body))
    .digest("hex");
}

function safeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function safeNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sampleOrder(overrides: Record<string, unknown>): NormalizedCommerceOrder {
  const order: NormalizedCommerceOrder = {
    address: safeString(overrides.address, "Al Aweer, Dubai"),
    area: safeString(overrides.area, "Al Aweer"),
    codAmount: safeNumber(overrides.codAmount, 250),
    codRequired: overrides.codRequired === false ? false : true,
    countryCode: safeString(overrides.countryCode, "AE"),
    currency: safeString(overrides.currency, "AED"),
    customerMobile: safeString(overrides.customerMobile, "+971506468441"),
    customerName: safeString(overrides.customerName, "Aiman"),
    externalOrderId: safeString(overrides.externalOrderId, "mock-order-10001"),
    externalOrderNumber: safeString(overrides.externalOrderNumber, "TEST-10001"),
    items: Array.isArray(overrides.items)
      ? overrides.items.map((item) => {
          const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
          return {
            quantity: safeNumber(row.quantity, 1),
            title: safeString(row.title, "Mock package"),
            ...(typeof row.externalProductId === "string" ? { externalProductId: row.externalProductId } : {}),
            ...(typeof row.sku === "string" ? { sku: row.sku } : {}),
            ...(row.weightKg === undefined ? {} : { weightKg: safeNumber(row.weightKg, 1) }),
          };
        })
      : [{ title: "Mock package", quantity: 1, weightKg: 1 }],
    packageCount: Math.max(1, Math.trunc(safeNumber(overrides.packageCount, 1))),
  };
  return {
    ...order,
    ...(typeof overrides.customerEmail === "string" ? { customerEmail: overrides.customerEmail } : {}),
    ...(typeof overrides.emirate === "string" ? { emirate: overrides.emirate } : { emirate: "Dubai" }),
    ...(typeof overrides.notes === "string" ? { notes: overrides.notes } : {}),
    ...(typeof overrides.updatedAt === "string" ? { updatedAt: overrides.updatedAt } : {}),
  };
}

export class MockCommerceProvider implements CommerceProvider {
  public readonly key = "mock_commerce" as const;
  public readonly label = "Mock Commerce";
  public readonly productionEnabled = false;

  public capabilities(): Readonly<Record<CommerceProviderCapability, boolean>> {
    return {
      api_keys: false,
      customers: true,
      inbound_cancellations: true,
      inbound_order_updates: true,
      inbound_orders: true,
      inventory: false,
      oauth: false,
      outbound_fulfillment: true,
      outbound_status: true,
      polling: true,
      products: true,
      webhooks: true,
    };
  }

  public verifyWebhook(input: { readonly body: unknown; readonly connectionReference: string; readonly signature?: string }): boolean {
    if (!input.signature) return false;
    const expected = signMockCommercePayload(input.connectionReference, input.body);
    const provided = input.signature.replace(/^sha256=/, "");
    const expectedBuffer = Buffer.from(expected, "hex");
    const providedBuffer = Buffer.from(provided, "hex");
    return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
  }

  public parseWebhook(input: { readonly body: unknown }): NormalizedCommerceEvent {
    const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
    const eventType = safeString(body.eventType, "order.created") as NormalizedCommerceEvent["eventType"];
    return {
      eventType,
      externalEventId: safeString(body.externalEventId, `mock-event-${Date.now()}`),
      ...(typeof body.externalReference === "string" ? { externalReference: body.externalReference } : {}),
      ...(eventType.startsWith("order.") ? { order: sampleOrder((body.order && typeof body.order === "object" ? body.order : body) as Record<string, unknown>) } : {}),
      ...(body.providerState === "degraded" || body.providerState === "unauthorized" || body.providerState === "healthy" ? { providerState: body.providerState } : {}),
      ...(body.simulateFailure === "timeout" || body.simulateFailure === "processing_failure" ? { simulateFailure: body.simulateFailure } : {}),
    };
  }

  public healthCheck(input: { readonly requestedState?: "healthy" | "degraded" | "unauthorized" }) {
    const status = input.requestedState ?? "healthy";
    return { status, message: status === "healthy" ? "Mock provider is healthy." : status === "degraded" ? "Mock provider is degraded." : "Mock provider credentials are unauthorized." };
  }

  public pushOrderStatus(input: { readonly externalOrderId: string; readonly status: string }) {
    return { externalStatus: input.status, providerMessage: `Mock provider recorded ${input.status} for ${input.externalOrderId}` };
  }
}
