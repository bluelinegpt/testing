import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { type ClaimedNotification, PushEventRepository } from "./push-event.repository.js";
import { PushProvider } from "./push-provider.port.js";

/**
 * Drains `notification_outbox_events` and delivers via `PushProvider` —
 * mirrors `AccountingEventProcessor` (`../accounting/accounting-event.processor.ts`)
 * exactly: `OnModuleInit`/`OnModuleDestroy`, a self-unref'd `setInterval`,
 * `recoverStaleLocks()` on boot, `for update skip locked` claiming so
 * multiple API instances can run this safely without a separate queue.
 *
 * Payloads sent to the provider carry only `titleKey`/`bodyKey`/`bodyParams`/
 * `targetType`/`targetId` — the mobile client localizes and renders; nothing
 * privacy-sensitive (Section P) is ever in `data`.
 */
@Injectable()
export class PushDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushDispatcher.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;

  public constructor(
    @Inject(PushEventRepository) private readonly events: PushEventRepository,
    @Inject(PushProvider) private readonly provider: PushProvider,
  ) {}

  public onModuleInit(): void {
    void this.events
      .recoverStaleLocks()
      .then(() => this.drain())
      .catch(() => undefined);
    this.timer = setInterval(() => {
      void this.drain().catch(() => undefined);
    }, 5_000);
    this.timer.unref();
  }

  public onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  public async drain(limit = 25): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let processed = 0;
    try {
      while (processed < limit) {
        const event = await this.events.next();
        if (event === undefined) break;
        await this.deliver(event);
        processed += 1;
      }
      return processed;
    } finally {
      this.draining = false;
    }
  }

  private async deliver(event: ClaimedNotification): Promise<void> {
    const device = await this.events.resolveEligibleDevice(event.companyId, event.recipientAccountId);
    if (device === "recipient_ineligible" || device === "no_active_device") {
      await this.events.markSkipped(event.id, device);
      return;
    }
    const result = await this.provider.send({
      token: device.token,
      title: event.titleKey,
      body: event.bodyKey ?? undefined,
      data: {
        notificationId: event.id,
        notificationType: event.notificationType,
        targetType: event.targetType,
        titleKey: event.titleKey,
        ...(event.targetId === null ? {} : { targetId: event.targetId }),
        ...(event.bodyKey === null ? {} : { bodyKey: event.bodyKey }),
        ...Object.fromEntries(
          Object.entries(event.bodyParams).map(([key, value]) => [key, String(value)]),
        ),
      },
    });
    // Never log the raw token — only a masked tail, useful for correlating
    // "which install" without being able to impersonate it from the logs.
    const maskedToken = `…${device.token.slice(-6)}`;
    if (result.outcome === "sent") {
      await this.events.markSent(event.id);
      this.logger.log(
        `push_sent notification=${event.id} type=${event.notificationType} token=${maskedToken}`,
      );
      return;
    }
    if (result.outcome === "invalid_token") {
      await this.events.recordInvalidToken(
        event.id,
        event.companyId,
        event.recipientAccountId,
        device.token,
      );
      this.logger.warn(`push_invalid_token notification=${event.id} token=${maskedToken}`);
      return;
    }
    await this.events.recordFailure(event.id, event.attempts, result);
    this.logger.warn(
      `push_${result.outcome} notification=${event.id} attempt=${event.attempts} reason=${result.reason}`,
    );
  }
}
