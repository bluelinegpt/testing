import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  AnnouncementsService,
  type PlatformAnnouncement,
} from "../announcements/announcements.service.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { correlationIdOf } from "./platform-audit.service.js";
import {
  PLATFORM_ANNOUNCEMENTS_MANAGE,
  PLATFORM_ANNOUNCEMENTS_READ,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
// Runtime DTO import is required so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SavePlatformAnnouncementDto } from "./platform-announcement.dto.js";

/**
 * Platform Administration -> Announcements: banners shown to all Companies or
 * to chosen ones, on the office web app, the Trader portal and/or the mobile
 * app, between "show from" and "show until". Platform-wide, so no target
 * Company guard: the targets are part of the announcement itself.
 */
@ApiTags("platform announcements")
@ApiBearerAuth()
@Controller("platform/announcements")
export class PlatformAnnouncementController {
  public constructor(
    @Inject(AnnouncementsService) private readonly announcements: AnnouncementsService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  private actor(request: Request) {
    return {
      accountId: this.identities.current().identityId,
      correlationId: correlationIdOf(request),
    };
  }

  @RequirePlatformPermissions(PLATFORM_ANNOUNCEMENTS_READ)
  @ApiOperation({ summary: "List Platform announcements with their current status" })
  @Get()
  public list(): Promise<PlatformAnnouncement[]> {
    return this.announcements.list();
  }

  @RequirePlatformPermissions(PLATFORM_ANNOUNCEMENTS_READ)
  @ApiOperation({ summary: "Show one Platform announcement" })
  @Get(":id")
  public detail(@Param("id", ParseUUIDPipe) id: string): Promise<PlatformAnnouncement> {
    return this.announcements.get(id);
  }

  @RequirePlatformPermissions(PLATFORM_ANNOUNCEMENTS_MANAGE)
  @ApiOperation({ summary: "Create a Platform announcement" })
  @Post()
  public create(
    @Body() input: SavePlatformAnnouncementDto,
    @Req() request: Request,
  ): Promise<PlatformAnnouncement> {
    return this.announcements.create(input, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_ANNOUNCEMENTS_MANAGE)
  @ApiOperation({ summary: "Edit a Platform announcement (users see it again)" })
  @Put(":id")
  public update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: SavePlatformAnnouncementDto,
    @Req() request: Request,
  ): Promise<PlatformAnnouncement> {
    return this.announcements.update(id, input, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_ANNOUNCEMENTS_MANAGE)
  @ApiOperation({ summary: "Stop showing a Platform announcement now" })
  @Post(":id/end-now")
  @HttpCode(200)
  public endNow(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: Request,
  ): Promise<PlatformAnnouncement> {
    return this.announcements.endNow(id, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_ANNOUNCEMENTS_MANAGE)
  @ApiOperation({ summary: "Cancel a Platform announcement (it is kept for the record)" })
  @Post(":id/cancel")
  @HttpCode(200)
  public cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: Request,
  ): Promise<PlatformAnnouncement> {
    return this.announcements.cancel(id, this.actor(request));
  }
}
