import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { IdentityContext } from "../security/identity-context.js";
import {
  createFixtureCompany,
  createFixtureDriver,
  createFixtureOfficeUser,
  createFixtureOrder,
  createFixtureTrader,
  createTestCommunicationService,
  StaticIdentityAccessor,
  withRolledBackCommunicationFixtures,
} from "./communication.database-test-helpers.js";

const enabled = process.env.RUN_COMMUNICATION_DATABASE === "true";

function identityFor(
  companyId: string,
  accountId: string,
  kind: IdentityContext["kind"],
  permissions: readonly string[],
  profileId?: string,
): IdentityContext & { companyId: string } {
  return {
    companyId,
    forcePasswordChange: false,
    identityId: accountId,
    kind,
    permissions: new Set(permissions),
    ...(profileId === undefined ? {} : { profileId }),
    sessionId: `session-${accountId}`,
  };
}

/** D. Cross-role / cross-Company security. */
describe.skipIf(!enabled)("guarded communication cross-role and cross-Company security", () => {
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

  async function buildCompany(
    transaction: Transaction<DatabaseSchema>,
    runId: string,
    label: string,
  ) {
    const company = await createFixtureCompany(transaction, runId, label);
    const office = await createFixtureOfficeUser(transaction, company.companyId, label, [
      "communication.operator.read",
      "communication.operator.send",
    ]);
    const trader = await createFixtureTrader(transaction, company.companyId, label, [
      "communication.trader.read",
      "communication.trader.send",
    ]);
    const driver = await createFixtureDriver(transaction, company.companyId, label, [
      "communication.driver.read",
      "communication.driver.send",
    ]);
    const traderOrder = await createFixtureOrder(transaction, company.companyId, office.accountId, {
      traderId: trader.traderId,
    });
    const driverOrder = await createFixtureOrder(transaction, company.companyId, office.accountId, {
      driverId: driver.driverId,
      traderId: trader.traderId,
    });
    return { company, driver, driverOrder, office, trader, traderOrder };
  }

  it("D1: cross-Company access is refused even for a real conversation id in another Company", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const a = await buildCompany(transaction, runId, "d1a");
      const b = await buildCompany(transaction, runId, "d1b");
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = identityFor(
        b.company.companyId,
        b.trader.accountId,
        "trader",
        ["communication.trader.read", "communication.trader.send"],
        b.trader.traderId,
      );
      const conversationB = await service.resolveConversation({
        conversationType: "order",
        orderId: b.traderOrder.orderId,
      });

      // Company A's Trader, holding a real conversation id from Company B,
      // is refused — the identifier alone carries no authority.
      accessor.identity = identityFor(
        a.company.companyId,
        a.trader.accountId,
        "trader",
        ["communication.trader.read", "communication.trader.send"],
        a.trader.traderId,
      );
      await expect(service.getMessages(conversationB.id, {})).rejects.toMatchObject({
        errorCode: "conversation_access_denied",
      });
      await expect(
        service.sendTextMessage(conversationB.id, {
          clientMessageId: "d1-cross-company",
          idempotencyKey: `d1-cross-company-key-${runId}`,
          text: "Should never land in Company B",
        }),
      ).rejects.toMatchObject({ errorCode: "conversation_access_denied" });
      return undefined;
    });
  });

  it("D2/D3: Driver <-> Trader direct communication is architecturally impossible", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const scenario = await buildCompany(transaction, runId, "d2");
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = identityFor(
        scenario.company.companyId,
        scenario.driver.accountId,
        "driver",
        ["communication.driver.read", "communication.driver.send"],
        scenario.driver.driverId,
      );
      const driverConversation = await service.resolveConversation({
        conversationType: "order",
        orderId: scenario.driverOrder.orderId,
      });
      expect(driverConversation.participantContextType).toBe("driver");

      // D3 — a Trader identity can never open a Driver-context conversation,
      // even when explicitly requesting one: the server derives context from
      // the caller's own kind and ignores the request for non-operator roles.
      accessor.identity = identityFor(
        scenario.company.companyId,
        scenario.trader.accountId,
        "trader",
        ["communication.trader.read", "communication.trader.send"],
        scenario.trader.traderId,
      );
      const traderAttempt = await service.resolveConversation({
        conversationType: "order",
        orderId: scenario.traderOrder.orderId,
        participantContextType: "driver",
      });
      expect(traderAttempt.participantContextType).toBe("trader");

      // D2 — and even with a real Driver-context conversation id in hand,
      // the Trader is not a participant and is refused, both for reading
      // and for sending — there is no Driver <-> Trader direct channel.
      await expect(service.getMessages(driverConversation.id, {})).rejects.toMatchObject({
        errorCode: "conversation_access_denied",
      });
      await expect(
        service.sendTextMessage(driverConversation.id, {
          clientMessageId: "d2-driver-trader",
          idempotencyKey: `d2-driver-trader-key-${runId}`,
          text: "Trader should never reach Driver conversation",
        }),
      ).rejects.toMatchObject({ errorCode: "conversation_access_denied" });

      // And the reverse: a Driver requesting a Trader-context conversation
      // still only ever gets their own Driver-context conversation back.
      accessor.identity = identityFor(
        scenario.company.companyId,
        scenario.driver.accountId,
        "driver",
        ["communication.driver.read", "communication.driver.send"],
        scenario.driver.driverId,
      );
      const driverAttempt = await service.resolveConversation({
        conversationType: "order",
        orderId: scenario.driverOrder.orderId,
        participantContextType: "trader",
      });
      expect(driverAttempt.participantContextType).toBe("driver");
      return undefined;
    });
  });

  it("D4: dedicated Trader/Driver permissions are enforced independently per action", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "d4");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "d4", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      // A Trader with send-only (no read) permission.
      const sendOnlyTrader = await createFixtureTrader(transaction, company.companyId, "d4-send", [
        "communication.trader.send",
      ]);
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: sendOnlyTrader.traderId,
      });

      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      // A Trader without `communication.trader.read` cannot open a new
      // conversation at all, regardless of send permission.
      accessor.identity = identityFor(
        company.companyId,
        sendOnlyTrader.accountId,
        "trader",
        ["communication.trader.send"],
        sendOnlyTrader.traderId,
      );
      await expect(
        service.resolveConversation({ conversationType: "order", orderId: order.orderId }),
      ).rejects.toMatchObject({ errorCode: "communication_permission_denied" });

      // The office side opens the same conversation independently (this is
      // how a Trader thread can exist before that Trader ever reads it).
      // Office `resolveConversation` only seats itself as a participant, not
      // the Trader — so even the send-only Trader, never having read-ed
      // their way in, is still not a participant and is refused either way:
      // the read gate is not merely advisory, it is the only door in.
      accessor.identity = identityFor(company.companyId, office.accountId, "company_user", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
        participantContextType: "trader",
      });
      accessor.identity = identityFor(
        company.companyId,
        sendOnlyTrader.accountId,
        "trader",
        ["communication.trader.send"],
        sendOnlyTrader.traderId,
      );
      await expect(service.getMessages(conversation.id, {})).rejects.toMatchObject({
        errorCode: "conversation_access_denied",
      });
      await expect(
        service.sendTextMessage(conversation.id, {
          clientMessageId: "d4-send-only-not-participant",
          idempotencyKey: `d4-send-only-not-participant-key-${runId}`,
          text: "Should be refused",
        }),
      ).rejects.toMatchObject({ errorCode: "conversation_access_denied" });

      // A Trader with no communication permissions at all is refused too,
      // for the same reason plus the missing permission.
      const noPermissionTrader = await createFixtureTrader(
        transaction,
        company.companyId,
        "d4-none",
        [],
      );
      accessor.identity = identityFor(
        company.companyId,
        noPermissionTrader.accountId,
        "trader",
        [],
        noPermissionTrader.traderId,
      );
      await expect(service.getMessages(conversation.id, {})).rejects.toMatchObject({
        errorCode: "conversation_access_denied",
      });
      await expect(
        service.sendTextMessage(conversation.id, {
          clientMessageId: "d4-no-permission",
          idempotencyKey: `d4-no-permission-key-${runId}`,
          text: "Should be refused",
        }),
      ).rejects.toMatchObject({ errorCode: "conversation_access_denied" });
      return undefined;
    });
  });

  it("D5: Operator read/send permissions are independently enforced; read-only cannot send", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "d5");
      const fullOffice = await createFixtureOfficeUser(transaction, company.companyId, "d5-full", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const readOnlyOffice = await createFixtureOfficeUser(
        transaction,
        company.companyId,
        "d5-read",
        ["communication.operator.read"],
      );
      const trader = await createFixtureTrader(transaction, company.companyId, "d5", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      const order = await createFixtureOrder(transaction, company.companyId, fullOffice.accountId, {
        traderId: trader.traderId,
      });

      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      accessor.identity = identityFor(
        company.companyId,
        trader.accountId,
        "trader",
        ["communication.trader.read", "communication.trader.send"],
        trader.traderId,
      );
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
      });

      // Any operator-read account can see the office queue (it is not
      // participant-scoped for operators) …
      accessor.identity = identityFor(company.companyId, readOnlyOffice.accountId, "company_user", [
        "communication.operator.read",
      ]);
      await expect(service.getMessages(conversation.id, {})).resolves.toBeDefined();
      // … but cannot send without the dedicated send permission.
      await expect(
        service.sendTextMessage(conversation.id, {
          clientMessageId: "d5-read-only",
          idempotencyKey: `d5-read-only-key-${runId}`,
          text: "Should be refused",
        }),
      ).rejects.toMatchObject({ errorCode: "communication_permission_denied" });

      // The fully-permissioned operator can do both.
      accessor.identity = identityFor(company.companyId, fullOffice.accountId, "company_user", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      await expect(
        service.sendTextMessage(conversation.id, {
          clientMessageId: "d5-full",
          idempotencyKey: `d5-full-key-${runId}`,
          text: "Office reply",
        }),
      ).resolves.toBeDefined();
      return undefined;
    });
  });
});
