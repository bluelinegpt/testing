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
  createFixtureDriver,
  createFixtureOfficeUser,
  createFixtureOrder,
  createFixtureTrackingToken,
  createFixtureTrader,
  createTestCommunicationService,
  StaticIdentityAccessor,
  withRolledBackCommunicationFixtures,
} from "./communication.database-test-helpers.js";

const enabled = process.env.RUN_COMMUNICATION_DATABASE === "true";

function officeIdentity(
  companyId: string,
  accountId: string,
  permissions: readonly string[],
): IdentityContext & { companyId: string } {
  return {
    companyId,
    forcePasswordChange: false,
    identityId: accountId,
    kind: "company_user",
    permissions: new Set(permissions),
    sessionId: `office-${accountId}`,
  };
}

/** Prompt 13: participantName enrichment, priority filter, and the Office
 * conversation actions (resolve/reopen/priority/assign). */
describe.skipIf(!enabled)("guarded communication Office actions (Prompt 13)", () => {
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

  it("participantName resolves the Trader/Driver/Customer's own name, and is null when unattributed", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "pname");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "pname", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "pname", []);
      const driver = await createFixtureDriver(transaction, company.companyId, "pname", []);
      const customer = await createFixtureCustomer(
        transaction,
        company.companyId,
        office.accountId,
        "pname",
      );
      const traderOrder = await createFixtureOrder(
        transaction,
        company.companyId,
        office.accountId,
        {
          traderId: trader.traderId,
        },
      );
      const driverOrder = await createFixtureOrder(
        transaction,
        company.companyId,
        office.accountId,
        {
          driverId: driver.driverId,
          traderId: trader.traderId,
        },
      );
      const customerOrder = await createFixtureOrder(
        transaction,
        company.companyId,
        office.accountId,
        {
          customerId: customer.customerId,
          traderId: trader.traderId,
        },
      );
      const unattributedOrder = await createFixtureOrder(
        transaction,
        company.companyId,
        office.accountId,
        {
          traderId: trader.traderId,
        },
      );

      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(company.companyId, office.accountId, [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const service = createTestCommunicationService(transaction, accessor);

      const traderConversation = await service.resolveConversation({
        conversationType: "order",
        orderId: traderOrder.orderId,
        participantContextType: "trader",
      });
      const driverConversation = await service.resolveConversation({
        conversationType: "order",
        orderId: driverOrder.orderId,
        participantContextType: "driver",
      });
      // Customer-context conversations are created only through the trusted
      // Customer messaging session flow, never the office `resolve` route —
      // exercise it exactly the way a real Customer conversation is created.
      const tracking = await createFixtureTrackingToken(
        transaction,
        company.companyId,
        customerOrder.orderId,
      );
      const customerSession = await service.createCustomerMessagingSession({
        trackingToken: tracking.rawToken,
      });
      const customerConversation = await service.customerResolveConversation(
        customerSession.customerMessagingToken,
      );
      const unattributedConversation = await service.resolveConversation({
        conversationType: "order",
        orderId: unattributedOrder.orderId,
        participantContextType: "driver",
      });

      const list = await service.listConversations({});
      const byId = new Map(list.items.map((item) => [item.id, item]));
      expect(byId.get(traderConversation.id)?.participantName).toContain("Trader pname");
      expect(byId.get(driverConversation.id)?.participantName).toContain("Driver pname");
      expect(byId.get(customerConversation.id)?.participantName).toContain("Customer pname");
      // The Driver-context conversation for an Order with no assigned Driver
      // has nothing to resolve a name from.
      expect(byId.get(unattributedConversation.id)?.participantName).toBeNull();
      return undefined;
    });
  });

  it("the priority filter narrows the conversation list server-side", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "priofilter");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "priofilter", [
        "communication.operator.read",
        "communication.operator.send",
        "communication.operator.priority",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "priofilter", []);
      const orderNormal = await createFixtureOrder(
        transaction,
        company.companyId,
        office.accountId,
        {
          traderId: trader.traderId,
        },
      );
      const orderUrgent = await createFixtureOrder(
        transaction,
        company.companyId,
        office.accountId,
        {
          traderId: trader.traderId,
        },
      );

      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(company.companyId, office.accountId, [
        "communication.operator.read",
        "communication.operator.send",
        "communication.operator.priority",
      ]);
      const service = createTestCommunicationService(transaction, accessor);
      const normal = await service.resolveConversation({
        conversationType: "order",
        orderId: orderNormal.orderId,
        participantContextType: "trader",
      });
      const urgent = await service.resolveConversation({
        conversationType: "order",
        orderId: orderUrgent.orderId,
        participantContextType: "trader",
      });
      await service.setConversationPriority(urgent.id, { priority: "urgent" });

      const filtered = await service.listConversations({ priority: "urgent" });
      expect(filtered.items.map((item) => item.id)).toEqual([urgent.id]);
      expect(filtered.items.map((item) => item.id)).not.toContain(normal.id);
      return undefined;
    });
  });

  it("resolve/reopen/priority/assign each require their own dedicated permission", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "perm");
      const readOnlyOffice = await createFixtureOfficeUser(
        transaction,
        company.companyId,
        "perm-read",
        ["communication.operator.read", "communication.operator.send"],
      );
      const fullOffice = await createFixtureOfficeUser(
        transaction,
        company.companyId,
        "perm-full",
        [
          "communication.operator.read",
          "communication.operator.send",
          "communication.operator.resolve",
          "communication.operator.reopen",
          "communication.operator.priority",
          "communication.operator.assign",
        ],
      );
      const trader = await createFixtureTrader(transaction, company.companyId, "perm", []);
      const order = await createFixtureOrder(transaction, company.companyId, fullOffice.accountId, {
        traderId: trader.traderId,
      });

      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(company.companyId, fullOffice.accountId, [
        "communication.operator.read",
        "communication.operator.send",
        "communication.operator.resolve",
        "communication.operator.reopen",
        "communication.operator.priority",
        "communication.operator.assign",
      ]);
      const fullService = createTestCommunicationService(transaction, accessor);
      const conversation = await fullService.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
        participantContextType: "trader",
      });

      const readOnlyAccessor = new StaticIdentityAccessor();
      readOnlyAccessor.identity = officeIdentity(company.companyId, readOnlyOffice.accountId, [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const readOnlyService = createTestCommunicationService(transaction, readOnlyAccessor);

      await expect(readOnlyService.markConversationResolved(conversation.id)).rejects.toMatchObject(
        { errorCode: "communication_permission_denied" },
      );
      await expect(readOnlyService.reopenConversation(conversation.id)).rejects.toMatchObject({
        errorCode: "communication_permission_denied",
      });
      await expect(
        readOnlyService.setConversationPriority(conversation.id, { priority: "high" }),
      ).rejects.toMatchObject({ errorCode: "communication_permission_denied" });
      await expect(readOnlyService.assignConversation(conversation.id, {})).rejects.toMatchObject({
        errorCode: "communication_permission_denied",
      });

      // The fully-permissioned office account can do all four, and each one
      // is reflected immediately in the returned summary.
      const resolved = await fullService.markConversationResolved(conversation.id);
      expect(resolved.status).toBe("resolved");
      const reopened = await fullService.reopenConversation(conversation.id);
      expect(reopened.status).toBe("reopened");
      const prioritized = await fullService.setConversationPriority(conversation.id, {
        priority: "urgent",
      });
      expect(prioritized.priority).toBe("urgent");
      const assigned = await fullService.assignConversation(conversation.id, {
        operatorAccountId: fullOffice.accountId,
      });
      expect(assigned.id).toBe(conversation.id);
      return undefined;
    });
  });

  it("assign refuses an assignee outside the Company, and clears assignment with no id", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const companyA = await createFixtureCompany(transaction, runId, "assigna");
      const officeA = await createFixtureOfficeUser(transaction, companyA.companyId, "assigna", [
        "communication.operator.read",
        "communication.operator.send",
        "communication.operator.assign",
      ]);
      const traderA = await createFixtureTrader(transaction, companyA.companyId, "assigna", []);
      const orderA = await createFixtureOrder(transaction, companyA.companyId, officeA.accountId, {
        traderId: traderA.traderId,
      });
      const companyB = await createFixtureCompany(transaction, runId, "assignb");
      const officeB = await createFixtureOfficeUser(transaction, companyB.companyId, "assignb", [
        "communication.operator.read",
      ]);

      const accessor = new StaticIdentityAccessor();
      accessor.identity = officeIdentity(companyA.companyId, officeA.accountId, [
        "communication.operator.read",
        "communication.operator.send",
        "communication.operator.assign",
      ]);
      const service = createTestCommunicationService(transaction, accessor);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: orderA.orderId,
        participantContextType: "trader",
      });

      await expect(
        service.assignConversation(conversation.id, { operatorAccountId: officeB.accountId }),
      ).rejects.toMatchObject({ errorCode: "assignee_not_found" });

      const assigned = await service.assignConversation(conversation.id, {
        operatorAccountId: officeA.accountId,
      });
      expect(assigned.id).toBe(conversation.id);
      // Ownership is readable back — required for the Web Communication
      // Center's "assign to me" / "unassign" controls to reflect real state.
      expect(assigned.assignedOperatorAccountId).toBe(officeA.accountId);
      expect(typeof assigned.assignedOperatorName).toBe("string");
      // Clearing the assignment (no id in the body) is a valid, distinct action.
      const cleared = await service.assignConversation(conversation.id, {});
      expect(cleared.id).toBe(conversation.id);
      expect(cleared.assignedOperatorAccountId).toBeNull();
      expect(cleared.assignedOperatorName).toBeNull();
      return undefined;
    });
  });

  it("Company isolation: an office identity from Company B cannot act on Company A's conversation", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const companyA = await createFixtureCompany(transaction, runId, "isoa");
      const officeA = await createFixtureOfficeUser(transaction, companyA.companyId, "isoa", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const traderA = await createFixtureTrader(transaction, companyA.companyId, "isoa", []);
      const orderA = await createFixtureOrder(transaction, companyA.companyId, officeA.accountId, {
        traderId: traderA.traderId,
      });
      const companyB = await createFixtureCompany(transaction, runId, "isob");
      const officeB = await createFixtureOfficeUser(transaction, companyB.companyId, "isob", [
        "communication.operator.read",
        "communication.operator.send",
        "communication.operator.resolve",
      ]);

      const accessorA = new StaticIdentityAccessor();
      accessorA.identity = officeIdentity(companyA.companyId, officeA.accountId, [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const serviceA = createTestCommunicationService(transaction, accessorA);
      const conversation = await serviceA.resolveConversation({
        conversationType: "order",
        orderId: orderA.orderId,
        participantContextType: "trader",
      });

      const accessorB = new StaticIdentityAccessor();
      accessorB.identity = officeIdentity(companyB.companyId, officeB.accountId, [
        "communication.operator.read",
        "communication.operator.send",
        "communication.operator.resolve",
      ]);
      const serviceB = createTestCommunicationService(transaction, accessorB);
      await expect(serviceB.markConversationResolved(conversation.id)).rejects.toMatchObject({
        errorCode: "conversation_access_denied",
      });
      return undefined;
    });
  });
});
