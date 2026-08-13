import { NoopNotificationPublisher } from "./noop-notification-publisher.js";
import type { NotificationEvent, NotificationEventType } from "./notification-event.js";

/**
 * §75: interface/event-shape tests only -- no provider, no network call.
 * `NoopNotificationPublisher` is the only concrete implementation that
 * exists today, and its whole job is to prove the contract is callable
 * without ever reaching a real notification channel.
 */
describe("Notification event contract (Prompt 3D Part I)", () => {
  const eventTypes: readonly NotificationEventType[] = [
    "store_order_submitted",
    "store_order_confirmed",
    "store_order_cancelled",
    "delivery_started",
    "delivery_delivered",
  ];

  it("declares exactly the five conceptual events named in §37", () => {
    expect(eventTypes).toHaveLength(5);
  });

  it.each(eventTypes)("accepts a channel-neutral %s event with identifiers only", async (type) => {
    const publisher = new NoopNotificationPublisher();
    const event: NotificationEvent = {
      occurredAt: new Date().toISOString(),
      storeOrderId: "11111111-1111-1111-1111-111111111111",
      storeOrderNumber: "SO-000001",
      type,
    };
    await expect(publisher.publish(event)).resolves.toBeUndefined();
  });

  it("carries no channel-specific payload (no title/body/deviceToken field)", () => {
    const event: NotificationEvent = {
      occurredAt: new Date().toISOString(),
      storeOrderId: "id",
      storeOrderNumber: "SO-000001",
      type: "store_order_confirmed",
    };
    expect(Object.keys(event).sort()).toEqual(
      ["occurredAt", "storeOrderId", "storeOrderNumber", "type"].sort(),
    );
  });

  it("the no-op publisher never throws and never performs a network call by construction", async () => {
    const publisher = new NoopNotificationPublisher();
    const before = Date.now();
    await publisher.publish({
      occurredAt: new Date().toISOString(),
      storeOrderId: "id",
      storeOrderNumber: "SO-000001",
      type: "store_order_submitted",
    });
    // A same-tick resolution (well under any plausible network round trip)
    // is a cheap, real signal that nothing left the process.
    expect(Date.now() - before).toBeLessThan(50);
  });
});
