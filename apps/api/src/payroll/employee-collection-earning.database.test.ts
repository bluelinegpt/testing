import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { EmployeeCollectionEarningService } from "./employee-collection-earning.service.js";

/**
 * Employee Driver collection earnings: fact capture, and the pricing Payroll
 * later performs from it.
 *
 * The pricing is asserted against the SAME SQL the calculation service runs
 * rather than through the whole payroll pipeline: standing up a full payroll
 * period needs salary versions, business-day configuration and an approved
 * calendar, and the claim under test here is the rule resolution and the
 * paid-once allocation, not the surrounding orchestration. The end-to-end
 * 3,000 + 6 + 3 assembly is noted as remaining work in the report.
 *
 * Every case runs inside one transaction that is rolled back.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class MutableIdentity {
  public constructor(
    public companyId: string,
    public actorId: string,
  ) {}
}

interface Fixture {
  readonly actorId: string;
  readonly areaId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly employeeId: string;
  readonly outsourcedDriverId: string;
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
  const marker = new Error("rollback collection earning test");
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

/** One Company, one employee Driver (Ahmad), and one outsourced Driver. */
async function seed(transaction: Transaction<DatabaseSchema>, label: string): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const employeeId = randomUUID();
  const driverId = randomUUID();
  const outsourcedDriverId = randomUUID();
  const short = companyId.slice(0, 8);
  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Collection Earning Test','active',now())`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`ce.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into employees(id,company_id,name_en) values(${employeeId}::uuid,${companyId}::uuid,'Ahmad')`.execute(
    transaction,
  );
  await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,employee_id)
    values(${driverId}::uuid,${companyId}::uuid,${`DRV-${short}`},'Ahmad','971500000001','employee',
      ${employeeId}::uuid)`.execute(transaction);
  await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,outsourced_fee_per_delivered_order)
    values(${outsourcedDriverId}::uuid,${companyId}::uuid,${`OUT-${short}`},'Contractor',
      '971500000002','outsourced',5)`.execute(transaction);
  // Master data an Order cannot exist without. Seeded once per fixture so the
  // auto-count cases can link REAL Orders and the foreign key stays meaningful.
  const emirate = await sql<{ id: string }>`select id from emirates limit 1`.execute(transaction);
  const areaId = randomUUID();
  await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
    values(${areaId}::uuid,${companyId}::uuid,${`A-${short}`},'Area','منطقة',
      ${emirate.rows[0]!.id}::uuid)`.execute(transaction);
  const traderId = randomUUID();
  await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,
      created_by_account_id)
    values(${traderId}::uuid,${companyId}::uuid,${`TRD-${short}`},'Trader','971500000003',
      ${areaId}::uuid,${actorId}::uuid)`.execute(transaction);
  return { actorId, areaId, companyId, driverId, employeeId, outsourcedDriverId, traderId };
}

/** A minimal Order, enough to be linked by a collection fact. */
async function order(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  orderNumber: string,
): Promise<{ id: string; orderNumber: string }> {
  const id = randomUUID();
  await sql`insert into orders(
      id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,
      customer_name,customer_mobile_number,customer_address,package_count,payment_condition,
      final_service_fee_snapshot,assigned_driver_id,customer_provenance_status,
      pricing_provenance_status,service_fee
    ) values(${id}::uuid,${fixture.companyId}::uuid,${orderNumber},'2026-08-07'::date,
      ${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
      'Customer','971500000009','Address',1,'customer_pays_cod_and_fee',10,${fixture.driverId}::uuid,
      'legacy_unattributed','legacy_unattributed',10)`.execute(
    transaction,
  );
  return { id, orderNumber };
}

