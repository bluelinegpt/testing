import { BadRequestException, Injectable } from "@nestjs/common";

import { MockCommerceProvider } from "./mock-commerce.provider.js";
import { SallaCommerceProvider } from "./salla-commerce.provider.js";
import { ShopifyCommerceProvider } from "./shopify-commerce.provider.js";
import type { CommerceProvider, CommerceProviderKey } from "./commerce-integration.types.js";

@Injectable()
export class CommerceProviderRouter {
  private readonly mock = new MockCommerceProvider();
  private readonly salla = new SallaCommerceProvider();
  private readonly shopify = new ShopifyCommerceProvider();

  public list(): readonly { key: CommerceProviderKey; label: string; enabled: boolean; capabilities: ReturnType<CommerceProvider["capabilities"]> }[] {
    return [
      {
        capabilities: this.mock.capabilities(),
        enabled: this.isEnabled(this.mock.key),
        key: this.mock.key,
        label: this.mock.label,
      },
      {
        capabilities: this.salla.capabilities(),
        enabled: this.isEnabled(this.salla.key),
        key: this.salla.key,
        label: this.salla.label,
      },
      {
        capabilities: this.shopify.capabilities(),
        enabled: this.isEnabled(this.shopify.key),
        key: this.shopify.key,
        label: this.shopify.label,
      },
      { key: "woocommerce", label: "WooCommerce", enabled: false, capabilities: this.emptyCapabilities() },
    ];
  }

  public get(provider: string): CommerceProvider {
    if (provider === this.mock.key && this.isEnabled("mock_commerce")) return this.mock;
    if (provider === this.salla.key && this.isEnabled("salla")) return this.salla;
    if (provider === this.shopify.key && this.isEnabled("shopify")) return this.shopify;
    throw new BadRequestException("commerce_provider_not_enabled");
  }

  public isEnabled(provider: CommerceProviderKey): boolean {
    if (provider === "salla") return process.env.SALLA_INTEGRATION_ENABLED === "true";
    if (provider === "shopify") return process.env.SHOPIFY_INTEGRATION_ENABLED === "true";
    if (provider !== "mock_commerce") return false;
    return process.env.NODE_ENV !== "production" && process.env.COMMERCE_MOCK_PROVIDER_ENABLED !== "false";
  }

  private emptyCapabilities(): ReturnType<CommerceProvider["capabilities"]> {
    return {
      api_keys: false,
      customers: false,
      inbound_cancellations: false,
      inbound_order_updates: false,
      inbound_orders: false,
      inventory: false,
      oauth: false,
      outbound_fulfillment: false,
      outbound_status: false,
      polling: false,
      products: false,
      webhooks: false,
    };
  }
}
