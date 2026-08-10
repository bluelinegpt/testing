import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { DeviceRegistrationService } from "./device-registration.service.js";
import { NotificationInboxService } from "./notification-inbox.service.js";
import { DeregisterDeviceDto, ListNotificationsDto, RegisterDeviceDto } from "./push.dto.js";

/**
 * Every route here is restricted to the identity kinds that actually run the
 * mobile app — `company_user` (Operator), `trader`, `driver`. There is no
 * `customer` identity kind at all (Customers authenticate through a separate
 * tracking-token session, not an `accounts` row) and `platform_administrator`
 * has no Company context, so device registration is meaningless for it —
 * Section N's explicit instruction not to fabricate Customer mobile push.
 */
@ApiTags("push")
@ApiBearerAuth()
@RequireIdentityKinds("company_user", "trader", "driver")
@Controller("push")
export class PushController {
  public constructor(
    @Inject(DeviceRegistrationService) private readonly registrations: DeviceRegistrationService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  @ApiOperation({ summary: "Register (or idempotently refresh) this install's push token" })
  @Post("device-registrations")
  public register(@Body() input: RegisterDeviceDto) {
    return this.registrations.register(input.platform, input.token, input.appVersion);
  }

  @ApiOperation({ summary: "Revoke this install's push registration" })
  @HttpCode(204)
  @Post("device-registrations/deregister")
  public async deregister(@Body() input: DeregisterDeviceDto): Promise<void> {
    await this.registrations.deregister(input.token, "client_deregistered");
  }

  @ApiOperation({ summary: "List the authenticated account's Notification Inbox, newest first" })
  @Get("notifications")
  public list(@Query() query: ListNotificationsDto) {
    return this.inbox.page(query.cursor);
  }

  @ApiOperation({ summary: "Mark one Notification Inbox entry as read" })
  @HttpCode(204)
  @Post("notifications/:id/read")
  public async markRead(@Param("id", new ParseUUIDPipe()) id: string): Promise<void> {
    await this.inbox.markRead(id);
  }

  @ApiOperation({ summary: "Mark every unread Notification Inbox entry as read" })
  @HttpCode(204)
  @Post("notifications/read-all")
  public async markAllRead(): Promise<void> {
    await this.inbox.markAllRead();
  }
}
