import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { CompanyWhatsAppProvider } from "./company-whatsapp-provider.port.js";
import { BaileysCompanyWhatsAppProvider } from "./providers/baileys-company-whatsapp.provider.js";
import { BaileysSessionStore } from "./providers/baileys-session-store.js";
import { BaileysSocketFactory, RealBaileysSocketFactory } from "./providers/baileys-client.js";
import { WhatsAppConnectionRuntime } from "./providers/whatsapp-connection-runtime.service.js";
import { TraderWhatsAppSettingsService } from "./trader-whatsapp-settings.service.js";
import { WhatsAppConnectionService } from "./whatsapp-connection.service.js";
import { WhatsAppController } from "./whatsapp.controller.js";
import { WhatsAppNotificationHistoryService } from "./whatsapp-notification-history.service.js";
import { WhatsAppOutboxWriter } from "./whatsapp-outbox-writer.service.js";
import { WhatsAppTestMessageService } from "./whatsapp-test-message.service.js";
import { WhatsAppSessionCipher } from "./whatsapp-session-cipher.js";

// The real Baileys provider (Prompt 2) is bound here — the
// `PushProvider`/`PushModule` pattern. Everything outside this module still
// depends only on the `CompanyWhatsAppProvider` port; `BaileysSocketFactory`
// is the inner seam tests replace with a fake socket.
@Module({
  imports: [AuthenticationModule],
  controllers: [WhatsAppController],
  providers: [
    TraderWhatsAppSettingsService,
    WhatsAppConnectionService,
    WhatsAppNotificationHistoryService,
    WhatsAppOutboxWriter,
    WhatsAppTestMessageService,
    WhatsAppSessionCipher,
    BaileysSessionStore,
    WhatsAppConnectionRuntime,
    { provide: BaileysSocketFactory, useClass: RealBaileysSocketFactory },
    { provide: CompanyWhatsAppProvider, useClass: BaileysCompanyWhatsAppProvider },
  ],
  // `WhatsAppOutboxWriter` is the only surface business modules will ever
  // import (Prompt 4's order-status hook) — they produce durable outbox rows
  // and never see the provider, mirroring `PushOutboxWriter`.
  exports: [WhatsAppOutboxWriter],
})
export class WhatsAppModule {}
