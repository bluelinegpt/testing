import { DisconnectReason } from "./baileys-client.js";

/**
 * Deliberate, provider-neutral interpretation of a Baileys socket close.
 * Raw Baileys/Boom states are never exposed upward — the runtime acts on
 * exactly one of these classifications.
 */
export type DisconnectClassification =
  /** Session revoked/unlinked by the phone — credentials are dead; a human
   *  must scan a new QR. Never auto-retried. */
  | { readonly kind: "logged_out" }
  /** Credentials are corrupt/unusable — same human recovery as logged_out
   *  but surfaced as an authentication failure. */
  | { readonly kind: "bad_session" }
  /** Another client opened this WhatsApp session — retrying would fight it;
   *  requires an intentional human reconnect. */
  | { readonly kind: "replaced" }
  /** Baileys asks for an immediate socket restart (normal right after QR
   *  pairing). Not an error; restart with the same credentials at once. */
  | { readonly kind: "restart_required" }
  /** Transient transport failure — eligible for bounded backoff retry. */
  | { readonly kind: "transient"; readonly code: number | undefined };

export function classifyDisconnect(error: Error | undefined): DisconnectClassification {
  const statusCode = (error as { output?: { statusCode?: number } } | undefined)?.output
    ?.statusCode;
  switch (statusCode) {
    case DisconnectReason.loggedOut:
    case DisconnectReason.forbidden:
      return { kind: "logged_out" };
    case DisconnectReason.badSession:
      return { kind: "bad_session" };
    case DisconnectReason.connectionReplaced:
      return { kind: "replaced" };
    case DisconnectReason.restartRequired:
      return { kind: "restart_required" };
    default:
      return { code: statusCode, kind: "transient" };
  }
}

/**
 * A Baileys user id looks like `971501234567:12@s.whatsapp.net` (device
 * suffix after `:`). The connected number Tawseelhub stores is the bare
 * normalized `+<digits>` — never a display-formatted string as identity.
 */
export function normalizeConnectedPhoneNumber(userId: string | undefined): string | null {
  if (userId === undefined) return null;
  const withoutServer = userId.split("@")[0] ?? "";
  const withoutDevice = withoutServer.split(":")[0] ?? "";
  const digits = withoutDevice.replace(/[^\d]/g, "");
  return digits.length === 0 ? null : `+${digits}`;
}

/** Bounded exponential backoff for transient reconnects: 2s, 4s, 8s, 16s,
 *  30s cap. Beyond the attempt limit the runtime gives up and persists a
 *  human-actionable `disconnected` state — never a hot loop. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, attempt - 1), 30_000);
}
