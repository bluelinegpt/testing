import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ConfigService } from "@nestjs/config";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertGuardedCommunicationDatabase,
  createFixtureCompany,
  createFixtureOfficeUser,
  createFixtureTrader,
  withRolledBackCommunicationFixtures,
} from "../communication/communication.database-test-helpers.js";
import { configuration, type AppConfiguration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import {
  BaileysSocketFactory,
  type BaileysAuthInput,
  type BaileysConnectionUpdate,
  type BaileysGroupMetadata,
  type BaileysSocket,
} from "./providers/baileys-client.js";
import { BaileysSessionStore } from "./providers/baileys-session-store.js";
import { WhatsAppConnectionRuntime } from "./providers/whatsapp-connection-runtime.service.js";
import { WhatsAppSessionCipher } from "./whatsapp-session-cipher.js";

const enabled = process.env.RUN_WHATSAPP_DATABASE === "true";

vi.setConfig({ testTimeout: 30_000 });

/**
 * Guarded connection-lifecycle tests: the real `WhatsAppConnectionRuntime`,
 * `BaileysSessionStore` and `WhatsAppSessionCipher` running against the
 * guarded local database inside rolled-back transactions — with the Baileys
 * socket replaced by a scripted fake at the `BaileysSocketFactory` seam, so
 * the QR → open → close → restore lifecycle is driven deterministically and
 * no real WhatsApp traffic ever occurs.
 */
describe.skipIf(!enabled)("whatsapp real-connectivity lifecycle", () => {
  let database: Kysely<DatabaseSchema>;

  beforeAll(async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await assertGuardedCommunicationDatabase(database);
  });

  afterAll(async () => {
    await database.destroy();
  });

  class FakeSocket implements BaileysSocket {
    public user: { id: string } | undefined;
    public loggedOut = false;
    public ended = false;
    public groups: Record<string, BaileysGroupMetadata> = {};
    public readonly sent: Array<{ jid: string; text: string }> = [];
    public failNextSend = false;
    public readonly auth: BaileysAuthInput;
    private readonly listeners = new Map<string, Array<(payload?: unknown) => void>>();

    public constructor(auth: BaileysAuthInput) {
      this.auth = auth;
    }

    public readonly ev = {
      on: (event: string, listener: (payload?: unknown) => void): void => {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
      },
    } as BaileysSocket["ev"];

    public emitConnectionUpdate(update: BaileysConnectionUpdate): void {
      for (const listener of this.listeners.get("connection.update") ?? []) listener(update);
    }

    public emitCredsUpdate(): void {
      for (const listener of this.listeners.get("creds.update") ?? []) listener();
    }

    public async logout(): Promise<void> {
      this.loggedOut = true;
    }

    public end(): void {
      this.ended = true;
    }

    public async groupFetchAllParticipating(): Promise<Record<string, BaileysGroupMetadata>> {
      return this.groups;
    }

    public async sendMessage(jid: string, content: { text: string }) {
      if (this.failNextSend) throw new Error("fake stream errored");
      this.sent.push({ jid, text: content.text });
      return { key: { id: `FAKE-${this.sent.length}` } };
    }
  }

  class FakeFactory extends BaileysSocketFactory {
    public readonly created: FakeSocket[] = [];

    public create(auth: BaileysAuthInput): BaileysSocket {
      const socket = new FakeSocket(auth);
      this.created.push(socket);
      return socket;
    }

    public last(): FakeSocket {
      const socket = this.created.at(-1);
      if (socket === undefined) throw new Error("no fake socket created yet");
      return socket;
    }
  }

  const encryptionKey = randomBytes(32).toString("base64");

  function cipherWithKey(key: string | undefined): WhatsAppSessionCipher {
    const config = {
      get: (name: string) => (name === "whatsapp.sessionEncryptionKey" ? key : undefined),
    } as unknown as ConfigService<AppConfiguration, true>;
    return new WhatsAppSessionCipher(config);
  }

  function buildRuntime(
    transaction: Transaction<DatabaseSchema>,
    options: { readonly key?: string | undefined } = {},
  ): { runtime: WhatsAppConnectionRuntime; factory: FakeFactory } {
    const db = transaction as unknown as Kysely<DatabaseSchema>;
    const factory = new FakeFactory();
    const runtime = new WhatsAppConnectionRuntime(
      db,
      new BaileysSessionStore(db, cipherWithKey("key" in options ? options.key : encryptionKey)),
      factory,
    );
    return { factory, runtime };
  }

  /** Socket events enqueue real awaited DB work onto the runtime's
   *  per-company chain — await the chain itself (a few rounds, since settled
   *  work can synchronously enqueue follow-up events). */
  async function flush(runtime: WhatsAppConnectionRuntime, companyId: string): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      await runtime.settle(companyId);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
    }
  }

  async function connectToOpen(
    runtime: WhatsAppConnectionRuntime,
    factory: FakeFactory,
    companyId: string,
    actorId: string | null,
    phoneUserId = "971501234567:5@s.whatsapp.net",
  ): Promise<FakeSocket> {
    await runtime.connect(companyId, actorId, `test-${randomUUID()}`);
    const socket = factory.last();
    socket.emitConnectionUpdate({ qr: "QR-PAYLOAD-1" });
    await flush(runtime, companyId);
    socket.user = { id: phoneUserId };
    socket.emitCredsUpdate();
    socket.emitConnectionUpdate({ connection: "open" });
    await flush(runtime, companyId);
    return socket;
  }

  async function readRow(transaction: Transaction<DatabaseSchema>, companyId: string) {
    const result = await sql<{
      status: string;
      disconnectReason: string | null;
      connectedPhoneNumber: string | null;
      encryptedSessionState: string | null;
      connectedAt: Date | null;
      lastConnectedAt: Date | null;
      lastDisconnectedAt: Date | null;
    }>`
      select status,
             disconnect_reason as "disconnectReason",
             connected_phone_number as "connectedPhoneNumber",
             encrypted_session_state as "encryptedSessionState",
             connected_at as "connectedAt",
             last_connected_at as "lastConnectedAt",
             last_disconnected_at as "lastDisconnectedAt"
        from company_whatsapp_connections
       where company_id = ${companyId}::uuid
    `.execute(transaction);
    return result.rows[0];
  }

  async function auditActions(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
  ): Promise<readonly string[]> {
    const result = await sql<{ action: string }>`
      select action from audit_events
       where company_id = ${companyId}::uuid and subject_type = 'company_whatsapp_connection'
       order by occurred_at
    `.execute(transaction);
    return result.rows.map((row) => row.action);
  }

  it("walks connect → QR → paired → connected, persisting encrypted auth and safe audit only", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-conn");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-conn", [
        "whatsapp.connection.manage",
      ]);
      const { factory, runtime } = buildRuntime(transaction);

      const initial = await runtime.connect(company.companyId, office.accountId, "test-corr");
      expect(initial.status).toBe("connecting");
      expect((await readRow(transaction, company.companyId))?.status).toBe("connecting");

      const socket = factory.last();
      socket.emitConnectionUpdate({ qr: "QR-PAYLOAD-XYZ" });
      await flush(runtime, company.companyId);
      // QR lives in runtime memory only, tenant-scoped; the database row and
      // audit trail never contain it.
      expect(runtime.getLiveState(company.companyId)).toEqual({
        qr: "QR-PAYLOAD-XYZ",
        status: "waiting_for_qr_scan",
      });
      const rowDuringQr = await readRow(transaction, company.companyId);
      expect(rowDuringQr?.status).toBe("waiting_for_qr_scan");
      expect(JSON.stringify(rowDuringQr)).not.toContain("QR-PAYLOAD-XYZ");

      // A rotated QR simply replaces the visible one.
      socket.emitConnectionUpdate({ qr: "QR-PAYLOAD-ROTATED" });
      await flush(runtime, company.companyId);
      expect(runtime.getLiveState(company.companyId)?.qr).toBe("QR-PAYLOAD-ROTATED");

      socket.user = { id: "971501234567:5@s.whatsapp.net" };
      socket.emitCredsUpdate();
      socket.emitConnectionUpdate({ connection: "open" });
      await flush(runtime, company.companyId);

      const row = await readRow(transaction, company.companyId);
      expect(row?.status).toBe("connected");
      expect(row?.connectedPhoneNumber).toBe("+971501234567");
      expect(row?.connectedAt).not.toBeNull();
      expect(row?.lastConnectedAt).not.toBeNull();
      expect(row?.encryptedSessionState?.startsWith("v1:")).toBe(true);
      // Encrypted at rest: no plaintext Baileys structure or QR content.
      expect(row?.encryptedSessionState).not.toContain("noiseKey");
      expect(row?.encryptedSessionState).not.toContain("QR-PAYLOAD");

      const actions = await auditActions(transaction, company.companyId);
      expect(actions).toContain("whatsapp.connection_started");
      expect(actions).toContain("whatsapp.connection_connected");
      const auditBlob = (
        await sql<{ blob: string }>`
          select coalesce(string_agg(after_data::text, ' '), '') as blob from audit_events
           where company_id = ${company.companyId}::uuid
        `.execute(transaction)
      ).rows[0]?.blob;
      expect(auditBlob).not.toContain("QR-PAYLOAD");
      expect(auditBlob).not.toContain("noiseKey");

      // Repeated connect while connected: same state back, no second socket.
      const repeat = await runtime.connect(company.companyId, office.accountId, "test-corr-2");
      expect(repeat.status).toBe("connected");
      expect(factory.created).toHaveLength(1);
      const rowCount = (
        await sql<{ count: string }>`
          select count(*)::text as count from company_whatsapp_connections
           where company_id = ${company.companyId}::uuid
        `.execute(transaction)
      ).rows[0]?.count;
      expect(rowCount).toBe("1");
    });
  });

  it("restores a persisted session without a QR and reuses the same row", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-restore");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-restore", [
        "whatsapp.connection.manage",
      ]);
      const first = buildRuntime(transaction);
      const original = await connectToOpen(
        first.runtime,
        first.factory,
        company.companyId,
        office.accountId,
      );
      const originalKey = Buffer.from(original.auth.creds.noiseKey.public).toString("base64");

      // "Restart": a brand-new runtime instance with its own factory, hydrated
      // purely from the encrypted database blob.
      const second = buildRuntime(transaction);
      const state = await second.runtime.connect(company.companyId, office.accountId, "test-corr");
      expect(state.status).toBe("connecting");
      const restoredSocket = second.factory.last();
      expect(Buffer.from(restoredSocket.auth.creds.noiseKey.public).toString("base64")).toBe(
        originalKey,
      );
      restoredSocket.user = { id: "971501234567:5@s.whatsapp.net" };
      restoredSocket.emitConnectionUpdate({ connection: "open" });
      await flush(second.runtime, company.companyId);
      expect((await readRow(transaction, company.companyId))?.status).toBe("connected");
    });
  });

  it("classifies a provider logout as requires_reconnect, clears auth, keeps Trader mappings", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-logout");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-logout", [
        "whatsapp.connection.manage",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "wa-logout-t", []);
      const { factory, runtime } = buildRuntime(transaction);
      const socket = await connectToOpen(runtime, factory, company.companyId, office.accountId);
      await sql`
        insert into trader_whatsapp_settings (
          company_id, trader_id, notifications_enabled, provider_group_id,
          group_name_snapshot, configured_by_account_id
        ) values (
          ${company.companyId}::uuid, ${trader.traderId}::uuid, true,
          'mapped@g.us', 'Dana vs NoorStore', ${office.accountId}::uuid
        )
      `.execute(transaction);

      const loggedOut = new Error("logged out");
      (loggedOut as Error & { output?: { statusCode?: number } }).output = { statusCode: 401 };
      socket.emitConnectionUpdate({ connection: "close", lastDisconnect: { error: loggedOut } });
      await flush(runtime, company.companyId);

      const row = await readRow(transaction, company.companyId);
      expect(row?.status).toBe("requires_reconnect");
      expect(row?.disconnectReason).toBe("logged_out");
      expect(row?.encryptedSessionState).toBeNull();
      expect(await auditActions(transaction, company.companyId)).toContain(
        "whatsapp.connection_reconnect_required",
      );
      expect(runtime.getLiveState(company.companyId)).toBeUndefined();

      const mapping = (
        await sql<{ count: string }>`
          select count(*)::text as count from trader_whatsapp_settings
           where company_id = ${company.companyId}::uuid and trader_id = ${trader.traderId}::uuid
        `.execute(transaction)
      ).rows[0]?.count;
      expect(mapping).toBe("1");
    });
  });

  it("gives up on exhausted transient failures with an actionable disconnected state", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-transient");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-transient", [
        "whatsapp.connection.manage",
      ]);
      const { factory, runtime } = buildRuntime(transaction);
      runtime.maxReconnectAttempts = 0;
      const socket = await connectToOpen(runtime, factory, company.companyId, office.accountId);

      const lost = new Error("connection lost");
      (lost as Error & { output?: { statusCode?: number } }).output = { statusCode: 408 };
      socket.emitConnectionUpdate({ connection: "close", lastDisconnect: { error: lost } });
      await flush(runtime, company.companyId);

      const row = await readRow(transaction, company.companyId);
      expect(row?.status).toBe("disconnected");
      expect(row?.disconnectReason).toBe("connection_lost");
      // Session material is preserved — an explicit reconnect can reuse it.
      expect(row?.encryptedSessionState).not.toBeNull();
      expect(await auditActions(transaction, company.companyId)).toContain(
        "whatsapp.connection_disconnected",
      );
    });
  });

  it("restarts the socket in place when the provider requires it after pairing", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-restart");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-restart", [
        "whatsapp.connection.manage",
      ]);
      const { factory, runtime } = buildRuntime(transaction);
      await runtime.connect(company.companyId, office.accountId, "test-corr");
      const socket = factory.last();
      const restart = new Error("restart required");
      (restart as Error & { output?: { statusCode?: number } }).output = { statusCode: 515 };
      socket.emitConnectionUpdate({ connection: "close", lastDisconnect: { error: restart } });
      await flush(runtime, company.companyId);
      expect(factory.created).toHaveLength(2);
      const replacement = factory.last();
      replacement.user = { id: "971509999999@s.whatsapp.net" };
      replacement.emitConnectionUpdate({ connection: "open" });
      await flush(runtime, company.companyId);
      expect((await readRow(transaction, company.companyId))?.status).toBe("connected");
      expect((await readRow(transaction, company.companyId))?.connectedPhoneNumber).toBe(
        "+971509999999",
      );
    });
  });

  it("performs a full user disconnect: logout, cleared auth, preserved configuration", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-disc");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-disc", [
        "whatsapp.connection.manage",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "wa-disc-t", []);
      const { factory, runtime } = buildRuntime(transaction);
      const socket = await connectToOpen(runtime, factory, company.companyId, office.accountId);
      await sql`
        insert into trader_whatsapp_settings (
          company_id, trader_id, notifications_enabled, provider_group_id,
          group_name_snapshot, configured_by_account_id
        ) values (
          ${company.companyId}::uuid, ${trader.traderId}::uuid, true,
          'kept@g.us', 'Kept Group', ${office.accountId}::uuid
        )
      `.execute(transaction);

      const state = await runtime.disconnect(company.companyId, office.accountId, "test-corr");
      expect(state.status).toBe("disconnected");
      expect(socket.loggedOut).toBe(true);
      const row = await readRow(transaction, company.companyId);
      expect(row?.status).toBe("disconnected");
      expect(row?.disconnectReason).toBe("user_disconnected");
      expect(row?.lastDisconnectedAt).not.toBeNull();
      expect(row?.encryptedSessionState).toBeNull();
      expect(await auditActions(transaction, company.companyId)).toContain(
        "whatsapp.connection_disconnected",
      );
      const mapping = (
        await sql<{ count: string }>`
          select count(*)::text as count from trader_whatsapp_settings
           where company_id = ${company.companyId}::uuid
        `.execute(transaction)
      ).rows[0]?.count;
      expect(mapping).toBe("1");
    });
  });

  it("discovers groups with provider ids as identity and no participant data", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-groups");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-groups", [
        "whatsapp.connection.manage",
      ]);
      const { factory, runtime } = buildRuntime(transaction);
      const socket = await connectToOpen(runtime, factory, company.companyId, office.accountId);
      socket.groups = {
        "111@g.us": {
          id: "111@g.us",
          participants: [{ id: "97150111@s.whatsapp.net" }, { id: "97150222@s.whatsapp.net" }],
          subject: "Dana vs NoorStore",
        },
        "222@g.us": {
          id: "222@g.us",
          participants: [{ id: "97150333@s.whatsapp.net" }],
          // Duplicate display name — provider ids keep them distinct.
          subject: "Dana vs NoorStore",
        },
      };

      const groups = await runtime.listGroups(company.companyId);
      expect(groups).toHaveLength(2);
      expect(new Set(groups.map((group) => group.providerGroupId))).toEqual(
        new Set(["111@g.us", "222@g.us"]),
      );
      expect(groups.map((group) => group.participantCount).sort()).toEqual([1, 2]);
      for (const group of groups) {
        expect(Object.keys(group).sort()).toEqual(["name", "participantCount", "providerGroupId"]);
      }
      expect(JSON.stringify(groups)).not.toContain("s.whatsapp.net");
    });
  });

  it("sends to a discovered group and normalizes the provider message id", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-send");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-send", [
        "whatsapp.connection.manage",
      ]);
      const { factory, runtime } = buildRuntime(transaction);
      const socket = await connectToOpen(runtime, factory, company.companyId, office.accountId);

      const result = await runtime.sendGroupMessage(company.companyId, "123@g.us", "Test message");
      expect(result.providerMessageId).toBe("FAKE-1");
      expect(result.sentAt).toBeInstanceOf(Date);
      expect(socket.sent).toEqual([{ jid: "123@g.us", text: "Test message" }]);

      await expect(
        runtime.sendGroupMessage(company.companyId, "not-a-group", "x"),
      ).rejects.toMatchObject({ errorCode: "whatsapp_group_not_found" });

      socket.failNextSend = true;
      await expect(
        runtime.sendGroupMessage(company.companyId, "123@g.us", "x"),
      ).rejects.toMatchObject({ errorCode: "whatsapp_send_rejected" });
    });
  });

  it("isolates runtimes, QR, groups and sends between Companies", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const companyA = await createFixtureCompany(transaction, runId, "wa-iso-a");
      const companyB = await createFixtureCompany(transaction, runId, "wa-iso-b");
      const officeA = await createFixtureOfficeUser(transaction, companyA.companyId, "wa-iso-a", [
        "whatsapp.connection.manage",
      ]);
      const { factory, runtime } = buildRuntime(transaction);

      const socketA = await connectToOpen(runtime, factory, companyA.companyId, officeA.accountId);
      socketA.groups = {
        "a-group@g.us": { id: "a-group@g.us", participants: [], subject: "Company A Group" },
      };

      // Company B has no runtime: no status leak, no groups, no sending — and
      // starting B's own connection creates a second, independent socket whose
      // QR is visible only under B's company id.
      expect(runtime.getLiveState(companyB.companyId)).toBeUndefined();
      await expect(runtime.listGroups(companyB.companyId)).rejects.toMatchObject({
        errorCode: "whatsapp_not_connected",
      });
      await expect(
        runtime.sendGroupMessage(companyB.companyId, "a-group@g.us", "cross-tenant"),
      ).rejects.toMatchObject({ errorCode: "whatsapp_not_connected" });

      await runtime.connect(companyB.companyId, null, "test-corr-b");
      const socketB = factory.last();
      expect(socketB).not.toBe(socketA);
      socketB.emitConnectionUpdate({ qr: "QR-FOR-B-ONLY" });
      await flush(runtime, companyB.companyId);
      expect(runtime.getLiveState(companyB.companyId)?.qr).toBe("QR-FOR-B-ONLY");
      expect(runtime.getLiveState(companyA.companyId)?.qr).toBeNull();
      expect(socketA.sent).toHaveLength(0);
    });
  });

  it("restores eligible sessions on startup, isolating corrupt ones and resetting stale rows", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const healthy = await createFixtureCompany(transaction, runId, "wa-boot-a");
      const corrupt = await createFixtureCompany(transaction, runId, "wa-boot-b");
      const stale = await createFixtureCompany(transaction, runId, "wa-boot-c");
      const office = await createFixtureOfficeUser(transaction, healthy.companyId, "wa-boot", [
        "whatsapp.connection.manage",
      ]);

      // Healthy: a real prior pairing persisted through the store.
      const first = buildRuntime(transaction);
      await connectToOpen(first.runtime, first.factory, healthy.companyId, office.accountId);
      // Corrupt: a connected row whose ciphertext cannot decrypt.
      await sql`
        insert into company_whatsapp_connections (
          company_id, status, provider_type, connected_phone_number,
          last_connected_at, encrypted_session_state
        ) values (
          ${corrupt.companyId}::uuid, 'connected', 'baileys', '+971500000020',
          now(), 'v1:bad:bad:bad'
        )
      `.execute(transaction);
      // Stale: a QR wait that died with the previous process.
      await sql`
        insert into company_whatsapp_connections (company_id, status, provider_type)
        values (${stale.companyId}::uuid, 'waiting_for_qr_scan', 'baileys')
      `.execute(transaction);

      const second = buildRuntime(transaction);
      await second.runtime.restoreOnStartup();
      // Healthy company got a fresh socket from the stored session; drive it
      // open to complete restoration.
      const restored = second.factory.last();
      restored.user = { id: "971501234567@s.whatsapp.net" };
      restored.emitConnectionUpdate({ connection: "open" });
      await flush(second.runtime, healthy.companyId);

      expect((await readRow(transaction, healthy.companyId))?.status).toBe("connected");
      const corruptRow = await readRow(transaction, corrupt.companyId);
      expect(corruptRow?.status).toBe("authentication_failed");
      expect(corruptRow?.disconnectReason).toBe("session_decryption_failed");
      expect((await readRow(transaction, stale.companyId))?.status).toBe("not_connected");
      // Restoration never writes connection_started audit noise.
      expect(await auditActions(transaction, healthy.companyId)).not.toContain(
        "whatsapp.connection_started_restore",
      );
    });
  });

  it("shuts down gracefully: sockets close, nothing logs out, auth survives for restart", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-shutdown");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-shutdown", [
        "whatsapp.connection.manage",
      ]);
      const { factory, runtime } = buildRuntime(transaction);
      const socket = await connectToOpen(runtime, factory, company.companyId, office.accountId);

      // A deploy restart is NOT a user Disconnect: the runtime closes the
      // socket but never logs the linked device out and never clears the
      // encrypted auth state — the next process restores without a QR.
      runtime.onModuleDestroy();
      expect(socket.ended).toBe(true);
      expect(socket.loggedOut).toBe(false);
      const row = await readRow(transaction, company.companyId);
      expect(row?.status).toBe("connected");
      expect(row?.encryptedSessionState).not.toBeNull();
      expect(runtime.getLiveState(company.companyId)).toBeUndefined();
    });
  });

  it("refuses to connect when session encryption is not configured", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-nokey");
      const { runtime } = buildRuntime(transaction, { key: undefined });
      await expect(runtime.connect(company.companyId, null, "test-corr")).rejects.toMatchObject({
        errorCode: "whatsapp_provider_unavailable",
      });
    });
  });
});
