import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
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

/**
 * B. Customer REST security — the guarded Customer messaging surface
 * (`/customer/messaging/*`) is a thin, `@Public()` controller over these
 * exact service methods, so exercising them here with real fixtures and a
 * real transaction proves the endpoints, not a mock.
 */
describe.skipIf(!enabled)("guarded Customer communication REST security", () => {
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

  async function buildScenario(runId: string, transaction: Transaction<DatabaseSchema>) {
    const company = await createFixtureCompany(transaction, runId, "b");
    const office = await createFixtureOfficeUser(transaction, company.companyId, "b", [
      "communication.operator.read",
      "communication.operator.send",
    ]);
    const trader = await createFixtureTrader(transaction, company.companyId, "b", []);
    const customer = await createFixtureCustomer(
      transaction,
      company.companyId,
      office.accountId,
      "b",
    );
    const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
      customerId: customer.customerId,
      traderId: trader.traderId,
    });
    const tracking = await createFixtureTrackingToken(
      transaction,
      company.companyId,
      order.orderId,
    );
    const accessor = new StaticIdentityAccessor();
    const service = createTestCommunicationService(transaction, accessor);
    const session = await service.createCustomerMessagingSession({
      trackingToken: tracking.rawToken,
    });
    return { accessor, company, customer, office, order, service, session, trader };
  }

  it("resolves the Customer conversation once and reuses it on every later call", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const { service, session, order } = await buildScenario(runId, transaction);
      const first = await service.customerResolveConversation(session.customerMessagingToken);
      const second = await service.customerResolveConversation(session.customerMessagingToken);
      expect(second.id).toBe(first.id);
      expect(first.orderId).toBe(order.orderId);
      expect(first.participantContextType).toBe("customer");
      return undefined;
    });
  });

  it("send/history/read/unread-count form a consistent, correctly scoped lifecycle", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const { service, session, office, company, order } = await buildScenario(runId, transaction);

      // The Customer's own message never counts toward their own unread total.
      const customerMessage = await service.customerSendText(session.customerMessagingToken, {
        clientMessageId: "b-lifecycle-customer-1",
        idempotencyKey: `b-lifecycle-key-1-${runId}`,
        text: "Where is my package?",
      });
      expect(await service.customerUnread(session.customerMessagingToken)).toMatchObject({
        unreadConversations: 0,
        unreadMessages: 0,
      });

      // Reject empty and over-long text — masked behind the same generic
      // session-invalid error the customer surface always uses, never a
      // distinct "validation" shape that would leak internal detail.
      await expect(
        service.customerSendText(session.customerMessagingToken, {
          clientMessageId: "b-lifecycle-empty",
          idempotencyKey: `b-lifecycle-empty-${runId}`,
          text: "   ",
        }),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });
      await expect(
        service.customerSendText(session.customerMessagingToken, {
          clientMessageId: "b-lifecycle-toolong",
          idempotencyKey: `b-lifecycle-toolong-${runId}`,
          text: "x".repeat(4001),
        }),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });

      // The office side replies twice; the Customer sees both as unread.
      const accessor = new StaticIdentityAccessor();
      accessor.identity = {
        companyId: company.companyId,
        forcePasswordChange: false,
        identityId: office.accountId,
        kind: "company_user",
        permissions: new Set(["communication.operator.read", "communication.operator.send"]),
        sessionId: "office-session",
      };
      const officeService = createTestCommunicationService(transaction, accessor);
      const conversation = await service.customerResolveConversation(
        session.customerMessagingToken,
      );
      const officeReplyOne = await officeService.sendTextMessage(conversation.id, {
        clientMessageId: "b-lifecycle-office-1",
        idempotencyKey: `b-lifecycle-office-key-1-${runId}`,
        text: "Checking now",
      });
      const officeReplyTwo = await officeService.sendTextMessage(conversation.id, {
        clientMessageId: "b-lifecycle-office-2",
        idempotencyKey: `b-lifecycle-office-key-2-${runId}`,
        text: "It is out for delivery",
      });

      const unreadAfterReplies = await service.customerUnread(session.customerMessagingToken);
      expect(unreadAfterReplies).toEqual({ unreadConversations: 1, unreadMessages: 2 });

      // History returns every message, oldest first, correctly scoped to
      // this Order's Company.
      const history = await service.customerMessages(session.customerMessagingToken, {});
      expect(history.items.map((message) => message.id)).toEqual([
        customerMessage.id,
        officeReplyOne.id,
        officeReplyTwo.id,
      ]);

      // Marking read through the first office reply leaves exactly the
      // second unread — the read cursor is precise, not all-or-nothing.
      const afterFirstRead = await service.customerMarkRead(session.customerMessagingToken, {
        throughMessageId: officeReplyOne.id,
      });
      expect(afterFirstRead.unreadCount).toBe(1);
      const afterSecondRead = await service.customerMarkRead(session.customerMessagingToken, {
        throughMessageId: officeReplyTwo.id,
      });
      expect(afterSecondRead.unreadCount).toBe(0);

      // Marking read against a message id that exists but is outside this
      // Customer's own conversation/Company is refused, not silently a no-op.
      const otherCompany = await createFixtureCompany(transaction, runId, "b-foreign");
      const otherOffice = await createFixtureOfficeUser(
        transaction,
        otherCompany.companyId,
        "b-foreign",
        ["communication.operator.read", "communication.operator.send"],
      );
      const otherTrader = await createFixtureTrader(
        transaction,
        otherCompany.companyId,
        "b-foreign",
        [],
      );
      const otherCustomer = await createFixtureCustomer(
        transaction,
        otherCompany.companyId,
        otherOffice.accountId,
        "b-foreign",
      );
      const otherOrder = await createFixtureOrder(
        transaction,
        otherCompany.companyId,
        otherOffice.accountId,
        { customerId: otherCustomer.customerId, traderId: otherTrader.traderId },
      );
      const otherTracking = await createFixtureTrackingToken(
        transaction,
        otherCompany.companyId,
        otherOrder.orderId,
      );
      const otherSession = await service.createCustomerMessagingSession({
        trackingToken: otherTracking.rawToken,
      });
      const otherAccessor = new StaticIdentityAccessor();
      otherAccessor.identity = {
        companyId: otherCompany.companyId,
        forcePasswordChange: false,
        identityId: otherOffice.accountId,
        kind: "company_user",
        permissions: new Set(["communication.operator.read", "communication.operator.send"]),
        sessionId: "other-office-session",
      };
      const otherOfficeService = createTestCommunicationService(transaction, otherAccessor);
      const otherConversation = await service.customerResolveConversation(
        otherSession.customerMessagingToken,
      );
      const foreignMessage = await otherOfficeService.sendTextMessage(otherConversation.id, {
        clientMessageId: "b-lifecycle-foreign",
        idempotencyKey: `b-lifecycle-foreign-key-${runId}`,
        text: "Foreign company message",
      });
      await expect(
        service.customerMarkRead(session.customerMessagingToken, {
          throughMessageId: foreignMessage.id,
        }),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });
      expect(order.orderId).not.toBe(otherOrder.orderId);
      return undefined;
    });
  });

  it("realtime recovery advances the cursor and safely reports fullRefreshRequired once it expires", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const { service, session, office, company } = await buildScenario(runId, transaction);
      const conversation = await service.customerResolveConversation(
        session.customerMessagingToken,
      );

      const accessor = new StaticIdentityAccessor();
      accessor.identity = {
        companyId: company.companyId,
        forcePasswordChange: false,
        identityId: office.accountId,
        kind: "company_user",
        permissions: new Set(["communication.operator.read", "communication.operator.send"]),
        sessionId: "office-session",
      };
      const officeService = createTestCommunicationService(transaction, accessor);
      await officeService.sendTextMessage(conversation.id, {
        clientMessageId: "b-recovery-office-1",
        idempotencyKey: `b-recovery-key-1-${runId}`,
        text: "First update",
      });

      const firstPage = await service.customerRecoverEvents(session.customerMessagingToken, {});
      expect(firstPage.fullRefreshRequired).toBe(false);
      expect(firstPage.events.length).toBeGreaterThan(0);
      // `nextCursor` only carries a value when there is a further page — the
      // whole page fits under the limit here, so it is legitimately null;
      // resuming from here means resuming from the last event's own sequence.
      expect(firstPage.nextCursor).toBeNull();
      const lastSequence = (firstPage.events.at(-1) as { readonly sequence: string }).sequence;

      const emptyReplay = await service.customerRecoverEvents(session.customerMessagingToken, {
        after: lastSequence,
      });
      expect(emptyReplay.events).toEqual([]);
      expect(emptyReplay.fullRefreshRequired).toBe(false);

      // Force every event at-or-before the cursor to have already expired;
      // the customer replay path must report `fullRefreshRequired` instead
      // of silently returning an empty page indistinguishable from "caught up".
      // This fixture Company has exactly one conversation's worth of events,
      // so scoping the update to company_id alone is unambiguous.
      await sql`
        update realtime_event_log
           set expires_at = now() - interval '1 minute'
         where company_id = ${company.companyId}::uuid
      `.execute(transaction);
      const expiredPage = await service.customerRecoverEvents(session.customerMessagingToken, {
        after: lastSequence,
      });
      expect(expiredPage).toEqual({ events: [], fullRefreshRequired: true, nextCursor: null });
      return undefined;
    });
  });
});
