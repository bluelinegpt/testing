import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { FilesModule } from "../files/files.module.js";
import { PushModule } from "../push/push.module.js";
import { CommunicationController } from "./communication.controller.js";
import { CommunicationRealtimeGateway } from "./communication-realtime.gateway.js";
import { CommunicationService } from "./communication.service.js";

@Module({
  imports: [AuthenticationModule, FilesModule, PushModule],
  controllers: [CommunicationController],
  providers: [CommunicationRealtimeGateway, CommunicationService],
  exports: [CommunicationRealtimeGateway, CommunicationService],
})
export class CommunicationModule {}
