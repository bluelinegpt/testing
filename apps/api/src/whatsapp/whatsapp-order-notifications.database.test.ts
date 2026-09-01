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
  withRolledBackCommunicationFixtures,
} from "../communication/communication.database-test-helpers.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { WhatsAppOutboxWriter } from "./whatsapp-outbox-writer.service.js";

const enabled = process.env.RUN_WHATSAPP_DATABASE === "true";

vi.setConfig({ testTimeout: 30_000 });

/**
 * The Prompt 4 hook, end to end at its single canonical point: a confirmed
 * `delivery` status-history event written through
 * `OperationsHistoryWriter.statusHistory` (the path every single/bulk/
 * driver/portal mutation uses) produces exactly one durable `order_status`
 * outbox intent — atomically, idempotently, with full snapshots — or,
 * for unconfigured/disabled Traders and ineligible statuses, nothing at all.
 */
describe.skipIf(!enabled)("automatic order-status WhatsApp notifications", () => {
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

  const history = () => new OperationsHistoryWriter(new WhatsAppOutboxWriter());

  interface World {
    readonly companyId: string;
    readonly accountId: string;
    readonly traderId: string;
    readonly orderId: string;
    readonly orderNumber: string;
  }

  async function createWorld(
    transaction: Transaction<DatabaseSchema>,
    runId: string,
    options: {
      readonly settings?: "enabled" | "disabled" | "none";
      readonly connection?: "connected" | "disconnected" | "none";
    } = {},
  ): Promise<World> {
    const company = await createFixtureCompany(transaction, runId, "wa-order");
    const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-order", [
      "whatsapp.trader_settings.manage",
    ]);
    const trader = await createFixtureTrader(transaction, company.companyId, "noor", []);
    const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
      traderId: trader.traderId,
    });
    if ((options.connection ?? "connected") !== "none") {
      await sql`
        insert into company_whatsapp_connections (
          company_id, status, provider_type, connected_phone_number, last_connected_at,
          disconnect_reason
        ) values (
          ${company.companyId}::uuid,
          ${(options.connection ?? "connected") === "connected" ? "connected" : "disconnected"},
          'baileys', '+971500000040', now(),
          ${(options.connection ?? "connected") === "connected" ? null : "user_disconnected"}
        )
      `.execute(transaction);
    }
    if ((options.settings ?? "enabled") !== "none") {
      await sql`
        insert into trader_whatsapp_settings (
          company_id, trader_id, notifications_enabled, provider_group_id,
          group_name_snapshot, message_language, configured_by_account_id
        ) values (
          ${company.companyId}::uuid, ${trader.traderId}::uuid,
          ${(options.settings ?? "enabled") === "enabled"},
          '120363000000000077@g.us', 'Dana vs NoorStore', 'both', ${office.accountId}::uuid
        )
      `.execute(transaction);
    }
    return {
      accountId: office.accountId,
      companyId: company.companyId,
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      traderId: trader.traderId,
    };
  }

  async function outboxRows(transaction: Transaction<DatabaseSchema>, companyId: string) {
    return (
      await sql<{
        id: string;
        messageType: string;
        status: string;
        orderId: string | null;
        historyId: string | null;
        traderId: string;
        providerGroupId: string;
        groupName: string | null;
        language: string;
        body: string;
      }>`
        select id, message_type as "messageType", status, order_id as "orderId",
               order_status_history_id as "historyId", trader_id as "traderId",
               provider_group_id as "providerGroupId", group_name_snapshot as "groupName",
               message_language as "language", message_body as "body"
          from whatsapp_message_outbox
         where company_id = ${companyId}::uuid
         order by created_at
      `.execute(transaction)
    ).rows;
  }

  it("creates exactly one snapshotted pending intent per eligible status event", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const writer = history();
      const event = await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "assigned_to_driver",
        orderId: world.orderId,
        to: "out_for_delivery",
      });

      const rows = await outboxRows(transaction, world.companyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        groupName: "Dana vs NoorStore",
        historyId: event.id,
        language: "both",
        messageType: "order_status",
        orderId: world.orderId,
        providerGroupId: "120363000000000077@g.us",
        status: "pending",
        traderId: world.traderId,
      });
      // The body is fully rendered and snapshotted at event time: bilingual,
      // carries the order number and the translated status.
      expect(rows[0]?.body).toContain(world.orderNumber);
      expect(rows[0]?.body).toContain("خرج للتوصيل");
      expect(rows[0]?.body).toContain("Out for delivery");

      // Duplicate hook invocation for the SAME status-history event (retry,
      // double-processing) cannot create a second intent.
      await new WhatsAppOutboxWriter().writeOrderStatusChanged(transaction, {
        companyId: world.companyId,
        occurredAt: new Date(),
        orderId: world.orderId,
        orderStatusHistoryId: event.id,
        toStatus: "out_for_delivery",
      });
      expect(await outboxRows(transaction, world.companyId)).toHaveLength(1);
    });
  });

  it("creates separate intents when an Order legitimately re-enters the same status", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const writer = history();
      const first = await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "assigned_to_driver",
        orderId: world.orderId,
        to: "out_for_delivery",
      });
      await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "out_for_delivery",
        orderId: world.orderId,
        to: "returned_to_branch",
      });
      const second = await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "returned_to_branch",
        orderId: world.orderId,
        to: "out_for_delivery",
      });
      expect(second.id).not.toBe(first.id);
      const rows = await outboxRows(transaction, world.companyId);
      // out_for_delivery twice + returned_to_branch once = 3 distinct intents.
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.historyId)).size).toBe(3);
    });
  });

  it("stays silent for disabled Traders, missing settings and ineligible events", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const disabled = await createWorld(transaction, runId, { settings: "disabled" });
      const none = await createWorld(transaction, runId, { settings: "none" });
      const writer = history();

      for (const world of [disabled, none]) {
        await writer.statusHistory(transaction, {
          actorId: world.accountId,
          companyId: world.companyId,
          from: "assigned_to_driver",
          orderId: world.orderId,
          to: "delivered",
        });
        expect(await outboxRows(transaction, world.companyId)).toHaveLength(0);
      }

      // Ineligible delivery statuses and non-delivery dimensions never notify,
      // even for a fully configured Trader.
      const configured = await createWorld(transaction, runId);
      await writer.statusHistory(transaction, {
        actorId: configured.accountId,
        companyId: configured.companyId,
        from: "new",
        orderId: configured.orderId,
        to: "in_branch",
      });
      await writer.statusHistory(transaction, {
        actorId: configured.accountId,
        companyId: configured.companyId,
        from: "not_applicable",
        orderId: configured.orderId,
        statusDimension: "driver_reconciliation",
        to: "pending",
      });
      expect(await outboxRows(transaction, configured.companyId)).toHaveLength(0);
    });
  });

  it("keeps the intent durable when the Company connection is down, and skips when never configured", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const offline = await createWorld(transaction, runId, { connection: "disconnected" });
      const writer = history();
      await writer.statusHistory(transaction, {
        actorId: offline.accountId,
        companyId: offline.companyId,
        from: "assigned_to_driver",
        orderId: offline.orderId,
        to: "delivered",
      });
      const rows = await outboxRows(transaction, offline.companyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("pending");

      // No connection row at all = the Company never set WhatsApp up; there
      // is no runtime that could ever send, so no intent is fabricated.
      const unconfigured = await createWorld(transaction, runId, { connection: "none" });
      await writer.statusHistory(transaction, {
        actorId: unconfigured.accountId,
        companyId: unconfigured.companyId,
        from: "assigned_to_driver",
        orderId: unconfigured.orderId,
        to: "delivered",
      });
      expect(await outboxRows(transaction, unconfigured.companyId)).toHaveLength(0);
    });
  });

  it("snapshots survive later mapping/language changes and group renames", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const writer = history();
      await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "assigned_to_driver",
        orderId: world.orderId,
        to: "delivered",
      });
      const before = (await outboxRows(transaction, world.companyId))[0];

      // The Company then reconfigures everything about the Trader mapping.
      await sql`
        update trader_whatsapp_settings
           set provider_group_id = 'brand-new-group@g.us',
               group_name_snapshot = 'Renamed Group',
               message_language = 'en',
               notifications_enabled = false,
               updated_at = now()
         where company_id = ${world.companyId}::uuid and trader_id = ${world.traderId}::uuid
      `.execute(transaction);

      const after = (await outboxRows(transaction, world.companyId))[0];
      expect(after).toEqual(before);
      expect(after?.providerGroupId).toBe("120363000000000077@g.us");
      expect(after?.language).toBe("both");
      // Future events use the new settings; this one is history.
    });
  });

  it("rolls the intent back together with the Order transaction", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const writer = history();
      await sql`savepoint order_change`.execute(transaction);
      await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "assigned_to_driver",
        orderId: world.orderId,
        to: "delivered",
      });
      expect(await outboxRows(transaction, world.companyId)).toHaveLength(1);
      // The business transaction fails after the hook ran: both the
      // status-history row and the notification intent must vanish together.
      await sql`rollback to savepoint order_change`.execute(transaction);
      expect(await outboxRows(transaction, world.companyId)).toHaveLength(0);
      const historyCount = (
        await sql<{ count: string }>`
          select count(*)::text as count from order_status_history
           where company_id = ${world.companyId}::uuid and status_dimension = 'delivery'
             and to_status = 'delivered'
        `.execute(transaction)
      ).rows[0];
      expect(historyCount?.count).toBe("0");
    });
  });
});
