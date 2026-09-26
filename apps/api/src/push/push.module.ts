import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { DeviceRegistrationService } from "./device-registration.service.js";
import { FirebasePushProvider } from "./firebase-push.provider.js";
import { NotificationInboxService } from "./notification-inbox.service.js";
import { PushController } from "./push.controller.js";
import { PushDispatcher } from "./push-dispatcher.service.js";
import { PushEventRepository } from "./push-event.repository.js";
import { PushOutboxWriter } from "./push-outbox-writer.service.js";
import { PushProvider } from "./push-provider.port.js";

// Swapping in a second/alternate provider later (or a Fake for a given
// environment) is the one line below — exactly the `FileStoragePort`/
// `FilesModule` pattern (`../files/files.module.ts`).
@Module({
  imports: [AuthenticationModule],
  controllers: [PushController],
  providers: [
    DeviceRegistrationService,
    NotificationInboxService,
    PushOutboxWriter,
    PushEventRepository,
    PushDispatcher,
    { provide: PushProvider, useClass: FirebasePushProvider },
  ],
  // `PushOutboxWriter` is what Communication/Operations import — it is the
  // entire surface those business modules ever touch (Section I: they never
  // see `PushProvider`, only produce durable events).
  exports: [PushOutboxWriter],
})
export class PushModule {}
