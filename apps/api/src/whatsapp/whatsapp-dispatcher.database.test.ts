import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertGuardedCommunicationDatabase,
  createFixtureCompany,
  createFixtureTrader,
  withRolledBackCommunicationFixtures,
} from "../communication/communication.database-test-helpers.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  CompanyWhatsAppProvider,
  SendWhatsAppMessageInput,
  WhatsAppSendResult,
} from "./company-whatsapp-provider.port.js";
import { WhatsAppOutboxDispatcher } from "./whatsapp-outbox-dispatcher.service.js";

const enabled = process.env.RUN_WHATSAPP_DATABASE === "true";

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!enabled)("whatsapp outbox dispatcher", () => {
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

  class StubProvider {
    public liveStatus: Record<string, string> = {};
    public readonly sends: SendWhatsAppMessageInput[] = [];
    public nextResult: WhatsAppSendResult = { outcome: "sent", providerMessageId: "3EB0AUTO1" };

    public async getConnectionStatus(companyId: string): Promise<string> {
      return this.liveStatus[companyId] ?? "connected";
    }

    public async sendMessage(input: SendWhatsAppMessageInput): Promise<WhatsAppSendResult> {
      this.sends.push(input);
      return this.nextResult;
    }
  }

  function buildDispatcher(transaction: Transaction<DatabaseSchema>): {
    dispatcher: WhatsAppOutboxDispatcher;
    provider: StubProvider;
  } {
    const provider = new StubProvider();
    const dispatcher = new WhatsAppOutboxDispatcher(
      transaction as unknown as Kysely<DatabaseSchema>,
      provider as unknown as CompanyWhatsAppProvider,
    );
    return { dispatcher, provider };
  }

  interface World {
    readonly companyId: string;
    readonly traderId: string;
    readonly connectionId: string;
  }

  async function createWorld(
    transaction: Transaction<DatabaseSchema>,
    runId: string,
    connectionStatus = "connected",
  ): Promise<World> {
    const company = await createFixtureCompany(transaction, runId, "wa-disp");
    const trader = await createFixtureTrader(transaction, company.companyId, "wa-disp-t", []);
    const connection = (
      await sql<{ id: string }>`
        insert into company_whatsapp_connections (
          company_id, status, provider_type, connected_phone_number, last_connected_at
        ) values (${company.companyId}::uuid, ${connectionStatus}, 'baileys', '+971500000050', now())
        returning id
      `.execute(transaction)
    ).rows[0]!;
    return { companyId: company.companyId, connectionId: connection.id, traderId: trader.traderId };
  }

  /** A minimal pending test-type row: dispatcher behavior is type-agnostic,
   *  and test rows avoid needing full Order fixtures per scenario. */
  async function insertPending(
    transaction: Transaction<DatabaseSchema>,
    world: World,
    overrides: {
      readonly status?: string;
      readonly attemptCount?: number;
      readonly processingAgeMinutes?: number;
      readonly createdAgeHours?: number;
      readonly group?: string;
    } = {},
  ): Promise<string> {
    const row = (
      await sql<{ id: string }>`
        insert into whatsapp_message_outbox (
          company_id, trader_id, connection_id, message_type, destination_type,
          provider_group_id, group_name_snapshot, message_language, message_body,
          status, attempt_count, processing_at, created_at, idempotency_key
        ) values (
          ${world.companyId}::uuid, ${world.traderId}::uuid, ${world.connectionId}::uuid,
          'test', 'group', ${overrides.group ?? "dispatch-target@g.us"}, 'Dispatch Group', 'both',
          'dispatch body', ${overrides.status ?? "pending"}, ${overrides.attemptCount ?? 0},
          ${overrides.processingAgeMinutes === undefined ? null : sql`now() - make_interval(mins => ${overrides.processingAgeMinutes})`},
          ${overrides.createdAgeHours === undefined ? sql`now()` : sql`now() - make_interval(hours => ${overrides.createdAgeHours})`},
          ${`dispatch-${Math.random().toString(36).slice(2)}`}
        )
        returning id
      `.execute(transaction)
    ).rows[0]!;
    return row.id;
  }

  async function readMessage(transaction: Transaction<DatabaseSchema>, id: string) {
    return (
      await sql<{
        status: string;
        providerMessageId: string | null;
        attemptCount: number;
        failureCode: string | null;
        nextAttemptAt: Date | null;
        sentAt: Date | null;
      }>`
        select status, provider_message_id as "providerMessageId", attempt_count as "attemptCount",
               failure_code as "failureCode", next_attempt_at as "nextAttemptAt", sent_at as "sentAt"
          from whatsapp_message_outbox where id = ${id}::uuid
      `.execute(transaction)
    ).rows[0];
  }

  async function attemptRows(transaction: Transaction<DatabaseSchema>, id: string) {
    return (
      await sql<{ attemptNumber: number; result: string; classification: string | null }>`
        select attempt_number as "attemptNumber", result, failure_classification as "classification"
          from whatsapp_message_attempts where message_id = ${id}::uuid order by attempt_number
      `.execute(transaction)
    ).rows;
  }

  it("claims once, sends once, stores the provider id and never reprocesses sent rows", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const { dispatcher, provider } = buildDispatcher(transaction);
      const id = await insertPending(transaction, world);

      expect(await dispatcher.tick()).toBe(1);
      const row = await readMessage(transaction, id);
      expect(row).toMatchObject({
        attemptCount: 1,
        providerMessageId: "3EB0AUTO1",
        status: "sent",
      });
      expect(row?.sentAt).not.toBeNull();
      expect(provider.sends).toHaveLength(1);
      expect(provider.sends[0]?.providerGroupId).toBe("dispatch-target@g.us");
      expect(await attemptRows(transaction, id)).toEqual([
        { attemptNumber: 1, classification: null, result: "sent" },
      ]);

      // Sent is terminal: further ticks find nothing and send nothing.
      expect(await dispatcher.tick()).toBe(0);
      expect(provider.sends).toHaveLength(1);
    });
  });

  it("requeues with backoff on transient failure and gives up after the attempt limit", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const { dispatcher, provider } = buildDispatcher(transaction);
      provider.nextResult = {
        failureCode: "whatsapp_provider_unavailable",
        outcome: "transient_failure",
      };

      const id = await insertPending(transaction, world);
      await dispatcher.tick();
      let row = await readMessage(transaction, id);
      expect(row).toMatchObject({ attemptCount: 1, status: "pending" });
      expect(row?.nextAttemptAt).not.toBeNull();
      expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);

      // Backed off: an immediate next tick must NOT reclaim it.
      expect(await dispatcher.tick()).toBe(0);
      expect(provider.sends).toHaveLength(1);

      // At the final allowed attempt, a transient failure becomes failed.
      const exhausted = await insertPending(transaction, world, { attemptCount: 4 });
      await dispatcher.tick();
      row = await readMessage(transaction, exhausted);
      expect(row).toMatchObject({
        attemptCount: 5,
        failureCode: "whatsapp_provider_unavailable",
        status: "failed",
      });
      expect((await attemptRows(transaction, exhausted))[0]?.classification).toBe("transient");
    });
  });

  it("treats an unknown group as permanent and ambiguous outcomes as requires_review", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const { dispatcher, provider } = buildDispatcher(transaction);

      provider.nextResult = {
        failureCode: "whatsapp_group_not_found",
        outcome: "permanent_failure",
      };
      const gone = await insertPending(transaction, world);
      await dispatcher.tick();
      expect(await readMessage(transaction, gone)).toMatchObject({
        failureCode: "whatsapp_group_not_found",
        status: "failed",
      });

      // A socket-level rejection mid-dispatch cannot rule out acceptance:
      // park it, never blind-resend.
      provider.nextResult = { failureCode: "whatsapp_send_rejected", outcome: "permanent_failure" };
      const uncertain = await insertPending(transaction, world);
      await dispatcher.tick();
      expect(await readMessage(transaction, uncertain)).toMatchObject({
        failureCode: "whatsapp_send_rejected",
        status: "requires_review",
      });
      expect((await attemptRows(transaction, uncertain))[0]?.classification).toBe("unknown");
      // requires_review is terminal for the dispatcher: no auto-recovery.
      expect(await dispatcher.tick()).toBe(0);
    });
  });

  it("holds pending rows without burning attempts while the connection is down, distinguishing human-action states", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const offline = await createWorld(transaction, runId, "disconnected");
      const broken = await createWorld(transaction, runId, "authentication_failed");
      const { dispatcher, provider } = buildDispatcher(transaction);
      provider.liveStatus[offline.companyId] = "not_connected";
      provider.liveStatus[broken.companyId] = "not_connected";

      const offlineId = await insertPending(transaction, offline);
      const brokenId = await insertPending(transaction, broken);
      await dispatcher.tick();

      const offlineRow = await readMessage(transaction, offlineId);
      const brokenRow = await readMessage(transaction, brokenId);
      // No provider call, no attempt burned, still durable pending.
      expect(provider.sends).toHaveLength(0);
      expect(offlineRow).toMatchObject({ attemptCount: 0, status: "pending" });
      expect(brokenRow).toMatchObject({ attemptCount: 0, status: "pending" });
      expect(await attemptRows(transaction, offlineId)).toHaveLength(0);
      // Human-action states hold longer than transient outages.
      expect(brokenRow!.nextAttemptAt!.getTime()).toBeGreaterThan(
        offlineRow!.nextAttemptAt!.getTime(),
      );

      // Connection recovery: once live again (and the hold elapses), the same
      // row sends with no manual requeue. Simulate the elapsed hold.
      provider.liveStatus[offline.companyId] = "connected";
      await sql`
        update whatsapp_message_outbox set next_attempt_at = now() - interval '1 second'
         where id = ${offlineId}::uuid
      `.execute(transaction);
      await dispatcher.tick();
      expect((await readMessage(transaction, offlineId))?.status).toBe("sent");
      expect(provider.sends).toHaveLength(1);
    });
  });

  it("recovers stale processing rows to requires_review and expires day-old pending rows", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const { dispatcher, provider } = buildDispatcher(transaction);

      const crashed = await insertPending(transaction, world, {
        processingAgeMinutes: 30,
        status: "processing",
      });
      const ancient = await insertPending(transaction, world, { createdAgeHours: 30 });
      const fresh = await insertPending(transaction, world);
      await dispatcher.tick();

      expect(await readMessage(transaction, crashed)).toMatchObject({
        failureCode: "processing_interrupted",
        status: "requires_review",
      });
      expect(await readMessage(transaction, ancient)).toMatchObject({
        failureCode: "notification_expired",
        status: "requires_review",
      });
      // The fresh row is unaffected by housekeeping and sends normally.
      expect((await readMessage(transaction, fresh))?.status).toBe("sent");
      expect(provider.sends).toHaveLength(1);
    });
  });

  it("processes each Company's rows strictly under that Company's identity", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const companyA = await createWorld(transaction, runId);
      const companyB = await createWorld(transaction, runId);
      const { dispatcher, provider } = buildDispatcher(transaction);

      await insertPending(transaction, companyA, { group: "group-a@g.us" });
      await insertPending(transaction, companyB, { group: "group-b@g.us" });
      await dispatcher.tick();

      // Every send carried the claimed row's own company id and snapshotted
      // group — Company A's message can never ride Company B's runtime.
      expect(provider.sends).toHaveLength(2);
      const byCompany = new Map(
        provider.sends.map((send) => [send.companyId, send.providerGroupId]),
      );
      expect(byCompany.get(companyA.companyId)).toBe("group-a@g.us");
      expect(byCompany.get(companyB.companyId)).toBe("group-b@g.us");
    });
  });
});
