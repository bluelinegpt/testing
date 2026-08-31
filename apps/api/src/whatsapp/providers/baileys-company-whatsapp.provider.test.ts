import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { ApplicationException } from "../../presentation/errors/application.exception.js";
import { BaileysCompanyWhatsAppProvider } from "./baileys-company-whatsapp.provider.js";
import type { WhatsAppConnectionRuntime } from "./whatsapp-connection-runtime.service.js";

function providerWith(runtime: Partial<WhatsAppConnectionRuntime>): BaileysCompanyWhatsAppProvider {
  return new BaileysCompanyWhatsAppProvider(runtime as WhatsAppConnectionRuntime);
}

describe("BaileysCompanyWhatsAppProvider result normalization", () => {
  it("normalizes an accepted send into the port's sent result", async () => {
    const sentAt = new Date("2026-08-31T18:00:00Z");
    const provider = providerWith({
      sendGroupMessage: async () => ({ providerMessageId: "3EB0ABC123", sentAt }),
    });
    const result = await provider.sendMessage({
      body: "hello",
      companyId: "c-1",
      providerGroupId: "123@g.us",
    });
    expect(result).toEqual({ outcome: "sent", providerMessageId: "3EB0ABC123", sentAt });
  });

  it("classifies not-connected as a transient failure, never an exception", async () => {
    const provider = providerWith({
      sendGroupMessage: async () => {
        throw new ApplicationException(
          "whatsapp_not_connected",
          "WhatsApp is not connected",
          HttpStatus.CONFLICT,
        );
      },
    });
    const result = await provider.sendMessage({
      body: "x",
      companyId: "c-1",
      providerGroupId: "123@g.us",
    });
    expect(result).toEqual({ failureCode: "whatsapp_not_connected", outcome: "transient_failure" });
  });

  it("classifies an unknown group as a permanent failure", async () => {
    const provider = providerWith({
      sendGroupMessage: async () => {
        throw new ApplicationException(
          "whatsapp_group_not_found",
          "Unknown group",
          HttpStatus.NOT_FOUND,
        );
      },
    });
    const result = await provider.sendMessage({
      body: "x",
      companyId: "c-1",
      providerGroupId: "nope",
    });
    expect(result).toEqual({
      failureCode: "whatsapp_group_not_found",
      outcome: "permanent_failure",
    });
  });

  it("sanitizes raw provider exceptions into a neutral failure code", async () => {
    const provider = providerWith({
      sendGroupMessage: async () => {
        throw new Error("raw baileys stream error with internal payload details");
      },
    });
    const result = await provider.sendMessage({
      body: "x",
      companyId: "c-1",
      providerGroupId: "123@g.us",
    });
    expect(result).toEqual({ failureCode: "whatsapp_send_rejected", outcome: "permanent_failure" });
  });

  it("reports not_connected status when no runtime exists for the Company", async () => {
    const provider = providerWith({ getLiveState: () => undefined });
    expect(await provider.getConnectionStatus("c-1")).toBe("not_connected");
  });
});
