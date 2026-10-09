import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { AnnouncementsController } from "./announcements.controller.js";
import { AnnouncementsService } from "./announcements.service.js";

/**
 * Platform announcements: the Company-facing banner feed. The Platform's own
 * editing routes live in PlatformModule (PlatformAnnouncementController),
 * which re-provides AnnouncementsService -- a leaf service (database only) --
 * rather than importing this module, the pattern used elsewhere here.
 */
@Module({
  controllers: [AnnouncementsController],
  exports: [AnnouncementsService],
  imports: [AuthenticationModule],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule {}
