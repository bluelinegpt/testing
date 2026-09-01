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
  createFixtureTrader,
  StaticIdentityAccessor,
  withRolledBackCommunicationFixtures,
} from "../communication/communication.database-test-helpers.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { IdentityContext } from "../security/identity-context.js";
import type {
  CompanyWhatsAppProvider,
  SendWhatsAppMessageInput,
  WhatsAppSendResult,
} from "./company-whatsapp-provider.port.js";
import { WhatsAppNotificationHistoryService } from "./whatsapp-notification-history.service.js";
import {
  buildTestMessageBody,
  WhatsAppTestMessageService,
} from "./whatsapp-test-message.service.js";

const enabled = process.env.RUN_WHATSAPP_DATABASE === "true";

vi.setConfig({ testTimeout: 30_000 });

describe("buildTestMessageBody", () => {
  it("renders bilingual content for `both` with the Trader's names", () => {
    const body = buildTestMessageBody("both", "Noor Store", "متجر نور");
    expect(body).toContain("Tawseelhub WhatsApp Test");
    expect(body).toContain("اختبار واتساب من توصيل هب");
    expect(body).toContain("Trader: Noor Store");
    expect(body).toContain("التاجر: متجر نور");
  });

  it("renders Arabic-only and English-only variants", () => {
    const arabic = buildTestMessageBody("ar", "Noor Store", null);
    expect(arabic).toContain("اختبار واتساب");
    expect(arabic).not.toContain("Tawseelhub WhatsApp Test");
    expect(arabic).toContain("التاجر: Noor Store");
    const english = buildTestMessageBody("en", "Noor Store", "متجر نور");
    expect(english).toContain("Tawseelhub WhatsApp Test");
    expect(english).not.toContain("اختبار");
  });
});

/** Guarded end-to-end test-message flow against the real schema, with the
 *  provider stubbed at the `CompanyWhatsAppProvider` port. */
