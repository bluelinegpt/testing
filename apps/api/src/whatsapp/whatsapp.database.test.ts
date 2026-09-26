import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertGuardedCommunicationDatabase,
  createFixtureCompany,
  createFixtureOfficeUser,
  createFixtureOrder,
  createFixtureTrader,
  StaticIdentityAccessor,
  withRolledBackCommunicationFixtures,
} from "../communication/communication.database-test-helpers.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import type { IdentityContext } from "../security/identity-context.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { WhatsAppConnectionRuntime } from "./providers/whatsapp-connection-runtime.service.js";
import { TraderWhatsAppSettingsService } from "./trader-whatsapp-settings.service.js";
import { WhatsAppConnectionService } from "./whatsapp-connection.service.js";
import { WhatsAppNotificationHistoryService } from "./whatsapp-notification-history.service.js";
import { WhatsAppOutboxWriter } from "./whatsapp-outbox-writer.service.js";

const enabled = process.env.RUN_WHATSAPP_DATABASE === "true";

vi.setConfig({ testTimeout: 30_000 });

/**
 * Guarded WhatsApp foundation tests. Everything runs inside one rolled-back
 * transaction against the guarded local `blueline` database — no committed
 * fixtures, no resets, exactly the communication/push suite discipline.
 *
 * True multi-connection concurrency cannot run inside one rolled-back
 * transaction; the "concurrent duplicate creation" guarantee is proven here
 * the way it actually holds in production — the database-level
 * `unique (company_id, idempotency_key)` constraint, exercised directly via
 * a raw duplicate INSERT below (the application `on conflict` path is only
 * ergonomics on top of that constraint).
 */
