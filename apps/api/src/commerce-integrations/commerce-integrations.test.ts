import { BadRequestException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { CommerceProviderRouter } from "./commerce-provider.router.js";
import { MockCommerceProvider, signMockCommercePayload } from "./mock-commerce.provider.js";
import { SallaCommerceProvider, signSallaWebhookPayload } from "./salla-commerce.provider.js";
import { ShopifyCommerceProvider, normalizeShopifyShopDomain, signShopifyWebhookPayload, verifyShopifyCallbackHmac } from "./shopify-commerce.provider.js";
import { WooCommerceCommerceProvider, normalizeWooCommerceStoreUrl, signWooCommerceWebhookPayload } from "./woocommerce-commerce.provider.js";

describe("CommerceProviderRouter", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalMockFlag = process.env.COMMERCE_MOCK_PROVIDER_ENABLED;
  const originalShopifyFlag = process.env.SHOPIFY_INTEGRATION_ENABLED;
  const originalWooFlag = process.env.WOOCOMMERCE_INTEGRATION_ENABLED;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalMockFlag === undefined) delete process.env.COMMERCE_MOCK_PROVIDER_ENABLED;
    else process.env.COMMERCE_MOCK_PROVIDER_ENABLED = originalMockFlag;
    if (originalShopifyFlag === undefined) delete process.env.SHOPIFY_INTEGRATION_ENABLED;
    else process.env.SHOPIFY_INTEGRATION_ENABLED = originalShopifyFlag;
    if (originalWooFlag === undefined) delete process.env.WOOCOMMERCE_INTEGRATION_ENABLED;
    else process.env.WOOCOMMERCE_INTEGRATION_ENABLED = originalWooFlag;
  });

  it("registers Mock Commerce as the only enabled provider outside production", () => {
    process.env.NODE_ENV = "test";
    delete process.env.COMMERCE_MOCK_PROVIDER_ENABLED;

    const router = new CommerceProviderRouter();
    const inventory = router.list();

    expect(inventory.find((provider) => provider.key === "mock_commerce")?.enabled).toBe(true);
    expect(inventory.find((provider) => provider.key === "shopify")?.enabled).toBe(false);
    expect(router.get("mock_commerce").label).toBe("Mock Commerce");
  });

  it("disables Mock Commerce in production and when explicitly switched off", () => {
    process.env.NODE_ENV = "production";
    expect(() => new CommerceProviderRouter().get("mock_commerce")).toThrow(BadRequestException);

    process.env.NODE_ENV = "test";
    process.env.COMMERCE_MOCK_PROVIDER_ENABLED = "false";
    expect(() => new CommerceProviderRouter().get("mock_commerce")).toThrow(BadRequestException);
  });

  it("registers Shopify only when the feature flag is enabled", () => {
    process.env.SHOPIFY_INTEGRATION_ENABLED = "false";
    expect(new CommerceProviderRouter().list().find((provider) => provider.key === "shopify")?.enabled).toBe(false);
    expect(() => new CommerceProviderRouter().get("shopify")).toThrow(BadRequestException);

    process.env.SHOPIFY_INTEGRATION_ENABLED = "true";
    const router = new CommerceProviderRouter();
    expect(router.list().find((provider) => provider.key === "shopify")?.capabilities.oauth).toBe(true);
    expect(router.get("shopify").label).toBe("Shopify");
  });

  it("registers WooCommerce only when the feature flag is enabled", () => {
    process.env.WOOCOMMERCE_INTEGRATION_ENABLED = "false";
    expect(new CommerceProviderRouter().list().find((provider) => provider.key === "woocommerce")?.enabled).toBe(false);
    expect(() => new CommerceProviderRouter().get("woocommerce")).toThrow(BadRequestException);

    process.env.WOOCOMMERCE_INTEGRATION_ENABLED = "true";
    const router = new CommerceProviderRouter();
    expect(router.list().find((provider) => provider.key === "woocommerce")?.capabilities.api_keys).toBe(true);
    expect(router.get("woocommerce").label).toBe("WooCommerce");
  });
});

