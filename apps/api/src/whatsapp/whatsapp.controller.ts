import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { TraderWhatsAppSettingsService } from "./trader-whatsapp-settings.service.js";
import { WhatsAppConnectionService } from "./whatsapp-connection.service.js";
import { WhatsAppNotificationHistoryService } from "./whatsapp-notification-history.service.js";
import type {
  CompanyWhatsAppConnectionView,
  TraderWhatsAppSettingsView,
  WhatsAppNotificationView,
} from "./whatsapp.dto.js";
// NOT `import type`: the DTO class must exist at runtime for ValidationPipe's
// decorator metadata — a type-only import silently breaks body validation.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UpdateTraderWhatsAppSettingsDto } from "./whatsapp.dto.js";

/**
 * Company-scoped WhatsApp configuration and history. Prompt 1 exposes only
 * what already truthfully exists: connection status (read), Trader group
 * mapping configuration, and outbox history reads. There is deliberately NO
 * group-discovery route and NO connect/QR route yet — the real provider does
 * not exist until Prompt 2, and this module never serves fabricated group or
 * connectivity data.
 *
 * Access follows the standard configuration discipline: a dedicated
 * permission per capability with the `users_roles.manage` administrator
 * fallback — Company membership alone grants nothing.
 */
@ApiTags("whatsapp")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("whatsapp")
export class WhatsAppController {
  public constructor(
    @Inject(WhatsAppConnectionService) private readonly connections: WhatsAppConnectionService,
    @Inject(TraderWhatsAppSettingsService)
    private readonly settings: TraderWhatsAppSettingsService,
    @Inject(WhatsAppNotificationHistoryService)
    private readonly history: WhatsAppNotificationHistoryService,
  ) {}

  @ApiOperation({ summary: "Read this Company's WhatsApp connection status" })
  @RequireAnyPermission("whatsapp.connection.manage", "users_roles.manage")
  @Get("connection")
  public connection(): Promise<CompanyWhatsAppConnectionView> {
    return this.connections.getConnection();
  }

  @ApiOperation({ summary: "Read one Trader's WhatsApp notification settings" })
  @RequireAnyPermission("whatsapp.trader_settings.manage", "users_roles.manage")
  @Get("traders/:traderId/settings")
  public traderSettings(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
  ): Promise<TraderWhatsAppSettingsView> {
    return this.settings.getForTrader(traderId);
  }

  @ApiOperation({ summary: "Create or update one Trader's WhatsApp notification settings" })
  @RequireAnyPermission("whatsapp.trader_settings.manage", "users_roles.manage")
  @Put("traders/:traderId/settings")
  public updateTraderSettings(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Body() input: UpdateTraderWhatsAppSettingsDto,
    @Req() request: Request,
  ): Promise<TraderWhatsAppSettingsView> {
    return this.settings.update(traderId, input, this.correlationId(request));
  }

  @ApiOperation({ summary: "Remove one Trader's WhatsApp group mapping and disable notifications" })
  @RequireAnyPermission("whatsapp.trader_settings.manage", "users_roles.manage")
  @Delete("traders/:traderId/settings/group")
  public removeTraderGroupMapping(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Req() request: Request,
  ): Promise<TraderWhatsAppSettingsView> {
    return this.settings.removeGroupMapping(traderId, this.correlationId(request));
  }

  @ApiOperation({ summary: "List WhatsApp notification history for one Order" })
  @RequireAnyPermission("whatsapp.history.view", "users_roles.manage")
  @Get("orders/:orderId/notifications")
  public orderNotifications(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
  ): Promise<readonly WhatsAppNotificationView[]> {
    return this.history.listForOrder(orderId);
  }

  @ApiOperation({ summary: "List WhatsApp notification history for one Trader" })
  @RequireAnyPermission("whatsapp.history.view", "users_roles.manage")
  @Get("traders/:traderId/notifications")
  public traderNotifications(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
  ): Promise<readonly WhatsAppNotificationView[]> {
    return this.history.listForTrader(traderId);
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
