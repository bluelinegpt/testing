import { type PushMessage, PushProvider, type PushSendResult } from "./push-provider.port.js";

/**
 * Test double for `PushProvider`. Constructed directly by tests (mirroring
 * how `communication.database-test-helpers.ts` constructs a real
 * `LocalFileStorageAdapter` directly rather than using Nest's
 * `overrideProvider`) — no DI override needed, callers just pass an instance
 * where `PushProvider` is expected.
 *
 * Default behaviour is `sent` for every token. Tests configure specific
 * tokens to fail via `queueResult`, and can inspect every call via `calls`.
 */
export class FakePushProvider extends PushProvider {
  public readonly calls: PushMessage[] = [];
  private readonly queuedResults = new Map<string, PushSendResult[]>();

  /** Queues a result for the NEXT `send()` call carrying this token. Calls
   *  without a queued result default to `{ outcome: "sent" }`. */
  public queueResult(token: string, result: PushSendResult): void {
    const queue = this.queuedResults.get(token) ?? [];
    queue.push(result);
    this.queuedResults.set(token, queue);
  }

  public async send(message: PushMessage): Promise<PushSendResult> {
    this.calls.push(message);
    const queue = this.queuedResults.get(message.token);
    const next = queue?.shift();
    return next ?? { outcome: "sent" };
  }
}