describe("MockCommerceProvider", () => {
  it("verifies deterministic webhook signatures without accepting invalid signatures", () => {
    const provider = new MockCommerceProvider();
    const body = { eventType: "order.created", externalEventId: "evt-1", order: { externalOrderNumber: "TEST-10001" } };
    const signature = signMockCommercePayload("CIN-000001", body);

    expect(provider.verifyWebhook({ body, connectionReference: "CIN-000001", signature })).toBe(true);
    expect(provider.verifyWebhook({ body, connectionReference: "CIN-000001", signature: "bad-signature" })).toBe(false);
  });

  it("normalizes a mock order into provider-independent commerce order shape", () => {
    const event = new MockCommerceProvider().parseWebhook({
      body: {
        eventType: "order.created",
        externalEventId: "evt-2",
        order: {
          area: "Al Aweer",
          codAmount: "250",
          customerMobile: "050 646 8441",
          externalOrderId: "mock-10001",
          externalOrderNumber: "TEST-10001",
        },
      },
    });

    expect(event.eventType).toBe("order.created");
    expect(event.externalEventId).toBe("evt-2");
    expect(event.order).toMatchObject({
      area: "Al Aweer",
      codAmount: 250,
      customerMobile: "050 646 8441",
      externalOrderId: "mock-10001",
      externalOrderNumber: "TEST-10001",
    });
  });
});

describe("SallaCommerceProvider", () => {
  const originalWebhookSecret = process.env.SALLA_WEBHOOK_SECRET;

  afterEach(() => {
    if (originalWebhookSecret === undefined) delete process.env.SALLA_WEBHOOK_SECRET;
    else process.env.SALLA_WEBHOOK_SECRET = originalWebhookSecret;
  });

  it("verifies Salla SHA-256 webhook signatures against the raw body", () => {
    process.env.SALLA_WEBHOOK_SECRET = "salla-test-secret";
    const provider = new SallaCommerceProvider();
    const rawBody = Buffer.from(JSON.stringify({ event: "order.created", data: { id: 10001 } }));
    const signature = signSallaWebhookPayload(rawBody, "salla-test-secret");

    expect(provider.verifyWebhook({ body: {}, connectionReference: "CIN-000001", rawBody, signature })).toBe(true);
    expect(provider.verifyWebhook({ body: {}, connectionReference: "CIN-000001", rawBody, signature: "bad-signature" })).toBe(false);
  });

  it("normalizes a Salla COD order into the generic commerce order shape", () => {
    const event = new SallaCommerceProvider().parseWebhook({
      body: {
        event: "order.created",
        data: {
          id: 10001,
          reference_id: "SALLA-10001",
          currency: { code: "AED" },
          customer: { name: "Aiman", mobile: "0506468441", email: "customer@example.test" },
          shipping_address: { country: { code: "AE", name: "United Arab Emirates" }, region: { name: "Dubai" }, city: "Dubai", district: "Al Aweer", street: "Warehouse 5" },
          payment_method: { name: "Cash on Delivery" },
          total: { amount: 250 },
          paid_amount: { amount: 0 },
          items: [{ product_id: 55, sku: "SKU-55", name: "Package", quantity: 2, weight: 1.5 }],
        },
      },
    });

    expect(event).toMatchObject({
      eventType: "order.created",
      externalReference: "SALLA-10001",
      order: {
        codAmount: 250,
        codRequired: true,
        countryCode: "AE",
        currency: "AED",
        customerEmail: "customer@example.test",
        customerMobile: "0506468441",
        externalOrderId: "10001",
        externalOrderNumber: "SALLA-10001",
        packageCount: 2,
      },
    });
    expect(event.order?.area).toContain("Al Aweer");
  });

  it("maps prepaid Salla orders to zero Tawseelhub COD", () => {
    const event = new SallaCommerceProvider().parseWebhook({
      body: {
        event: "order.updated",
        data: {
          id: 10002,
          reference_id: "SALLA-10002",
          currency: "AED",
          customer: { name: "Prepaid Customer", mobile: "971501111111" },
          shipping_address: { city: "Dubai", district: "Al Aweer" },
          payment_method: { name: "Credit Card", status: "paid" },
          total: { amount: 199 },
          paid_amount: { amount: 199 },
        },
      },
    });

    expect(event.eventType).toBe("order.updated");
    expect(event.order?.codRequired).toBe(false);
    expect(event.order?.codAmount).toBe(0);
  });
});