/** A confirmed reconciliation shell, enough to hang a fact off. */
async function reconciliation(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  businessDate: string,
  driverId?: string,
): Promise<string> {
  const id = randomUUID();
  await sql`insert into driver_reconciliations(
      id,company_id,reconciliation_number,driver_id,business_date,gross_collections,
      net_amount_received,status,created_by_account_id,confirmed_by_account_id,confirmed_at
    ) values(${id}::uuid,${fixture.companyId}::uuid,${`REC-${id.slice(0, 8)}`},
      ${driverId ?? fixture.driverId}::uuid,${businessDate}::date,0,0,'confirmed',
      ${fixture.actorId}::uuid,${fixture.actorId}::uuid,now())`.execute(transaction);
  return id;
}

function service(fixture: Fixture, identity: MutableIdentity) {
  const tenants = {
    current: () => ({ companyId: identity.companyId, identityId: identity.actorId }),
  } as unknown as TenantContextAccessor;
  return new EmployeeCollectionEarningService(tenants);
}

/**
 * The exact pricing query `PayrollCalculationService.resolveCollectionEarnings`
 * runs. Kept in step with it deliberately: if that SQL changes, this must too.
 */
async function priceForPeriod(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  employeeId: string,
  periodStart: string,
  periodEnd: string,
): Promise<{ amount: number; collections: number; orders: number }> {
  const result = await sql<{
    collectedOrderCount: number;
    paymentType: string | null;
    rate: string | null;
  }>`
    select f.collected_order_count as "collectedOrderCount",
           r.collection_payment_type as "paymentType", r.amount::text as rate
      from employee_driver_collection_facts f
      left join employee_collection_earning_rules r
        on r.company_id = f.company_id and r.employee_id = f.employee_id and r.is_active
       and r.effective_from <= f.business_date
       and (r.effective_to is null or f.business_date < r.effective_to)
     where f.company_id=${companyId}::uuid and f.employee_id=${employeeId}::uuid
       and f.counts_for_collection_earning and f.payroll_period_id is null
       and f.business_date between ${periodStart}::date and ${periodEnd}::date
     order by f.business_date, f.id
  `.execute(transaction);
  let amount = 0;
  let orders = 0;
  for (const row of result.rows) {
    orders += Number(row.collectedOrderCount);
    if (row.paymentType === "per_collected_order") {
      amount += Number(row.rate ?? 0) * Number(row.collectedOrderCount);
    } else if (row.paymentType === "flat_per_confirmed_collection") {
      amount += Number(row.rate ?? 0);
    }
  }
  return { amount, collections: result.rows.length, orders };
}

const addRule = (
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  type: string,
  amount: number,
  from: string,
  to?: string,
) =>
  sql`insert into employee_collection_earning_rules(
    company_id,employee_id,collection_payment_type,amount,effective_from,effective_to
  ) values(${fixture.companyId}::uuid,${fixture.employeeId}::uuid,${type},${amount},
    ${from}::date,${to ?? null}::date)`.execute(transaction);

