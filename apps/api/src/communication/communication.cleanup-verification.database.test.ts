import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import {
  cleanupCommunicationRunId,
  communicationTestRunId,
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
 * I. Cleanup verification.
 *
 * IMPORTANT SCHEMA FACT this file exists to encode as a permanent guard,
 * not just document: `roles` (`roles_no_delete`, unconditional — every Role
 * for every account kind), `customers`/`customer_addresses`
 * (`reject_customer_delete`), and `company_user` `accounts`
 * (`reject_administration_delete`) can never be deleted once committed. Any
 * realistic communication fixture involves at least one permissioned
 * account, which requires a Role — so it can **never** be fully cleaned up
 * after a real commit. That is exactly why every other file in this suite
 * runs entirely inside `withRolledBackCommunicationFixtures`. This file
 * proves rollback truly leaves zero residue (I1), and proves the narrow
 * `cleanupCommunicationRunId` mechanism itself is correct and scoped (I2)
 * using the one kind of fixture that genuinely can be committed and removed
 * — a bare `companies` row with no account, Role, or Customer attached.
 */
describe.skipIf(!enabled)("guarded communication cleanup verification", () => {
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

  /**
   * Builds a full scenario touching every table the permanent suite writes
   * to: Company, office/Trader accounts, Customer, Order, tracking token,
   * Customer session, conversation, participants, a message (which cascades
   * into the realtime event log and the notification outbox). Only ever
   * used inside a rolled-back transaction — see the file-level note above.
   */
  async function buildFullScenario(transaction: Transaction<DatabaseSchema>, runId: string, label: string) {
    const company = await createFixtureCompany(transaction, runId, label);
    const office = await createFixtureOfficeUser(transaction, company.companyId, label, [
      "communication.operator.read",
      "communication.operator.send",
    ]);
    const trader = await createFixtureTrader(transaction, company.companyId, label, [
      "communication.trader.read",
      "communication.trader.send",
    ]);
    const customer = await createFixtureCustomer(transaction, company.companyId, office.accountId, label);
    const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
      customerId: customer.customerId,
      traderId: trader.traderId,
    });
    const tracking = await createFixtureTrackingToken(transaction, company.companyId, order.orderId);
    const accessor = new StaticIdentityAccessor();
    const service = createTestCommunicationService(transaction, accessor);
    const session = await service.createCustomerMessagingSession({ trackingToken: tracking.rawToken });
    await service.customerResolveConversation(session.customerMessagingToken);
    await service.customerSendText(session.customerMessagingToken, {
      clientMessageId: `${label}-cleanup-message`,
      idempotencyKey: `${label}-cleanup-key-${runId}`,
      text: "Fixture message for cleanup verification",
    });
    return company;
  }

  it("I1: transaction rollback leaves zero rows behind, even after touching every communication table", async () => {
    let companyCode = "";
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await buildFullScenario(transaction, runId, "i1");
      companyCode = company.code;
      // Sanity check inside the transaction: the rows really were written.
      const insideCount = await sql<{ count: string }>`
        select count(*)::text as count from companies where code = ${companyCode}
      `.execute(transaction);
      expect(insideCount.rows[0]?.count).toBe("1");
      return undefined;
    });

    const afterRollback = await sql<{ count: string }>`
      select count(*)::text as count from companies where code = ${companyCode}
    `.execute(database);
    expect(afterRollback.rows[0]?.count).toBe("0");
    return undefined;
  });

  it("I2: the narrow, captured-run-id cleanup mechanism deletes only its own rows, never a truncate/reset", async () => {
    const targetRunId = communicationTestRunId();
    const controlRunId = communicationTestRunId();
    let targetCode = "";
    let controlCode = "";
    try {
      // A bare Company row is the one fixture shape that can be committed
      // and later fully removed — no account, Role, or Customer is ever
      // attached, so none of the permanent no-delete triggers apply.
      const target = await createFixtureCompany(database as unknown as Transaction<DatabaseSchema>, targetRunId, "i2t");
      const control = await createFixtureCompany(
        database as unknown as Transaction<DatabaseSchema>,
        controlRunId,
        "i2c",
      );
      targetCode = target.code;
      controlCode = control.code;

      await cleanupCommunicationRunId(database, targetRunId);

      const targetAfter = await sql<{ count: string }>`
        select count(*)::text as count from companies where code = ${targetCode}
      `.execute(database);
      expect(targetAfter.rows[0]?.count).toBe("0");

      // The unrelated control Company, tagged with a different run id, is
      // completely untouched by that narrow cleanup.
      const controlAfter = await sql<{ count: string }>`
        select count(*)::text as count from companies where code = ${controlCode}
      `.execute(database);
      expect(controlAfter.rows[0]?.count).toBe("1");
    } finally {
      await cleanupCommunicationRunId(database, targetRunId);
      await cleanupCommunicationRunId(database, controlRunId);
      const targetGone = await sql<{ count: string }>`
        select count(*)::text as count from companies where code = ${targetCode}
      `.execute(database);
      const controlGone = await sql<{ count: string }>`
        select count(*)::text as count from companies where code = ${controlCode}
      `.execute(database);
      expect(targetGone.rows[0]?.count).toBe("0");
      expect(controlGone.rows[0]?.count).toBe("0");
    }
  });

  it("I2b: cleanupCommunicationRunId refuses a run id that created a Role or a Customer, instead of silently leaving residue", async () => {
    // A synthetic, never-persisted run id: the guard must trip on the
    // *existence check itself* only when matching rows exist, so first
    // prove the zero-company no-op path, then prove the loud refusal by
    // actually creating (inside a rolled-back transaction — never
    // committed) a Company with a Role.
    const emptyRunId = communicationTestRunId();
    await expect(cleanupCommunicationRunId(database, emptyRunId)).resolves.toBeUndefined();

    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "i2b");
      await createFixtureOfficeUser(transaction, company.companyId, "i2b", []);
      // This must never be reachable from a real committed scenario — it
      // is only exercised here, against uncommitted rows still inside the
      // open transaction, purely to prove the guard clause itself works.
      await expect(cleanupCommunicationRunId(transaction as unknown as Kysely<DatabaseSchema>, runId)).rejects.toThrow(
        /cannot remove Role rows/,
      );
      return undefined;
    });
  });

  it("I3: no leftover synthetic Companies remain from any run this suite committed", async () => {
    const leftovers = await sql<{ code: string }>`
      select code from companies where code like 'comm-test-%' limit 5
    `.execute(database);
    expect(leftovers.rows).toEqual([]);
  });

  it("I4 (known, permanent, disclosed limitation): a handful of earlier synthetic Companies cannot be removed", async () => {
    // Before this suite's cleanup helper learned about roles_no_delete /
    // reject_customer_delete / reject_administration_delete, a small number
    // of synthetic Companies were committed and partially cleaned — every
    // removable row (Orders, conversations, messages, sessions, events,
    // outbox, tracking tokens) is gone, but each Company's Customer,
    // CustomerAddress, one Role, and one company_user account are
    // permanently undeletable by the database's own design and remain.
    // This test documents and bounds that known residue rather than
    // silently tolerating unbounded pollution: it fails if the count grows.
    const residue = await sql<{ count: string }>`
      select count(*)::text as count from companies
       where code like 'comm-test-%-i2t-%' or code like 'comm-test-%-i2c-%'
    `.execute(database);
    expect(Number(residue.rows[0]?.count ?? "0")).toBeLessThanOrEqual(5);
    void randomUUID;
  });
});
