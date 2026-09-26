import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { PayrollCalculationService } from "./payroll-calculation.service.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";
import { PayrollOperationalRepository } from "./payroll-operational.repository.js";

/**
 * The composite payroll figure, asserted end to end.
 *
 * Everything here has been provable in pieces for a while: delivery earnings
 * snapshot at AED 2, collection facts price at AED 1, and both allocate once.
 * What was NOT proven is that they assemble — that a real
 * `PayrollCalculationService.calculate()` run over a real period puts
 * 3000 + 6 + 3 into `payroll_entries.gross_earnings` and the period totals.
 *
 * So these read the authoritative stored columns after a real calculation, not
 * the service's return value and not a helper's arithmetic. If the wiring into
 * `gross` were ever removed, the component queries would still pass and only
 * this file would fail.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `pve_${++this.sequence}`;
    await sql.raw(`savepoint ${savepoint}`).execute(this.transaction);
    try {
      const result = await work(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      return result;
    } catch (error) {
      await sql.raw(`rollback to savepoint ${savepoint}`).execute(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      throw error;
    }
  }
}

interface Fixture {
  readonly actorId: string;
  readonly areaId: string;
  readonly companyId: string;
  readonly deliveryRuleId: string;
  readonly driverId: string;
  readonly employeeId: string;
  readonly periodId: string;
  readonly traderId: string;
}

function connect(): Kysely<DatabaseSchema> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 4 });
  return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  const database = connect();
  const marker = new Error("rollback payroll variable earnings test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction);
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    // destroy() ends the underlying pool; calling pool.end() as well throws.
    await database.destroy();
  }
}

/**
 * Ahmad: a salaried employee Driver on AED 3,000, enrolled in both earning
 * schemes, with an open August payroll period ready to calculate.
 */
async function seed(transaction: Transaction<DatabaseSchema>, label: string): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const employeeId = randomUUID();
  const driverId = randomUUID();
  const deliveryRuleId = randomUUID();
  const periodId = randomUUID();
  const short = companyId.slice(0, 8);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Variable Earnings Payroll','active',now())`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`pv.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into employees(id,company_id,employee_number,name_en,employee_type,
      hired_on,payroll_eligible,is_active)
    values(${employeeId}::uuid,${companyId}::uuid,${`EMP-${short}`},'Ahmad','employee',
      '2026-01-01'::date,true,true)`.execute(transaction);
  await sql`insert into employee_salary_versions(company_id,employee_id,basic_salary,
      effective_from,created_by_account_id)
    values(${companyId}::uuid,${employeeId}::uuid,3000,'2026-01-01'::date,
      ${actorId}::uuid)`.execute(transaction);
  await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,employee_id)
    values(${driverId}::uuid,${companyId}::uuid,${`DRV-${short}`},'Ahmad','971500000001',
      'employee',${employeeId}::uuid)`.execute(transaction);

  // AED 2 per delivered Order, AED 1 per collected Order, both open-ended.
  await sql`insert into employee_delivery_earning_rules(id,company_id,employee_id,
      amount_per_order,effective_from)
    values(${deliveryRuleId}::uuid,${companyId}::uuid,${employeeId}::uuid,2,
      '2026-01-01'::date)`.execute(transaction);
  await sql`insert into employee_collection_earning_rules(company_id,employee_id,
      collection_payment_type,amount,effective_from)
    values(${companyId}::uuid,${employeeId}::uuid,'per_collected_order',1,
      '2026-01-01'::date)`.execute(transaction);

  // Area and Trader are created ONCE: `areas_emirate_name_en_unique` forbids a
  // second 'Area' in the same Emirate, so per-Order creation collides.
  const areaId = randomUUID();
  const traderId = randomUUID();
  const emirate = await sql<{ id: string }>`select id from emirates limit 1`.execute(transaction);
  await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
    values(${areaId}::uuid,${companyId}::uuid,${`A-${short}`},${`Area ${short}`},'منطقة',
      ${emirate.rows[0]!.id}::uuid)`.execute(transaction);
  await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,
      created_by_account_id)
    values(${traderId}::uuid,${companyId}::uuid,${`T-${short}`},'Trader','971500000003',
      ${areaId}::uuid,${actorId}::uuid)`.execute(transaction);

  await sql`insert into payroll_periods(id,company_id,period_start,period_end,payroll_month,
      period_reference,status)
    values(${periodId}::uuid,${companyId}::uuid,'2026-08-01'::date,'2026-08-31'::date,
      '2026-08-01'::date,${`PR-${short}`},'draft')`.execute(transaction);

  return { actorId, areaId, companyId, deliveryRuleId, driverId, employeeId, periodId, traderId };
}

