import { Module } from "@nestjs/common";

import { NotificationPublisher } from "./notification-event.js";
import { NoopNotificationPublisher } from "./noop-notification-publisher.js";

/**
 * Prompt 3D Part I: the push-notification abstraction module. Exports the
 * `NotificationPublisher` TOKEN bound to the no-op implementation -- any
 * consumer (`StoreOrderModule` today) depends on the interface, never on
 * `NoopNotificationPublisher` directly, so this binding is the only place a
 * future real provider needs to change.
 */
@Module({
  exports: [NotificationPublisher],
  providers: [{ provide: NotificationPublisher, useClass: NoopNotificationPublisher }],
})
export class NotificationsModule {}
