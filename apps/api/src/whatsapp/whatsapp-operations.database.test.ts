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
  createFixtureOrder,
  createFixtureTrader,
  StaticIdentityAccessor,
  withRolledBackCommunicationFixtures,
} from "../communication/communication.database-test-helpers.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { IdentityContext } from "../security/identity-context.js";
import { WhatsAppMessageOperationsService } from "./whatsapp-message-operations.service.js";
import { WhatsAppNotificationHistoryService } from "./whatsapp-notification-history.service.js";

const enabled = process.env.RUN_WHATSAPP_DATABASE === "true";

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!enabled)("whatsapp message operations", () => {
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

  function identityFor(companyId: string, accountId: string): IdentityContext {
    return {
      companyId,
      forcePasswordChange: false,
      identityId: accountId,
      kind: "company_user",
      permissions: new Set(["whatsapp.messages.manage", "whatsapp.history.view"]),
      sessionId: randomUUID(),
    };
  }

  interface World {
    readonly companyId: string;
    readonly accountId: string;
    readonly traderId: string;
    readonly connectionId: string;
    readonly service: WhatsAppMessageOperationsService;
    readonly accessor: StaticIdentityAccessor;
  }

  async function createWorld(
    transaction: Transaction<DatabaseSchema>,
    runId: string,
  ): Promise<World> {
    const company = await createFixtureCompany(transaction, runId, "wa-ops");
    const office = await createFixtureOfficeUser(transaction, company.companyId, "wa-ops", [
      "whatsapp.messages.manage",
    ]);
    const trader = await createFixtureTrader(transaction, company.companyId, "wa-ops-t", []);
    const connection = (
      await sql<{ id: string }>`
        insert into company_whatsapp_connections (
          company_id, status, provider_type, connected_phone_number, last_connected_at
        ) values (${company.companyId}::uuid, 'connected', 'baileys', '+971500000060', now())
        returning id
      `.execute(transaction)
    ).rows[0]!;
    const accessor = new StaticIdentityAccessor();
    accessor.identity = identityFor(company.companyId, office.accountId);
    const service = new WhatsAppMessageOperationsService(
      transaction as unknown as Kysely<DatabaseSchema>,
      accessor,
    );
    return {
      accessor,
      accountId: office.accountId,
      companyId: company.companyId,
      connectionId: connection.id,
      service,
      traderId: trader.traderId,
    };
  }

  async function insertMessage(
    transaction: Transaction<DatabaseSchema>,
    world: World,
    overrides: {
      readonly status?: string;
      readonly messageType?: string;
      readonly orderId?: string;
      readonly historyId?: string;
      readonly sentAt?: boolean;
      readonly failureCode?: string;
    } = {},
  ): Promise<string> {
    const isOrder = overrides.messageType === "order_status";
    const row = (
      await sql<{ id: string }>`
        insert into whatsapp_message_outbox (
          company_id, trader_id, order_id, order_status_history_id, connection_id,
          message_type, destination_type, provider_group_id, group_name_snapshot,
          message_language, message_body, status, sent_at, failure_code, idempotency_key
        ) values (
          ${world.companyId}::uuid, ${world.traderId}::uuid,
          ${isOrder ? overrides.orderId : null}::uuid, ${isOrder ? overrides.historyId : null}::uuid,
          ${world.connectionId}::uuid,
          ${overrides.messageType ?? "test"}, 'group', 'ops-group@g.us', 'Ops Group', 'both',
          'ops body', ${overrides.status ?? "pending"},
          ${overrides.sentAt === true ? sql`now()` : null},
          ${overrides.failureCode ?? null},
          ${`ops-${randomUUID()}`}
        )
        returning id
      `.execute(transaction)
    ).rows[0]!;
    return row.id;
  }

  it("lists with filters and pagination, joining Trader and Order context", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      const order = await createFixtureOrder(transaction, world.companyId, world.accountId, {
        traderId: world.traderId,
      });
      const historyId = (
        await sql<{ id: string }>`
          insert into order_status_history (
            company_id, order_id, status_dimension, to_status, changed_by_account_id
          ) values (
            ${world.companyId}::uuid, ${order.orderId}::uuid, 'delivery', 'delivered',
            ${world.accountId}::uuid
          ) returning id
        `.execute(transaction)
      ).rows[0]!.id;

      await insertMessage(transaction, world, { sentAt: true, status: "sent" });
      await insertMessage(transaction, world, {
        failureCode: "whatsapp_group_not_found",
        historyId,
        messageType: "order_status",
        orderId: order.orderId,
        status: "failed",
      });
      await insertMessage(transaction, world, { status: "requires_review" });

      const all = await world.service.list({});
      expect(all.total).toBe(3);
      expect(all.items).toHaveLength(3);

      const failed = await world.service.list({ status: "failed" } as never);
      expect(failed.total).toBe(1);
      expect(failed.items[0]).toMatchObject({
        failureCode: "whatsapp_group_not_found",
        orderNumber: order.orderNumber,
        orderStatus: "delivered",
        traderId: world.traderId,
      });

      const tests = await world.service.list({ messageType: "test" } as never);
      expect(tests.total).toBe(2);

      const byOrder = await world.service.list({
        orderNumber: order.orderNumber.slice(4),
      } as never);
      expect(byOrder.total).toBe(1);

      const paged = await world.service.list({ page: "2", pageSize: "2" } as never);
      expect(paged.total).toBe(3);
      expect(paged.items).toHaveLength(1);
    });
  });

  it("returns full detail with attempts, and keeps everything tenant-isolated", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const worldA = await createWorld(transaction, runId);
      const worldB = await createWorld(transaction, runId);
      const id = await insertMessage(transaction, worldA, {
        failureCode: "whatsapp_provider_unavailable",
        status: "failed",
      });
      await sql`
        insert into whatsapp_message_attempts (
          company_id, message_id, attempt_number, completed_at, result,
          provider_response_summary, failure_classification
        ) values (
          ${worldA.companyId}::uuid, ${id}::uuid, 1, now(), 'failed', 'send_failed', 'transient'
        )
      `.execute(transaction);

      const detail = await worldA.service.detail(id);
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]).toMatchObject({
        attemptNumber: 1,
        failureClassification: "transient",
        result: "failed",
      });
      expect(detail.providerGroupId).toBe("ops-group@g.us");
      expect(detail.messageBody).toBe("ops body");

      // Company B sees nothing of A's messages — read or mutate.
      await expect(worldB.service.detail(id)).rejects.toMatchObject({
        errorCode: "whatsapp_message_not_found",
      });
      await expect(worldB.service.retry(id, true, "corr")).rejects.toMatchObject({
        errorCode: "whatsapp_message_not_found",
      });
      await expect(worldB.service.resolve(id, "cancel", "corr")).rejects.toMatchObject({
        errorCode: "whatsapp_message_not_found",
      });
      const listB = await worldB.service.list({});
      expect(listB.total).toBe(0);
    });
  });

  it("enforces the central retry rules, including the duplicate-risk confirmation", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);

      const sent = await insertMessage(transaction, world, { sentAt: true, status: "sent" });
      await expect(world.service.retry(sent, true, "corr")).rejects.toMatchObject({
        errorCode: "whatsapp_retry_not_allowed",
      });
      const cancelled = await insertMessage(transaction, world, { status: "cancelled" });
      await expect(world.service.retry(cancelled, true, "corr")).rejects.toMatchObject({
        errorCode: "whatsapp_retry_not_allowed",
      });
      const pending = await insertMessage(transaction, world, { status: "pending" });
      await expect(world.service.retry(pending, false, "corr")).rejects.toMatchObject({
        errorCode: "whatsapp_retry_not_needed",
      });

      // Failed: normal retry re-queues immediately.
      const failed = await insertMessage(transaction, world, {
        failureCode: "whatsapp_provider_unavailable",
        status: "failed",
      });
      const retried = await world.service.retry(failed, false, "corr");
      expect(retried.status).toBe("pending");
      expect(retried.nextAttemptAt).not.toBeNull();

      // requires_review: refused without the explicit duplicate-risk
      // confirmation, allowed with it.
      const review = await insertMessage(transaction, world, {
        failureCode: "provider_timeout",
        status: "requires_review",
      });
      await expect(world.service.retry(review, false, "corr")).rejects.toMatchObject({
        errorCode: "whatsapp_duplicate_risk_confirmation_required",
      });
      const confirmed = await world.service.retry(review, true, "corr");
      expect(confirmed.status).toBe("pending");

      const audits = (
        await sql<{ action: string }>`
          select action from audit_events
           where company_id = ${world.companyId}::uuid
             and subject_type = 'whatsapp_message_outbox'
           order by occurred_at
        `.execute(transaction)
      ).rows.map((row) => row.action);
      expect(audits).toContain("whatsapp.message_retry_requested");
      expect(audits).toContain("whatsapp.message_uncertain_retry_confirmed");
    });
  });

  it("resolves and cancels with audits, refusing invalid states", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);

      const review = await insertMessage(transaction, world, { status: "requires_review" });
      const resolved = await world.service.resolve(review, "mark_resolved", "corr");
      expect(resolved.status).toBe("cancelled");
      expect(resolved.failureReason).toBe("operator_resolved_no_resend");

      const failed = await insertMessage(transaction, world, { status: "failed" });
      const cancelled = await world.service.resolve(failed, "cancel", "corr");
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.failureReason).toBe("operator_cancelled");

      const sent = await insertMessage(transaction, world, { sentAt: true, status: "sent" });
      await expect(world.service.resolve(sent, "cancel", "corr")).rejects.toMatchObject({
        errorCode: "whatsapp_resolution_not_allowed",
      });

      const audits = (
        await sql<{ action: string }>`
          select action from audit_events
           where company_id = ${world.companyId}::uuid
             and subject_type = 'whatsapp_message_outbox'
        `.execute(transaction)
      ).rows.map((row) => row.action);
      expect(audits).toContain("whatsapp.message_marked_resolved");
      expect(audits).toContain("whatsapp.message_cancelled");
    });
  });

  it("reports the expanded operational summary", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId);
      await insertMessage(transaction, world, { status: "pending" });
      await insertMessage(transaction, world, { status: "processing" });
      await insertMessage(transaction, world, { status: "failed" });
      await insertMessage(transaction, world, { status: "requires_review" });
      await insertMessage(transaction, world, { sentAt: true, status: "sent" });

      const history = new WhatsAppNotificationHistoryService(
        transaction as unknown as Kysely<DatabaseSchema>,
        world.accessor,
      );
      const summary = await history.summary();
      expect(summary).toMatchObject({
        failed: 1,
        pending: 1,
        processing: 1,
        requiresReview: 1,
        sentLast24h: 1,
        sentToday: 1,
      });
      expect(summary.oldestPendingAt).not.toBeNull();
      expect(summary.lastSuccessfulSendAt).not.toBeNull();
    });
  });
});