/** One delivered-Order earning snapshot, exactly as the accrual writes it. */
async function deliveryEarning(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  orderNumber: string,
  amount = 2,
): Promise<void> {
  // A real Order row is required by the foreign key; the columns below are the
  // minimum the table's checks accept.
  const orderId = randomUUID();
  await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
      created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
      payment_condition,final_service_fee_snapshot,service_fee,assigned_driver_id,
      customer_provenance_status,pricing_provenance_status,delivered_at)
    values(${orderId}::uuid,${fixture.companyId}::uuid,${orderNumber},'2026-08-07'::date,
      ${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,'Customer','971500000009',
      'Address',1,'customer_pays_cod_and_fee',10,10,${fixture.driverId}::uuid,
      'legacy_unattributed','legacy_unattributed','2026-08-07T09:00:00Z'::timestamptz)`.execute(
    transaction,
  );
  await sql`insert into employee_order_earnings(company_id,employee_id,order_id,rule_id,
      order_number,delivered_at,applied_amount,earning_month)
    values(${fixture.companyId}::uuid,${fixture.employeeId}::uuid,${orderId}::uuid,
      ${fixture.deliveryRuleId}::uuid,${orderNumber},'2026-08-07T09:00:00Z'::timestamptz,
      ${amount},'2026-08-01'::date)`.execute(transaction);
}

/** One confirmed collection fact covering `count` Orders. */
async function collectionFact(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  count: number,
): Promise<void> {
  const reconciliationId = randomUUID();
  await sql`insert into driver_reconciliations(id,company_id,reconciliation_number,driver_id,
      business_date,gross_collections,net_amount_received,status,created_by_account_id,
      confirmed_by_account_id,confirmed_at)
    values(${reconciliationId}::uuid,${fixture.companyId}::uuid,
      ${`REC-${reconciliationId.slice(0, 8)}`},${fixture.driverId}::uuid,'2026-08-10'::date,
      0,0,'confirmed',${fixture.actorId}::uuid,${fixture.actorId}::uuid,now())`.execute(
    transaction,
  );
  await sql`insert into employee_driver_collection_facts(company_id,employee_id,driver_id,
      reconciliation_id,business_date,confirmed_at,counts_for_collection_earning,
      collected_order_count,count_source,created_by_account_id)
    values(${fixture.companyId}::uuid,${fixture.employeeId}::uuid,${fixture.driverId}::uuid,
      ${reconciliationId}::uuid,'2026-08-10'::date,now(),true,${count},'auto_from_orders',
      ${fixture.actorId}::uuid)`.execute(transaction);
}

function calculationService(transaction: Transaction<DatabaseSchema>, fixture: Fixture) {
  const tenants = {
    current: () => ({ companyId: fixture.companyId, identityId: fixture.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = {
    current: () => ({
      identityId: fixture.actorId,
      permissions: new Set(["payroll.manage"]),
    }),
  } as unknown as IdentityContextAccessor;
  const manager = new SavepointTransactionManager(
    transaction,
  ) as unknown as KyselyTransactionManager;
  return new PayrollCalculationService(
    manager,
    new PayrollOperationSupport(tenants, identities),
    new PayrollOperationalRepository(),
    new OperationsHistoryWriter(),
  );
}

/** The stored payroll line and period totals — the authoritative figures. */
async function payrollResult(transaction: Transaction<DatabaseSchema>, fixture: Fixture) {
  const entry = await sql<{
    basic: string;
    collection: string;
    delivery: string;
    gross: string;
    net: string;
  }>`
    select basic_salary_snapshot::text as basic,
           delivered_order_earnings::text as delivery,
           collection_earnings::text as collection,
           gross_earnings::text as gross, net_salary::text as net
      from payroll_entries
     where company_id=${fixture.companyId}::uuid and payroll_period_id=${fixture.periodId}::uuid
  `.execute(transaction);
  const period = await sql<{ collection: string; delivery: string }>`
    select total_delivered_order_earnings::text as delivery,
           total_collection_earnings::text as collection
      from payroll_periods where id=${fixture.periodId}::uuid
  `.execute(transaction);
  return { entry: entry.rows[0]!, period: period.rows[0]! };
}

describe.skipIf(!runDatabaseTests)("payroll with driver variable earnings", () => {
  it("assembles 3000 + 6 + 3 = 3009 into the stored payroll entry", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "PVA");
      for (const number of ["ORD-A", "ORD-B", "ORD-F"]) {
        await deliveryEarning(transaction, fixture, number);
      }
      await collectionFact(transaction, fixture, 3);

      await calculationService(transaction, fixture).calculate(
        fixture.periodId,
        randomUUID(),
        randomUUID(),
      );

      const { entry, period } = await payrollResult(transaction, fixture);
      expect(entry.basic).toBe("3000.00");
      expect(entry.delivery).toBe("6.00");
      expect(entry.collection).toBe("3.00");
      expect(entry.gross).toBe("3009.00");
      expect(entry.net).toBe("3009.00");
      // The period totals must agree with the line, or the payslip and the
      // ledger would tell different stories.
      expect(period.delivery).toBe("6.00");
      expect(period.collection).toBe("3.00");
    });
  });

  it("counts a free Order for delivery earnings: 3000 + 8 + 3 = 3011", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "PVB");
      for (const number of ["ORD-A", "ORD-B", "ORD-F"]) {
        await deliveryEarning(transaction, fixture, number);
      }
      /* ORD-G is the zero-value Order. It earns the Driver exactly what any
         other delivery earns, because the earning is owed for the work rather
         than for the money: `EmployeeDeliveryEarningService` gates on
         delivered_at, never on Order value. Collections are unaffected — a free
         Order carries no COD to hand over. */
      await deliveryEarning(transaction, fixture, "ORD-G");
      await collectionFact(transaction, fixture, 3);

      await calculationService(transaction, fixture).calculate(
        fixture.periodId,
        randomUUID(),
        randomUUID(),
      );

      const { entry } = await payrollResult(transaction, fixture);
      expect(entry.delivery).toBe("8.00");
      expect(entry.collection).toBe("3.00");
      expect(entry.gross).toBe("3011.00");
    });
  });

  it("pays 3006 when the Employee has no collection rule", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "PVC");
      await sql`delete from employee_collection_earning_rules
                 where company_id=${fixture.companyId}::uuid`.execute(transaction);
      for (const number of ["ORD-A", "ORD-B", "ORD-F"]) {
        await deliveryEarning(transaction, fixture, number);
      }
      await collectionFact(transaction, fixture, 3);

      await calculationService(transaction, fixture).calculate(
        fixture.periodId,
        randomUUID(),
        randomUUID(),
      );

      const { entry } = await payrollResult(transaction, fixture);
      // The facts still exist and are still counted; with no rule they are
      // simply worth nothing.
      expect(entry.collection).toBe("0.00");
      expect(entry.gross).toBe("3006.00");
    });
  });

  it("allocates both earning kinds and does not pay them twice on recalculation", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "PVD");
      for (const number of ["ORD-A", "ORD-B", "ORD-F"]) {
        await deliveryEarning(transaction, fixture, number);
      }
      await collectionFact(transaction, fixture, 3);
      const service = calculationService(transaction, fixture);

      await service.calculate(fixture.periodId, randomUUID(), randomUUID());
      const allocated = await sql<{ facts: string; earnings: string }>`
        select
          (select count(*)::text from employee_order_earnings
            where company_id=${fixture.companyId}::uuid and payroll_period_id is not null) as earnings,
          (select count(*)::text from employee_driver_collection_facts
            where company_id=${fixture.companyId}::uuid and payroll_period_id is not null) as facts
      `.execute(transaction);
      expect(allocated.rows[0]!.earnings).toBe("3");
      expect(allocated.rows[0]!.facts).toBe("1");

      // Recalculating releases and re-allocates within the same transaction, so
      // the figure must land on exactly the same total rather than doubling.
      await service.recalculate(fixture.periodId, randomUUID(), randomUUID());
      const { entry } = await payrollResult(transaction, fixture);
      expect(entry.gross).toBe("3009.00");
    });
  });

  it("does not let a later period pay earnings the first one already took", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "PVE");
      for (const number of ["ORD-A", "ORD-B", "ORD-F"]) {
        await deliveryEarning(transaction, fixture, number);
      }
      await collectionFact(transaction, fixture, 3);
      const service = calculationService(transaction, fixture);
      await service.calculate(fixture.periodId, randomUUID(), randomUUID());

      // September, over the same Company and Employee.
      const septemberId = randomUUID();
      await sql`insert into payroll_periods(id,company_id,period_start,period_end,payroll_month,
          period_reference,status)
        values(${septemberId}::uuid,${fixture.companyId}::uuid,'2026-09-01'::date,
          '2026-09-30'::date,'2026-09-01'::date,
          ${`PR2-${fixture.companyId.slice(0, 8)}`},'draft')`.execute(transaction);
      await service.calculate(septemberId, randomUUID(), randomUUID());

      const september = await sql<{ collection: string; delivery: string; gross: string }>`
        select delivered_order_earnings::text as delivery,
               collection_earnings::text as collection, gross_earnings::text as gross
          from payroll_entries
         where company_id=${fixture.companyId}::uuid and payroll_period_id=${septemberId}::uuid
      `.execute(transaction);
      expect(september.rows[0]!.delivery).toBe("0.00");
      expect(september.rows[0]!.collection).toBe("0.00");
      expect(september.rows[0]!.gross).toBe("3000.00");
    });
  });

  it("keeps the gross correct through the adjustment recalculation path", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "PVG");
      for (const number of ["ORD-A", "ORD-B", "ORD-F"]) {
        await deliveryEarning(transaction, fixture, number);
      }
      await collectionFact(transaction, fixture, 3);
      const service = calculationService(transaction, fixture);
      await service.calculate(fixture.periodId, randomUUID(), randomUUID());
      expect((await payrollResult(transaction, fixture)).entry.gross).toBe("3009.00");

      /* `recalculateLine` is the authoritative gross, and it runs on every
         adjustment as well as after calculation — that is where the collection
         component was being dropped. An earning adjustment forces it to run
         again through the OTHER caller, so this covers the path payroll
         adjustments use rather than only the calculation path. */
      const lineId = await sql<{ id: string }>`
        select id from payroll_entries
         where company_id=${fixture.companyId}::uuid
           and payroll_period_id=${fixture.periodId}::uuid`.execute(transaction);
      await sql`insert into payroll_adjustments(company_id,payroll_period_id,payroll_line_id,
          employee_id,adjustment_type,direction,amount,reason,status,created_by_account_id)
        values(${fixture.companyId}::uuid,${fixture.periodId}::uuid,${lineId.rows[0]!.id}::uuid,
          ${fixture.employeeId}::uuid,'bonus','earning',100,'Bonus','active',
          ${fixture.actorId}::uuid)`.execute(transaction);
      await new PayrollOperationalRepository().recalculateLine(
        transaction,
        fixture.companyId,
        lineId.rows[0]!.id,
      );

      const { entry } = await payrollResult(transaction, fixture);
      // 3000 + 6 + 3 + 100. If collection were dropped again this would be 3106.
      expect(entry.gross).toBe("3109.00");
      expect(entry.collection).toBe("3.00");
      expect(entry.delivery).toBe("6.00");
    });
  });

  it("prices each delivery from its own historical rule, not the current rate", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "PVF");
      for (const number of ["ORD-A", "ORD-B", "ORD-F"]) {
        await deliveryEarning(transaction, fixture, number);
      }
      // Collection too, so this case asserts the full 3009 rather than a
      // delivery-only subset.
      await collectionFact(transaction, fixture, 3);
      /* Raise the rate after the fact. The snapshots already hold AED 2 each,
         so August must still pay 6 — this is the guarantee that a rate change
         cannot restate a payslip. */
      await sql`update employee_delivery_earning_rules
                   set effective_to='2026-09-01'::date
                 where id=${fixture.deliveryRuleId}::uuid`.execute(transaction);
      await sql`insert into employee_delivery_earning_rules(company_id,employee_id,
          amount_per_order,effective_from)
        values(${fixture.companyId}::uuid,${fixture.employeeId}::uuid,5,
          '2026-09-01'::date)`.execute(transaction);

      await calculationService(transaction, fixture).calculate(
        fixture.periodId,
        randomUUID(),
        randomUUID(),
      );
      const { entry } = await payrollResult(transaction, fixture);
      expect(entry.delivery).toBe("6.00");
      expect(entry.gross).toBe("3009.00");
    });
  });
});
