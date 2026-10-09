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
import { allocateAutomaticOrderSerial } from "./order-serial-allocation.js";

/**
 * Automatic Serial Number allocation against a real PostgreSQL schema.
 *
 * Disposable database only: refuses to run unless the connected database is
 * named `blueline` on a local host. Every transaction here is rolled back, so
 * nothing is left behind.
 *
 *   RUN_ORDER_SERIAL_DATABASE=true pnpm --filter @blueline/api exec vitest run src/operations/order-serial-allocation.database.test.ts
 */
const run = process.env.RUN_ORDER_SERIAL_DATABASE === "true";

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
    values (${companyId}::uuid, ${`OS-${tag}`}, ${`os-${tag}`}, 'Order Serial Test', 'active', now())`.execute(
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

describe.skipIf(!run)("Automatic Order Serial allocation (database)", () => {
  beforeAll(async () => {
    if (process.env.BLUELINE_DISABLE_DOTENV !== "1") {
      loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    }
    pool = new Pool({ connectionString: configuration().database.url, max: 4 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const identity = await sql<{ name: string; local: boolean }>`
      select current_database() as name,
             coalesce(host(inet_server_addr()) in ('127.0.0.1', '::1'), true) as local
    `.execute(database);
    const row = identity.rows[0];
    if (row?.name !== "blueline" || !row.local) {
      throw new Error(`Refusing Order Serial tests against database ${String(row?.name)}`);
    }
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it("starts at 1 on a day with no Orders", async () => {
    await inRollback(async (tx) => {
      const c = await company(tx);
      expect(await allocateAutomaticOrderSerial(tx, c.companyId)).toBe("1");
    });
  });

  it("continues after the real last number and ignores a typed outlier (1-63 + 500 -> 64)", async () => {
    await inRollback(async (tx) => {
      const c = await company(tx);
      for (let serial = 1; serial <= 63; serial += 1) await order(tx, c, String(serial));
      await order(tx, c, "500");
      expect(await allocateAutomaticOrderSerial(tx, c.companyId)).toBe("64");
    });
  });

  it("sees an Order it inserted earlier in the same transaction (rows in sequence)", async () => {
    await inRollback(async (tx) => {
      const c = await company(tx);
      const first = await allocateAutomaticOrderSerial(tx, c.companyId);
      await order(tx, c, first);
      const second = await allocateAutomaticOrderSerial(tx, c.companyId);
      expect([first, second]).toEqual(["1", "2"]);
    });
  });

  it("ignores other days, non-numeric serials and other Companies", async () => {
    await inRollback(async (tx) => {
      const mine = await company(tx);
      const other = await company(tx);
      for (let serial = 1; serial <= 5; serial += 1) await order(tx, mine, String(serial));
      for (let serial = 1; serial <= 40; serial += 1) await order(tx, mine, String(serial), -1);
      await order(tx, mine, "SER-A");
      for (let serial = 1; serial <= 80; serial += 1) await order(tx, other, String(serial));
      expect(await allocateAutomaticOrderSerial(tx, mine.companyId)).toBe("6");
      expect(await allocateAutomaticOrderSerial(tx, other.companyId)).toBe("81");
    });
  });

  it("steps over a number the caller lost to a typed Serial", async () => {
    await inRollback(async (tx) => {
      const c = await company(tx);
      for (let serial = 1; serial <= 3; serial += 1) await order(tx, c, String(serial));
      expect(await allocateAutomaticOrderSerial(tx, c.companyId, ["4"])).toBe("5");
    });
  });

  it("serializes concurrent allocations for one Company and day, and a rollback consumes no number", async () => {
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    let reportFirst!: (value: { companyId: string; serial: string }) => void;
    const firstAllocated = new Promise<{ companyId: string; serial: string }>((resolveFirst) => {
      reportFirst = resolveFirst;
    });

    const first = inRollback(async (tx) => {
      const c = await company(tx);
      const serial = await allocateAutomaticOrderSerial(tx, c.companyId);
      await order(tx, c, serial);
      reportFirst({ companyId: c.companyId, serial });
      await firstMayFinish;
    });

    const { companyId, serial: firstSerial } = await firstAllocated;
    let secondSerial: string | undefined;
    const second = inRollback(async (tx) => {
      secondSerial = await allocateAutomaticOrderSerial(tx, companyId);
    });

    // The second allocation must wait on the first's day lock.
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    expect(secondSerial).toBeUndefined();

    releaseFirst();
    await first;
    await second;

    expect(firstSerial).toBe("1");
    // The first transaction rolled back, so its number is free again.
    expect(secondSerial).toBe("1");
  });
});
