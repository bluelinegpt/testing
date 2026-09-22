import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../authentication/authentication.decorators.js";
import { AgentService } from "./agent.service.js";
import { AgentOpenedEventDto, CreateAgentConversationDto, CreateLiveAvatarSessionDto, LiveAvatarUsageDto, SendAgentMessageDto, SimulateWhatsAppMessageDto } from "./agent.dto.js";

export function trustedCountryCode(headers: Request["headers"], trustCloudflareHeaders: boolean): string | undefined {
  if (!trustCloudflareHeaders) return undefined;
  const country = Array.isArray(headers["cf-ipcountry"]) ? headers["cf-ipcountry"][0] : headers["cf-ipcountry"];
  const cloudflareRay = Array.isArray(headers["cf-ray"]) ? headers["cf-ray"][0] : headers["cf-ray"];
  return cloudflareRay && /^[A-Za-z]{2}$/.test(country ?? "") ? country!.toUpperCase() : undefined;
}

export function coarseUserAgent(value: string | undefined) {
  const userAgent = value ?? "";
  const deviceCategory = /bot|crawler|spider/i.test(userAgent)
    ? "bot"
    : /ipad|tablet/i.test(userAgent)
      ? "tablet"
      : /mobile|iphone|android/i.test(userAgent)
        ? "mobile"
        : userAgent
          ? "desktop"
          : "unknown";
  const browserFamily = /edg\//i.test(userAgent) ? "Edge" : /firefox\//i.test(userAgent) ? "Firefox" : /chrome\//i.test(userAgent) ? "Chrome" : /safari\//i.test(userAgent) ? "Safari" : "Other";
  const operatingSystemFamily = /windows/i.test(userAgent) ? "Windows" : /android/i.test(userAgent) ? "Android" : /iphone|ipad|ios/i.test(userAgent) ? "iOS" : /mac os|macintosh/i.test(userAgent) ? "macOS" : /linux/i.test(userAgent) ? "Linux" : "Other";
  return { browserFamily, deviceCategory, operatingSystemFamily };
}

@Controller("public/agent")
export class PublicAgentController {
  public constructor(@Inject(AgentService) private readonly agent: AgentService) {}

  private requestIp(request: Request) {
    const forwarded = request.headers["x-forwarded-for"];
    const realIp = request.headers["x-real-ip"];
    const cfIp = request.headers["cf-connecting-ip"];
    const raw = Array.isArray(cfIp) ? cfIp[0] : cfIp
      ?? (Array.isArray(realIp) ? realIp[0] : realIp)
      ?? (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?? request.ip
      ?? request.socket.remoteAddress
      ?? "";
    return String(raw).split(",")[0]?.trim().replace(/^::ffff:/, "") || undefined;
  }

  @Public() @Throttle({ default: { limit: 8, ttl: 60000 } }) @HttpCode(201) @Post("conversations")
  public create(@Body() body: CreateAgentConversationDto, @Req() request: Request) {
    const countryCode = trustedCountryCode(
      request.headers,
      process.env.TRUST_CLOUDFLARE_VISITOR_HEADERS === "true",
    );
    return this.agent.createWebsiteConversation(body.language, body.visitorId, this.requestIp(request), body.surface, {
      ...coarseUserAgent(request.get("user-agent")),
      ...(countryCode ? { countryCode } : {}),
      ...(body.landingPage ? { landingPage: body.landingPage } : {}),
      ...(body.referrerDomain ? { referrerDomain: body.referrerDomain } : {}),
      sourceHostname: body.sourceHostname ?? request.hostname,
      ...(body.sourcePage ? { sourcePage: body.sourcePage } : {}),
      ...(body.utmCampaign ? { utmCampaign: body.utmCampaign } : {}),
      ...(body.utmMedium ? { utmMedium: body.utmMedium } : {}),
      ...(body.utmSource ? { utmSource: body.utmSource } : {}),
    });
  }

  @Public() @Get("avatar/settings")
  @Header("Cache-Control", "no-store")
  public avatarSettings() { return this.agent.publicAvatarSettings(); }

  @Public() @Throttle({ default: { limit: 30, ttl: 60000 } }) @Get("conversations/:token")
  public get(@Param("token") token: string) {
    return this.agent.websiteConversation(token);
  }

  @Public() @Throttle({ default: { limit: 18, ttl: 60000 } }) @Post("conversations/:token/messages")
  public message(@Param("token") token: string, @Body() body: SendAgentMessageDto, @Req() request: Request) {
    return this.agent.receiveWebsiteMessage(token, body.message, body.language, this.requestIp(request), body.inboundMessageId);
  }

  @Public() @Throttle({ default: { limit: 30, ttl: 60000 } }) @HttpCode(204) @Post("conversations/:token/events/opened")
  public opened(@Param("token") token: string, @Body() body: AgentOpenedEventDto) {
    return this.agent.recordWebsiteOpen(token, body.eventId);
  }

  @Public() @Throttle({ default: { limit: 3, ttl: 60000 } }) @HttpCode(201) @Post("conversations/:token/avatar/live-session")
  public liveAvatarSession(@Param("token") token: string, @Body() body: CreateLiveAvatarSessionDto, @Req() request: Request) {
    return this.agent.createLiveAvatarSession(token, body.language, this.requestIp(request));
  }

  @Public() @Throttle({ default: { limit: 60, ttl: 60000 } }) @Post("conversations/:token/avatar/live-usage/:usageId")
  public liveAvatarUsage(@Param("token") token: string, @Param("usageId") usageId: string, @Body() body: LiveAvatarUsageDto) {
    return this.agent.reportLiveAvatarUsage(token, usageId, body);
  }

  @Public() @Throttle({ default: { limit: 20, ttl: 60000 } }) @Post("whatsapp/simulate")
  public simulateWhatsApp(@Body() body: SimulateWhatsAppMessageDto) {
    return this.agent.simulateWhatsApp(body);
  }

  @Public() @Get("whatsapp/settings")
  public whatsAppSettings() {
    return this.agent.publicWhatsAppSettings();
  }

  @Public() @Get("availability")
  public availability() {
    return this.agent.publicAvailability();
  }

  @Public() @Get("whatsapp/webhook")
  @Header("Content-Type", "text/plain")
  public verifyWhatsAppWebhook(@Query() query: Record<string, unknown>) {
    return this.agent.verifyWhatsAppWebhook(query as Record<string, unknown>);
  }

  @Public() @Post("whatsapp/webhook")
  public receiveWhatsAppWebhook(@Body() body: unknown, @Req() request: Request & { rawBody?: Buffer }, @Headers("x-hub-signature-256") signature?: string) {
    return this.agent.receiveWhatsAppWebhook(body, request.rawBody, signature);
  }
}
