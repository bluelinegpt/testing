import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config as loadEnvironment } from "dotenv";
import { describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { OperationsService } from "./operations.service.js";
import { WhatsAppOutboxWriter } from "../whatsapp/whatsapp-outbox-writer.service.js";
import type { IdentityContext } from "../security/identity-context.js";
import type { TenantContext } from "../tenancy/tenant-context.js";

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

async function withDatabase<T>(work: (database: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const identity = await database
    .selectNoFrom((eb) => eb.val(sql`current_database()`).as("databaseName"))
    .executeTakeFirstOrThrow();
  if (identity.databaseName === undefined || identity.databaseName !== "blueline") {
    await database.destroy();
    throw new Error(`Refusing repair certification against database ${String(identity.databaseName)}`);
  }
  try {
    return await work(database);
  } finally {
    await database.destroy();
  }
}

async function seedFixture(database: Kysely<DatabaseSchema>) {
  const ids = {
    companyId: randomUUID(),
    actorId: randomUUID(),
    roleId: randomUUID(),
    traderAccountId: randomUUID(),
    traderId: randomUUID(),
    areaId: randomUUID(),
    orderId: randomUUID(),
    historicalReceivableId: randomUUID(),
    cancelledReceivableId: randomUUID(),
  };
  const orderNumber = `ORD-REPAIR-${ids.orderId.slice(0, 8)}`;
  const reference = `RCV-REPAIR-${ids.historicalReceivableId.slice(0, 8)}`;
  await database.transaction().execute(async (tx) => {
    await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
      values (${ids.companyId}::uuid, ${`RP-${ids.companyId.slice(0, 8)}`},
        ${`rp-${ids.companyId.slice(0, 8)}`}, 'Repair Test', 'active', now())`.execute(tx);
    await sql`insert into accounts(id, company_id, account_kind, username, password_hash, preferred_language)
      values (${ids.actorId}::uuid, ${ids.companyId}::uuid, 'company_user',
        ${`rp.a.${ids.actorId}`}, 'x', 'en'),
        (${ids.traderAccountId}::uuid, ${ids.companyId}::uuid, 'trader',
        ${`rp.t.${ids.traderAccountId}`}, 'x', 'en')`.execute(tx);
    await sql`insert into roles(id, company_id, code, name, is_system, is_active)
      values (${ids.roleId}::uuid, ${ids.companyId}::uuid, 'repair_operator', 'Repair Operator', true, true)`.execute(tx);
    await sql`insert into role_permissions(role_id, permission_code)
      values (${ids.roleId}::uuid, 'users_roles.manage')`.execute(tx);
    await sql`insert into account_roles(account_id, role_id, company_id, assigned_by_account_id)
      values (${ids.actorId}::uuid, ${ids.roleId}::uuid, ${ids.companyId}::uuid, ${ids.actorId}::uuid)`.execute(tx);
    await sql`insert into accounting_configurations(
      company_id, accounting_enabled, automatic_posting_enabled, automatic_posting_areas,
      automatic_posting_enabled_by_account_id, automatic_posting_enabled_at
    ) values (
      ${ids.companyId}::uuid, true, true, array['trader_receivables']::text[],
      ${ids.actorId}::uuid, now()
    )`.execute(tx);
    await sql`insert into traders(id, company_id, account_id, code, name_en, mobile_number, created_by_account_id)
      values (${ids.traderId}::uuid, ${ids.companyId}::uuid, ${ids.traderAccountId}::uuid,
        ${`TRD-${ids.traderId.slice(0, 8)}`}, 'Repair Trader', '971500000000', ${ids.actorId}::uuid)`.execute(tx);
    const emirate = await sql<{ id: string }>`select id from emirates where code = 'DXB'`.execute(tx);
    await sql`insert into areas(id, company_id, emirate_id, code, name_en)
      values (${ids.areaId}::uuid, ${ids.companyId}::uuid, ${emirate.rows[0]!.id}::uuid,
        ${`AREA-${ids.areaId.slice(0, 8)}`}, 'Repair Area')`.execute(tx);
    await sql`insert into orders(
      id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
      customer_name, customer_mobile_number, customer_address, reference_number,
      reference_number_normalized, package_count, payment_condition, service_fee,
      final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status,
      trader_gross_payable, trader_net_payable, cod_amount, customer_amount_due,
      delivery_status, driver_reconciliation_status, trader_settlement_status, return_status
    ) values (
      ${ids.orderId}::uuid, ${ids.companyId}::uuid, ${orderNumber}, current_date,
      ${ids.traderId}::uuid, ${ids.areaId}::uuid, ${ids.actorId}::uuid,
      'Repair Customer', '971501111111', 'Test Address', ${reference}, lower(${reference}), 1,
      'customer_pays_cod_trader_pays_fee', 18, 18, 'legacy_unattributed', 'legacy_unattributed',
      0, 0, 0, 0, 'delivered', 'not_applicable', 'not_eligible', 'not_applicable'
    )`.execute(tx);
    await sql`insert into trader_receivables(
      id, company_id, receivable_number, trader_id, source_type, source_reference,
      business_date, original_amount_due, amount_collected, status, reason,
      notes, created_by_account_id
    ) values (
      ${ids.historicalReceivableId}::uuid, ${ids.companyId}::uuid, ${reference},
      ${ids.traderId}::uuid, 'service_charge', ${orderNumber}, current_date, 18, 0,
      'reversed', 'Historical reset fixture', 'Synthetic test record', ${ids.actorId}::uuid
    )`.execute(tx);
    await sql`insert into trader_receivables(
      id, company_id, receivable_number, trader_id, source_type, source_reference,
      business_date, original_amount_due, amount_collected, status, reason,
      notes, created_by_account_id
    ) values (
      ${ids.cancelledReceivableId}::uuid, ${ids.companyId}::uuid,
      ${`RCV-CANCELLED-${ids.cancelledReceivableId.slice(0, 8)}`}, ${ids.traderId}::uuid,
      'service_charge', ${orderNumber}, current_date, 18, 0,
      'cancelled', 'Historical cancellation fixture', 'Synthetic test record', ${ids.actorId}::uuid
    )`.execute(tx);
  });
  return { ...ids, orderNumber };
}

function buildService(transaction: Transaction<DatabaseSchema>, fixture: { companyId: string; actorId: string; traderId: string }) {
  const tenants = { current: (): TenantContext => ({ companyId: fixture.companyId, identityId: fixture.actorId }) };
  const identities = {
    current: (): IdentityContext => ({
      companyId: fixture.companyId, forcePasswordChange: false, identityId: fixture.actorId,
      kind: "company_user", permissions: new Set(["trader_receivables.create"]),
      sessionId: "repair-test",
    }),
  };
  const transactions = { execute: async <T>(work: (tx: Transaction<DatabaseSchema>) => Promise<T>) => work(transaction) };
  return new OperationsService(
    transaction as unknown as Kysely<DatabaseSchema>, transactions as never, tenants as never,
    undefined as never, undefined as never, identities as never, undefined as never,
    undefined as never, undefined as never, undefined as never,
    new OperationsHistoryWriter(new WhatsAppOutboxWriter()),
  );
}

async function counts(database: Kysely<DatabaseSchema>, fixture: { companyId: string; orderNumber: string }) {
  const rows = await sql<{ active: string; events: string }>`
    select
      (select count(*) from trader_receivables where company_id=${fixture.companyId}::uuid
        and source_type='service_charge' and source_reference=${fixture.orderNumber}
        and status not in ('reversed', 'cancelled'))::text as active,
      (select count(*) from accounting_events where company_id=${fixture.companyId}::uuid
        and source_entity_type='trader_receivable'
        and source_entity_id in (
          select id from trader_receivables where company_id=${fixture.companyId}::uuid
            and source_type='service_charge' and source_reference=${fixture.orderNumber}
            and status not in ('reversed', 'cancelled')
        )
        and event_type='trader_receivable_recognized')::text as events
  `.execute(database);
  return { active: Number(rows.rows[0]!.active), events: Number(rows.rows[0]!.events) };
}

describe.skipIf(!runDatabaseTests)("repairTraderReceivable database certification", () => {
  it("creates one replacement, is idempotent, and emits one recognition event", async () => {
    await withDatabase(async (database) => {
      const fixture = await seedFixture(database);
      await database.transaction().execute(async (tx) => {
        const service = buildService(tx, fixture);
        expect(await service.repairTraderReceivable(fixture.orderId, "repair-idempotency-1")).toEqual({ created: true, amount: "18.00" });
        expect(await service.repairTraderReceivable(fixture.orderId, "repair-idempotency-2")).toEqual({ created: false, amount: "18.00" });
        const result = await counts(tx as unknown as Kysely<DatabaseSchema>, fixture);
        expect(result.active).toBe(1);
        expect(result.events).toBe(1);
        throw new Error("ROLLBACK_FIXTURE");
      }).catch((error) => { if (!(error instanceof Error) || error.message !== "ROLLBACK_FIXTURE") throw error; });
    });
  });

  it("rolls back the replacement and accounting event when the outer transaction fails", async () => {
    await withDatabase(async (database) => {
      const fixture = await seedFixture(database);
      await database.transaction().execute(async (tx) => {
        const service = buildService(tx, fixture);
        expect(await service.repairTraderReceivable(fixture.orderId, "repair-rollback")).toEqual({ created: true, amount: "18.00" });
        throw new Error("FORCED_REPAIR_ROLLBACK");
      }).catch((error) => { if (!(error instanceof Error) || error.message !== "FORCED_REPAIR_ROLLBACK") throw error; });
      const result = await counts(database, fixture);
      expect(result.active).toBe(0);
      expect(result.events).toBe(0);
    });
  });
});
