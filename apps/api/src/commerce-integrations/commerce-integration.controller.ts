import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../authentication/authentication.decorators.js";
import { RequirePlatformPermissions } from "../platform/platform-authorization.js";
import { Throttle } from "@nestjs/throttler";

import { CommerceIntegrationService } from "./commerce-integration.service.js";
import { CommerceAreaMappingDto, CreateMockCommerceConnectionDto, DisconnectCommerceConnectionDto, SimulateCommerceEventDto, StartSallaConnectionDto, StartShopifyConnectionDto } from "./commerce-integration.dto.js";

@Controller("integrations/commerce")
export class CommerceIntegrationWebhookController {
  public constructor(@Inject(CommerceIntegrationService) private readonly commerce: CommerceIntegrationService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @HttpCode(202)
  @Post(":provider/webhook/:connectionReference")
  public webhook(
    @Param("provider") provider: string,
    @Param("connectionReference") connectionReference: string,
    @Body() body: unknown,
    @Req() request: Request & { rawBody?: Buffer },
    @Headers("x-commerce-signature") signature?: string,
    @Headers("x-salla-signature") sallaSignature?: string,
    @Headers("x-shopify-hmac-sha256") shopifySignature?: string,
    @Headers("x-shopify-topic") shopifyTopic?: string,
    @Headers("x-shopify-shop-domain") shopifyShopDomain?: string,
    @Headers("x-shopify-webhook-id") shopifyWebhookId?: string,
    @Headers("x-shopify-event-id") shopifyEventId?: string,
    @Headers("x-shopify-api-version") shopifyApiVersion?: string,
  ) {
    return this.commerce.webhook(provider, connectionReference, body, request.rawBody, signature ?? sallaSignature ?? shopifySignature, {
      "x-shopify-api-version": shopifyApiVersion,
      "x-shopify-event-id": shopifyEventId,
      "x-shopify-hmac-sha256": shopifySignature,
      "x-shopify-shop-domain": shopifyShopDomain,
      "x-shopify-topic": shopifyTopic,
      "x-shopify-webhook-id": shopifyWebhookId,
    });
  }

  @Public()
  @Get("salla/oauth/callback")
  public sallaCallback(@Query() query: Record<string, string | undefined>) {
    return this.commerce.completeSallaCallback(query);
  }

  @Public()
  @Get("shopify/oauth/callback")
  public shopifyCallback(@Query() query: Record<string, string | undefined>) {
    return this.commerce.completeShopifyCallback(query);
  }
}

@RequirePlatformPermissions()
@Controller("platform/commerce-integrations")
export class PlatformCommerceIntegrationController {
  public constructor(@Inject(CommerceIntegrationService) private readonly commerce: CommerceIntegrationService) {}

  @Get("providers")
  public providers() {
    return this.commerce.providerInventory();
  }

  @Get("mock-targets")
  public mockTargets() {
    return this.commerce.mockTargets();
  }

  @Get("connections")
  public connections(@Query() query: Record<string, string | undefined>) {
    return this.commerce.connections(query);
  }

  @Post("connections/mock")
  public createMock(@Body() body: CreateMockCommerceConnectionDto) {
    return this.commerce.createMockConnection(body);
  }

  @Post("connections/salla/start")
  public startSalla(@Body() body: StartSallaConnectionDto) {
    return this.commerce.startSallaConnection(body);
  }

  @Post("connections/shopify/start")
  public startShopify(@Body() body: StartShopifyConnectionDto) {
    return this.commerce.startShopifyConnection(body);
  }

  @Get("connections/:id")
  public connection(@Param("id") id: string) {
    return this.commerce.connection(id);
  }

  @Post("connections/:id/simulate")
  public simulate(@Param("id") id: string, @Body() body: SimulateCommerceEventDto) {
    return this.commerce.simulate(id, body);
  }

  @Post("connections/:id/test")
  public test(@Param("id") id: string, @Body() body: { requestedState?: "healthy" | "degraded" | "unauthorized" }) {
    return this.commerce.testConnection(id, body.requestedState);
  }

  @Post("connections/:id/disconnect")
  public disconnect(@Param("id") id: string, @Body() body: DisconnectCommerceConnectionDto) {
    return this.commerce.disconnect(id, body);
  }

  @Post("connections/:id/reconnect")
  public reconnect(@Param("id") id: string) {
    return this.commerce.reconnect(id);
  }

  @Post("connections/:id/area-mappings")
  public areaMapping(@Param("id") id: string, @Body() body: CommerceAreaMappingDto) {
    return this.commerce.saveAreaMapping(id, body);
  }

  @Get("connections/:id/areas")
  public areaOptions(@Param("id") id: string, @Query() query: Record<string, string | undefined>) {
    return this.commerce.areaOptions(id, query);
  }

  @Get("connections/:id/events")
  public events(@Param("id") id: string, @Query() query: Record<string, string | undefined>) {
    return this.commerce.events(id, query);
  }

  @Post("events/:id/retry")
  public retry(@Param("id") id: string) {
    return this.commerce.retryEvent(id);
  }

  @Post("orders/:orderId/outbound-delivered")
  public outboundDelivered(@Param("orderId") orderId: string) {
    return this.commerce.outboundDelivered(orderId);
  }
}
