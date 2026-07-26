import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { UserAdministrationController } from "./user-administration.controller.js";
import { UserAdministrationService } from "./user-administration.service.js";

@Module({
  controllers: [UserAdministrationController],
  imports: [AuthenticationModule],
  providers: [UserAdministrationService],
})
export class UserAdministrationModule {}
