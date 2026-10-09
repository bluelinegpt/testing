import { Controller, Get, HttpStatus, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { type AnnouncementSurface, surfaceAllowedFor } from "./announcements.js";
import { type ActiveAnnouncement, AnnouncementsService } from "./announcements.service.js";

/**
 * The banner feed for the Company apps. Any signed-in office user, Trader or
 * Driver may read it -- no permission beyond being signed in, because a
 * maintenance notice is for everyone in the Company. The Company is the
 * caller's own; the surface is checked against what that account type can
 * ever see, so a Trader cannot read an office-only announcement.
 */
@ApiTags("announcements")
@ApiBearerAuth()
@RequireIdentityKinds("company_user", "trader", "driver")
@Controller("announcements")
export class AnnouncementsController {
  public constructor(
    @Inject(AnnouncementsService) private readonly announcements: AnnouncementsService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  @ApiOperation({ summary: "Live Platform announcements for the caller's Company and screen" })
  @Get("active")
  public active(@Query("surface") surface?: string): Promise<ActiveAnnouncement[]> {
    const identity = this.identities.current();
    if (surface === undefined || !surfaceAllowedFor(identity.kind, surface)) {
      throw new ApplicationException(
        "announcement_surface_denied",
        "This account cannot read announcements for that screen",
        HttpStatus.FORBIDDEN,
      );
    }
    if (identity.companyId === null) return Promise.resolve([]);
    return this.announcements.active(identity.companyId, surface as AnnouncementSurface);
  }
}