describe.skipIf(!enabled)("whatsapp trader test messages", () => {
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
    public status = "connected";
    public readonly sends: SendWhatsAppMessageInput[] = [];
    public nextResult: WhatsAppSendResult = { outcome: "sent", providerMessageId: "3EB0TEST1" };

    public async getConnectionStatus(): Promise<string> {
      return this.status;
    }

    public async sendMessage(input: SendWhatsAppMessageInput): Promise<WhatsAppSendResult> {
      this.sends.push(input);
      return this.nextResult;
    }
  }

  function officeIdentity(companyId: string, accountId: string): IdentityContext {
    return {
      companyId,
      forcePasswordChange: false,
      identityId: accountId,
      kind: "company_user",
      permissions: new Set(["whatsapp.trader_settings.manage"]),
      sessionId: randomUUID(),
    };
  }

  interface World {
    readonly companyId: string;
    readonly accountId: string;
    readonly traderId: string;
    readonly service: WhatsAppTestMessageService;
    readonly provider: StubProvider;
    readonly accessor: StaticIdentityAccessor;
  }

  async function createWorld(
    transaction: Transaction<DatabaseSchema>,
    runId: string,
    options: { readonly withGroup?: boolean } = {},
  ): Promise<World> {
    const company = await createFixtureCompany(transaction, runId, "wa-test-msg");
    const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-test-msg", [
      "whatsapp.trader_settings.manage",
    ]);
    const trader = await createFixtureTrader(transaction, company.companyId, "noor-store", []);
    await sql`
      insert into company_whatsapp_connections (
        company_id, status, provider_type, connected_phone_number, last_connected_at
      ) values (${company.companyId}::uuid, 'connected', 'baileys', '+971500000030', now())
    `.execute(transaction);
    if (options.withGroup !== false) {
      await sql`
        insert into trader_whatsapp_settings (
          company_id, trader_id, notifications_enabled, provider_group_id,
          group_name_snapshot, message_language, configured_by_account_id
        ) values (
          ${company.companyId}::uuid, ${trader.traderId}::uuid, true,
          '120363000000000042@g.us', 'Dana vs NoorStore', 'both', ${office.accountId}::uuid
        )
      `.execute(transaction);
    }
    const provider = new StubProvider();
    const accessor = new StaticIdentityAccessor();
    accessor.identity = officeIdentity(company.companyId, office.accountId);
    const service = new WhatsAppTestMessageService(
      transaction as unknown as Kysely<DatabaseSchema>,
      accessor,
      provider as unknown as CompanyWhatsAppProvider,
    );
    return {
      accessor,
      accountId: office.accountId,
      companyId: company.companyId,
      provider,
      service,
      traderId: trader.traderId,
    };
  }

  async function tableCount(
    transaction: Transaction<DatabaseSchema>,
    table: "orders" | "order_status_history",
    companyId: string,
  ): Promise<string> {
    const result =
      table === "orders"
        ? await sql<{ count: string }>`
            select count(*)::text as count from orders where company_id = ${companyId}::uuid
          `.execute(transaction)
        : await sql<{ count: string }>`
            select count(*)::text as count from order_status_history where company_id = ${companyId}::uuid
          `.execute(transaction);
    return result.rows[0]?.count ?? "0";
  }

  it("sends one test message to the exact mapped group and records it without Order data", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);

      const result = await world.service.send(world.traderId, "test-corr", randomUUID());
      expect(result.status).toBe("sent");
      expect(result.providerMessageId).toBe("3EB0TEST1");
      expect(result.duplicate).toBeUndefined();

      // The provider received exactly the mapped provider group id and a
      // bilingual body (settings language = both).
      expect(world.provider.sends).toHaveLength(1);
      expect(world.provider.sends[0]?.providerGroupId).toBe("120363000000000042@g.us");
      expect(world.provider.sends[0]?.body).toContain("Tawseelhub WhatsApp Test");
      expect(world.provider.sends[0]?.body).toContain("اختبار واتساب من توصيل هب");

      const row = (
        await sql<{
          messageType: string;
          orderId: string | null;
          historyId: string | null;
          status: string;
          providerMessageId: string | null;
          groupName: string | null;
        }>`
          select message_type as "messageType", order_id as "orderId",
                 order_status_history_id as "historyId", status,
                 provider_message_id as "providerMessageId",
                 group_name_snapshot as "groupName"
            from whatsapp_message_outbox where company_id = ${world.companyId}::uuid
        `.execute(transaction)
      ).rows[0];
      expect(row).toMatchObject({
        groupName: "Dana vs NoorStore",
        historyId: null,
        messageType: "test",
        orderId: null,
        providerMessageId: "3EB0TEST1",
        status: "sent",
      });

      // One attempt-audit row; no Orders or status-history rows fabricated.
      const attempts = (
        await sql<{ count: string; result: string }>`
          select count(*)::text as count, min(result) as result
            from whatsapp_message_attempts where company_id = ${world.companyId}::uuid
        `.execute(transaction)
      ).rows[0];
      expect(attempts).toMatchObject({ count: "1", result: "sent" });
      expect(await tableCount(transaction, "orders", world.companyId)).toBe("0");
      expect(await tableCount(transaction, "order_status_history", world.companyId)).toBe("0");

      // History surfaces it as a test message with no Order columns.
      const history = new WhatsAppNotificationHistoryService(
        transaction as unknown as Kysely<DatabaseSchema>,
        world.accessor,
      );
      const entries = await history.listForTrader(world.traderId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        messageType: "test",
        orderId: null,
        orderNumber: null,
        orderStatus: null,
        status: "sent",
      });

      const audit = (
        await sql<{ count: string }>`
          select count(*)::text as count from audit_events
           where company_id = ${world.companyId}::uuid
             and action = 'whatsapp.trader_test_message_sent'
        `.execute(transaction)
      ).rows[0];
      expect(audit?.count).toBe("1");
    });
  });

  it("collapses a retried clientRequestId onto one message but treats new clicks as new sends", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const clickId = randomUUID();

      const first = await world.service.send(world.traderId, "test-corr", clickId);
      const retry = await world.service.send(world.traderId, "test-corr", clickId);
      expect(retry.duplicate).toBe(true);
      expect(retry.messageId).toBe(first.messageId);
      expect(world.provider.sends).toHaveLength(1);

      const secondClick = await world.service.send(world.traderId, "test-corr", randomUUID());
      expect(secondClick.duplicate).toBeUndefined();
      expect(world.provider.sends).toHaveLength(2);
      const count = (
        await sql<{ count: string }>`
          select count(*)::text as count from whatsapp_message_outbox
           where company_id = ${world.companyId}::uuid
        `.execute(transaction)
      ).rows[0];
      expect(count?.count).toBe("2");
    });
  });

  it("records a sanitized failure when the provider rejects the send", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      world.provider.nextResult = {
        failureCode: "whatsapp_send_rejected",
        outcome: "permanent_failure",
      };
      const result = await world.service.send(world.traderId, "test-corr", randomUUID());
      expect(result.status).toBe("failed");
      expect(result.failureCode).toBe("whatsapp_send_rejected");
      const row = (
        await sql<{ status: string; failureCode: string | null }>`
          select status, failure_code as "failureCode" from whatsapp_message_outbox
           where company_id = ${world.companyId}::uuid
        `.execute(transaction)
      ).rows[0];
      expect(row).toMatchObject({ failureCode: "whatsapp_send_rejected", status: "failed" });
    });
  });

  it("refuses without a connection, without a group, and across tenants", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);

      world.provider.status = "disconnected";
      await expect(
        world.service.send(world.traderId, "test-corr", randomUUID()),
      ).rejects.toMatchObject({ errorCode: "whatsapp_not_connected" });
      world.provider.status = "connected";

      const bare = await createWorld(transaction, runId, { withGroup: false });
      await expect(
        bare.service.send(bare.traderId, "test-corr", randomUUID()),
      ).rejects.toMatchObject({ errorCode: "whatsapp_group_required" });

      // Company A's identity cannot send to Company B's Trader — the Trader
      // simply does not exist for it, regardless of any group mapping.
      await expect(
        world.service.send(bare.traderId, "test-corr", randomUUID()),
      ).rejects.toMatchObject({ errorCode: "trader_not_found" });
      expect(world.provider.sends).toHaveLength(0);
    });
  });

  it("enforces the message-type shape at the database level", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const connection = (
        await sql<{ id: string }>`
          select id from company_whatsapp_connections where company_id = ${world.companyId}::uuid
        `.execute(transaction)
      ).rows[0];

      async function expectShapeViolation(work: () => Promise<unknown>): Promise<void> {
        await sql`savepoint shape_check`.execute(transaction);
        let caught: unknown;
        try {
          await work();
        } catch (error) {
          caught = error;
        }
        await sql`rollback to savepoint shape_check`.execute(transaction);
        expect(String((caught as Error | undefined)?.message)).toMatch(
          /whatsapp_message_outbox_type_shape_check/,
        );
      }

      // An order_status row without Order references is rejected …
      await expectShapeViolation(() =>
        sql`
          insert into whatsapp_message_outbox (
            company_id, trader_id, connection_id, message_type, provider_group_id,
            message_language, message_body, idempotency_key
          ) values (
            ${world.companyId}::uuid, ${world.traderId}::uuid, ${connection?.id}::uuid,
            'order_status', 'g@g.us', 'both', 'x', ${`shape-${randomUUID()}`}
          )
        `.execute(transaction),
      );
      // … and a test row carrying Order references is rejected too: a test
      // can never masquerade as an Order notification.
      const order = randomUUID();
      await expectShapeViolation(() =>
        sql`
          insert into whatsapp_message_outbox (
            company_id, trader_id, order_id, order_status_history_id, connection_id,
            message_type, provider_group_id, message_language, message_body, idempotency_key
          ) values (
            ${world.companyId}::uuid, ${world.traderId}::uuid, ${order}::uuid, ${order}::uuid,
            ${connection?.id}::uuid, 'test', 'g@g.us', 'both', 'x', ${`shape-${randomUUID()}`}
          )
        `.execute(transaction),
      );

      // message_type is immutable once recorded.
      await world.service.send(world.traderId, "test-corr", randomUUID());
      await sql`savepoint type_flip`.execute(transaction);
      let caught: unknown;
      try {
        await sql`
          update whatsapp_message_outbox set message_type = 'order_status'
           where company_id = ${world.companyId}::uuid
        `.execute(transaction);
      } catch (error) {
        caught = error;
      }
      await sql`rollback to savepoint type_flip`.execute(transaction);
      expect(String((caught as Error | undefined)?.message)).toMatch(
        /whatsapp_outbox_identity_immutable/,
      );
    });
  });
});
