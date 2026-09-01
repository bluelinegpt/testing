import { afterEach, describe, expect, it } from "vitest";

import type { Kysely } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { CompanyWhatsAppProvider } from "./company-whatsapp-provider.port.js";
import { WhatsAppOutboxDispatcher } from "./whatsapp-outbox-dispatcher.service.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalRuntimeEnabled = process.env.WHATSAPP_RUNTIME_ENABLED;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalRuntimeEnabled === undefined) {
    delete process.env.WHATSAPP_RUNTIME_ENABLED;
  } else {
    process.env.WHATSAPP_RUNTIME_ENABLED = originalRuntimeEnabled;
  }
});

function buildDispatcher(): WhatsAppOutboxDispatcher {
  // No DB/provider calls happen in init/destroy — inert stand-ins suffice.
  return new WhatsAppOutboxDispatcher(
    undefined as unknown as Kysely<DatabaseSchema>,
    undefined as unknown as CompanyWhatsAppProvider,
  );
}

describe("WhatsApp dispatcher kill switch", () => {
  it("never starts when WHATSAPP_RUNTIME_ENABLED=false (the single-owner guard)", () => {
    process.env.NODE_ENV = "development";
    process.env.WHATSAPP_RUNTIME_ENABLED = "false";
    const dispatcher = buildDispatcher();
    dispatcher.onModuleInit();
    expect(dispatcher.healthSnapshot().running).toBe(false);
  });

  it("starts by default and stops claiming on graceful shutdown", () => {
    process.env.NODE_ENV = "development";
    delete process.env.WHATSAPP_RUNTIME_ENABLED;
    const dispatcher = buildDispatcher();
    dispatcher.onModuleInit();
    expect(dispatcher.healthSnapshot().running).toBe(true);
    dispatcher.onModuleDestroy();
    expect(dispatcher.healthSnapshot().running).toBe(false);
  });

  it("never starts under NODE_ENV=test regardless of the guard", () => {
    process.env.NODE_ENV = "test";
    delete process.env.WHATSAPP_RUNTIME_ENABLED;
    const dispatcher = buildDispatcher();
    dispatcher.onModuleInit();
    expect(dispatcher.healthSnapshot().running).toBe(false);
  });
});
