import { Injectable, Logger } from "@nestjs/common";

import { NotificationPublisher, type NotificationEvent } from "./notification-event.js";

/**
 * The only concrete `NotificationPublisher` registered today (§38): it sends
 * nothing anywhere. Kept as a real, injectable class -- not a stub deleted
 * later -- so `StoreOrderModule` already depends on the ABSTRACTION
 * (`NotificationPublisher`), and swapping in a real provider later is a
 * one-line change to this module's `providers` array, not a Store Order
 * domain change.
 */
@Injectable()
export class NoopNotificationPublisher extends NotificationPublisher {
  private readonly logger = new Logger(NoopNotificationPublisher.name);

  public async publish(event: NotificationEvent): Promise<void> {
    this.logger.debug(
      `notification event (no-op, not sent): ${event.type} for ${event.storeOrderNumber}`,
    );
    await Promise.resolve();
  }
}
