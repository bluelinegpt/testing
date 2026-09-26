import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { ApplicationException } from "../../presentation/errors/application.exception.js";
import {
  CompanyWhatsAppProvider,
  type CompanyWhatsAppConnectionStatus,
  type SendWhatsAppMessageInput,
  type WhatsAppConnectionResult,
  type WhatsAppGroup,
  type WhatsAppSendResult,
} from "../company-whatsapp-provider.port.js";
import { WhatsAppConnectionRuntime } from "./whatsapp-connection-runtime.service.js";

/**
 * The real `CompanyWhatsAppProvider` binding (replacing Prompt 1's
 * `UnimplementedCompanyWhatsAppProvider` in `WhatsAppModule`). A thin
 * adapter over `WhatsAppConnectionRuntime`: the port keeps its
 * provider-neutral contract for the rest of Tawseelhub (Prompt 4's outbox
 * dispatcher will depend on this), while the runtime owns every
 * Baileys-specific concern.
 *
 * Send failures are returned as the port's result union, classified
 * provider-neutrally — raw Baileys errors never cross this boundary.
 */
@Injectable()
export class BaileysCompanyWhatsAppProvider extends CompanyWhatsAppProvider {
  public constructor(
    @Inject(WhatsAppConnectionRuntime) private readonly runtime: WhatsAppConnectionRuntime,
  ) {
    super();
  }

  public async connect(companyId: string): Promise<WhatsAppConnectionResult> {
    const state = await this.runtime.connect(companyId, null, `whatsapp-provider:${randomUUID()}`);
    return {
      status: state.status,
      ...(state.qr === null ? {} : { qrCode: state.qr }),
    };
  }

  public async disconnect(companyId: string): Promise<void> {
    await this.runtime.disconnect(companyId, null, `whatsapp-provider:${randomUUID()}`);
  }

  public async getConnectionStatus(companyId: string): Promise<CompanyWhatsAppConnectionStatus> {
    return this.runtime.getLiveState(companyId)?.status ?? "not_connected";
  }

  public listGroups(companyId: string): Promise<readonly WhatsAppGroup[]> {
    return this.runtime.listGroups(companyId);
  }

  public async sendMessage(input: SendWhatsAppMessageInput): Promise<WhatsAppSendResult> {
    try {
      const result = await this.runtime.sendGroupMessage(
        input.companyId,
        input.providerGroupId,
        input.body,
      );
      return {
        outcome: "sent",
        providerMessageId: result.providerMessageId,
        sentAt: result.sentAt,
      };
    } catch (error) {
      if (error instanceof ApplicationException) {
        const retryable = ["whatsapp_not_connected", "whatsapp_provider_unavailable"];
        return retryable.includes(error.errorCode)
          ? { failureCode: error.errorCode, outcome: "transient_failure" }
          : { failureCode: error.errorCode, outcome: "permanent_failure" };
      }
      return { failureCode: "whatsapp_send_rejected", outcome: "permanent_failure" };
    }
  }
}
