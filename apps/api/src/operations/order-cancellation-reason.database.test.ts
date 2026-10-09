import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Decimal } from "decimal.js";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { calculateOrderFinancials } from "./order-financial-model.js";

/**
 * Order cancellation type column and constraint against a real PostgreSQL schema.
 *
 * Disposable database only: refuses to run unless the connected database is
 * named `blueline` on a local host. Every transaction here is rolled back, so
 * nothing is left behind.
 *
 *   RUN_ORDER_CANCELLATION_DATABASE=true pnpm --filter @blueline/api exec vitest run src/operations/order-cancellation-reason.database.test.ts
 */
const run = process.env.RUN_ORDER_CANCELLATION_DATABASE === "true";

type Db = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
class Rollback extends Error {}

let pool: Pool;
let database: Kysely<DatabaseSchema>;

async function inRollback(work: (tx: Transaction<DatabaseSchema>) => Promise<void>): Promise<void> {
  try {
    await database.transaction().execute(async (tx) => {
      await work(tx);
      throw new Rollback("rollback");
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

interface CompanyFixture {
  readonly companyId: string;
  readonly actorId: string;
  readonly traderId: string;
  readonly areaId: string;
}

async function company(tx: Db): Promise<CompanyFixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const traderId = randomUUID();
  const areaId = randomUUID();
  const tag = companyId.slice(0, 8);
  await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
    values (${companyId}::uuid, ${`OS-${tag}`}, ${`os-${tag}`}, 'Order Cancellation Test', 'active', now())`.execute(
    tx,
  );
  await sql`insert into accounts(id, company_id, account_kind, username, password_hash, preferred_language)
    values (${actorId}::uuid, ${companyId}::uuid, 'company_user', ${`os.a.${actorId}`}, 'x', 'en')`.execute(
    tx,
  );
  await sql`insert into traders(id, company_id, code, name_en, mobile_number, created_by_account_id)
    values (${traderId}::uuid, ${companyId}::uuid, ${`TRD-${tag}`}, 'Serial Trader', '971500000000', ${actorId}::uuid)`.execute(
    tx,
  );
  const emirate = await sql<{ id: string }>`select id from emirates where code = 'DXB' limit 1`.execute(
    tx,
  );
  let emirateId = emirate.rows[0]?.id;
  if (emirateId === undefined) {
    emirateId = randomUUID();
    await sql`insert into emirates(id, code, name_en, name_ar, display_order)
      values (${emirateId}::uuid, 'DXB', 'Dubai', 'دبي', 999)`.execute(tx);
  }
  await sql`insert into areas(id, company_id, emirate_id, code, name_en)
    values (${areaId}::uuid, ${companyId}::uuid, ${emirateId}::uuid, ${`AREA-${tag}`}, 'Serial Area')`.execute(
    tx,
  );
  return { companyId, actorId, traderId, areaId };
}

let orderSequence = 0;

/** A minimal valid `new` Order with the given Serial on the given day offset. */
async function order(
  tx: Db,
  c: CompanyFixture,
  serial: string,
  dayOffset = 0,
): Promise<void> {
  orderSequence += 1;
  const f = calculateOrderFinancials({
    prospective: true,
    additionalFees: new Decimal(0),
    codAmount: new Decimal(100),
    driverCost: new Decimal(0),
    paymentCondition: "customer_pays_cod_and_fee",
    serviceFee: new Decimal(18),
    vatPolicy: { enabled: false, priceMode: null, rate: new Decimal(0) },
  });
  const net = f.traderNetPayable.toNumber();
  await sql`insert into orders(
      id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
      customer_name, customer_mobile_number, customer_address, package_count,
      payment_condition, final_service_fee_snapshot, customer_provenance_status,
      pricing_provenance_status, financial_model_version, serial_number, serial_number_normalized,
      reference_number, reference_number_normalized, area_name_fallback_used,
      vat_enabled_snapshot, vat_rate_snapshot, vat_price_mode_snapshot, additional_fee_vat_amount,
      service_fee_vat_amount, cod_amount, service_fee, additional_fees, service_fee_net_amount,
      customer_amount_due, trader_gross_payable, trader_paid_service_fee, trader_deductions,
      total_deductions, trader_net_payable, company_revenue, order_profit, vat_amount,
      trader_paid_amount, amount_collected, delivery_status, delivered_at, closed_at,
      driver_reconciliation_status, trader_settlement_status, return_status, assigned_driver_id
    ) values (
      ${randomUUID()}::uuid, ${c.companyId}::uuid,
      ${`ORD-S${String(orderSequence).padStart(6, "0")}`}, current_date + ${dayOffset}::int,
      ${c.traderId}::uuid, ${c.areaId}::uuid, ${c.actorId}::uuid, 'Serial Customer', '971501111111',
      'Address', 1, 'customer_pays_cod_and_fee', 18, 'legacy_unattributed', 'legacy_unattributed',
      'trader_deduction_v1', ${serial}, ${serial.toLowerCase()}, null, null, false, false, 0, null,
      0, 0, ${f.codAmount.toNumber()}, ${f.serviceFee.toNumber()}, ${f.additionalFees.toNumber()},
      ${f.serviceFeeNetAmount.toNumber()}, ${f.customerAmountDue.toNumber()}, ${f.codAmount.toNumber()},
      ${f.traderPaidServiceFee.toNumber()}, ${f.traderDeductions.toNumber()},
      ${f.totalDeductions.toNumber()}, ${net}, ${f.companyRevenue.toNumber()},
      ${f.orderProfit.toNumber()}, ${f.vatAmount.toNumber()}, 0, 0, 'new', null, null,
      'not_applicable', ${net > 0 ? "unsettled" : "not_eligible"}, 'not_applicable', null
    )`.execute(tx);
}

describe.skipIf(!run)("Order cancellation type (database)", () => {
  beforeAll(async () => {
    if (process.env.BLUELINE_DISABLE_DOTENV !== "1") {
      loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    }
    pool = new Pool({ connectionString: configuration().database.url, max: 2 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const identity = await sql<{ name: string; local: boolean }>`
      select current_database() as name,
             coalesce(host(inet_server_addr()) in ('127.0.0.1', '::1'), true) as local
    `.execute(database);
    const row = identity.rows[0];
    if (row?.name !== "blueline" || !row.local) {
      throw new Error(`Refusing Order Cancellation tests against database ${String(row?.name)}`);
    }
  });

  afterAll(async () => {
    await database?.destroy();
  });

  const cancel = (tx: Db, companyId: string, serial: string, code: string | null) =>
    sql`update orders
           set delivery_status = 'cancelled', delivery_reason = 'test',
               trader_settlement_status = 'not_eligible',
               driver_reconciliation_status = 'not_applicable',
               cancellation_reason_code = ${code}
         where company_id = ${companyId}::uuid and serial_number = ${serial}`.execute(tx);

  const stored = async (tx: Db, companyId: string, serial: string) =>
    (
      await sql<{ code: string | null }>`select cancellation_reason_code as code from orders
        where company_id = ${companyId}::uuid and serial_number = ${serial}`.execute(tx)
    ).rows[0]?.code;

  it.each(["cancel_by_customer", "cancel_by_trader", "cancel_normal"])(
    "stores %s on a cancelled Order",
    async (code) => {
      await inRollback(async (tx) => {
        const c = await company(tx);
        await order(tx, c, "1");
        await cancel(tx, c.companyId, "1", code);
        expect(await stored(tx, c.companyId, "1")).toBe(code);
      });
    },
  );

  it("keeps NULL for Orders that are not cancelled or were cancelled before the column", async () => {
    await inRollback(async (tx) => {
      const c = await company(tx);
      await order(tx, c, "1");
      expect(await stored(tx, c.companyId, "1")).toBeNull();
      await cancel(tx, c.companyId, "1", null);
      expect(await stored(tx, c.companyId, "1")).toBeNull();
    });
  });

  it("rejects a value outside the fixed list", async () => {
    await expect(
      inRollback(async (tx) => {
        const c = await company(tx);
        await order(tx, c, "1");
        await cancel(tx, c.companyId, "1", "cancel_by_driver");
      }),
    ).rejects.toThrow(/orders_cancellation_reason_code_check/);
  });
});