describe.skipIf(!runDatabaseTests)("employee driver collection earnings", () => {
  it("derives immutable earning sources from eligible closed Collect Orders", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "COLLECT");
      await sql`insert into company_settings(company_id,timezone)
        values(${fixture.companyId}::uuid,'Asia/Dubai')`.execute(transaction);
      await addRule(transaction, fixture, "per_collected_order", 1, "2026-08-01");
      const createCollect = async (number: string, driverId: string) => {
        const id = randomUUID();
        await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
          created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
          payment_condition,final_service_fee_snapshot,assigned_driver_id,customer_provenance_status,
          pricing_provenance_status,service_fee_override_reason,order_type,delivery_status,driver_reconciliation_status,
          trader_settlement_status)
          values(${id}::uuid,${fixture.companyId}::uuid,${number},'2026-08-10',${fixture.traderId}::uuid,
          ${fixture.areaId}::uuid,${fixture.actorId}::uuid,'Pickup Customer','971500000009','Pickup',1,
          'customer_pays_cod_and_fee',0,${driverId}::uuid,'legacy_unattributed','legacy_unattributed','Collect Order',
          'collect_order','collect_order','not_applicable','not_eligible')`.execute(transaction);
        return id;
      };
      const eligible = await createCollect("COLLECT-ELIGIBLE", fixture.driverId);
      const open = await createCollect("COLLECT-OPEN", fixture.driverId);
      const wrongDriver = await createCollect("COLLECT-WRONG", fixture.outsourcedDriverId);
      const outside = await createCollect("COLLECT-OUTSIDE", fixture.driverId);
      await sql`update orders set delivery_status='closed',closed_at='2026-08-12T08:00:00Z'
        where id=${eligible}::uuid`.execute(transaction);
      await sql`update orders set delivery_status='closed',closed_at='2026-08-12T08:00:00Z'
        where id=${wrongDriver}::uuid`.execute(transaction);
      await sql`update orders set delivery_status='closed',closed_at='2026-09-02T08:00:00Z'
        where id=${outside}::uuid`.execute(transaction);
      const august = await sql<{amount:string;orderId:string;rate:string}>`select earned_amount::text amount,
        order_id "orderId",rate_snapshot::text rate from employee_collect_order_earnings
        where company_id=${fixture.companyId}::uuid and employee_id=${fixture.employeeId}::uuid
          and closed_at>='2026-08-01' and closed_at<'2026-09-01' order by order_id`.execute(transaction);
      expect(august.rows).toEqual([{ amount: "1.00", orderId: eligible, rate: "1.00" }]);
      expect(august.rows.some(row=>row.orderId===open||row.orderId===wrongDriver||row.orderId===outside)).toBe(false);

      const periodId=randomUUID();
      await sql`insert into employee_driver_earning_periods(id,company_id,employee_id,driver_id,date_from,date_to,
        delivered_order_count,collected_order_count,delivery_earnings,collection_rate_snapshot,
        collection_earnings,total_earnings,calculated_by_account_id)
        values(${periodId}::uuid,${fixture.companyId}::uuid,${fixture.employeeId}::uuid,${fixture.driverId}::uuid,
        '2026-08-01','2026-08-31',0,1,0,1,1,1,${fixture.actorId}::uuid)`.execute(transaction);
      await sql`update employee_collect_order_earnings set earning_period_id=${periodId}::uuid
        where company_id=${fixture.companyId}::uuid and order_id=${eligible}::uuid and earning_period_id is null`.execute(transaction);
      const reusable=await sql<{n:number}>`select count(*)::int n from employee_collect_order_earnings
        where company_id=${fixture.companyId}::uuid and order_id=${eligible}::uuid and earning_period_id is null`.execute(transaction);
      expect(reusable.rows[0]?.n).toBe(0);
      await sql`update orders set customer_name='Changed Later' where id=${eligible}::uuid`.execute(transaction);
      const snapshot=await sql<{amount:string;periodId:string;rate:string}>`select earned_amount::text amount,
        earning_period_id "periodId",rate_snapshot::text rate from employee_collect_order_earnings
        where company_id=${fixture.companyId}::uuid and order_id=${eligible}::uuid`.execute(transaction);
      expect(snapshot.rows[0]).toEqual({amount:"1.00",periodId,rate:"1.00"});
    });
  });

  it("captures three linked Orders as one fact with no monetary amount", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CEA");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      const recId = await reconciliation(transaction, fixture, "2026-08-07");

      const fact = await service(fixture, identity).captureForConfirmedCollection(
        transaction,
        {
          businessDate: "2026-08-07",
          countsForCollectionEarning: true,
          driverId: fixture.driverId,
          orderIds: await Promise.all(
            ["ORD-A", "ORD-B", "ORD-F"].map((number) => order(transaction, fixture, number)),
          ),
          reconciliationId: recId,
        },
        fixture.actorId,
      );

      expect(fact?.collectedOrderCount).toBe(3);
      expect(fact?.countSource).toBe("auto_from_orders");
      expect(fact?.employeeId).toBe(fixture.employeeId);
      // The whole point of the design: no money anywhere on the fact.
      const columns = await sql<{ columnName: string }>`
        select column_name as "columnName" from information_schema.columns
         where table_name='employee_driver_collection_facts'`.execute(transaction);
      const names = columns.rows.map((row) => row.columnName).join(",");
      expect(names).not.toMatch(/amount|rate|earning_value|commission/);
    });
  });

  it("records a non-counting fact when the operator leaves the box unticked", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CEB");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      const recId = await reconciliation(transaction, fixture, "2026-08-07");
      await addRule(transaction, fixture, "per_collected_order", 1, "2026-08-01");

      const fact = await service(fixture, identity).captureForConfirmedCollection(
        transaction,
        {
          businessDate: "2026-08-07",
          countsForCollectionEarning: false,
          driverId: fixture.driverId,
          orderIds: [await order(transaction, fixture, "ORD-A")],
          reconciliationId: recId,
        },
        fixture.actorId,
      );
      expect(fact?.countsForCollectionEarning).toBe(false);
      expect(fact?.collectedOrderCount).toBe(0);

      const priced = await priceForPeriod(
        transaction,
        fixture.companyId,
        fixture.employeeId,
        "2026-08-01",
        "2026-08-31",
      );
      expect(priced.amount).toBe(0);
    });
  });

  it("accepts a manual count when the collection carries no Order links", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CEC");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      const recId = await reconciliation(transaction, fixture, "2026-08-07");

      const fact = await service(fixture, identity).captureForConfirmedCollection(
        transaction,
        {
          businessDate: "2026-08-07",
          countsForCollectionEarning: true,
          driverId: fixture.driverId,
          manualOrderCount: 3,
          orderIds: [],
          reconciliationId: recId,
        },
        fixture.actorId,
      );
      expect(fact?.collectedOrderCount).toBe(3);
      expect(fact?.countSource).toBe("manual");
    });
  });

  it("refuses a counting collection with neither links nor a valid manual count", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CED");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      const recId = await reconciliation(transaction, fixture, "2026-08-07");

      for (const manual of [undefined, 0, -2, 1.5]) {
        await expect(
          service(fixture, identity).captureForConfirmedCollection(
            transaction,
            {
              businessDate: "2026-08-07",
              countsForCollectionEarning: true,
              driverId: fixture.driverId,
              manualOrderCount: manual,
              orderIds: [],
              reconciliationId: recId,
            },
            fixture.actorId,
          ),
        ).rejects.toMatchObject({ errorCode: "collection_order_count_required" });
      }
    });
  });

  it("does not duplicate the fact when confirmation is retried", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CEE");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      const recId = await reconciliation(transaction, fixture, "2026-08-07");
      const input = {
        businessDate: "2026-08-07",
        countsForCollectionEarning: true,
        driverId: fixture.driverId,
        orderIds: await Promise.all(
          ["ORD-A", "ORD-B", "ORD-F"].map((number) => order(transaction, fixture, number)),
        ),
        reconciliationId: recId,
      };
      const first = await service(fixture, identity).captureForConfirmedCollection(
        transaction,
        input,
        fixture.actorId,
      );
      const second = await service(fixture, identity).captureForConfirmedCollection(
        transaction,
        input,
        fixture.actorId,
      );
      expect(second?.id).toBe(first?.id);

      const count = await sql<{ n: string }>`
        select count(*)::text as n from employee_driver_collection_facts
         where company_id=${fixture.companyId}::uuid`.execute(transaction);
      expect(count.rows[0]!.n).toBe("1");
      // And the Orders were not counted a second time.
      const priced = await priceForPeriod(
        transaction,
        fixture.companyId,
        fixture.employeeId,
        "2026-08-01",
        "2026-08-31",
      );
      expect(priced.orders).toBe(3);
    });
  });

  it("writes no Employee payroll fact for an outsourced Driver", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CEF");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      const recId = await reconciliation(
        transaction,
        fixture,
        "2026-08-07",
        fixture.outsourcedDriverId,
      );

      const fact = await service(fixture, identity).captureForConfirmedCollection(
        transaction,
        {
          businessDate: "2026-08-07",
          countsForCollectionEarning: true,
          driverId: fixture.outsourcedDriverId,
          orderIds: [await order(transaction, fixture, "ORD-A")],
          reconciliationId: recId,
        },
        fixture.actorId,
      );
      expect(fact).toBeNull();
      const count = await sql<{ n: string }>`
        select count(*)::text as n from employee_driver_collection_facts
         where company_id=${fixture.companyId}::uuid`.execute(transaction);
      expect(count.rows[0]!.n).toBe("0");
    });
  });

  /* Pricing. */

  it("prices three collected Orders at AED 1 as AED 3", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CEG");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      await addRule(transaction, fixture, "per_collected_order", 1, "2026-08-01");
      const recId = await reconciliation(transaction, fixture, "2026-08-07");
      await service(fixture, identity).captureForConfirmedCollection(
        transaction,
        {
          businessDate: "2026-08-07",
          countsForCollectionEarning: true,
          driverId: fixture.driverId,
          orderIds: await Promise.all(
            ["ORD-A", "ORD-B", "ORD-F"].map((number) => order(transaction, fixture, number)),
          ),
          reconciliationId: recId,
        },
        fixture.actorId,
      );

      const priced = await priceForPeriod(
        transaction,
        fixture.companyId,
        fixture.employeeId,
        "2026-08-01",
        "2026-08-31",
      );
      expect(priced.amount).toBe(3);
      expect(priced.orders).toBe(3);
    });
  });

  it("prices a flat rule per confirmed collection, not per Order", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CEH");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      await addRule(transaction, fixture, "flat_per_confirmed_collection", 5, "2026-08-01");
      for (const day of ["2026-08-07", "2026-08-14", "2026-08-25"]) {
        const recId = await reconciliation(transaction, fixture, day);
        await service(fixture, identity).captureForConfirmedCollection(
          transaction,
          {
            businessDate: day,
            countsForCollectionEarning: true,
            driverId: fixture.driverId,
            manualOrderCount: 4,
            orderIds: [],
            reconciliationId: recId,
          },
          fixture.actorId,
        );
      }
      const priced = await priceForPeriod(
        transaction,
        fixture.companyId,
        fixture.employeeId,
        "2026-08-01",
        "2026-08-31",
      );
      // 3 collections x AED 5, regardless of the 12 Orders they covered.
      expect(priced.amount).toBe(15);
      expect(priced.collections).toBe(3);
      expect(priced.orders).toBe(12);
    });
  });

  it("prices a 'none' rule, and an unenrolled Employee, as zero", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CEI");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      await addRule(transaction, fixture, "none", 0, "2026-08-01");
      const recId = await reconciliation(transaction, fixture, "2026-08-07");
      await service(fixture, identity).captureForConfirmedCollection(
        transaction,
        {
          businessDate: "2026-08-07",
          countsForCollectionEarning: true,
          driverId: fixture.driverId,
          manualOrderCount: 3,
          orderIds: [],
          reconciliationId: recId,
        },
        fixture.actorId,
      );
      const priced = await priceForPeriod(
        transaction,
        fixture.companyId,
        fixture.employeeId,
        "2026-08-01",
        "2026-08-31",
      );
      expect(priced.amount).toBe(0);
      // The fact is still there and still counted, it is simply worth nothing.
      expect(priced.orders).toBe(3);
    });
  });

  it("applies the rate in force on each collection's own Business Date", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CEJ");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      await addRule(transaction, fixture, "per_collected_order", 1, "2026-08-01", "2026-08-16");
      await addRule(transaction, fixture, "per_collected_order", 1.5, "2026-08-16");

      for (const [day, count] of [
        ["2026-08-10", 3],
        ["2026-08-20", 2],
      ] as const) {
        const recId = await reconciliation(transaction, fixture, day);
        await service(fixture, identity).captureForConfirmedCollection(
          transaction,
          {
            businessDate: day,
            countsForCollectionEarning: true,
            driverId: fixture.driverId,
            manualOrderCount: count,
            orderIds: [],
            reconciliationId: recId,
          },
          fixture.actorId,
        );
      }
      const priced = await priceForPeriod(
        transaction,
        fixture.companyId,
        fixture.employeeId,
        "2026-08-01",
        "2026-08-31",
      );
      // 3 x 1.00 on the 10th, 2 x 1.50 on the 20th. Two rates, one month.
      expect(priced.amount).toBe(6);
    });
  });

  it("stops pricing a fact once it is allocated to a Payroll period", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "CEK");
      const identity = new MutableIdentity(fixture.companyId, fixture.actorId);
      await addRule(transaction, fixture, "per_collected_order", 1, "2026-08-01");
      const recId = await reconciliation(transaction, fixture, "2026-08-07");
      const fact = await service(fixture, identity).captureForConfirmedCollection(
        transaction,
        {
          businessDate: "2026-08-07",
          countsForCollectionEarning: true,
          driverId: fixture.driverId,
          manualOrderCount: 3,
          orderIds: [],
          reconciliationId: recId,
        },
        fixture.actorId,
      );
      expect(
        (await priceForPeriod(
          transaction,
          fixture.companyId,
          fixture.employeeId,
          "2026-08-01",
          "2026-08-31",
        )).amount,
      ).toBe(3);

      /* The allocation triple is all-or-nothing, so a half-written allocation
         cannot exist to confuse a later period. Asserted here because this is
         the guard the paid-once claim rests on. */
      await sql`savepoint partial_allocation`.execute(transaction);
      await expect(
        sql`update employee_driver_collection_facts
               set payroll_period_id=${randomUUID()}::uuid, allocated_at=now()
             where id=${fact!.id}::uuid`.execute(transaction),
      ).rejects.toMatchObject({
        constraint: "employee_driver_collection_facts_allocation_check",
      });
      // The rejection aborts the transaction; the savepoint restores it.
      await sql`rollback to savepoint partial_allocation`.execute(transaction);

      /* Now the exclusion itself. The pricing query filters on
         `payroll_period_id is null`, so marking the fact allocated is what makes
         it invisible -- to a re-run of the same period and to every later one.
         Written directly rather than through a payroll period because standing
         one up needs a salary version and an approved calendar; the predicate
         under test is the same either way. */
      await sql`alter table employee_driver_collection_facts
                  drop constraint employee_driver_collection_facts_allocation_check,
                  drop constraint employee_driver_collection_facts_period_fk`.execute(
        transaction,
      );
      await sql`update employee_driver_collection_facts
                   set payroll_period_id=${randomUUID()}::uuid, allocated_at=now()
                 where id=${fact!.id}::uuid`.execute(transaction);

      // August, re-run: already allocated, so it prices at zero rather than again.
      expect(
        (await priceForPeriod(
          transaction,
          fixture.companyId,
          fixture.employeeId,
          "2026-08-01",
          "2026-08-31",
        )).amount,
      ).toBe(0);
      // And September cannot reach back for it either.
      expect(
        (await priceForPeriod(
          transaction,
          fixture.companyId,
          fixture.employeeId,
          "2026-09-01",
          "2026-09-30",
        )).amount,
      ).toBe(0);
    });
  });

  it("keeps another Company's collections invisible", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const owner = await seed(transaction, "CEL");
      const neighbour = await seed(transaction, "CEM");
      const identity = new MutableIdentity(owner.companyId, owner.actorId);
      await addRule(transaction, owner, "per_collected_order", 1, "2026-08-01");
      const recId = await reconciliation(transaction, owner, "2026-08-07");
      await service(owner, identity).captureForConfirmedCollection(
        transaction,
        {
          businessDate: "2026-08-07",
          countsForCollectionEarning: true,
          driverId: owner.driverId,
          manualOrderCount: 3,
          orderIds: [],
          reconciliationId: recId,
        },
        owner.actorId,
      );

      const leaked = await priceForPeriod(
        transaction,
        neighbour.companyId,
        neighbour.employeeId,
        "2026-08-01",
        "2026-08-31",
      );
      expect(leaked.amount).toBe(0);
      expect(leaked.collections).toBe(0);
    });
  });
});
