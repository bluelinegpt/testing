import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { UserAdministrationController } from "./user-administration.controller.js";
import { UserAdministrationService } from "./user-administration.service.js";
import { BusinessSystemAccessController, LegacyBusinessLinkController } from "./user-business-access.controller.js";
import { UserBusinessAccessService } from "./user-business-access.service.js";

@Module({
  controllers: [UserAdministrationController, BusinessSystemAccessController, LegacyBusinessLinkController],
  imports: [AuthenticationModule],
  providers: [UserAdministrationService, UserBusinessAccessService],
})
export class UserAdministrationModule {}
