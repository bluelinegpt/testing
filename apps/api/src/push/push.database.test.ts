import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PasswordHasher } from "../authentication/password-hasher.js";
import { configuration } from "../configuration/environment.js";
import type { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import {
  createFixtureCompany,
  createFixtureOfficeUser,
  createFixtureOrder,
  createFixtureTrader,
  createTestCommunicationService,
  StaticIdentityAccessor,
  withRolledBackCommunicationFixtures,
} from "../communication/communication.database-test-helpers.js";
import type { IdentityContext } from "../security/identity-context.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { FakePushProvider } from "./fake-push.provider.js";
import { PushDispatcher } from "./push-dispatcher.service.js";
import { PushEventRepository } from "./push-event.repository.js";
import { PushOutboxWriter } from "./push-outbox-writer.service.js";

const enabled = process.env.RUN_PUSH_DATABASE === "true";
const rollbackMarker = Symbol("rollback push database test");

// Every `it()` here does several real round trips against the guarded dev
// database (fixture inserts, a claim query, a provider call, an assertion
// query) inside one outer transaction — under concurrent CPU load elsewhere
// on the machine (e.g. a parallel Flutter build) the default 5s vitest
// timeout is too tight for that, independent of this suite's own logic.
vi.setConfig({ testTimeout: 30_000 });

function officeIdentity(companyId: string, accountId: string): IdentityContext {
  return {
    companyId,
    forcePasswordChange: false,
    identityId: accountId,
    kind: "company_user",
    permissions: new Set(["communication.operator.read", "communication.operator.send"]),
    sessionId: `office-${accountId}`,
  };
}

function traderIdentity(companyId: string, accountId: string, traderId: string): IdentityContext {
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

/**
 * `PushDispatcher`/`PushEventRepository` service-level security and delivery
 * tests — no HTTP boundary, direct construction against one rolled-back
 * transaction (the `withRolledBackCommunicationFixtures` pattern, self-
 * contained here rather than imported so this module has no dependency on
 * the Communication feature). Covers Section Z items 6-9 (dispatch-time
 * eligibility, independent of what was true when the event was written) and
 * 15-20 (provider outcomes, retry, idempotency, payload minimization).
 */
describe.skipIf(!enabled)("guarded push notification dispatch security", () => {
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

  async function withFixtures<T>(
    work: (transaction: Transaction<DatabaseSchema>, runId: string) => Promise<T>,
  ): Promise<T> {
    const runId = `push-test-${randomUUID()}`;
    let result: T | undefined;
    try {
      await database.transaction().execute(async (transaction) => {
        result = await work(transaction, runId);
        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    }
    return result as T;
  }

  // Kysely does not support calling `.transaction()` again on an
  // already-active `Transaction` — `PushEventRepository.next()` goes through
  // `KyselyTransactionManager` precisely so a test can substitute this
  // direct-passthrough stub, matching the pattern already used throughout
  // this codebase (`communication.database-test-helpers.ts`,
  // `operations-history.regression.test.ts`) for the identical reason.
  function stubTransactions(transaction: Transaction<DatabaseSchema>): KyselyTransactionManager {
    return {
      execute: <T>(work: (t: Transaction<DatabaseSchema>) => Promise<T>): Promise<T> =>
        work(transaction),
    } as unknown as KyselyTransactionManager;
  }

  async function makeCompany(transaction: Transaction<DatabaseSchema>, runId: string, label: string, status = "active") {
    const companyId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const code = `${runId}-${label}-${suffix}`.slice(0, 60);
    const subdomain = `c-${label}-${suffix}`.slice(0, 60);
    await sql`
      insert into companies (id, code, subdomain, name_en, status, activated_at, closed_at)
      values (${companyId}::uuid, ${code}, ${subdomain}, ${`Push Test ${label}`}, ${status}, now(),
              ${status === "closed" ? sql`now()` : null})
    `.execute(transaction);
    return companyId;
  }

  async function makeAccount(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    label: string,
    status = "active",
  ) {
    const accountId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const hasher = new PasswordHasher();
    const hash = await hasher.hash(`Push-Test-${suffix}-Aa1!`);
    await sql`
      insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
      values (${accountId}::uuid, ${companyId}::uuid, 'company_user', ${`push-${label}-${suffix}`}, ${hash},
              ${status}, now())
    `.execute(transaction);
    return accountId;
  }

  async function registerDevice(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    accountId: string,
    token: string,
    status = "active",
  ) {
    await sql`
      insert into device_registrations (
        company_id, account_id, platform, provider, push_token, status, revoked_at, revoked_reason
      )
      values (${companyId}::uuid, ${accountId}::uuid, 'android', 'fcm', ${token}, ${status},
              ${status === "revoked" ? sql`now()` : null},
              ${status === "revoked" ? "test_revoked" : null})
    `.execute(transaction);
  }

  async function writeEvent(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    accountId: string,
    dedupeKey: string,
  ) {
    await sql`
      insert into notification_outbox_events (
        company_id, recipient_account_id, notification_type, target_type, target_id,
        title_key, dedupe_key
      ) values (
        ${companyId}::uuid, ${accountId}::uuid, 'order.assigned', 'order', ${randomUUID()}::uuid,
        'push.order.assignedTitle', ${dedupeKey}
      )
    `.execute(transaction);
  }

  it("dispatches a pending event through a Fake provider and marks it sent", async () => {
    await withFixtures(async (transaction, runId) => {
      const companyId = await makeCompany(transaction, runId, "sent");
      const accountId = await makeAccount(transaction, companyId, "acct");
      await registerDevice(transaction, companyId, accountId, `tok-${runId}-1`);
      await writeEvent(transaction, companyId, accountId, `dedupe-${runId}-1`);

      const repository = new PushEventRepository(
        transaction as unknown as Kysely<DatabaseSchema>,
        stubTransactions(transaction),
      );
      const provider = new FakePushProvider();
      const dispatcher = new PushDispatcher(repository, provider);

      const processed = await dispatcher.drain();
      expect(processed).toBe(1);
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.token).toBe(`tok-${runId}-1`);

      const row = await sql<{ status: string; sentAt: string | null }>`
        select status, sent_at::text as "sentAt" from notification_outbox_events
         where company_id = ${companyId}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.status).toBe("sent");
      expect(row.rows[0]?.sentAt).not.toBeNull();
    });
  });

  it("a transient provider failure retries with backoff, not immediately", async () => {
    await withFixtures(async (transaction, runId) => {
      const companyId = await makeCompany(transaction, runId, "retry");
      const accountId = await makeAccount(transaction, companyId, "acct");
      const token = `tok-${runId}-1`;
      await registerDevice(transaction, companyId, accountId, token);
      await writeEvent(transaction, companyId, accountId, `dedupe-${runId}-1`);

      const repository = new PushEventRepository(
        transaction as unknown as Kysely<DatabaseSchema>,
        stubTransactions(transaction),
      );
      const provider = new FakePushProvider();
      provider.queueResult(token, { outcome: "transient_failure", reason: "server_unavailable" });
      const dispatcher = new PushDispatcher(repository, provider);

      await dispatcher.drain();
      const row = await sql<{ status: string; attempts: number; nextRetryAt: string | null }>`
        select status, attempts, next_retry_at::text as "nextRetryAt" from notification_outbox_events
         where company_id = ${companyId}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.status).toBe("retryable_failure");
      expect(row.rows[0]?.nextRetryAt).not.toBeNull();

      // The retry is scheduled in the future — draining again right now must
      // not re-attempt it (no infinite rapid loop).
      const secondDrain = await dispatcher.drain();
      expect(secondDrain).toBe(0);
      expect(provider.calls).toHaveLength(1);
    });
  });

  it("a permanent provider failure never retries", async () => {
    await withFixtures(async (transaction, runId) => {
      const companyId = await makeCompany(transaction, runId, "perm");
      const accountId = await makeAccount(transaction, companyId, "acct");
      const token = `tok-${runId}-1`;
      await registerDevice(transaction, companyId, accountId, token);
      await writeEvent(transaction, companyId, accountId, `dedupe-${runId}-1`);

      const repository = new PushEventRepository(
        transaction as unknown as Kysely<DatabaseSchema>,
        stubTransactions(transaction),
      );
      const provider = new FakePushProvider();
      provider.queueResult(token, { outcome: "permanent_failure", reason: "malformed_payload" });
      const dispatcher = new PushDispatcher(repository, provider);

      await dispatcher.drain();
      const row = await sql<{ status: string; nextRetryAt: string | null }>`
        select status, next_retry_at::text as "nextRetryAt" from notification_outbox_events
         where company_id = ${companyId}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.status).toBe("permanent_failure");
      expect(row.rows[0]?.nextRetryAt).toBeNull();
    });
  });

  it("an invalid-token result deactivates the registration and stops retrying it", async () => {
    await withFixtures(async (transaction, runId) => {
      const companyId = await makeCompany(transaction, runId, "invalid");
      const accountId = await makeAccount(transaction, companyId, "acct");
      const token = `tok-${runId}-1`;
      await registerDevice(transaction, companyId, accountId, token);
      await writeEvent(transaction, companyId, accountId, `dedupe-${runId}-1`);

      const repository = new PushEventRepository(
        transaction as unknown as Kysely<DatabaseSchema>,
        stubTransactions(transaction),
      );
      const provider = new FakePushProvider();
      provider.queueResult(token, { outcome: "invalid_token" });
      const dispatcher = new PushDispatcher(repository, provider);

      await dispatcher.drain();
      const event = await sql<{ status: string }>`
        select status from notification_outbox_events where company_id = ${companyId}::uuid
      `.execute(transaction);
      expect(event.rows[0]?.status).toBe("permanent_failure");
      const device = await sql<{ status: string; revokedReason: string | null }>`
        select status, revoked_reason as "revokedReason" from device_registrations
         where company_id = ${companyId}::uuid and push_token = ${token}
      `.execute(transaction);
      expect(device.rows[0]?.status).toBe("revoked");
      expect(device.rows[0]?.revokedReason).toBe("invalid_token");
    });
  });

  it("a disabled account is skipped at dispatch time even though the event and an active device both exist", async () => {
    await withFixtures(async (transaction, runId) => {
      const companyId = await makeCompany(transaction, runId, "disabledacct");
      const accountId = await makeAccount(transaction, companyId, "acct", "disabled");
      await registerDevice(transaction, companyId, accountId, `tok-${runId}-1`);
      await writeEvent(transaction, companyId, accountId, `dedupe-${runId}-1`);

      const repository = new PushEventRepository(
        transaction as unknown as Kysely<DatabaseSchema>,
        stubTransactions(transaction),
      );
      const provider = new FakePushProvider();
      const dispatcher = new PushDispatcher(repository, provider);

      await dispatcher.drain();
      expect(provider.calls).toHaveLength(0);
      const row = await sql<{ status: string; errorCategory: string | null }>`
        select status, error_category as "errorCategory" from notification_outbox_events
         where company_id = ${companyId}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.status).toBe("skipped");
      expect(row.rows[0]?.errorCategory).toBe("recipient_ineligible");
    });
  });

  it("a suspended/closed Company's account is skipped at dispatch time", async () => {
    await withFixtures(async (transaction, runId) => {
      const companyId = await makeCompany(transaction, runId, "closedco", "closed");
      const accountId = await makeAccount(transaction, companyId, "acct");
      await registerDevice(transaction, companyId, accountId, `tok-${runId}-1`);
      await writeEvent(transaction, companyId, accountId, `dedupe-${runId}-1`);

      const repository = new PushEventRepository(
        transaction as unknown as Kysely<DatabaseSchema>,
        stubTransactions(transaction),
      );
      const provider = new FakePushProvider();
      const dispatcher = new PushDispatcher(repository, provider);

      await dispatcher.drain();
      expect(provider.calls).toHaveLength(0);
      const row = await sql<{ status: string }>`
        select status from notification_outbox_events where company_id = ${companyId}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.status).toBe("skipped");
    });
  });

  it("a revoked device registration is excluded — the event is skipped, not delivered", async () => {
    await withFixtures(async (transaction, runId) => {
      const companyId = await makeCompany(transaction, runId, "revoked");
      const accountId = await makeAccount(transaction, companyId, "acct");
      await registerDevice(transaction, companyId, accountId, `tok-${runId}-1`, "revoked");
      await writeEvent(transaction, companyId, accountId, `dedupe-${runId}-1`);

      const repository = new PushEventRepository(
        transaction as unknown as Kysely<DatabaseSchema>,
        stubTransactions(transaction),
      );
      const provider = new FakePushProvider();
      const dispatcher = new PushDispatcher(repository, provider);

      await dispatcher.drain();
      expect(provider.calls).toHaveLength(0);
      const row = await sql<{ status: string; errorCategory: string | null }>`
        select status, error_category as "errorCategory" from notification_outbox_events
         where company_id = ${companyId}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.status).toBe("skipped");
      expect(row.rows[0]?.errorCategory).toBe("no_active_device");
    });
  });

  it("PushOutboxWriter is idempotent: the same logical event written twice produces one row", async () => {
    await withFixtures(async (transaction, runId) => {
      const companyId = await makeCompany(transaction, runId, "dedupe");
      const accountId = await makeAccount(transaction, companyId, "acct");
      const writer = new PushOutboxWriter();
      const orderId = randomUUID();
      const correlationId = randomUUID();
      // Simulate a retried business transaction calling the writer twice for
      // the exact same logical event (same order, driver, correlation id).
      await sql`
        insert into device_registrations (company_id, account_id, platform, provider, push_token, status)
        values (${companyId}::uuid, ${accountId}::uuid, 'android', 'fcm', ${`tok-${runId}`}, 'active')
      `.execute(transaction);
      await writer.writeOrderAssigned(transaction, {
        companyId,
        orderId,
        driverAccountId: accountId,
        isReassignment: false,
        correlationId,
      });
      await writer.writeOrderAssigned(transaction, {
        companyId,
        orderId,
        driverAccountId: accountId,
        isReassignment: false,
        correlationId,
      });
      const rows = await sql<{ count: string }>`
        select count(*)::text as count from notification_outbox_events where company_id = ${companyId}::uuid
      `.execute(transaction);
      expect(rows.rows[0]?.count).toBe("1");
    });
  });

  it("worker restart safety: draining twice after a claim never re-delivers an already-sent event", async () => {
    await withFixtures(async (transaction, runId) => {
      const companyId = await makeCompany(transaction, runId, "restart");
      const accountId = await makeAccount(transaction, companyId, "acct");
      const token = `tok-${runId}-1`;
      await registerDevice(transaction, companyId, accountId, token);
      await writeEvent(transaction, companyId, accountId, `dedupe-${runId}-1`);

      const repository = new PushEventRepository(
        transaction as unknown as Kysely<DatabaseSchema>,
        stubTransactions(transaction),
      );
      const provider = new FakePushProvider();
      const dispatcher = new PushDispatcher(repository, provider);

      await dispatcher.drain();
      await dispatcher.drain();
      expect(provider.calls).toHaveLength(1);
    });
  });

  it("the payload sent to the provider excludes every restricted field — only safe identifiers and localization keys", async () => {
    await withFixtures(async (transaction, runId) => {
      const companyId = await makeCompany(transaction, runId, "payload");
      const accountId = await makeAccount(transaction, companyId, "acct");
      const token = `tok-${runId}-1`;
      await registerDevice(transaction, companyId, accountId, token);
      await sql`
        insert into notification_outbox_events (
          company_id, recipient_account_id, notification_type, target_type, target_id,
          title_key, body_key, body_params, dedupe_key
        ) values (
          ${companyId}::uuid, ${accountId}::uuid, 'order.status_changed', 'order', ${randomUUID()}::uuid,
          'push.order.statusChangedTitle', null, ${JSON.stringify({ status: "delivered" })}::jsonb,
          ${`dedupe-${runId}-1`}
        )
      `.execute(transaction);

      const repository = new PushEventRepository(
        transaction as unknown as Kysely<DatabaseSchema>,
        stubTransactions(transaction),
      );
      const provider = new FakePushProvider();
      const dispatcher = new PushDispatcher(repository, provider);
      await dispatcher.drain();

      const call = provider.calls[0];
      expect(call).toBeDefined();
      const forbidden = [
        "address",
        "cod",
        "codAmount",
        "amount",
        "token",
        "accessToken",
        "password",
        "mobile",
        "mobileNumber",
        "bank",
      ];
      const keys = Object.keys(call?.data ?? {}).map((key) => key.toLowerCase());
      for (const value of forbidden) {
        expect(keys.some((key) => key.includes(value.toLowerCase()))).toBe(false);
      }
      expect(call?.data.notificationType).toBe("order.status_changed");
      expect(call?.data.status).toBe("delivered");
    });
  });

  it("communication push: notifies every other active participant with an account, never the sender, never a different Company", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const companyA = await createFixtureCompany(transaction, runId, "commpush-a");
      const companyB = await createFixtureCompany(transaction, runId, "commpush-b");
      const officeOne = await createFixtureOfficeUser(transaction, companyA.companyId, "office-one", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const officeTwo = await createFixtureOfficeUser(transaction, companyA.companyId, "office-two", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, companyA.companyId, "trader", [
        "communication.trader.read",
        "communication.trader.send",
      ]);
      // Company B's own office account — never a legitimate recipient of a
      // Company A conversation regardless of any coincidental id overlap.
      const officeOtherCompany = await createFixtureOfficeUser(
        transaction,
        companyB.companyId,
        "office-b",
        ["communication.operator.read", "communication.operator.send"],
      );
      const order = await createFixtureOrder(transaction, companyA.companyId, officeOne.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = traderIdentity(companyA.companyId, trader.accountId, trader.traderId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
      });
      accessor.identity = officeIdentity(companyA.companyId, officeOne.accountId);
      await service.getMessages(conversation.id, {});
      accessor.identity = officeIdentity(companyA.companyId, officeTwo.accountId);
      await service.getMessages(conversation.id, {});

      accessor.identity = traderIdentity(companyA.companyId, trader.accountId, trader.traderId);
      const message = await service.sendTextMessage(conversation.id, {
        clientMessageId: `push-comm-${runId}`,
        idempotencyKey: `push-comm-key-${runId}`,
        text: "Trader update",
      });

      const rows = await sql<{ recipientAccountId: string; companyId: string }>`
        select recipient_account_id as "recipientAccountId", company_id as "companyId"
          from notification_outbox_events
         where notification_type = 'communication.message.created'
           and target_id = ${conversation.id}::uuid
      `.execute(transaction);
      const recipients = rows.rows.map((row) => row.recipientAccountId).sort();
      expect(recipients).toEqual([officeOne.accountId, officeTwo.accountId].sort());
      // Never the sender, never a different Company's account.
      expect(recipients).not.toContain(trader.accountId);
      expect(recipients).not.toContain(officeOtherCompany.accountId);
      expect(rows.rows.every((row) => row.companyId === companyA.companyId)).toBe(true);
      return undefined;
    });
  });
});
