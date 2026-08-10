/**
 * The push-delivery abstraction, mirroring `FileStoragePort`
 * (`../files/file-storage.port.ts`): an abstract class bound to a concrete
 * adapter via a one-line `useClass` in `PushModule`. Nothing that depends on
 * `PushProvider` needs to know whether delivery goes through Firebase, a fake
 * test double, or (later) a second provider for a platform Firebase doesn't
 * cover.
 *
 * `PushDispatcher` is the only caller. Order/Communication business services
 * never see this port — they only ever write a durable
 * `notification_outbox_events` row (Section I: "Do not send push
 * synchronously from Order or Communication business transactions").
 */
export interface PushMessage {
  readonly token: string;
  readonly title: string;
  readonly body: string | undefined;
  /** String-only, matching FCM's own data-payload constraint. Minimal by
   *  design — see Section P: no addresses, no COD, no tokens, no secrets. */
  readonly data: Readonly<Record<string, string>>;
}

export type PushSendResult =
  | { readonly outcome: "sent" }
  /** Firebase explicitly reported the token unregistered/invalid — the
   *  registration must be revoked and this delivery must never be retried. */
  | { readonly outcome: "invalid_token" }
  /** Timeout, rate limit, transient provider/network failure — safe to retry
   *  with backoff. */
  | { readonly outcome: "transient_failure"; readonly reason: string }
  /** Anything else Firebase rejects outright (malformed payload, disabled
   *  project, etc.) — retrying will not help. */
  | { readonly outcome: "permanent_failure"; readonly reason: string };

export abstract class PushProvider {
  public abstract send(message: PushMessage): Promise<PushSendResult>;
}
