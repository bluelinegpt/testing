import { randomUUID } from "node:crypto";

import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../../infrastructure/database/database.types.js";
import { ApplicationException } from "../../presentation/errors/application.exception.js";
import type {
  CompanyWhatsAppConnectionStatus,
  WhatsAppGroup,
} from "../company-whatsapp-provider.port.js";
import { type BaileysSocket, BaileysSocketFactory } from "./baileys-client.js";
import {
  classifyDisconnect,
  normalizeConnectedPhoneNumber,
  reconnectDelayMs,
} from "./baileys-lifecycle.js";
import {
  BaileysSessionStore,
  type RuntimeAuthState,
  SessionStateCorruptError,
} from "./baileys-session-store.js";

export interface LiveConnectionState {
  readonly status: CompanyWhatsAppConnectionStatus;
  /** Present only while waiting for a QR scan. Held in server memory only —
   *  never persisted, logged, or audited. */
  readonly qr: string | null;
}

interface CompanyRuntime {
  connectionRowId: string;
  socket: BaileysSocket | null;
  status: CompanyWhatsAppConnectionStatus;
  qr: string | null;
  authState: RuntimeAuthState;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  closing: boolean;
  generation: number;
  /** Serializes async socket-event handling so state transitions for one
   *  Company can never interleave. */
  eventChain: Promise<void>;
  initiatedByAccountId: string | null;
  correlationId: string;
}

/**
 * The per-Company WhatsApp runtime/session manager: opens Baileys sockets,
 * restores encrypted auth state, tracks QR pairing, maps provider events to
 * the Prompt 1 lifecycle statuses, reconnects with bounded backoff, and
 * exposes group discovery + group send to the provider adapter.
 *
 * Tenancy: the in-memory map is keyed by `company_id` (never by phone
 * number), every database write carries `where company_id = …`, and a QR or
 * socket is reachable only through the authenticated Company's own entry —
 * there is no lookup path from one Company to another's runtime.
 *
 * This manager is NOT the authoritative credential store: all durable state
 * lives encrypted in `company_whatsapp_connections` via
 * `BaileysSessionStore`, so a process restart recovers from the database.
 */
