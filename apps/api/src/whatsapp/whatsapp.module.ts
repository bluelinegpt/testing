import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import {
  CompanyWhatsAppProvider,
  UnimplementedCompanyWhatsAppProvider,
} from "./company-whatsapp-provider.port.js";
import { TraderWhatsAppSettingsService } from "./trader-whatsapp-settings.service.js";
import { WhatsAppConnectionService } from "./whatsapp-connection.service.js";
import { WhatsAppController } from "./whatsapp.controller.js";
import { WhatsAppNotificationHistoryService } from "./whatsapp-notification-history.service.js";
import { WhatsAppOutboxWriter } from "./whatsapp-outbox-writer.service.js";
import { WhatsAppSessionCipher } from "./whatsapp-session-cipher.js";

// Prompt 2 replaces `UnimplementedCompanyWhatsAppProvider` with the real
// per-Company provider on this one line — the `PushProvider`/`PushModule`
// pattern. Everything else in the application depends only on the port.
@Module({
  imports: [AuthenticationModule],
  controllers: [WhatsAppController],
  providers: [
    TraderWhatsAppSettingsService,
    WhatsAppConnectionService,
    WhatsAppNotificationHistoryService,
    WhatsAppOutboxWriter,
    WhatsAppSessionCipher,
    { provide: CompanyWhatsAppProvider, useClass: UnimplementedCompanyWhatsAppProvider },
  ],
  // `WhatsAppOutboxWriter` is the only surface business modules will ever
  // import (Prompt 4's order-status hook) — they produce durable outbox rows
  // and never see the provider, mirroring `PushOutboxWriter`.
  exports: [WhatsAppOutboxWriter],
})
export class WhatsAppModule {}
