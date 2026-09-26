import { webConfiguration } from "../../configuration/environment.js";
import type { CommunicationEvent } from "./communication-api.js";

export type CommunicationRealtimeStatus = "closed" | "connecting" | "open" | "reconnecting";

export interface CommunicationRealtimeHandlers {
  readonly onEvent: (event: CommunicationEvent) => void;
  readonly onFullRefreshRequired: () => void;
  readonly onStatusChange: (status: CommunicationRealtimeStatus) => void;
}

/**
 * Builds the `/api/v1/communication/realtime` WebSocket URL from the same
 * `apiBaseUrl` the REST client uses — same-origin path or absolute URL — so
 * dev's Vite proxy (`ws: true`) and a same-origin production deployment both
 * resolve correctly without a second configuration value.
 */
export function communicationRealtimeUrl(conversationId: string, accessToken: string): string {
  const base = webConfiguration.apiBaseUrl;
  const target = base.startsWith("/")
    ? new URL(`${base}/communication/realtime`, globalThis.location.href)
    : new URL(`${base.replace(/\/$/, "")}/communication/realtime`);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.searchParams.set("token", accessToken);
  target.searchParams.set("conversationId", conversationId);
  return target.toString();
}

/**
 * One live subscription to a single conversation's realtime event stream.
 * The backend gateway (`communication-realtime.gateway.ts`) is scoped to one
 * conversation per socket, so a new connection is opened whenever the active
 * conversation changes and closed when the user navigates away from it.
 *
 * Handles automatic reconnect with exponential backoff, cursor-based replay
 * on every (re)connect, sequence-number de-duplication (an event already
 * delivered — live or replayed — is never dispatched twice), and the
 * durable-cursor-expired → full-refresh-required signal.
 */
export class CommunicationRealtimeConnection {
  private socket: WebSocket | undefined;
  private cursor: string | undefined;
  private readonly delivered = new Set<string>();
  private reconnectAttempt = 0;
  // `ReturnType<typeof setTimeout>` rather than `number`: with `@types/node`
  // in the workspace (a transitive dev dependency), `globalThis.setTimeout`
  // resolves to the Node overload returning `Timeout`. This form is correct
  // under either typing and changes nothing at runtime.
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByCaller = false;

  public constructor(
    private readonly url: string,
    private readonly handlers: CommunicationRealtimeHandlers,
  ) {}

  /** `initialCursor`, if supplied, resumes from a previously-seen sequence
   *  (e.g. the last event id already rendered before this component mounted)
   *  instead of replaying the full recent history again. */
  public connect(initialCursor?: string): void {
    this.closedByCaller = false;
    if (initialCursor !== undefined) this.cursor = initialCursor;
    this.open();
  }

  public close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer !== undefined) globalThis.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
  }

  private open(): void {
    this.handlers.onStatusChange(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const target = new URL(this.url);
    if (this.cursor !== undefined) target.searchParams.set("cursor", this.cursor);
    let socket: WebSocket;
    try {
      socket = new WebSocket(target.toString());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.handlers.onStatusChange("open");
    });
    socket.addEventListener("message", (message) => {
      this.handleMessage(typeof message.data === "string" ? message.data : "");
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.closedByCaller) {
        this.handlers.onStatusChange("closed");
        return;
      }
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const payload = parsed as {
      readonly type?: unknown;
      readonly events?: readonly CommunicationEvent[];
      readonly event?: CommunicationEvent;
      readonly fullRefreshRequired?: unknown;
    };
    if (payload.type === "cursor_expired" || payload.fullRefreshRequired === true) {
      this.handlers.onFullRefreshRequired();
      return;
    }
    if (payload.type === "recovery" && Array.isArray(payload.events)) {
      for (const event of payload.events) this.dispatch(event);
      return;
    }
    if (payload.type === "event" && payload.event !== undefined) {
      this.dispatch(payload.event);
    }
  }

  private dispatch(event: CommunicationEvent): void {
    if (this.delivered.has(event.sequence)) return;
    this.delivered.add(event.sequence);
    this.cursor = event.sequence;
    this.handlers.onEvent(event);
  }

  private scheduleReconnect(): void {
    this.handlers.onStatusChange("reconnecting");
    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempt, 15_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = globalThis.setTimeout(() => {
      if (!this.closedByCaller) this.open();
    }, delayMs);
  }
}
