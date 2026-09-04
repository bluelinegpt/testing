import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../authentication/authentication.decorators.js";
import { AgentService } from "./agent.service.js";
import { CreateAgentConversationDto, CreateLiveAvatarSessionDto, LiveAvatarUsageDto, SendAgentMessageDto, SimulateWhatsAppMessageDto } from "./agent.dto.js";

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
    return this.agent.createWebsiteConversation(body.language, body.visitorId, this.requestIp(request), body.surface);
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
    return this.agent.receiveWebsiteMessage(token, body.message, body.language, this.requestIp(request));
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
