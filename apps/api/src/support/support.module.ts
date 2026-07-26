import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { SupportController } from "./support.controller.js";
import { SupportService } from "./support.service.js";

@Module({
  imports: [AuthenticationModule],
  controllers: [SupportController],
  providers: [SupportService],
})
export class SupportModule {}
