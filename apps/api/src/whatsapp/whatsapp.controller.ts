import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
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
import { WhatsAppMessageOperationsService } from "./whatsapp-message-operations.service.js";
import { WhatsAppNotificationHistoryService } from "./whatsapp-notification-history.service.js";
import {
  WhatsAppOutboxDispatcher,
  type DispatcherHealthSnapshot,
} from "./whatsapp-outbox-dispatcher.service.js";
import { WhatsAppTestMessageService } from "./whatsapp-test-message.service.js";
import type {
  CompanyWhatsAppConnectionView,
  TraderGroupHealthView,
  TraderWhatsAppSettingsView,
  WhatsAppGroupView,
  WhatsAppMessageDetailView,
  WhatsAppMessagePage,
  WhatsAppMessageSummaryView,
  WhatsAppNotificationView,
  WhatsAppTestMessageResult,
} from "./whatsapp.dto.js";
// NOT `import type`: the DTO classes must exist at runtime for ValidationPipe's
// decorator metadata — a type-only import silently breaks body validation.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ListWhatsAppMessagesDto,
  ResolveWhatsAppMessageDto,
  RetryWhatsAppMessageDto,
  SendTestMessageDto,
  UpdateTraderWhatsAppSettingsDto,
} from "./whatsapp.dto.js";