@Injectable()
export class WhatsAppConnectionRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppConnectionRuntime.name);
  private readonly runtimes = new Map<string, CompanyRuntime>();
  /** Overridable in tests to keep retry behavior deterministic. */
  public maxReconnectAttempts = 5;
  public restoreConcurrency = 3;

  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(BaileysSessionStore) private readonly sessions: BaileysSessionStore,
    @Inject(BaileysSocketFactory) private readonly sockets: BaileysSocketFactory,
  ) {}

  /** Startup restoration runs in the background a few seconds after boot —
   *  the API must become healthy without waiting for any WhatsApp session,
   *  and one broken Company session must never fail the process. */
  public onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    // Single-owner guard: only ONE process may own Company WhatsApp sockets.
    // On any instance that must not own them (a future multi-instance
    // topology), WHATSAPP_RUNTIME_ENABLED=false disables restoration here
    // and the dispatcher alongside it. Horizontal scaling of the owning
    // service is prohibited — see Documentation/whatsapp-operations.md.
    if (process.env.WHATSAPP_RUNTIME_ENABLED === "false") {
      this.logger.warn("whatsapp_runtime_disabled_by_configuration");
      return;
    }
    if (!this.sessions.isEncryptionConfigured()) return;
    const timer = setTimeout(() => {
      this.restoreOnStartup().catch((error: unknown) => {
        this.logger.warn(`whatsapp_startup_restoration_failed: ${(error as Error).message}`);
      });
    }, 5_000);
    timer.unref();
  }

  public onModuleDestroy(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.closing = true;
      if (runtime.reconnectTimer !== null) clearTimeout(runtime.reconnectTimer);
      // end(), never logout(): shutdown must keep the session linkable so the
      // next process restores it without a new QR.
      try {
        runtime.socket?.end();
      } catch {
        // Socket teardown failures during shutdown are irrelevant.
      }
    }
    this.runtimes.clear();
  }

  /** Await this Company's queued socket-event handling (state transitions,
   *  auth persistence, audits). Resolves immediately when no runtime exists.
   *  Used by tests to observe deterministic state, and safe for any caller
   *  that needs the latest transition durably applied. */
  public async settle(companyId: string): Promise<void> {
    await this.runtimes.get(companyId)?.eventChain;
  }

  public getLiveState(companyId: string): LiveConnectionState | undefined {
    const runtime = this.runtimes.get(companyId);
    if (runtime === undefined) return undefined;
    return {
      qr: runtime.status === "waiting_for_qr_scan" ? runtime.qr : null,
      status: runtime.status,
    };
  }

  /**
   * Start (or resume) this Company's WhatsApp connection. Idempotent against
   * repeated clicks: an already connecting/waiting/connected runtime is
   * returned as-is rather than opening a second socket.
   */
  public async connect(
    companyId: string,
    actorAccountId: string | null,
    correlationId: string,
    options: { readonly restore?: boolean } = {},
  ): Promise<LiveConnectionState> {
    this.requireEncryption();
    const existing = this.runtimes.get(companyId);
    if (
      existing !== undefined &&
      ["connected", "connecting", "waiting_for_qr_scan"].includes(existing.status)
    ) {
      return {
        qr: existing.status === "waiting_for_qr_scan" ? existing.qr : null,
        status: existing.status,
      };
    }
    if (existing !== undefined) this.dropRuntime(companyId);

    const row = await sql<{ id: string }>`
      insert into company_whatsapp_connections (company_id, status, provider_type)
      values (${companyId}::uuid, 'connecting', 'baileys')
      on conflict (company_id) do update
        set status = 'connecting', provider_type = 'baileys', updated_at = now()
      returning id
    `.execute(this.database);
    const connectionRowId = row.rows[0]?.id;
    if (connectionRowId === undefined) throw new Error("whatsapp_connection_upsert_failed");

    // Background restoration is not a user-initiated lifecycle action — it
    // gets no `connection_started` audit row (one per process restart per
    // Company would be flood, not signal); a successful restore still writes
    // `connection_connected` when the socket opens.
    if (options.restore !== true) {
      await this.audit(
        companyId,
        connectionRowId,
        "whatsapp.connection_started",
        actorAccountId,
        correlationId,
        {
          provider: "baileys",
        },
      );
    }

    let stored;
    try {
      stored = await this.sessions.load(companyId);
    } catch (error) {
      if (!(error instanceof SessionStateCorruptError)) throw error;
      // Unusable ciphertext: never expose it, never fall back to plaintext,
      // never silently discard it — record the failure and require a fresh
      // QR pairing (whose success overwrites the blob).
      await this.markStatus(companyId, "authentication_failed", "session_decryption_failed");
      await this.audit(
        companyId,
        connectionRowId,
        "whatsapp.connection_authentication_failed",
        actorAccountId,
        correlationId,
        { reason: "session_decryption_failed" },
      );
      // A human explicitly connecting proceeds straight into a fresh QR
      // pairing (they are present to scan). Background restoration stops
      // here instead — opening a QR socket nobody will scan helps no one;
      // the persisted `authentication_failed` state is the actionable truth.
      if (options.restore === true) {
        return { qr: null, status: "authentication_failed" };
      }
      stored = undefined;
    }

    const runtime: CompanyRuntime = {
      authState: this.sessions.createRuntimeAuthState(companyId, stored),
      closing: false,
      connectionRowId,
      correlationId,
      eventChain: Promise.resolve(),
      generation: 0,
      initiatedByAccountId: actorAccountId,
      qr: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      socket: null,
      status: "connecting",
    };
    this.runtimes.set(companyId, runtime);
    this.startSocket(companyId, runtime);
    return { qr: null, status: "connecting" };
  }

  /**
   * Full user-facing disconnect: intentionally logs out (unlinks the device)
   * so the session cannot be reused, clears the now-unusable encrypted auth
   * state, and persists `disconnected`. Trader group mappings and message
   * history are untouched — only the connection itself ends.
   */
  public async disconnect(
    companyId: string,
    actorAccountId: string | null,
    correlationId: string,
  ): Promise<LiveConnectionState> {
    const runtime = this.runtimes.get(companyId);
    if (runtime !== undefined) {
      runtime.closing = true;
      if (runtime.reconnectTimer !== null) clearTimeout(runtime.reconnectTimer);
      try {
        await runtime.socket?.logout();
      } catch {
        // Logout can fail when the transport is already dead; local cleanup
        // below still applies and the QR pairing is invalidated server-side
        // next time WhatsApp sees the dead device.
      }
      try {
        runtime.socket?.end();
      } catch {
        // Already closed.
      }
      this.runtimes.delete(companyId);
    }
    const rowId = await this.findConnectionRowId(companyId);
    if (rowId === null) return { qr: null, status: "not_connected" };
    await this.sessions.clear(companyId);
    await sql`
      update company_whatsapp_connections
         set status = 'disconnected', disconnect_reason = 'user_disconnected',
             last_disconnected_at = now(), updated_at = now(), version = version + 1
       where company_id = ${companyId}::uuid
    `.execute(this.database);
    await this.audit(
      companyId,
      rowId,
      "whatsapp.connection_disconnected",
      actorAccountId,
      correlationId,
      {
        reason: "user_disconnected",
      },
    );
    return { qr: null, status: "disconnected" };
  }

  /**
   * Explicit reconnect: tear down whatever runtime exists (without logging
   * out — stored credentials must survive) and start again. With valid
   * stored auth this connects without a QR; if WhatsApp demands re-pairing,
   * the normal QR flow takes over. The existing connection row is reused.
   */
  public async reconnect(
    companyId: string,
    actorAccountId: string | null,
    correlationId: string,
  ): Promise<LiveConnectionState> {
    this.requireEncryption();
    this.dropRuntime(companyId);
    return this.connect(companyId, actorAccountId, correlationId);
  }

  public async listGroups(companyId: string): Promise<readonly WhatsAppGroup[]> {
    const runtime = this.requireConnectedRuntime(companyId);
    let groups;
    try {
      groups = await runtime.socket!.groupFetchAllParticipating();
    } catch {
      throw new ApplicationException(
        "whatsapp_provider_unavailable",
        "WhatsApp groups could not be loaded. Try again shortly.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await this.touchActivity(companyId);
    return Object.values(groups)
      .map((group) => ({
        name: group.subject,
        providerGroupId: group.id,
        ...(Array.isArray(group.participants)
          ? { participantCount: group.participants.length }
          : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async sendGroupMessage(
    companyId: string,
    providerGroupId: string,
    text: string,
  ): Promise<{ readonly providerMessageId: string | null; readonly sentAt: Date }> {
    const runtime = this.requireConnectedRuntime(companyId);
    if (!providerGroupId.endsWith("@g.us")) {
      throw new ApplicationException(
        "whatsapp_group_not_found",
        "The destination is not a WhatsApp group of the connected account",
        HttpStatus.NOT_FOUND,
      );
    }
    let result;
    try {
      result = await runtime.socket!.sendMessage(providerGroupId, { text });
    } catch {
      throw new ApplicationException(
        "whatsapp_send_rejected",
        "WhatsApp did not accept the message",
        HttpStatus.BAD_GATEWAY,
      );
    }
    await this.touchActivity(companyId);
    // "Sent" here means the provider accepted the message — never a
    // delivered/read claim; Baileys gives no such evidence at this layer.
    return { providerMessageId: result?.key?.id ?? null, sentAt: new Date() };
  }

  /**
   * Restore previously-connected sessions after a process restart, with
   * bounded concurrency and per-Company error isolation. Rows stuck in the
   * transient `connecting`/`waiting_for_qr_scan` states are stale (their
   * runtime died with the old process) and reset to `not_connected`.
   */
  public async restoreOnStartup(): Promise<void> {
    await sql`
      update company_whatsapp_connections
         set status = 'not_connected', updated_at = now()
       where status in ('connecting', 'waiting_for_qr_scan')
    `.execute(this.database);
    const eligible = await sql<{ companyId: string }>`
      select company_id as "companyId" from company_whatsapp_connections
       where status = 'connected' and encrypted_session_state is not null
    `.execute(this.database);
    const queue = [...eligible.rows];
    const workers = Array.from({ length: Math.max(1, this.restoreConcurrency) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return;
        try {
          await this.connect(next.companyId, null, `whatsapp-restore:${randomUUID()}`, {
            restore: true,
          });
        } catch (error) {
          this.logger.warn(
            `whatsapp_restore_failed company=${next.companyId} code=${(error as Error).message}`,
          );
        }
      }
    });
    await Promise.all(workers);
  }

  private startSocket(companyId: string, runtime: CompanyRuntime): void {
    runtime.generation += 1;
    const generation = runtime.generation;
    const socket = this.sockets.create(runtime.authState.auth);
    runtime.socket = socket;

    const guarded = (work: () => Promise<void>): void => {
      if (this.runtimes.get(companyId) !== runtime || runtime.generation !== generation) return;
      runtime.eventChain = runtime.eventChain.then(async () => {
        if (this.runtimes.get(companyId) !== runtime || runtime.generation !== generation) return;
        try {
          await work();
        } catch (error) {
          this.logger.warn(
            `whatsapp_event_handling_failed company=${companyId} code=${(error as Error).message}`,
          );
        }
      });
    };

    socket.ev.on("creds.update", () => {
      guarded(() => runtime.authState.persist());
    });

    socket.ev.on("connection.update", (update) => {
      guarded(async () => {
        if (update.qr !== undefined) {
          runtime.qr = update.qr;
          if (runtime.status !== "waiting_for_qr_scan") {
            runtime.status = "waiting_for_qr_scan";
            await this.markStatus(companyId, "waiting_for_qr_scan", null);
          }
          return;
        }
        if (update.connection === "open") {
          await this.handleOpen(companyId, runtime);
          return;
        }
        if (update.connection === "close") {
          await this.handleClose(companyId, runtime, update.lastDisconnect?.error);
        }
      });
    });
  }

  private async handleOpen(companyId: string, runtime: CompanyRuntime): Promise<void> {
    runtime.qr = null;
    runtime.reconnectAttempts = 0;
    runtime.status = "connected";
    const phone = normalizeConnectedPhoneNumber(runtime.socket?.user?.id);
    await sql`
      update company_whatsapp_connections
         set status = 'connected',
             provider_type = 'baileys',
             connected_phone_number = coalesce(${phone}, connected_phone_number, 'unknown'),
             connected_at = coalesce(connected_at, now()),
             last_connected_at = now(),
             last_health_check_at = now(),
             disconnect_reason = null,
             updated_at = now(),
             version = version + 1
       where company_id = ${companyId}::uuid
    `.execute(this.database);
    await runtime.authState.persist();
    await this.audit(
      companyId,
      runtime.connectionRowId,
      "whatsapp.connection_connected",
      runtime.initiatedByAccountId,
      runtime.correlationId,
      { connectedPhoneNumber: phone, provider: "baileys" },
    );
  }

  private async handleClose(
    companyId: string,
    runtime: CompanyRuntime,
    error: Error | undefined,
  ): Promise<void> {
    if (runtime.closing) return;
    const classification = classifyDisconnect(error);
    switch (classification.kind) {
      case "restart_required": {
        // Normal immediately after QR pairing: restart with the same creds.
        this.startSocket(companyId, runtime);
        return;
      }
      // Terminal branches mark `closing` FIRST (so any further close events
      // from the dying socket are ignored) and remove the runtime entry LAST
      // (so `settle()` observes the persistence work still in flight).
      case "logged_out": {
        runtime.closing = true;
        await this.sessions.clear(companyId);
        await this.markStatus(companyId, "requires_reconnect", "logged_out");
        await this.audit(
          companyId,
          runtime.connectionRowId,
          "whatsapp.connection_reconnect_required",
          null,
          runtime.correlationId,
          { reason: "logged_out" },
        );
        this.dropRuntime(companyId);
        return;
      }
      case "bad_session": {
        runtime.closing = true;
        await this.sessions.clear(companyId);
        await this.markStatus(companyId, "authentication_failed", "bad_session");
        await this.audit(
          companyId,
          runtime.connectionRowId,
          "whatsapp.connection_authentication_failed",
          null,
          runtime.correlationId,
          { reason: "bad_session" },
        );
        this.dropRuntime(companyId);
        return;
      }
      case "replaced": {
        runtime.closing = true;
        await this.markStatus(companyId, "disconnected", "connection_replaced", {
          touchDisconnectedAt: true,
        });
        await this.audit(
          companyId,
          runtime.connectionRowId,
          "whatsapp.connection_disconnected",
          null,
          runtime.correlationId,
          { reason: "connection_replaced" },
        );
        this.dropRuntime(companyId);
        return;
      }
      case "transient": {
        runtime.reconnectAttempts += 1;
        if (runtime.reconnectAttempts > this.maxReconnectAttempts) {
          runtime.closing = true;
          await this.markStatus(companyId, "disconnected", "connection_lost", {
            touchDisconnectedAt: true,
          });
          await this.audit(
            companyId,
            runtime.connectionRowId,
            "whatsapp.connection_disconnected",
            null,
            runtime.correlationId,
            { reason: "connection_lost" },
          );
          this.dropRuntime(companyId);
          return;
        }
        runtime.status = "connecting";
        runtime.qr = null;
        await this.markStatus(companyId, "connecting", null);
        const delay = reconnectDelayMs(runtime.reconnectAttempts);
        runtime.reconnectTimer = setTimeout(() => {
          runtime.reconnectTimer = null;
          if (this.runtimes.get(companyId) === runtime && !runtime.closing) {
            this.startSocket(companyId, runtime);
          }
        }, delay);
        runtime.reconnectTimer.unref?.();
        return;
      }
    }
  }

  private requireEncryption(): void {
    if (!this.sessions.isEncryptionConfigured()) {
      throw new ApplicationException(
        "whatsapp_provider_unavailable",
        "WhatsApp session encryption is not configured on this server",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private requireConnectedRuntime(companyId: string): CompanyRuntime {
    const runtime = this.runtimes.get(companyId);
    if (runtime === undefined || runtime.socket === null || runtime.status !== "connected") {
      throw new ApplicationException(
        "whatsapp_not_connected",
        "WhatsApp is not connected",
        HttpStatus.CONFLICT,
      );
    }
    return runtime;
  }

  private dropRuntime(companyId: string): void {
    const runtime = this.runtimes.get(companyId);
    if (runtime === undefined) return;
    runtime.closing = true;
    if (runtime.reconnectTimer !== null) clearTimeout(runtime.reconnectTimer);
    try {
      runtime.socket?.end();
    } catch {
      // Already closed.
    }
    this.runtimes.delete(companyId);
  }

  private async markStatus(
    companyId: string,
    status: CompanyWhatsAppConnectionStatus,
    disconnectReason: string | null,
    options: { readonly touchDisconnectedAt?: boolean } = {},
  ): Promise<void> {
    await sql`
      update company_whatsapp_connections
         set status = ${status},
             disconnect_reason = ${disconnectReason},
             last_disconnected_at = case when ${options.touchDisconnectedAt === true} then now() else last_disconnected_at end,
             updated_at = now(),
             version = version + 1
       where company_id = ${companyId}::uuid
    `.execute(this.database);
  }

  private async touchActivity(companyId: string): Promise<void> {
    await sql`
      update company_whatsapp_connections
         set last_health_check_at = now(), updated_at = now()
       where company_id = ${companyId}::uuid
    `.execute(this.database);
  }

  private async findConnectionRowId(companyId: string): Promise<string | null> {
    const result = await sql<{ id: string }>`
      select id from company_whatsapp_connections where company_id = ${companyId}::uuid
    `.execute(this.database);
    return result.rows[0]?.id ?? null;
  }

  /** Lifecycle audit. Never contains QR content, session state, or any
   *  provider credential material — identifiers and safe snapshots only. */
  private async audit(
    companyId: string,
    connectionRowId: string,
    action: string,
    actorAccountId: string | null,
    correlationId: string,
    after: object,
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id
      ) values (
        ${companyId}::uuid, ${actorAccountId}::uuid, ${action},
        'company_whatsapp_connection', ${connectionRowId},
        ${JSON.stringify(after)}::jsonb, ${correlationId}
      )
    `.execute(this.database);
  }
}
