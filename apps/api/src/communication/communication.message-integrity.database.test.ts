import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
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

/** E. Message idempotency. F. Read/unread integrity. */
describe.skipIf(!enabled)("guarded communication message integrity and read-state security", () => {
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

  it("E1/E2: a duplicate send with the same key is idempotent; a reused key with a different payload is a conflict", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "e1");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "e1", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "e1", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      accessor.identity = {
        companyId: company.companyId,
        forcePasswordChange: false,
        identityId: trader.accountId,
        kind: "trader",
        permissions: new Set(["communication.trader.read", "communication.trader.send"]),
        profileId: trader.traderId,
        sessionId: "trader-session",
      };
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
      });
      const key = `e1-key-${runId}`;

      const first = await service.sendTextMessage(conversation.id, {
        clientMessageId: "e1-client-message",
        idempotencyKey: key,
        text: "Where is my delivery?",
      });
      const retry = await service.sendTextMessage(conversation.id, {
        clientMessageId: "e1-client-message",
        idempotencyKey: key,
        text: "Where is my delivery?",
      });
      expect(retry.id).toBe(first.id);
      const history = await service.getMessages(conversation.id, {});
      expect(history.items.filter((message) => message.id === first.id)).toHaveLength(1);

      // Same key, different payload: refused as a conflict, not silently applied.
      await expect(
        service.sendTextMessage(conversation.id, {
          clientMessageId: "e1-client-message-different",
          idempotencyKey: key,
          text: "A completely different message",
        }),
      ).rejects.toMatchObject({ errorCode: "idempotency_conflict" });
      return undefined;
    });
  });

  it("E3: an idempotency key reused across a different conversation is rejected, not silently cross-served (internal path)", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "e3");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "e3", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const traderOne = await createFixtureTrader(transaction, company.companyId, "e3-one", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      const traderTwo = await createFixtureTrader(transaction, company.companyId, "e3-two", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      const orderOne = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: traderOne.traderId,
      });
      const orderTwo = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: traderTwo.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = {
        companyId: company.companyId,
        forcePasswordChange: false,
        identityId: traderOne.accountId,
        kind: "trader",
        permissions: new Set(["communication.trader.read", "communication.trader.send"]),
        profileId: traderOne.traderId,
        sessionId: "trader-one-session",
      };
      const conversationOne = await service.resolveConversation({
        conversationType: "order",
        orderId: orderOne.orderId,
      });
      const sharedKey = `e3-shared-key-${runId}`;
      const sharedClientMessageId = "e3-shared-client-message";
      const sharedText = "Collision-prone payload";
      const messageInConversationOne = await service.sendTextMessage(conversationOne.id, {
        clientMessageId: sharedClientMessageId,
        idempotencyKey: sharedKey,
        text: sharedText,
      });

      // Trader Two, a legitimate participant of a *different* conversation in
      // the same Company, happens to submit the exact same idempotency key,
      // client message id, and text (a realistic collision from a buggy
      // client-side key generator, or a deliberate replay). The server must
      // refuse this — reusing conversation one's message under conversation
      // two's identity, instead of scoping strictly to the requested
      // conversation, is the exact defect already fixed on the Customer path.
      accessor.identity = {
        companyId: company.companyId,
        forcePasswordChange: false,
        identityId: traderTwo.accountId,
        kind: "trader",
        permissions: new Set(["communication.trader.read", "communication.trader.send"]),
        profileId: traderTwo.traderId,
        sessionId: "trader-two-session",
      };
      const conversationTwo = await service.resolveConversation({
        conversationType: "order",
        orderId: orderTwo.orderId,
      });
      await expect(
        service.sendTextMessage(conversationTwo.id, {
          clientMessageId: sharedClientMessageId,
          idempotencyKey: sharedKey,
          text: sharedText,
        }),
      ).rejects.toMatchObject({ errorCode: "idempotency_key_scope_denied" });
      const conversationTwoHistory = await service.getMessages(conversationTwo.id, {});
      expect(conversationTwoHistory.items).toEqual([]);
      expect(messageInConversationOne.id).toBeDefined();
      return undefined;
    });
  });

  it("E3 (Customer path regression): cross-conversation idempotency-key reuse stays rejected", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "e3c");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "e3c", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "e3c", []);
      const customerOne = await createFixtureCustomer(transaction, company.companyId, office.accountId, "e3c1");
      const customerTwo = await createFixtureCustomer(transaction, company.companyId, office.accountId, "e3c2");
      const orderOne = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customerOne.customerId,
        traderId: trader.traderId,
      });
      const orderTwo = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customerTwo.customerId,
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      const trackingOne = await createFixtureTrackingToken(transaction, company.companyId, orderOne.orderId);
      const trackingTwo = await createFixtureTrackingToken(transaction, company.companyId, orderTwo.orderId);
      const sessionOne = await service.createCustomerMessagingSession({ trackingToken: trackingOne.rawToken });
      const sessionTwo = await service.createCustomerMessagingSession({ trackingToken: trackingTwo.rawToken });
      const sharedKey = `e3c-shared-key-${runId}`;

      const messageOne = await service.customerSendText(sessionOne.customerMessagingToken, {
        clientMessageId: "e3c-shared-client-message",
        idempotencyKey: sharedKey,
        text: "Collision-prone customer payload",
      });

      await expect(
        service.customerSendText(sessionTwo.customerMessagingToken, {
          clientMessageId: "e3c-shared-client-message",
          idempotencyKey: sharedKey,
          text: "Collision-prone customer payload",
        }),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });
      const conversationTwoHistory = await service.customerMessages(sessionTwo.customerMessagingToken, {});
      expect(conversationTwoHistory.items).toEqual([]);
      expect(messageOne.id).toBeDefined();
      return undefined;
    });
  });

  it("F1: marking read is per-principal — one participant's read cursor never advances another's", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "f1");
      const officeOne = await createFixtureOfficeUser(transaction, company.companyId, "f1-office-one", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const officeTwo = await createFixtureOfficeUser(transaction, company.companyId, "f1-office-two", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "f1", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      const order = await createFixtureOrder(transaction, company.companyId, officeOne.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = {
        companyId: company.companyId,
        forcePasswordChange: false,
        identityId: trader.accountId,
        kind: "trader",
        permissions: new Set(["communication.trader.read", "communication.trader.send"]),
        profileId: trader.traderId,
        sessionId: "trader-session",
      };
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
      });
      const message = await service.sendTextMessage(conversation.id, {
        clientMessageId: "f1-trader-message",
        idempotencyKey: `f1-trader-key-${runId}`,
        text: "Status update needed",
      });

      // Two different office accounts are both participants (added
      // automatically as office participants on conversation creation).
      accessor.identity = officeIdentity(company.companyId, officeOne.accountId);
      const beforeRead = await service.getMessages(conversation.id, {});
      expect(beforeRead.items).toHaveLength(1);
      await service.markRead(conversation.id, { throughMessageId: message.id });

      // Office One's read does not affect Office Two's unread state.
      accessor.identity = officeIdentity(company.companyId, officeTwo.accountId);
      const officeTwoConversations = await service.listConversations({});
      const target = officeTwoConversations.items.find((item) => item.id === conversation.id);
      expect(target?.unreadCount).toBe(1);

      accessor.identity = officeIdentity(company.companyId, officeOne.accountId);
      const officeOneConversations = await service.listConversations({});
      const targetForOfficeOne = officeOneConversations.items.find((item) => item.id === conversation.id);
      expect(targetForOfficeOne?.unreadCount).toBe(0);
      return undefined;
    });
  });
});