/**
 * Company-scoped WhatsApp configuration, connectivity and history: the
 * connect/disconnect/reconnect lifecycle with QR pairing (the QR rides on
 * `GET connection` while pairing — the frontend polls that one endpoint),
 * live group discovery from the connected account, Trader group-mapping
 * configuration, and outbox history reads.
 *
 * Access follows the standard configuration discipline: a dedicated
 * permission per capability with the `users_roles.manage` administrator
 * fallback — Company membership alone grants nothing. Session/auth material
 * never appears in any response; the QR payload is the only pairing artifact
 * the frontend ever receives.
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
    @Inject(WhatsAppTestMessageService)
    private readonly testMessages: WhatsAppTestMessageService,
    @Inject(WhatsAppMessageOperationsService)
    private readonly messageOperations: WhatsAppMessageOperationsService,
    @Inject(WhatsAppOutboxDispatcher)
    private readonly dispatcher: WhatsAppOutboxDispatcher,
  ) {}

  @ApiOperation({
    summary:
      "Read this Company's WhatsApp connection status (includes the current QR while pairing)",
  })
  // Read-only status is also visible to Trader-settings managers: the Trader
  // WhatsApp section must honestly show "not connected" before offering a
  // test message. Mutations below stay connection-manage only.
  @RequireAnyPermission(
    "whatsapp.connection.manage",
    "whatsapp.trader_settings.manage",
    "users_roles.manage",
  )
  @Get("connection")
  public connection(): Promise<CompanyWhatsAppConnectionView> {
    return this.connections.getConnection();
  }

  @ApiOperation({ summary: "Start this Company's WhatsApp connection (QR pairing when required)" })
  @RequireAnyPermission("whatsapp.connection.manage", "users_roles.manage")
  @Post("connection/connect")
  public connect(@Req() request: Request): Promise<CompanyWhatsAppConnectionView> {
    return this.connections.connect(this.correlationId(request));
  }

  @ApiOperation({
    summary:
      "Disconnect this Company's WhatsApp (logs out the linked device; Trader mappings and history are kept)",
  })
  @RequireAnyPermission("whatsapp.connection.manage", "users_roles.manage")
  @Post("connection/disconnect")
  public disconnect(@Req() request: Request): Promise<CompanyWhatsAppConnectionView> {
    return this.connections.disconnect(this.correlationId(request));
  }

  @ApiOperation({
    summary: "Reconnect this Company's WhatsApp, reusing stored credentials when still valid",
  })
  @RequireAnyPermission("whatsapp.connection.manage", "users_roles.manage")
  @Post("connection/reconnect")
  public reconnect(@Req() request: Request): Promise<CompanyWhatsAppConnectionView> {
    return this.connections.reconnect(this.correlationId(request));
  }

  @ApiOperation({ summary: "List WhatsApp groups available to this Company's connected account" })
  @RequireAnyPermission(
    "whatsapp.trader_settings.manage",
    "whatsapp.connection.manage",
    "users_roles.manage",
  )
  @Get("groups")
  public groups(): Promise<readonly WhatsAppGroupView[]> {
    return this.connections.listGroups();
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

  @ApiOperation({
    summary: "Send one explicit test message to the Trader's configured WhatsApp group",
  })
  @RequireAnyPermission("whatsapp.trader_settings.manage", "users_roles.manage")
  @Post("traders/:traderId/test-message")
  public sendTestMessage(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Body() input: SendTestMessageDto,
    @Req() request: Request,
  ): Promise<WhatsAppTestMessageResult> {
    return this.testMessages.send(traderId, this.correlationId(request), input.clientRequestId);
  }

  @ApiOperation({ summary: "Company-level WhatsApp message pipeline counts" })
  @RequireAnyPermission("whatsapp.connection.manage", "whatsapp.history.view", "users_roles.manage")
  @Get("messages/summary")
  public messageSummary(): Promise<WhatsAppMessageSummaryView> {
    return this.history.summary();
  }

  @ApiOperation({ summary: "Filterable, paginated Company WhatsApp message operations table" })
  @RequireAnyPermission("whatsapp.history.view", "whatsapp.connection.manage", "users_roles.manage")
  @Get("messages")
  public listMessages(@Query() filters: ListWhatsAppMessagesDto): Promise<WhatsAppMessagePage> {
    return this.messageOperations.list(filters);
  }

  @ApiOperation({ summary: "One WhatsApp message with its full attempt history" })
  @RequireAnyPermission("whatsapp.history.view", "whatsapp.connection.manage", "users_roles.manage")
  @Get("messages/:messageId")
  public messageDetail(
    @Param("messageId", new ParseUUIDPipe()) messageId: string,
  ): Promise<WhatsAppMessageDetailView> {
    return this.messageOperations.detail(messageId);
  }

  @ApiOperation({
    summary:
      "Retry a failed message; requires an explicit duplicate-risk confirmation for requires_review",
  })
  @RequireAnyPermission("whatsapp.messages.manage", "users_roles.manage")
  @Post("messages/:messageId/retry")
  public retryMessage(
    @Param("messageId", new ParseUUIDPipe()) messageId: string,
    @Body() input: RetryWhatsAppMessageDto,
    @Req() request: Request,
  ): Promise<WhatsAppMessageDetailView> {
    return this.messageOperations.retry(
      messageId,
      input.confirmDuplicateRisk === true,
      this.correlationId(request),
    );
  }

  @ApiOperation({ summary: "Resolve (no resend) or cancel a stuck WhatsApp message" })
  @RequireAnyPermission("whatsapp.messages.manage", "users_roles.manage")
  @Post("messages/:messageId/resolve")
  public resolveMessage(
    @Param("messageId", new ParseUUIDPipe()) messageId: string,
    @Body() input: ResolveWhatsAppMessageDto,
    @Req() request: Request,
  ): Promise<WhatsAppMessageDetailView> {
    return this.messageOperations.resolve(messageId, input.action, this.correlationId(request));
  }

  @ApiOperation({ summary: "Configured Trader group mappings vs live discoverability" })
  @RequireAnyPermission(
    "whatsapp.trader_settings.manage",
    "whatsapp.connection.manage",
    "users_roles.manage",
  )
  @Get("trader-groups/health")
  public traderGroupHealth(): Promise<TraderGroupHealthView> {
    return this.connections.traderGroupHealth();
  }

  @ApiOperation({ summary: "Process-local WhatsApp dispatcher health snapshot" })
  @RequireAnyPermission("whatsapp.connection.manage", "users_roles.manage")
  @Get("dispatcher/health")
  public dispatcherHealth(): DispatcherHealthSnapshot {
    return this.dispatcher.healthSnapshot();
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