describe.skipIf(!enabled)("whatsapp trader-group foundation", () => {
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

  // These foundation tests exercise persisted state only — no live socket
  // exists, exactly the situation after a process restart.
  const stubRuntime = { getLiveState: () => undefined } as unknown as WhatsAppConnectionRuntime;

  function stubTransactions(transaction: Transaction<DatabaseSchema>): KyselyTransactionManager {
    return {
      execute: <T>(work: (t: Transaction<DatabaseSchema>) => Promise<T>): Promise<T> =>
        work(transaction),
    } as unknown as KyselyTransactionManager;
  }

  function officeIdentity(companyId: string, accountId: string): IdentityContext {
    return {
      companyId,
      forcePasswordChange: false,
      identityId: accountId,
      kind: "company_user",
      permissions: new Set(["whatsapp.trader_settings.manage", "whatsapp.history.view"]),
      sessionId: randomUUID(),
    };
  }

  function settingsService(
    transaction: Transaction<DatabaseSchema>,
    accessor: StaticIdentityAccessor,
  ): TraderWhatsAppSettingsService {
    return new TraderWhatsAppSettingsService(
      transaction as unknown as Kysely<DatabaseSchema>,
      stubTransactions(transaction),
      accessor,
    );
  }

  async function insertConnection(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    options: { readonly encryptedSessionState?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      insert into company_whatsapp_connections (
        id, company_id, status, provider_type, connected_phone_number,
        encrypted_session_state, last_connected_at
      ) values (
        ${id}::uuid, ${companyId}::uuid, 'connected', 'baileys', '+971500000010',
        ${options.encryptedSessionState ?? null}, now()
      )
    `.execute(transaction);
    return id;
  }

  async function insertStatusHistory(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    orderId: string,
    actorAccountId: string,
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      insert into order_status_history (
        id, company_id, order_id, status_dimension, from_status, to_status, changed_by_account_id
      ) values (
        ${id}::uuid, ${companyId}::uuid, ${orderId}::uuid, 'delivery',
        'assigned_to_driver', 'delivered', ${actorAccountId}::uuid
      )
    `.execute(transaction);
    return id;
  }

  /** Runs work expected to fail at the database level inside a savepoint so
   *  the outer rolled-back test transaction stays usable afterwards. */
  async function expectDatabaseFailure(
    transaction: Transaction<DatabaseSchema>,
    work: () => Promise<unknown>,
    messagePattern: RegExp,
  ): Promise<void> {
    await sql`savepoint expected_failure`.execute(transaction);
    let caught: unknown;
    try {
      await work();
    } catch (error) {
      caught = error;
    }
    await sql`rollback to savepoint expected_failure`.execute(transaction);
    expect(caught).toBeDefined();
    expect(String((caught as Error).message)).toMatch(messagePattern);
  }

  interface TwoCompanyWorld {
    readonly companyA: string;
    readonly companyB: string;
    readonly officeA: { accountId: string };
    readonly officeB: { accountId: string };
    readonly traderA: { traderId: string };
    readonly traderB: { traderId: string };
  }

  async function createTwoCompanyWorld(
    transaction: Transaction<DatabaseSchema>,
    runId: string,
  ): Promise<TwoCompanyWorld> {
    const companyA = await createFixtureCompany(transaction, runId, "wa-a");
    const companyB = await createFixtureCompany(transaction, runId, "wa-b");
    const officeA = await createFixtureOfficeUser(transaction, companyA.companyId, "wa-office-a", [
      "whatsapp.trader_settings.manage",
    ]);
    const officeB = await createFixtureOfficeUser(transaction, companyB.companyId, "wa-office-b", [
      "whatsapp.trader_settings.manage",
    ]);
    const traderA = await createFixtureTrader(transaction, companyA.companyId, "wa-trader-a", []);
    const traderB = await createFixtureTrader(transaction, companyB.companyId, "wa-trader-b", []);
    return {
      companyA: companyA.companyId,
      companyB: companyB.companyId,
      officeA,
      officeB,
      traderA,
      traderB,
    };
  }

  it("isolates connections, settings and history between Companies", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createTwoCompanyWorld(transaction, runId);
      await insertConnection(transaction, world.companyB, {
        encryptedSessionState: "v1:company-b-secret",
      });

      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(world.companyA, world.officeA.accountId);
      const connections = new WhatsAppConnectionService(
        transaction as unknown as Kysely<DatabaseSchema>,
        accessor,
        stubRuntime,
      );
      const settings = settingsService(transaction, accessor);
      const history = new WhatsAppNotificationHistoryService(
        transaction as unknown as Kysely<DatabaseSchema>,
        accessor,
      );

      // Company A cannot read Company B's connection — it sees only its own
      // (non-existent) state.
      const view = await connections.getConnection();
      expect(view.status).toBe("not_connected");
      expect(view.connectedPhoneNumber).toBeNull();

      // Company A cannot read, update, or clear Company B's Trader mapping,
      // and cannot read Company B's history — cross-tenant ids read as 404.
      await expect(settings.getForTrader(world.traderB.traderId)).rejects.toMatchObject({
        errorCode: "trader_not_found",
      });
      await expect(
        settings.update(
          world.traderB.traderId,
          { notificationsEnabled: true, providerGroupId: "hijack@g.us" },
          "test-correlation",
        ),
      ).rejects.toMatchObject({ errorCode: "trader_not_found" });
      await expect(
        settings.removeGroupMapping(world.traderB.traderId, "test-correlation"),
      ).rejects.toMatchObject({ errorCode: "trader_not_found" });
      await expect(history.listForTrader(world.traderB.traderId)).rejects.toMatchObject({
        errorCode: "trader_not_found",
      });

      // The outbox writer refuses another Company's Trader outright.
      const writer = new WhatsAppOutboxWriter();
      const orderA = await createFixtureOrder(
        transaction,
        world.companyA,
        world.officeA.accountId,
        {
          traderId: world.traderA.traderId,
        },
      );
      const historyId = await insertStatusHistory(
        transaction,
        world.companyA,
        orderA.orderId,
        world.officeA.accountId,
      );
      await expect(
        writer.createTraderWhatsAppNotification(transaction, {
          companyId: world.companyA,
          messageBody: "test",
          orderId: orderA.orderId,
          orderStatusHistoryId: historyId,
          traderId: world.traderB.traderId,
        }),
      ).rejects.toMatchObject({ errorCode: "trader_not_found" });
    });
  });

  it("keeps one configuration per Trader with `both` as the default language", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createTwoCompanyWorld(transaction, runId);
      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(world.companyA, world.officeA.accountId);
      const settings = settingsService(transaction, accessor);

      const created = await settings.update(
        world.traderA.traderId,
        {
          groupNameSnapshot: "Dana vs NoorStore",
          notificationsEnabled: true,
          providerGroupId: "120363000000000001@g.us",
        },
        "test-correlation",
      );
      expect(created.configured).toBe(true);
      expect(created.messageLanguage).toBe("both");
      expect(created.destinationType).toBe("group");

      // A second update mutates the same row, never a second one.
      await settings.update(
        world.traderA.traderId,
        { messageLanguage: "ar", notificationsEnabled: true },
        "test-correlation",
      );
      const rows = await sql<{ count: string; language: string }>`
        select count(*)::text as count, min(message_language) as language
          from trader_whatsapp_settings
         where company_id = ${world.companyA}::uuid and trader_id = ${world.traderA.traderId}::uuid
      `.execute(transaction);
      expect(rows.rows[0]).toMatchObject({ count: "1", language: "ar" });

      // The (company_id, trader_id) uniqueness is a database constraint, not
      // just upsert behavior.
      await expectDatabaseFailure(
        transaction,
        () =>
          sql`
            insert into trader_whatsapp_settings (
              company_id, trader_id, notifications_enabled, provider_group_id, configured_by_account_id
            ) values (
              ${world.companyA}::uuid, ${world.traderA.traderId}::uuid, false, null,
              ${world.officeA.accountId}::uuid
            )
          `.execute(transaction),
        /duplicate key value/,
      );

      // Audit trail exists for enable + group assignment, without secrets.
      const audits = await sql<{ action: string }>`
        select action from audit_events
         where company_id = ${world.companyA}::uuid
           and subject_type = 'trader_whatsapp_settings'
         order by occurred_at
      `.execute(transaction);
      const actions = audits.rows.map((row) => row.action);
      expect(actions).toContain("whatsapp.trader_notifications_enabled");
      expect(actions).toContain("whatsapp.trader_group_changed");
      expect(actions).toContain("whatsapp.trader_language_changed");
    });
  });

  it("rejects enabling notifications without a group, at service and database level", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createTwoCompanyWorld(transaction, runId);
      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(world.companyA, world.officeA.accountId);
      const settings = settingsService(transaction, accessor);

      await expect(
        settings.update(world.traderA.traderId, { notificationsEnabled: true }, "test-correlation"),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ApplicationException && error.errorCode === "whatsapp_group_required",
      );

      await expectDatabaseFailure(
        transaction,
        () =>
          sql`
            insert into trader_whatsapp_settings (
              company_id, trader_id, notifications_enabled, provider_group_id, configured_by_account_id
            ) values (
              ${world.companyA}::uuid, ${world.traderA.traderId}::uuid, true, null,
              ${world.officeA.accountId}::uuid
            )
          `.execute(transaction),
        /trader_whatsapp_settings_enabled_shape_check/,
      );

      await expectDatabaseFailure(
        transaction,
        () =>
          sql`
            insert into trader_whatsapp_settings (
              company_id, trader_id, notifications_enabled, provider_group_id,
              message_language, configured_by_account_id
            ) values (
              ${world.companyA}::uuid, ${world.traderA.traderId}::uuid, false, null,
              'fr', ${world.officeA.accountId}::uuid
            )
          `.execute(transaction),
        /trader_whatsapp_settings_language_check/,
      );
    });
  });

  it("creates exactly one outbox row per status-history event per group", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createTwoCompanyWorld(transaction, runId);
      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(world.companyA, world.officeA.accountId);
      const settings = settingsService(transaction, accessor);
      const writer = new WhatsAppOutboxWriter();

      await insertConnection(transaction, world.companyA);
      await settings.update(
        world.traderA.traderId,
        {
          groupNameSnapshot: "Dana vs NoorStore",
          notificationsEnabled: true,
          providerGroupId: "120363000000000001@g.us",
        },
        "test-correlation",
      );
      const order = await createFixtureOrder(transaction, world.companyA, world.officeA.accountId, {
        traderId: world.traderA.traderId,
      });
      const firstEvent = await insertStatusHistory(
        transaction,
        world.companyA,
        order.orderId,
        world.officeA.accountId,
      );

      const input = {
        companyId: world.companyA,
        messageBody: "Order delivered",
        orderId: order.orderId,
        orderStatusHistoryId: firstEvent,
        traderId: world.traderA.traderId,
      };
      const first = await writer.createTraderWhatsAppNotification(transaction, input);
      expect(first.outcome).toBe("created");

      // Retry with the exact same event returns the existing record.
      const retry = await writer.createTraderWhatsAppNotification(transaction, input);
      expect(retry.outcome).toBe("already_exists");
      expect(retry).toMatchObject({
        messageId: (first as { messageId: string }).messageId,
      });

      // The duplicate-prevention mechanism is the unique constraint itself —
      // a raw INSERT that bypasses every application check still cannot
      // create a second row (this is what makes concurrent creation safe).
      await expectDatabaseFailure(
        transaction,
        () =>
          sql`
            insert into whatsapp_message_outbox (
              company_id, trader_id, order_id, order_status_history_id, connection_id,
              provider_group_id, message_language, message_body, idempotency_key
            )
            select company_id, trader_id, order_id, order_status_history_id, connection_id,
                   provider_group_id, message_language, message_body, idempotency_key
              from whatsapp_message_outbox
             where company_id = ${world.companyA}::uuid
          `.execute(transaction),
        /duplicate key value/,
      );

      // A DIFFERENT status-history event on the same Order is a new logical
      // notification.
      const secondEvent = await insertStatusHistory(
        transaction,
        world.companyA,
        order.orderId,
        world.officeA.accountId,
      );
      const second = await writer.createTraderWhatsAppNotification(transaction, {
        ...input,
        orderStatusHistoryId: secondEvent,
      });
      expect(second.outcome).toBe("created");

      const count = await sql<{ count: string }>`
        select count(*)::text as count from whatsapp_message_outbox
         where company_id = ${world.companyA}::uuid and order_id = ${order.orderId}::uuid
      `.execute(transaction);
      expect(count.rows[0]?.count).toBe("2");
    });
  });

  it("keeps Traders independent and skips honestly when nothing is configured", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createTwoCompanyWorld(transaction, runId);
      const traderA2 = await createFixtureTrader(transaction, world.companyA, "wa-trader-a2", []);
      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(world.companyA, world.officeA.accountId);
      const settings = settingsService(transaction, accessor);
      const writer = new WhatsAppOutboxWriter();

      const orderOne = await createFixtureOrder(
        transaction,
        world.companyA,
        world.officeA.accountId,
        { traderId: world.traderA.traderId },
      );
      const eventOne = await insertStatusHistory(
        transaction,
        world.companyA,
        orderOne.orderId,
        world.officeA.accountId,
      );

      // No connection row yet -> skipped, never a partial write.
      await settings.update(
        world.traderA.traderId,
        { notificationsEnabled: true, providerGroupId: "g-one@g.us" },
        "test-correlation",
      );
      const noConnection = await writer.createTraderWhatsAppNotification(transaction, {
        companyId: world.companyA,
        messageBody: "m",
        orderId: orderOne.orderId,
        orderStatusHistoryId: eventOne,
        traderId: world.traderA.traderId,
      });
      expect(noConnection).toEqual({ outcome: "skipped", reason: "no_connection" });

      await insertConnection(transaction, world.companyA);

      // A Trader without an enabled mapping is skipped, not errored.
      const orderTwo = await createFixtureOrder(
        transaction,
        world.companyA,
        world.officeA.accountId,
        { traderId: traderA2.traderId },
      );
      const eventTwo = await insertStatusHistory(
        transaction,
        world.companyA,
        orderTwo.orderId,
        world.officeA.accountId,
      );
      const unconfigured = await writer.createTraderWhatsAppNotification(transaction, {
        companyId: world.companyA,
        messageBody: "m",
        orderId: orderTwo.orderId,
        orderStatusHistoryId: eventTwo,
        traderId: traderA2.traderId,
      });
      expect(unconfigured).toEqual({ outcome: "skipped", reason: "not_configured" });

      // Both Traders configured to different groups create independent rows.
      await settings.update(
        traderA2.traderId,
        { notificationsEnabled: true, providerGroupId: "g-two@g.us" },
        "test-correlation",
      );
      const one = await writer.createTraderWhatsAppNotification(transaction, {
        companyId: world.companyA,
        messageBody: "m1",
        orderId: orderOne.orderId,
        orderStatusHistoryId: eventOne,
        traderId: world.traderA.traderId,
      });
      const two = await writer.createTraderWhatsAppNotification(transaction, {
        companyId: world.companyA,
        messageBody: "m2",
        orderId: orderTwo.orderId,
        orderStatusHistoryId: eventTwo,
        traderId: traderA2.traderId,
      });
      expect(one.outcome).toBe("created");
      expect(two.outcome).toBe("created");

      // An Order belonging to a different Trader than the one addressed is a
      // hard conflict, never a message to the wrong group.
      await expect(
        writer.createTraderWhatsAppNotification(transaction, {
          companyId: world.companyA,
          messageBody: "m",
          orderId: orderOne.orderId,
          orderStatusHistoryId: eventOne,
          traderId: traderA2.traderId,
        }),
      ).rejects.toMatchObject({ errorCode: "whatsapp_order_trader_mismatch" });
    });
  });

  it("preserves history when notifications are disabled, and `sent` is terminal", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createTwoCompanyWorld(transaction, runId);
      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(world.companyA, world.officeA.accountId);
      const settings = settingsService(transaction, accessor);
      const writer = new WhatsAppOutboxWriter();

      await insertConnection(transaction, world.companyA);
      await settings.update(
        world.traderA.traderId,
        { notificationsEnabled: true, providerGroupId: "g-hist@g.us" },
        "test-correlation",
      );
      const order = await createFixtureOrder(transaction, world.companyA, world.officeA.accountId, {
        traderId: world.traderA.traderId,
      });
      const event = await insertStatusHistory(
        transaction,
        world.companyA,
        order.orderId,
        world.officeA.accountId,
      );
      const created = await writer.createTraderWhatsAppNotification(transaction, {
        companyId: world.companyA,
        messageBody: "m",
        orderId: order.orderId,
        orderStatusHistoryId: event,
        traderId: world.traderA.traderId,
      });
      expect(created.outcome).toBe("created");
      const messageId = (created as { messageId: string }).messageId;

      // Disabling (via group removal) keeps every historical outbox record.
      await settings.removeGroupMapping(world.traderA.traderId, "test-correlation");
      const remaining = await sql<{ count: string }>`
        select count(*)::text as count from whatsapp_message_outbox
         where company_id = ${world.companyA}::uuid and trader_id = ${world.traderA.traderId}::uuid
      `.execute(transaction);
      expect(remaining.rows[0]?.count).toBe("1");

      // Mark it sent, then prove the database refuses to re-queue it.
      await sql`
        update whatsapp_message_outbox
           set status = 'sent', sent_at = now(), updated_at = now()
         where id = ${messageId}::uuid
      `.execute(transaction);
      await expectDatabaseFailure(
        transaction,
        () =>
          sql`
            update whatsapp_message_outbox set status = 'pending'
             where id = ${messageId}::uuid
          `.execute(transaction),
        /whatsapp_outbox_sent_is_terminal/,
      );
      // The identity/idempotency columns are immutable too.
      await expectDatabaseFailure(
        transaction,
        () =>
          sql`
            update whatsapp_message_outbox set idempotency_key = 'forged'
             where id = ${messageId}::uuid
          `.execute(transaction),
        /whatsapp_outbox_identity_immutable/,
      );
    });
  });

  it("never exposes session material through the connection view", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-secret");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-sec", [
        "whatsapp.connection.manage",
      ]);
      await insertConnection(transaction, company.companyId, {
        encryptedSessionState: "v1:super-secret-session-material",
      });
      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(company.companyId, office.accountId);
      const connections = new WhatsAppConnectionService(
        transaction as unknown as Kysely<DatabaseSchema>,
        accessor,
        stubRuntime,
      );
      const view = await connections.getConnection();
      expect(view.status).toBe("connected");
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("super-secret-session-material");
      expect(Object.keys(view)).not.toContain("encryptedSessionState");
      expect(Object.keys(view)).not.toContain("providerAccountReference");
    });
  });

  it("allows only one connection row per Company at the database level", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "wa-single");
      await insertConnection(transaction, company.companyId);
      await expectDatabaseFailure(
        transaction,
        () => insertConnection(transaction, company.companyId),
        /duplicate key value/,
      );
    });
  });
});
