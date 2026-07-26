import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { RoleController } from "./role.controller.js";
import { RoleService } from "./role.service.js";

@Module({
  controllers: [RoleController],
  imports: [AuthenticationModule],
  providers: [RoleService],
})
export class RoleModule {}