describe("ShopifyCommerceProvider", () => {
  const originalClientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const originalWebhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;

  afterEach(() => {
    if (originalClientSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
    else process.env.SHOPIFY_CLIENT_SECRET = originalClientSecret;
    if (originalWebhookSecret === undefined) delete process.env.SHOPIFY_WEBHOOK_SECRET;
    else process.env.SHOPIFY_WEBHOOK_SECRET = originalWebhookSecret;
  });

  it("normalizes only legitimate myshopify.com domains", () => {
    expect(normalizeShopifyShopDomain("https://Noor-Test.myshopify.com/admin")).toBe("noor-test.myshopify.com");
    expect(() => normalizeShopifyShopDomain("javascript:alert(1)")).toThrow("shopify_shop_domain_invalid");
    expect(() => normalizeShopifyShopDomain("example.com")).toThrow("shopify_shop_domain_invalid");
    expect(() => normalizeShopifyShopDomain("bad_host.myshopify.com")).toThrow("shopify_shop_domain_invalid");
  });

  it("verifies Shopify callback and webhook HMAC values", () => {
    process.env.SHOPIFY_CLIENT_SECRET = "shopify-test-secret";
    const query = {
      code: "code-123",
      shop: "noor-test.myshopify.com",
      state: "state-123",
      timestamp: "1797600000",
    };
    const hmac = createHmac("sha256", "shopify-test-secret").update("code=code-123&shop=noor-test.myshopify.com&state=state-123&timestamp=1797600000").digest("hex");
    expect(verifyShopifyCallbackHmac({ ...query, hmac }, "shopify-test-secret")).toBe(true);
    expect(verifyShopifyCallbackHmac({ ...query, hmac: "bad" }, "shopify-test-secret")).toBe(false);

    const rawBody = Buffer.from(JSON.stringify({ id: 1001, name: "#1001" }));
    const signature = signShopifyWebhookPayload(rawBody, "shopify-test-secret");
    const provider = new ShopifyCommerceProvider();
    expect(provider.verifyWebhook({ body: {}, connectionReference: "CIN-000001", rawBody, signature })).toBe(true);
    expect(provider.verifyWebhook({ body: {}, connectionReference: "CIN-000001", rawBody, signature: "bad-signature" })).toBe(false);
  });

  it("normalizes Shopify COD orders into the generic commerce order shape", () => {
    const event = new ShopifyCommerceProvider().parseWebhook({
      body: {
        id: 1001,
        admin_graphql_api_id: "gid://shopify/Order/1001",
        name: "#1001",
        currency: "AED",
        current_total_price: "250.00",
        total_outstanding: "250.00",
        payment_gateway_names: ["Cash on Delivery (COD)"],
        customer: { first_name: "Aiman", last_name: "Noor", email: "aiman@example.test" },
        shipping_address: { name: "Aiman Noor", phone: "0506468441", address1: "Warehouse 5", city: "Dubai", province: "Dubai", country_code: "AE" },
        line_items: [{ product_id: 55, sku: "SKU-55", title: "Package", quantity: 2, grams: 1500 }],
        updated_at: "2026-08-19T10:00:00Z",
      },
      headers: { "x-shopify-topic": "orders/create", "x-shopify-event-id": "evt-shopify-1" },
    });

    expect(event).toMatchObject({
      eventType: "order.created",
      externalEventId: "evt-shopify-1",
      externalReference: "#1001",
      order: {
        codAmount: 250,
        codRequired: true,
        countryCode: "AE",
        currency: "AED",
        customerEmail: "aiman@example.test",
        customerMobile: "0506468441",
        externalOrderId: "gid://shopify/Order/1001",
        externalOrderNumber: "#1001",
        packageCount: 1,
      },
    });
    expect(event.order?.area).toContain("Dubai");
    expect(event.order?.items[0]).toMatchObject({ externalProductId: "55", quantity: 2, sku: "SKU-55", weightKg: 1.5 });
  });

  it("imports prepaid guest Shopify orders with zero COD", () => {
    const event = new ShopifyCommerceProvider().parseWebhook({
      body: {
        id: 1002,
        name: "#1002",
        currency: "AED",
        current_total_price: "199.00",
        financial_status: "paid",
        payment_gateway_names: ["shopify_payments"],
        email: "guest@example.test",
        shipping_address: { name: "Guest Buyer", phone: "+971501111111", address1: "Villa 1", city: "Ajman", province: "Ajman", country_code: "AE" },
        line_items: [{ title: "Discounted item", quantity: 1 }],
      },
      headers: { "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "webhook-2" },
    });

    expect(event.eventType).toBe("order.updated");
    expect(event.order?.codRequired).toBe(false);
    expect(event.order?.codAmount).toBe(0);
    expect(event.order?.customerName).toBe("Guest Buyer");
    expect(event.order?.customerEmail).toBe("guest@example.test");
  });
});

describe("WooCommerceCommerceProvider", () => {
  const originalSecretSeed = process.env.WOOCOMMERCE_WEBHOOK_SECRET_SEED;

  afterEach(() => {
    if (originalSecretSeed === undefined) delete process.env.WOOCOMMERCE_WEBHOOK_SECRET_SEED;
    else process.env.WOOCOMMERCE_WEBHOOK_SECRET_SEED = originalSecretSeed;
  });

  it("normalizes only safe production store URLs", () => {
    expect(normalizeWooCommerceStoreUrl("https://Shop.Example.com/store?x=1#fragment")).toBe("https://shop.example.com");
    expect(() => normalizeWooCommerceStoreUrl("javascript:alert(1)")).toThrow("woocommerce_store_url_invalid");
    expect(() => normalizeWooCommerceStoreUrl("http://shop.example.com")).toThrow("woocommerce_https_required");
    expect(() => normalizeWooCommerceStoreUrl("https://localhost")).toThrow("woocommerce_store_url_private");
    expect(() => normalizeWooCommerceStoreUrl("https://127.0.0.1")).toThrow("woocommerce_store_url_private");
    expect(() => normalizeWooCommerceStoreUrl("https://10.0.0.5")).toThrow("woocommerce_store_url_private");
    expect(() => normalizeWooCommerceStoreUrl("http://127.0.0.1", { production: false })).toThrow("woocommerce_store_url_private");
    expect(normalizeWooCommerceStoreUrl("http://127.0.0.1:8080", { allowPrivate: true, production: false })).toBe("http://127.0.0.1:8080");
  });

  it("verifies WooCommerce webhook signatures against the raw body and connection reference", () => {
    process.env.WOOCOMMERCE_WEBHOOK_SECRET_SEED = "woocommerce-test-seed";
    const provider = new WooCommerceCommerceProvider();
    const rawBody = Buffer.from(JSON.stringify({ id: 1045, number: "1045" }));
    const reference = "CIN-000777";
    const secret = createHmac("sha256", "woocommerce-test-seed").update(`woocommerce:${reference}`).digest("hex");
    const signature = signWooCommerceWebhookPayload(rawBody, secret);

    expect(provider.verifyWebhook({ connectionReference: reference, rawBody, signature })).toBe(true);
    expect(provider.verifyWebhook({ connectionReference: reference, rawBody, signature: "bad-signature" })).toBe(false);
    expect(provider.verifyWebhook({ connectionReference: "CIN-OTHER", rawBody, signature })).toBe(false);
  });

  it("normalizes WooCommerce COD orders into the generic commerce order shape", () => {
    const event = new WooCommerceCommerceProvider().parseWebhook({
      body: {
        id: 1045,
        number: "1045",
        status: "processing",
        currency: "AED",
        total: "250.00",
        payment_method: "cod",
        payment_method_title: "Cash on Delivery",
        billing: { first_name: "Aiman", last_name: "Noor", phone: "0506468441", email: "aiman@example.test", country: "AE" },
        shipping: { first_name: "Aiman", last_name: "Noor", phone: "0506468441", address_1: "Warehouse 5", city: "Dubai", state: "Dubai", country: "AE" },
        line_items: [{ product_id: 55, sku: "SKU-55", name: "Package", quantity: 2 }],
        date_modified_gmt: "2026-08-20T10:00:00",
      },
      headers: { "x-wc-webhook-topic": "order.created", "x-wc-delivery-id": "delivery-1" },
    });

    expect(event).toMatchObject({
      eventType: "order.created",
      externalEventId: "delivery-1",
      externalReference: "1045",
      order: {
        codAmount: 250,
        codRequired: true,
        countryCode: "AE",
        currency: "AED",
        customerEmail: "aiman@example.test",
        customerMobile: "0506468441",
        externalOrderId: "1045",
        externalOrderNumber: "1045",
        packageCount: 1,
      },
    });
    expect(event.order?.area).toContain("Dubai");
    expect(event.order?.items[0]).toMatchObject({ externalProductId: "55", quantity: 2, sku: "SKU-55" });
  });

  it("normalizes WooCommerce prepaid guest orders with zero COD", () => {
    const event = new WooCommerceCommerceProvider().parseWebhook({
      body: {
        id: 1046,
        number: "1046",
        status: "processing",
        currency: "AED",
        total: "199.00",
        payment_method: "stripe",
        payment_method_title: "Credit Card",
        billing: { first_name: "Guest", last_name: "Buyer", phone: "+971501111111", email: "guest@example.test", country: "AE" },
        shipping: { first_name: "Guest", last_name: "Buyer", address_1: "Villa 1", city: "Ajman", state: "Ajman", country: "AE" },
        line_items: [{ name: "Discounted item", quantity: 1 }],
      },
      headers: { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-id": "wh-2" },
    });

    expect(event.eventType).toBe("order.updated");
    expect(event.order?.codRequired).toBe(false);
    expect(event.order?.codAmount).toBe(0);
    expect(event.order?.customerName).toBe("Guest Buyer");
    expect(event.order?.customerEmail).toBe("guest@example.test");
  });
});
