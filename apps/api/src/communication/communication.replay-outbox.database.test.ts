import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { IdentityContext } from "../security/identity-context.js";
import {
  createFixtureCompany,
  createFixtureCustomer,
  createFixtureOfficeUser,
  createFixtureOrder,
  createFixtureTrackingToken,
  createFixtureTrader,
  createTestCommunicationService,
  StaticIdentityAccessor,
  withRolledBackCommunicationFixtures,
} from "./communication.database-test-helpers.js";

const enabled = process.env.RUN_COMMUNICATION_DATABASE === "true";

function officeIdentity(companyId: string, accountId: string): IdentityContext & { companyId: string } {
  return {
    companyId,
    forcePasswordChange: false,
    identityId: accountId,
    kind: "company_user",
    permissions: new Set(["communication.operator.read", "communication.operator.send"]),
    sessionId: `office-${accountId}`,
  };
}

function traderIdentity(
  companyId: string,
  accountId: string,
  traderId: string,
): IdentityContext & { companyId: string } {
  return {
    companyId,
    forcePasswordChange: false,
    identityId: accountId,
    kind: "trader",
    permissions: new Set(["communication.trader.read", "communication.trader.send"]),
    profileId: traderId,
    sessionId: `trader-${accountId}`,
  };
}

async function outboxRecipients(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  messageId: string,
): Promise<readonly string[]> {
  const rows = await sql<{ recipient_account_id: string }>`
    select recipient_account_id from communication_notification_outbox
     where company_id = ${companyId}::uuid and message_id = ${messageId}::uuid
  `.execute(transaction);
  return rows.rows.map((row) => row.recipient_account_id);
}

