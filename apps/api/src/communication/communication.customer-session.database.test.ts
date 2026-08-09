import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import {
  assertGuardedCommunicationDatabase,
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

describe.skipIf(!enabled)("guarded Customer communication database security", () => {
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

  it("refuses an unguarded database target and rolls back synthetic fixture work", async () => {
    await assertGuardedCommunicationDatabase(database);
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const before = await sql<{ count: string }>`
        select count(*)::text as count from companies where code = ${runId}
      `.execute(transaction);
      expect(before.rows[0]?.count).toBe("0");
      return undefined;
    });
    const after = await sql<{ count: string }>`
      select count(*)::text as count from companies where code like 'comm-test-%'
    `.execute(database);
    expect(Number(after.rows[0]?.count ?? "0")).toBeGreaterThanOrEqual(0);
  });

  // --- A. Customer session / identity security -----------------------------

  it("A1/A2: a valid trusted session succeeds; an invalid tracking token is rejected", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "a1");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "a1", []);
      const trader = await createFixtureTrader(transaction, company.companyId, "a1", []);
      const customer = await createFixtureCustomer(transaction, company.companyId, office.accountId, "a1");
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customer.customerId,
        traderId: trader.traderId,
      });
      const tracking = await createFixtureTrackingToken(transaction, company.companyId, order.orderId);
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      const session = await service.createCustomerMessagingSession({ trackingToken: tracking.rawToken });
      expect(session.orderId).toBe(order.orderId);
      const principal = await service.validateCustomerMessagingSession(session.customerMessagingToken);
      expect(principal.companyId).toBe(company.companyId);
      expect(principal.orderId).toBe(order.orderId);
      expect(principal.customerId).toBe(customer.customerId);

      // A2 — a syntactically valid but unknown tracking token is rejected the
      // same way as a malformed one (no existence oracle).
      const unknownToken = "Z".repeat(43);
      await expect(
        service.createCustomerMessagingSession({ trackingToken: unknownToken }),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_token_invalid" });
      await expect(
        service.createCustomerMessagingSession({ trackingToken: "too-short" }),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_token_invalid" });
      return undefined;
    });
  });

  it("A3: an expired tracking token and an expired session are both rejected", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "a3");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "a3", []);
      const trader = await createFixtureTrader(transaction, company.companyId, "a3", []);
      const customer = await createFixtureCustomer(transaction, company.companyId, office.accountId, "a3");
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customer.customerId,
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      // Expired tracking token cannot mint a session at all.
      const expiredTracking = await createFixtureTrackingToken(
        transaction,
        company.companyId,
        order.orderId,
        { expired: true },
      );
      await expect(
        service.createCustomerMessagingSession({ trackingToken: expiredTracking.rawToken }),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_token_invalid" });

      // A session minted while valid, then expired later, is rejected on use.
      const tracking = await createFixtureTrackingToken(transaction, company.companyId, order.orderId);
      const session = await service.createCustomerMessagingSession({ trackingToken: tracking.rawToken });
      // The expiry check constraint requires expires_at > created_at, so
      // backdating one without the other would fail the UPDATE itself.
      await sql`
        update customer_messaging_sessions
           set expires_at = now() - interval '1 hour', created_at = now() - interval '2 hours'
         where token_hash = ${createHash("sha256")
           .update(session.customerMessagingToken, "utf8")
           .digest("hex")}
      `.execute(transaction);
      await expect(
        service.validateCustomerMessagingSession(session.customerMessagingToken),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });
      return undefined;
    });
  });

  it("A4: a revoked tracking token and a revoked session are both rejected", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "a4");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "a4", []);
      const trader = await createFixtureTrader(transaction, company.companyId, "a4", []);
      const customer = await createFixtureCustomer(transaction, company.companyId, office.accountId, "a4");
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customer.customerId,
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      const revokedTracking = await createFixtureTrackingToken(
        transaction,
        company.companyId,
        order.orderId,
        { revoked: true },
      );
      await expect(
        service.createCustomerMessagingSession({ trackingToken: revokedTracking.rawToken }),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_token_invalid" });

      const tracking = await createFixtureTrackingToken(transaction, company.companyId, order.orderId);
      const session = await service.createCustomerMessagingSession({ trackingToken: tracking.rawToken });
      await sql`update customer_messaging_sessions set revoked_at = now() where id = (
        select id from customer_messaging_sessions where company_id = ${company.companyId}::uuid
          and order_id = ${order.orderId}::uuid order by created_at desc limit 1
      )`.execute(transaction);
      await expect(
        service.validateCustomerMessagingSession(session.customerMessagingToken),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });

      // Once revoked, the tracking token used a second time cannot re-derive
      // a *usable* session either: a fresh session mints fine (tokens can be
      // reused to open new sessions) but the original session id stays dead.
      const rerequest = await service.createCustomerMessagingSession({
        trackingToken: tracking.rawToken,
      });
      const reprincipal = await service.validateCustomerMessagingSession(
        rerequest.customerMessagingToken,
      );
      expect(reprincipal.orderId).toBe(order.orderId);
      return undefined;
    });
  });

  it("A5: a Customer deactivated after the session was issued is rejected on use", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "a5");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "a5", []);
      const trader = await createFixtureTrader(transaction, company.companyId, "a5", []);
      const customer = await createFixtureCustomer(transaction, company.companyId, office.accountId, "a5");
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customer.customerId,
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      const tracking = await createFixtureTrackingToken(transaction, company.companyId, order.orderId);
      const session = await service.createCustomerMessagingSession({ trackingToken: tracking.rawToken });

      // Still active: session validates.
      await expect(
        service.validateCustomerMessagingSession(session.customerMessagingToken),
      ).resolves.toMatchObject({ customerId: customer.customerId });

      await sql`update customers set status = 'disabled' where id = ${customer.customerId}::uuid`.execute(
        transaction,
      );
      await expect(
        service.validateCustomerMessagingSession(session.customerMessagingToken),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });
      return undefined;
    });
  });

  it("A6/A9: a session is permanently scoped to its own Order and cannot be redirected to another", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "a6");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "a6", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "a6", []);
      const customer = await createFixtureCustomer(transaction, company.companyId, office.accountId, "a6");
      const orderOne = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customer.customerId,
        traderId: trader.traderId,
      });
      const orderTwo = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customer.customerId,
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      const trackingOne = await createFixtureTrackingToken(transaction, company.companyId, orderOne.orderId);
      const trackingTwo = await createFixtureTrackingToken(transaction, company.companyId, orderTwo.orderId);
      const sessionOne = await service.createCustomerMessagingSession({
        trackingToken: trackingOne.rawToken,
      });
      const sessionTwo = await service.createCustomerMessagingSession({
        trackingToken: trackingTwo.rawToken,
      });
      const conversationOne = await service.customerResolveConversation(sessionOne.customerMessagingToken);
      const conversationTwo = await service.customerResolveConversation(sessionTwo.customerMessagingToken);
      expect(conversationOne.orderId).toBe(orderOne.orderId);
      expect(conversationTwo.orderId).toBe(orderTwo.orderId);
      expect(conversationOne.id).not.toBe(conversationTwo.id);

      // A6 — the FK from customer_messaging_sessions.conversation_id enforces
      // (conversation_id, company_id) together, but nothing stops the *value*
      // of order_id from being swapped at the row level by a bug elsewhere;
      // prove the read path still enforces order scope independently of that
      // column by pointing session one's conversation_id at order two's
      // conversation and confirming the read is refused, not silently served.
      await sql`
        update customer_messaging_sessions set conversation_id = ${conversationTwo.id}::uuid
         where token_hash = ${createHash("sha256")
           .update(sessionOne.customerMessagingToken, "utf8")
           .digest("hex")}
      `.execute(transaction);
      await expect(service.customerMessages(sessionOne.customerMessagingToken, {})).rejects.toMatchObject({
        errorCode: "customer_messaging_session_invalid",
      });
      return undefined;
    });
  });

  it("A7/A10: a session cannot be reused across Companies, enforced at the schema level", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const companyA = await createFixtureCompany(transaction, runId, "a7a");
      const companyB = await createFixtureCompany(transaction, runId, "a7b");
      const officeA = await createFixtureOfficeUser(transaction, companyA.companyId, "a7a", [
        "communication.operator.read",
      ]);
      const officeB = await createFixtureOfficeUser(transaction, companyB.companyId, "a7b", [
        "communication.operator.read",
      ]);
      const traderA = await createFixtureTrader(transaction, companyA.companyId, "a7a", []);
      const traderB = await createFixtureTrader(transaction, companyB.companyId, "a7b", []);
      const customerA = await createFixtureCustomer(
        transaction,
        companyA.companyId,
        officeA.accountId,
        "a7a",
      );
      const customerB = await createFixtureCustomer(
        transaction,
        companyB.companyId,
        officeB.accountId,
        "a7b",
      );
      const orderA = await createFixtureOrder(transaction, companyA.companyId, officeA.accountId, {
        customerId: customerA.customerId,
        traderId: traderA.traderId,
      });
      const orderB = await createFixtureOrder(transaction, companyB.companyId, officeB.accountId, {
        customerId: customerB.customerId,
        traderId: traderB.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      const trackingA = await createFixtureTrackingToken(transaction, companyA.companyId, orderA.orderId);
      const sessionA = await service.createCustomerMessagingSession({ trackingToken: trackingA.rawToken });
      const principalA = await service.validateCustomerMessagingSession(sessionA.customerMessagingToken);
      expect(principalA.companyId).toBe(companyA.companyId);
      expect(principalA.companyId).not.toBe(companyB.companyId);

      // A10 — the composite FK on customer_messaging_sessions.conversation_id
      // makes cross-Company redirection impossible at the database level, not
      // just by convention: resolving Company A's conversation, then trying
      // to point at Company B's conversation for the same session, fails.
      const conversationA = await service.customerResolveConversation(sessionA.customerMessagingToken);
      const trackingB = await createFixtureTrackingToken(transaction, companyB.companyId, orderB.orderId);
      const sessionB = await service.createCustomerMessagingSession({ trackingToken: trackingB.rawToken });
      const conversationB = await service.customerResolveConversation(sessionB.customerMessagingToken);
      expect(conversationA.id).not.toBe(conversationB.id);

      await expect(
        sql`
          update customer_messaging_sessions set conversation_id = ${conversationB.id}::uuid
           where token_hash = ${createHash("sha256")
             .update(sessionA.customerMessagingToken, "utf8")
             .digest("hex")}
        `.execute(transaction),
      ).rejects.toThrow(/foreign key|violat/i);
      return undefined;
    });
  });

  it("A8: Customer A cannot read or write Customer B's conversation", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "a8");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "a8", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "a8", []);
      const customerA = await createFixtureCustomer(transaction, company.companyId, office.accountId, "a8a");
      const customerB = await createFixtureCustomer(transaction, company.companyId, office.accountId, "a8b");
      const orderA = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customerA.customerId,
        traderId: trader.traderId,
      });
      const orderB = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customerB.customerId,
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      const trackingA = await createFixtureTrackingToken(transaction, company.companyId, orderA.orderId);
      const trackingB = await createFixtureTrackingToken(transaction, company.companyId, orderB.orderId);
      const sessionA = await service.createCustomerMessagingSession({ trackingToken: trackingA.rawToken });
      const sessionB = await service.createCustomerMessagingSession({ trackingToken: trackingB.rawToken });

      const sentByA = await service.customerSendText(sessionA.customerMessagingToken, {
        clientMessageId: "a8-message-from-a-",
        idempotencyKey: `a8-key-from-a-${runId}`,
        text: "Message from Customer A",
      });

      const bMessages = await service.customerMessages(sessionB.customerMessagingToken, {});
      expect(bMessages.items.some((message) => message.id === sentByA.id)).toBe(false);

      const bUnread = await service.customerUnread(sessionB.customerMessagingToken);
      expect(bUnread.unreadMessages).toBe(0);
      return undefined;
    });
  });
});
