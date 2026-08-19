import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../authentication/authentication.decorators.js";
import { AgentService } from "./agent.service.js";
import { CreateAgentConversationDto, SendAgentMessageDto, SimulateWhatsAppMessageDto } from "./agent.dto.js";

@Controller("public/agent")
export class PublicAgentController {
  public constructor(@Inject(AgentService) private readonly agent: AgentService) {}

  @Public() @Throttle({ default: { limit: 8, ttl: 60000 } }) @HttpCode(201) @Post("conversations")
  public create(@Body() body: CreateAgentConversationDto) {
    return this.agent.createWebsiteConversation(body.language, body.visitorId);
  }

  @Public() @Throttle({ default: { limit: 30, ttl: 60000 } }) @Get("conversations/:token")
  public get(@Param("token") token: string) {
    return this.agent.websiteConversation(token);
  }

  @Public() @Throttle({ default: { limit: 18, ttl: 60000 } }) @Post("conversations/:token/messages")
  public message(@Param("token") token: string, @Body() body: SendAgentMessageDto) {
    return this.agent.receiveWebsiteMessage(token, body.message, body.language);
  }

  @Public() @Throttle({ default: { limit: 20, ttl: 60000 } }) @Post("whatsapp/simulate")
  public simulateWhatsApp(@Body() body: SimulateWhatsAppMessageDto) {
    return this.agent.simulateWhatsApp(body);
  }

  @Public() @Get("whatsapp/settings")
  public whatsAppSettings() {
    return this.agent.publicWhatsAppSettings();
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