/** G. Notification outbox security. H. Replay / event security. */
describe.skipIf(!enabled)("guarded communication outbox and replay security", () => {
  let database: Kysely<DatabaseSchema>;

  beforeAll(() => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  });

  afterAll(async () => {
    await database.destroy();
  });

  it("G1/G2: the outbox notifies every other participant with an account, never the sender", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "g1");
      const officeOne = await createFixtureOfficeUser(transaction, company.companyId, "g1-office-one", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const officeTwo = await createFixtureOfficeUser(transaction, company.companyId, "g1-office-two", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "g1", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      const order = await createFixtureOrder(transaction, company.companyId, officeOne.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = traderIdentity(company.companyId, trader.accountId, trader.traderId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
      });
      // Office One reads first so both office accounts are seated as active
      // participants before the Trader's message is sent.
      accessor.identity = officeIdentity(company.companyId, officeOne.accountId);
      await service.getMessages(conversation.id, {});
      accessor.identity = officeIdentity(company.companyId, officeTwo.accountId);
      await service.getMessages(conversation.id, {});

      accessor.identity = traderIdentity(company.companyId, trader.accountId, trader.traderId);
      const message = await service.sendTextMessage(conversation.id, {
        clientMessageId: "g1-trader-message",
        idempotencyKey: `g1-trader-key-${runId}`,
        text: "Update from Trader",
      });

      const recipients = await outboxRecipients(transaction, company.companyId, message.id);
      expect(recipients.sort()).toEqual([officeOne.accountId, officeTwo.accountId].sort());
      expect(recipients).not.toContain(trader.accountId);
      return undefined;
    });
  });

  it("G3: a Customer-sent message notifies every office participant (sender has no account to exclude)", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "g3");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "g3", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "g3", []);
      const customer = await createFixtureCustomer(transaction, company.companyId, office.accountId, "g3");
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customer.customerId,
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      const tracking = await createFixtureTrackingToken(transaction, company.companyId, order.orderId);
      const session = await service.createCustomerMessagingSession({ trackingToken: tracking.rawToken });
      const message = await service.customerSendText(session.customerMessagingToken, {
        clientMessageId: "g3-customer-message",
        idempotencyKey: `g3-customer-key-${runId}`,
        text: "Where is my order?",
      });

      const recipients = await outboxRecipients(transaction, company.companyId, message.id);
      expect(recipients).toEqual([office.accountId]);
      return undefined;
    });
  });

  it("G4: a duplicate idempotent send creates no additional outbox rows", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "g4");
      const officeOne = await createFixtureOfficeUser(transaction, company.companyId, "g4-office-one", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "g4", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      const order = await createFixtureOrder(transaction, company.companyId, officeOne.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      accessor.identity = traderIdentity(company.companyId, trader.accountId, trader.traderId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
      });
      accessor.identity = officeIdentity(company.companyId, officeOne.accountId);
      await service.getMessages(conversation.id, {});
      accessor.identity = traderIdentity(company.companyId, trader.accountId, trader.traderId);

      const key = `g4-key-${runId}`;
      const first = await service.sendTextMessage(conversation.id, {
        clientMessageId: "g4-message",
        idempotencyKey: key,
        text: "Same message twice",
      });
      const before = await outboxRecipients(transaction, company.companyId, first.id);
      await service.sendTextMessage(conversation.id, {
        clientMessageId: "g4-message",
        idempotencyKey: key,
        text: "Same message twice",
      });
      const after = await outboxRecipients(transaction, company.companyId, first.id);
      expect(after).toEqual(before);
      return undefined;
    });
  });

  it("G5: a rejected send (no permission) creates no message and no outbox row", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "g5");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "g5", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const readOnlyTrader = await createFixtureTrader(transaction, company.companyId, "g5", [
        "communication.trader.read",
      ]);
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: readOnlyTrader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      accessor.identity = {
        companyId: company.companyId,
        forcePasswordChange: false,
        identityId: readOnlyTrader.accountId,
        kind: "trader",
        permissions: new Set(["communication.trader.read"]),
        profileId: readOnlyTrader.traderId,
        sessionId: `trader-${readOnlyTrader.accountId}`,
      };
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
      });

      await expect(
        service.sendTextMessage(conversation.id, {
          clientMessageId: "g5-denied-message",
          idempotencyKey: `g5-denied-key-${runId}`,
          text: "Should never be created",
        }),
      ).rejects.toMatchObject({ errorCode: "communication_permission_denied" });

      const messages = await sql<{ count: string }>`
        select count(*)::text as count from messages where company_id = ${company.companyId}::uuid
      `.execute(transaction);
      expect(messages.rows[0]?.count).toBe("0");
      const outbox = await sql<{ count: string }>`
        select count(*)::text as count from communication_notification_outbox
         where company_id = ${company.companyId}::uuid
      `.execute(transaction);
      expect(outbox.rows[0]?.count).toBe("0");
      return undefined;
    });
  });

  it("H1: internal-identity event recovery advances the cursor and safely reports fullRefreshRequired once expired", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "h1");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "h1", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "h1", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      accessor.identity = traderIdentity(company.companyId, trader.accountId, trader.traderId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
      });
      await service.sendTextMessage(conversation.id, {
        clientMessageId: "h1-message",
        idempotencyKey: `h1-key-${runId}`,
        text: "Event for recovery",
      });

      accessor.identity = officeIdentity(company.companyId, office.accountId);
      const firstPage = await service.recoverEvents({});
      expect(firstPage.fullRefreshRequired).toBe(false);
      expect(firstPage.events.length).toBeGreaterThan(0);
      // The expiry check only looks at rows at-or-before the caller's own
      // cursor, so the fixture must resume from a real, now-expired sequence
      // — not from "0", which no real row is ever <= to.
      const lastSequence = (firstPage.events.at(-1) as { readonly sequence: string }).sequence;

      await sql`
        update realtime_event_log
           set expires_at = now() - interval '1 minute'
         where company_id = ${company.companyId}::uuid and audience_account_id = ${office.accountId}::uuid
      `.execute(transaction);
      const expiredPage = await service.recoverEvents({ after: lastSequence });
      expect(expiredPage).toEqual({ events: [], fullRefreshRequired: true, nextCursor: null });
      return undefined;
    });
  });

  it("H2: an office account never receives another Company's realtime events, even via a shared cursor value", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const companyA = await createFixtureCompany(transaction, runId, "h2a");
      const officeA = await createFixtureOfficeUser(transaction, companyA.companyId, "h2a", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const traderA = await createFixtureTrader(transaction, companyA.companyId, "h2a", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      const orderA = await createFixtureOrder(transaction, companyA.companyId, officeA.accountId, {
        traderId: traderA.traderId,
      });
      const companyB = await createFixtureCompany(transaction, runId, "h2b");
      const officeB = await createFixtureOfficeUser(transaction, companyB.companyId, "h2b", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const traderB = await createFixtureTrader(transaction, companyB.companyId, "h2b", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      const orderB = await createFixtureOrder(transaction, companyB.companyId, officeB.accountId, {
        traderId: traderB.traderId,
      });

      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      accessor.identity = traderIdentity(companyA.companyId, traderA.accountId, traderA.traderId);
      const conversationA = await service.resolveConversation({
        conversationType: "order",
        orderId: orderA.orderId,
      });
      await service.sendTextMessage(conversationA.id, {
        clientMessageId: "h2-message-a",
        idempotencyKey: `h2-key-a-${runId}`,
        text: "Company A event",
      });
      accessor.identity = traderIdentity(companyB.companyId, traderB.accountId, traderB.traderId);
      const conversationB = await service.resolveConversation({
        conversationType: "order",
        orderId: orderB.orderId,
      });
      await service.sendTextMessage(conversationB.id, {
        clientMessageId: "h2-message-b",
        idempotencyKey: `h2-key-b-${runId}`,
        text: "Company B event",
      });

      accessor.identity = officeIdentity(companyA.companyId, officeA.accountId);
      const eventsForA = await service.recoverEvents({ after: "0" });
      const payloadsA = eventsForA.events as readonly { readonly payload: { readonly conversationId: string } }[];
      expect(payloadsA.every((event) => event.payload.conversationId === conversationA.id)).toBe(true);
      expect(payloadsA.some((event) => event.payload.conversationId === conversationB.id)).toBe(false);
      return undefined;
    });
  });
});
