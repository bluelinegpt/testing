import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { IntegrityCheckService } from "../observability/integrity-check.service.js";
import { DriverCashReconciliationService } from "../operations/driver-cash-reconciliation.service.js";
import { OperationsService } from "../operations/operations.service.js";
import { OrderDeliveryReopenService } from "../operations/order-delivery-reopen.service.js";
import { ReceivableOffsetReversalService } from "../operations/receivable-offset-reversal.service.js";
import { TraderReceivableService } from "../operations/trader-receivable.service.js";
import { TraderSettlementService } from "../operations/trader-settlement.service.js";
import { DriverEarningsService } from "../payroll/driver-earnings.service.js";
import { OutsourcedDriverFeeService } from "../payroll/outsourced-driver-fee.service.js";
import { PayrollAdjustmentService } from "../payroll/payroll-adjustment.service.js";
import { PayrollCalculationService } from "../payroll/payroll-calculation.service.js";
import { PayrollPaymentService } from "../payroll/payroll-payment.service.js";
import { PayrollPeriodService } from "../payroll/payroll-period.service.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { CashBankManagementService } from "./cash-bank-management.service.js";
import { FundingAccountBalanceService } from "./funding-account-balance.service.js";
import { GeneralExpensePaymentService } from "./general-expense-payment.service.js";
import { GeneralExpenseService } from "./general-expense.service.js";

/**
 * Phase 1 Prompt 3 -- the operational finance LIFECYCLE, Accounting OFF and ON.
 *
 * Every step runs through the REAL service (AppModule compiled, NOT
 * initialised, so no Accounting Event is ever processed or posted) inside the
 * real request security context, once for a Company with GL Accounting OFF
 * (bare: no configuration, no Chart of Accounts) and once for an
 * existing-style Accounting-ON Company (approved template, enabled).
 *
 * Covered, per mode:
 *   A  Orders: create (COD and zero-COD trader-pays-fee) with real pricing,
 *      deliver, Driver Cash, trader payment, close, reopen, redeliver.
 *   C  Settlements with receivable offsets: single, multiple, partial,
 *      idempotent replay, full reversal, re-settlement after reversal
 *      (SET-A -> SET-A-REV -> SET-B is NOT a duplicate), receivable-level
 *      reversal and the full-reversal hazard it creates.
 *   B  Receivable offset reversal with Accounting OFF (operational Credit, no
 *      GL artifact); Accounting ON keeps the certified posted-Event guard.
 *   D  Driver Cash: counted exactly once, reversal handled.
 *   E  Payroll: earnings, bonus and deduction adjustments, advance recovery,
 *      interim payment, approval, payment, payment reversal.
 *   G  Outsourced fee: one authoritative balance effect.
 *   I  General Expense: create, submit, approve, pay, reverse payment, reverse.
 *   J  Integrity Checker: no operational finding on a healthy lifecycle.
 *
 * Plus, once: F legacy Accounting-OFF cash trails (markers absent) give the
 * same balance; J crafted defects ARE found; K tenant isolation.
 *
 * Fixtures are committed to the disposable database under fresh `OPLIFE-`
 * Companies. Gated: RUN_INTEGRITY_DATABASE=true and DATABASE_URL naming
 * BLUELINE_DISPOSABLE_DB_NAME.
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseTests =
  process.env.RUN_INTEGRITY_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

const today = new Date().toISOString().slice(0, 10);
const payrollMonth = today.slice(0, 7);

const PERMISSIONS = [
  "accounting.view",
  "accounting.manage",
  "accounting.approve",
  "accounting.reverse",
  "accounting.configuration.manage",
  "orders.create",
  "orders.view",
  "orders.update",
  "orders.update_delivery_status",
  "orders.assign_driver",
  "orders.settle",
  "trader_receivables.create",
  "trader_receivables.view",
  "trader_receivables.reverse",
  "settlements.create",
  "settlements.view",
  "settlements.reverse",
  "payroll.view",
  "payroll.manage",
  "payroll.approve",
  "payroll.pay",
  "payroll.reverse",
  "outsourced_driver_fees.pay",
  "outsourced_driver_fees.view",
  "outsourced_driver_fees.manage",
  "reconciliations.create",
  "reconciliations.view",
  "reconciliations.reverse",
  "users_roles.manage",
];

const OPERATIONAL_CHECKS = [
  "receivable_collected_beyond_due",
  "receivable_outstanding_inconsistent",
  "receivable_settled_more_than_once",
  "settlement_offset_invalid_reference",
  "cash_double_count_candidate",
  "payroll_payment_cash_inconsistent",
  "general_expense_payment_cash_inconsistent",
];

type Mode = "off" | "on";

interface Fixture {
  readonly mode: Mode;
  readonly companyId: string;
  readonly actorId: string;
  readonly cashAccountId: string;
  readonly traderId: string;
  readonly areaId: string;
  readonly employeeDriverId: string;
  readonly outsourcedDriverId: string;
  readonly payrollEmployeeId: string;
  readonly advanceEmployeeId: string;
  readonly earningEmployeeId: string;
}

describe.skipIf(!runDatabaseTests)("Operational finance lifecycle, Accounting OFF and ON", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let store: RequestSecurityContextStore;
  let get: <T>(type: new (...args: never[]) => T) => T;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .compile();
    get = (type) => module.get(type, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
    for (const [index, code] of ["DXB", "SHJ", "AUH"].entries()) {
      await sql`insert into emirates(code,name_en,name_ar,display_order)
        values (${code},${code},${code},${200 + index}) on conflict (code) do nothing`.execute(db);
    }
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function as<T>(fixture: Pick<Fixture, "actorId" | "companyId">, work: () => Promise<T>) {
    return store.run(
      {
        identity: {
          companyId: fixture.companyId,
          forcePasswordChange: false,
          identityId: fixture.actorId,
          kind: "company_user",
          permissions: new Set(PERMISSIONS),
          sessionId: randomUUID(),
        },
        tenant: { companyId: fixture.companyId, identityId: fixture.actorId },
      },
      work,
    );
  }

  const key = (label: string) => `oplife.${label}.${randomUUID()}`;

  async function refusal(work: Promise<unknown>): Promise<ApplicationException> {
    try {
      await work;
    } catch (error) {
      if (error instanceof ApplicationException) return error;
      throw error;
    }
    throw new Error("expected the operation to be refused");
  }

  async function balance(fixture: Fixture): Promise<number> {
    const result = await as(fixture, () =>
      get(FundingAccountBalanceService).current("cash", fixture.cashAccountId),
    );
    return Number(result.balance);
  }

  async function events(companyId: string, sourceType?: string, sourceId?: string) {
    const rows = await sql<{ eventType: string }>`
      select event_type as "eventType" from accounting_events
       where company_id=${companyId}::uuid
         and (${sourceType ?? null}::text is null or source_entity_type=${sourceType ?? null})
         and (${sourceId ?? null}::uuid is null or source_entity_id=${sourceId ?? null}::uuid)
       order by created_at`.execute(db);
    return rows.rows.map((row) => row.eventType);
  }

  async function journalCount(companyId: string) {
    const row = await sql<{ n: number }>`select count(*)::int as n from journal_entries
      where company_id=${companyId}::uuid`.execute(db);
    return row.rows[0]!.n;
  }

  async function operationalFindings(companyId: string) {
    const findings = await new IntegrityCheckService(db).runAll(companyId);
    return findings.filter((finding) => OPERATIONAL_CHECKS.includes(finding.checkId));
  }

  async function receivable(id: string) {
    const row = await sql<{
      status: string;
      collected: string;
      outstanding: string;
    }>`select status, amount_collected::text as collected, outstanding_amount::text as outstanding
         from trader_receivables where id=${id}::uuid`.execute(db);
    return row.rows[0]!;
  }

  async function order(id: string) {
    const row = await sql<{
      delivery: string;
      cash: string;
      settlement: string;
      fee: string;
      due: string;
      net: string;
      number: string;
    }>`select delivery_status as delivery, driver_reconciliation_status as cash,
              trader_settlement_status as settlement, service_fee::text as fee,
              customer_amount_due::text as due, trader_net_payable::text as net,
              order_number as number
         from orders where id=${id}::uuid`.execute(db);
    return row.rows[0]!;
  }

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`OPLIFE-${tag}`},${`oplife-${tag}`},${`Lifecycle ${mode} ${tag}`},
              'active',now())`.execute(db);
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`oplife.${actorId}`},'x','disabled')`.execute(
      db,
    );
    if (mode === "on") {
      await db.transaction().execute((transaction) =>
        new AccountingTemplateImporter().apply(transaction, {
          actorAccountId: null,
          baseCurrency: "AED",
          companyId,
          effectiveFrom: today,
          templateCode: "UAE_DELIVERY_STANDARD",
          templateVersion: 3,
        }),
      );
      await sql`update accounting_configurations set accounting_enabled = true, version = version + 1
                 where company_id = ${companyId}::uuid`.execute(db);
    }
    const areaId = randomUUID();
    const traderId = randomUUID();
    const outsourcedDriverId = randomUUID();
    const emirate = await sql<{ id: string }>`select id from emirates where code='DXB'`.execute(db);
    await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
      values (${areaId}::uuid,${companyId}::uuid,${`A-${tag}`},${`Area ${tag}`},'منطقة',
              ${emirate.rows[0]!.id}::uuid)`.execute(db);
    await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id)
      values (${traderId}::uuid,${companyId}::uuid,${`T-${tag}`},'Trader','971500000003',
              ${areaId}::uuid,${actorId}::uuid)`.execute(db);
    // Real pricing: AED 20 per Order for this Trader in this Area.
    await sql`insert into trader_service_prices(company_id,trader_id,emirate_id,area_id,service_fee,
        created_by_account_id)
      values (${companyId}::uuid,${traderId}::uuid,${emirate.rows[0]!.id}::uuid,${areaId}::uuid,20,
              ${actorId}::uuid)`.execute(db);
    await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,
        outsourced_fee_per_delivered_order)
      values (${outsourcedDriverId}::uuid,${companyId}::uuid,${`OD-${tag}`},'Outsourced driver',
              '971500000004','outsourced',5)`.execute(db);
    await sql`insert into outsourced_driver_fee_versions(company_id,driver_id,effective_from,
        fee_per_order,status,created_by_account_id)
      values (${companyId}::uuid,${outsourcedDriverId}::uuid,'-infinity'::date,5,'active',
              ${actorId}::uuid)`.execute(db);

    const employee = async (name: string, salary: number) => {
      const id = randomUUID();
      await sql`insert into employees(id,company_id,employee_number,name_en,employee_type,hired_on,
          payroll_eligible,is_active)
        values (${id}::uuid,${companyId}::uuid,${`E-${id.slice(0, 6)}`},${name},'employee',
                '2026-01-01'::date,true,true)`.execute(db);
      await sql`insert into employee_salary_versions(company_id,employee_id,basic_salary,
          effective_from,created_by_account_id)
        values (${companyId}::uuid,${id}::uuid,${salary},'2026-01-01'::date,${actorId}::uuid)`.execute(
        db,
      );
      return id;
    };
    const payrollEmployeeId = await employee("Payroll employee", 1000);
    const advanceEmployeeId = await employee("Advance employee", 3000);
    const earningEmployeeId = await employee("Driver employee", 2000);
    const employeeDriverId = randomUUID();
    await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,employee_id)
      values (${employeeDriverId}::uuid,${companyId}::uuid,${`ED-${tag}`},'Employee driver',
              '971500000005','employee',${earningEmployeeId}::uuid)`.execute(db);

    const partial = {
      actorId,
      advanceEmployeeId,
      areaId,
      cashAccountId: "",
      companyId,
      earningEmployeeId,
      employeeDriverId,
      mode,
      outsourcedDriverId,
      payrollEmployeeId,
      traderId,
    };
    const cash = get(CashBankManagementService);
    const cashAccountId =
      mode === "off"
        ? (
            (await as(partial, () =>
              cash.createCashAccount(
                {
                  code: "CASH-OFF",
                  effectiveFrom: today,
                  name: "Main Cash",
                  type: "main_cash",
                } as never,
                key("cash-account"),
              ),
            )) as { id: string }
          ).id
        : (
            await sql<{ id: string }>`select id from company_cash_accounts
              where company_id=${companyId}::uuid and cash_account_type='main_cash'`.execute(db)
          ).rows[0]!.id;
    const fixture = { ...partial, cashAccountId };
    // Operating funds: OFF an operational opening balance, ON an owner deposit.
    const movement = (await as(fixture, () =>
      cash.createMovement(
        mode === "off"
          ? ({
              accountingDate: today,
              amount: "100000",
              destinationCashAccountId: cashAccountId,
              movementDate: today,
              movementType: "opening_balance",
            } as never)
          : ({
              accountingDate: today,
              amount: "100000",
              classificationMappingKey: "cash_bank_deposit_owner_contribution",
              destinationCashAccountId: cashAccountId,
              movementDate: today,
              movementType: "cash_deposit",
            } as never),
        key("fund"),
      ),
    )) as { id: string };
    await as(fixture, () => cash.confirmMovement(movement.id, undefined, key("fund-confirm")));
    return fixture;
  }

  let serial = 0;
  /** A real Order through OperationsService.createOrder, assigned to a Driver. */
  async function createOrder(
    fixture: Fixture,
    codAmount: number,
    paymentCondition: "customer_pays_cod_and_fee" | "customer_pays_cod_trader_pays_fee",
    driverId = fixture.employeeDriverId,
  ): Promise<string> {
    serial += 1;
    const created = (await as(fixture, () =>
      get(OperationsService).createOrder(
        {
          areaId: fixture.areaId,
          codAmount,
          customerAddress: "Address",
          customerMobileNumber: "0501234567",
          customerName: "Customer",
          driverId,
          packageCount: 1,
          paymentCondition,
          serialNumber: `OPL-${Date.now()}-${serial}`,
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("order"),
      ),
    )) as { id: string };
    return created.id;
  }

  async function deliver(fixture: Fixture, orderId: string) {
    const operations = get(OperationsService);
    const current = await order(orderId);
    if (current.delivery === "assigned_to_driver") {
      await as(fixture, () =>
        operations.changeOrderStatus(
          orderId,
          { status: "out_for_delivery" } as never,
          randomUUID(),
        ),
      );
    }
    await as(fixture, () =>
      operations.changeOrderStatus(orderId, { status: "delivered" } as never, randomUUID()),
    );
  }

  async function serviceChargeReceivable(fixture: Fixture, orderId: string): Promise<string> {
    const number = (await order(orderId)).number;
    const row = await sql<{ id: string }>`select id from trader_receivables
      where company_id=${fixture.companyId}::uuid and source_type='service_charge'
        and source_reference=${number}`.execute(db);
    expect(row.rows).toHaveLength(1);
    return row.rows[0]!.id;
  }

  async function settle(
    fixture: Fixture,
    orders: readonly { orderId: string; amount: number }[],
    offsets: readonly { receivableId: string; amount: number }[],
    idempotencyKey = key("settle"),
  ): Promise<string> {
    const allocated = orders.reduce((sum, line) => sum + line.amount, 0);
    const offset = offsets.reduce((sum, line) => sum + line.amount, 0);
    const result = (await as(fixture, () =>
      get(TraderSettlementService).createPayment(
        {
          allocations: orders,
          amount: Number((allocated - offset).toFixed(2)),
          cashAccountId: fixture.cashAccountId,
          paymentDate: today,
          paymentMethod: "cash",
          receivableOffsets: offsets,
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        idempotencyKey,
      ),
    )) as { settlementId?: string; id?: string };
    return (result.settlementId ?? result.id)!;
  }

  /** A delivered COD Order (Trader payable 80) and a delivered zero-COD
   * trader-pays-fee Order whose Receivable is 20. */
  async function payableAndReceivable(fixture: Fixture) {
    const payableOrderId = await createOrder(fixture, 100, "customer_pays_cod_and_fee");
    await deliver(fixture, payableOrderId);
    // A Settlement needs the Driver's cash for the Order reconciled first.
    await as(fixture, () =>
      get(DriverCashReconciliationService).confirmSingleOrder(
        payableOrderId,
        { paymentMethod: "cash" } as never,
        randomUUID(),
        key("reconcile"),
      ),
    );
    const feeOrderId = await createOrder(fixture, 0, "customer_pays_cod_trader_pays_fee");
    await deliver(fixture, feeOrderId);
    return {
      feeOrderId,
      payableOrderId,
      receivableId: await serviceChargeReceivable(fixture, feeOrderId),
    };
  }

  // ---------------------------------------------------------------------------
  // The lifecycle, once per mode
  // ---------------------------------------------------------------------------

  describe.each(["off", "on"] as const)("Accounting %s", (mode) => {
    let fixture: Fixture;
    const off = mode === "off";

    beforeAll(async () => {
      fixture = await createFixture(mode);
    }, 120_000);

    let codOrderId: string;
    let reconciliationId: string;

    it("A1. COD Order: created with real pricing, delivered, Driver Cash counted once, Trader paid, closed", async () => {
      codOrderId = await createOrder(fixture, 100, "customer_pays_cod_and_fee");
      expect(await order(codOrderId)).toMatchObject({
        delivery: "assigned_to_driver",
        due: "100.00",
        fee: "20.00",
        net: "80.00",
      });
      await deliver(fixture, codOrderId);
      expect((await order(codOrderId)).delivery).toBe("delivered");
      expect(await events(fixture.companyId, "order", codOrderId)).toEqual(
        off ? [] : ["order_delivered"],
      );

      // D. Driver Cash: the trail is the only record of the cash arriving.
      const beforeCash = await balance(fixture);
      const reconciled = (await as(fixture, () =>
        get(DriverCashReconciliationService).confirmSingleOrder(
          codOrderId,
          { paymentMethod: "cash" } as never,
          randomUUID(),
          key("single-reconcile"),
        ),
      )) as { reconciliationId?: string; id?: string };
      reconciliationId = (reconciled.reconciliationId ?? reconciled.id)!;
      expect((await order(codOrderId)).cash).toBe("reconciled");
      expect(await balance(fixture)).toBe(off ? beforeCash + 100 : beforeCash);
      const trails = await sql<{ n: number }>`select count(*)::int as n from cash_bank_movements
        where company_id=${fixture.companyId}::uuid and correlation_id=${reconciliationId}`.execute(
        db,
      );
      expect(trails.rows[0]!.n).toBe(1);
      expect(await events(fixture.companyId, "driver_reconciliation", reconciliationId)).toEqual(
        off ? [] : ["driver_collection_confirmed"],
      );

      // Trader paid the COD net of the fee, from the drawer, exactly once.
      const beforePay = await balance(fixture);
      await settle(fixture, [{ amount: 80, orderId: codOrderId }], []);
      expect(await balance(fixture)).toBe(beforePay - 80);
      expect((await order(codOrderId)).settlement).toBe("money_sent_to_trader");

      await as(fixture, () =>
        get(OperationsService).changeOrderStatus(
          codOrderId,
          { status: "closed" } as never,
          randomUUID(),
        ),
      );
      expect((await order(codOrderId)).delivery).toBe("closed");
    });

    it("A2. zero-COD trader-pays-fee Order: net 0, not eligible, a 20 service-charge Receivable, closes directly", async () => {
      const orderId = await createOrder(fixture, 0, "customer_pays_cod_trader_pays_fee");
      await deliver(fixture, orderId);
      expect(await order(orderId)).toMatchObject({
        due: "0.00",
        fee: "20.00",
        net: "0.00",
        settlement: "not_eligible",
      });
      const receivableId = await serviceChargeReceivable(fixture, orderId);
      expect(await receivable(receivableId)).toEqual({
        collected: "0.00",
        outstanding: "20.00",
        status: "outstanding",
      });
      // No payable and nothing due from the customer: no Order Event in either mode.
      expect(await events(fixture.companyId, "order", orderId)).toEqual([]);
      expect(await events(fixture.companyId, "trader_receivable", receivableId)).toEqual(
        off ? [] : ["trader_receivable_recognized"],
      );
      await as(fixture, () =>
        get(OperationsService).changeOrderStatus(
          orderId,
          { status: "closed" } as never,
          randomUUID(),
        ),
      );
      expect((await order(orderId)).delivery).toBe("closed");
    });

    it("A3. reopen and redelivery: no second delivery Event, the Receivable is unchanged", async () => {
      const orderId = await createOrder(fixture, 0, "customer_pays_cod_trader_pays_fee");
      await deliver(fixture, orderId);
      const receivableId = await serviceChargeReceivable(fixture, orderId);
      await as(fixture, () =>
        get(OrderDeliveryReopenService).reopen(orderId, "Customer was not home", randomUUID()),
      );
      expect((await order(orderId)).delivery).not.toBe("delivered");
      await deliver(fixture, orderId);
      expect((await order(orderId)).delivery).toBe("delivered");
      expect(await serviceChargeReceivable(fixture, orderId)).toBe(receivableId);
      expect(await receivable(receivableId)).toMatchObject({ outstanding: "20.00" });
      const deliveredEvents = (await events(fixture.companyId, "order", orderId)).filter(
        (type) => type === "order_delivered",
      );
      expect(deliveredEvents.length).toBeLessThanOrEqual(off ? 0 : 1);
    });

    it("D. Driver Cash reversal: OFF the inflow stops counting; ON unchanged; never counted twice", async () => {
      // Its own Order: a reconciliation already followed by a Trader
      // Settlement is (rightly) not reversible.
      const orderId = await createOrder(fixture, 100, "customer_pays_cod_and_fee");
      await deliver(fixture, orderId);
      const start = await balance(fixture);
      const reconciled = (await as(fixture, () =>
        get(DriverCashReconciliationService).confirmSingleOrder(
          orderId,
          { paymentMethod: "cash" } as never,
          randomUUID(),
          key("d-reconcile"),
        ),
      )) as { reconciliationId?: string; id?: string };
      reconciliationId = (reconciled.reconciliationId ?? reconciled.id)!;
      expect(await balance(fixture)).toBe(off ? start + 100 : start);
      const before = await balance(fixture);
      await as(fixture, () =>
        get(DriverCashReconciliationService).reverse(
          reconciliationId,
          "Counted against the wrong driver",
          randomUUID(),
          key("reconcile-reverse"),
        ),
      );
      expect(await balance(fixture)).toBe(off ? before - 100 : before);
      // No counter-Movement is written by the (on-hold) service either way.
      const trails = await sql<{ n: number }>`select count(*)::int as n from cash_bank_movements
        where company_id=${fixture.companyId}::uuid and correlation_id=${reconciliationId}`.execute(
        db,
      );
      expect(trails.rows[0]!.n).toBe(1);
      expect(
        (await operationalFindings(fixture.companyId)).filter(
          (finding) => finding.checkId === "cash_double_count_candidate",
        ),
      ).toEqual([]);
    });

    let singleSettlementId: string;
    let singleReceivableId: string;

    it("C1. one receivable offset: the Trader is paid net, the Receivable is collected", async () => {
      const { payableOrderId, receivableId } = await payableAndReceivable(fixture);
      singleReceivableId = receivableId;
      const before = await balance(fixture);
      singleSettlementId = await settle(
        fixture,
        [{ amount: 80, orderId: payableOrderId }],
        [{ amount: 20, receivableId }],
      );
      expect(await balance(fixture)).toBe(before - 60);
      expect(await receivable(receivableId)).toEqual({
        collected: "20.00",
        outstanding: "0.00",
        status: "collected",
      });
      expect(await events(fixture.companyId, "trader_settlement", singleSettlementId)).toEqual(
        off ? [] : ["trader_settlement_confirmed"],
      );
    });

    it("C2. multiple receivable offsets on one Settlement", async () => {
      const first = await payableAndReceivable(fixture);
      const secondFee = await createOrder(fixture, 0, "customer_pays_cod_trader_pays_fee");
      await deliver(fixture, secondFee);
      const second = await serviceChargeReceivable(fixture, secondFee);
      const before = await balance(fixture);
      const settlementId = await settle(
        fixture,
        [{ amount: 80, orderId: first.payableOrderId }],
        [
          { amount: 20, receivableId: first.receivableId },
          { amount: 20, receivableId: second },
        ],
      );
      expect(await balance(fixture)).toBe(before - 40);
      expect((await receivable(first.receivableId)).status).toBe("collected");
      expect((await receivable(second)).status).toBe("collected");
      const rows = await sql<{ n: number }>`select count(*)::int as n
        from trader_settlement_receivable_offsets where settlement_id=${settlementId}::uuid`.execute(
        db,
      );
      expect(rows.rows[0]!.n).toBe(2);
    });

    it("C3. partial offset leaves the Receivable partially collected", async () => {
      const { payableOrderId, receivableId } = await payableAndReceivable(fixture);
      await settle(
        fixture,
        [{ amount: 80, orderId: payableOrderId }],
        [{ amount: 5, receivableId }],
      );
      expect(await receivable(receivableId)).toEqual({
        collected: "5.00",
        outstanding: "15.00",
        status: "partially_collected",
      });
    });

    it("C4. idempotent: replaying the same request settles once and pays once", async () => {
      const { payableOrderId, receivableId } = await payableAndReceivable(fixture);
      const replayKey = key("settle-replay");
      const before = await balance(fixture);
      const first = await settle(
        fixture,
        [{ amount: 80, orderId: payableOrderId }],
        [{ amount: 20, receivableId }],
        replayKey,
      );
      const second = await settle(
        fixture,
        [{ amount: 80, orderId: payableOrderId }],
        [{ amount: 20, receivableId }],
        replayKey,
      );
      expect(second).toBe(first);
      expect(await balance(fixture)).toBe(before - 60);
      const rows = await sql<{ n: number }>`select count(*)::int as n
        from trader_settlement_receivable_offsets where receivable_id=${receivableId}::uuid`.execute(
        db,
      );
      expect(rows.rows[0]!.n).toBe(1);
      expect(await receivable(receivableId)).toMatchObject({ collected: "20.00" });
    });

    let resettledReceivableId: string;
    let setB: string;

    it("C5. SET-A -> full reversal -> SET-B: one EFFECTIVE settlement, history kept, no false duplicate", async () => {
      const { payableOrderId, receivableId } = await payableAndReceivable(fixture);
      resettledReceivableId = receivableId;
      const start = await balance(fixture);
      const setA = await settle(
        fixture,
        [{ amount: 80, orderId: payableOrderId }],
        [{ amount: 20, receivableId }],
      );
      expect(await balance(fixture)).toBe(start - 60);
      await as(fixture, () =>
        get(TraderSettlementService).reverse(setA, "Paid to the wrong account", randomUUID()),
      );
      expect(await balance(fixture)).toBe(start);
      expect(await receivable(receivableId)).toEqual({
        collected: "0.00",
        outstanding: "20.00",
        status: "outstanding",
      });
      setB = await settle(
        fixture,
        [{ amount: 80, orderId: payableOrderId }],
        [{ amount: 20, receivableId }],
      );
      expect(await balance(fixture)).toBe(start - 60);
      expect(await receivable(receivableId)).toMatchObject({
        collected: "20.00",
        status: "collected",
      });

      // History is kept: two offset rows, never deleted.
      const rows = await sql<{ n: number }>`select count(*)::int as n
        from trader_settlement_receivable_offsets where receivable_id=${receivableId}::uuid`.execute(
        db,
      );
      expect(rows.rows[0]!.n).toBe(2);
      // The detail counts the EFFECTIVE offset only and flags the historical one.
      const detail = (await as(fixture, () =>
        get(TraderReceivableService).receivableDetail(receivableId),
      )) as {
        settlementOffsetAmount: string;
        totalSettledAmount: string;
        settlementOffsets: readonly { settlementId: string; effective: boolean }[];
      };
      expect(detail.settlementOffsetAmount).toBe("20.00");
      expect(detail.totalSettledAmount).toBe("20.00");
      expect(
        detail.settlementOffsets.map((line) => [line.settlementId, line.effective]).sort(),
      ).toEqual(
        [
          [setA, false],
          [setB, true],
        ].sort(),
      );
      // And the Integrity Checker does not call it a duplicate.
      const findings = (await operationalFindings(fixture.companyId)).filter(
        (finding) => finding.subjectId === receivableId,
      );
      expect(findings).toEqual([]);
    });

    it("B. receivable-level reversal: OFF an operational Credit with no GL artifact; ON the certified posted-Event guard holds", async () => {
      const reversal = get(ReceivableOffsetReversalService);
      const preview = await as(fixture, () => reversal.preview(singleReceivableId));
      if (!off) {
        // ON: the clearing Settlement's Event exists but has not posted (the
        // processor is not running here) -- certified behaviour, unchanged.
        expect(preview.blockedReasonCode).toBe("trader_settlement_accounting_not_posted");
        const refused = await refusal(
          as(fixture, () =>
            reversal.execute(singleReceivableId, "Fee charged twice", randomUUID()),
          ),
        );
        expect(refused.errorCode).toBe("trader_settlement_accounting_not_posted");
        expect((await receivable(singleReceivableId)).status).toBe("collected");
        return;
      }
      expect(preview).toMatchObject({
        blockedReasonCode: null,
        executionAvailable: true,
        physicalCashMovement: "0.00",
        recognitionJournalWillBeReversed: false,
        settlementId: singleSettlementId,
        traderCompensation: "20.00",
        traderNetPositionChange: "0.00",
      });
      const before = await balance(fixture);
      const eventsBefore = await events(fixture.companyId);
      const result = await as(fixture, () =>
        reversal.execute(singleReceivableId, "Fee charged twice", randomUUID()),
      );
      expect(result).toMatchObject({
        alreadyReversed: false,
        creditAmount: "20.00",
        receivableStatus: "reversed",
        settlementStatus: "confirmed",
      });
      // Original settlement and offset preserved; only this Receivable changed.
      expect(await receivable(singleReceivableId)).toEqual({
        collected: "20.00",
        outstanding: "0.00",
        status: "reversed",
      });
      const offsetRows = await sql<{ n: number }>`select count(*)::int as n
        from trader_settlement_receivable_offsets where settlement_id=${singleSettlementId}::uuid`.execute(
        db,
      );
      expect(offsetRows.rows[0]!.n).toBe(1);
      const credit = await sql<{ amount: string; status: string; settlement: string }>`
        select amount::text, status, source_settlement_id as settlement from trader_credits
         where source_receivable_id=${singleReceivableId}::uuid`.execute(db);
      expect(credit.rows).toEqual([
        { amount: "20.00", settlement: singleSettlementId, status: expect.any(String) },
      ]);
      // No GL artifact of any kind, no cash.
      expect(await events(fixture.companyId)).toEqual(eventsBefore);
      expect(await journalCount(fixture.companyId)).toBe(0);
      expect(await balance(fixture)).toBe(before);
      // Idempotent: a retry is a no-op returning the same Credit.
      const again = await as(fixture, () =>
        reversal.execute(singleReceivableId, "Fee charged twice", randomUUID()),
      );
      expect(again).toMatchObject({ alreadyReversed: true, creditId: result.creditId });
      const credits = await sql<{ n: number }>`select count(*)::int as n from trader_credits
        where source_receivable_id=${singleReceivableId}::uuid`.execute(db);
      expect(credits.rows[0]!.n).toBe(1);
      // Audited.
      const audit = await sql<{ n: number }>`select count(*)::int as n from audit_events
        where company_id=${fixture.companyId}::uuid and action='trader_receivable.reverse_offset'
          and subject_id=${singleReceivableId}`.execute(db);
      expect(audit.rows[0]!.n).toBe(1);
    });

    it("C6. full reversal of a Settlement whose Receivable was reversed on its own is refused (no double compensation)", async () => {
      if (!off) return; // ON: the receivable-level reversal was (correctly) refused above.
      const before = await balance(fixture);
      const refused = await refusal(
        as(fixture, () =>
          get(TraderSettlementService).reverse(singleSettlementId, "Undo", randomUUID()),
        ),
      );
      expect(refused.errorCode).toBe("trader_settlement_reversal_blocked_by_receivable_reversal");
      expect(await receivable(singleReceivableId)).toMatchObject({ status: "reversed" });
      const reversals = await sql<{ n: number }>`select count(*)::int as n from trader_settlements
        where reversal_of_id=${singleSettlementId}::uuid`.execute(db);
      expect(reversals.rows[0]!.n).toBe(0);
      expect(await balance(fixture)).toBe(before);
    });

    it("C7. receivable-level reversal after re-settlement targets the EFFECTIVE Settlement (SET-B)", async () => {
      if (!off) return;
      const result = await as(fixture, () =>
        get(ReceivableOffsetReversalService).execute(
          resettledReceivableId,
          "Fee waived",
          randomUUID(),
        ),
      );
      expect(result.receivableStatus).toBe("reversed");
      const credit = await sql<{ settlement: string }>`
        select source_settlement_id as settlement from trader_credits
         where source_receivable_id=${resettledReceivableId}::uuid`.execute(db);
      expect(credit.rows[0]!.settlement).toBe(setB);
    });

    let periodId: string;
    let paymentId: string;
    let paidTotal: number;

    it("E1. payroll: earnings, bonus and deduction adjustments, advance recovery, interim payment, calculation", async () => {
      // An advance paid before the period is calculated: recovered at calculation.
      await as(fixture, () =>
        get(DriverEarningsService).paySalaryAdvance(
          {
            accountId: fixture.cashAccountId,
            amount: 500,
            employeeId: fixture.advanceEmployeeId,
            paymentDate: today,
            paymentMethod: "cash",
          } as never,
          key("advance"),
          randomUUID(),
        ),
      );
      // One delivered-Order earning of AED 2 for the Driver employee, paid in the interim.
      const ruleId = randomUUID();
      await sql`insert into employee_delivery_earning_rules(id,company_id,employee_id,
          amount_per_order,effective_from)
        values (${ruleId}::uuid,${fixture.companyId}::uuid,${fixture.earningEmployeeId}::uuid,2,
                '2026-01-01'::date)`.execute(db);
      const earningOrderId = await createOrder(fixture, 0, "customer_pays_cod_and_fee");
      await deliver(fixture, earningOrderId);
      const existing = await sql<{
        n: number;
      }>`select count(*)::int as n from employee_order_earnings
        where order_id=${earningOrderId}::uuid`.execute(db);
      if (existing.rows[0]!.n === 0) {
        await sql`insert into employee_order_earnings(company_id,employee_id,order_id,rule_id,
            order_number,delivered_at,applied_amount,earning_month)
          values (${fixture.companyId}::uuid,${fixture.earningEmployeeId}::uuid,${earningOrderId}::uuid,
            ${ruleId}::uuid,${(await order(earningOrderId)).number},now(),2,
            ${`${payrollMonth}-01`}::date)`.execute(db);
      }
      const earned = await sql<{
        total: string;
      }>`select coalesce(sum(applied_amount),0)::text as total
        from employee_order_earnings where company_id=${fixture.companyId}::uuid
          and employee_id=${fixture.earningEmployeeId}::uuid`.execute(db);
      const earnedTotal = Number(earned.rows[0]!.total);
      await as(fixture, () =>
        get(DriverEarningsService).payVariableEarnings(
          {
            accountId: fixture.cashAccountId,
            amount: earnedTotal,
            employeeId: fixture.earningEmployeeId,
            paymentDate: today,
            paymentMethod: "cash",
          } as never,
          key("interim"),
          randomUUID(),
        ),
      );

      const period = (await as(fixture, () =>
        get(PayrollPeriodService).create(payrollMonth, undefined, key("period"), randomUUID()),
      )) as { periodId: string };
      periodId = period.periodId;
      await as(fixture, () =>
        get(PayrollCalculationService).calculate(periodId, key("calculate"), randomUUID(), true),
      );
      const lineOf = async (employeeId: string) =>
        (
          await sql<{
            id: string;
            net: string;
            recovery: string;
            alreadyPaid: string;
            earnings: string;
          }>`select id, net_salary::text as net,
                    salary_advance_recovery::text as recovery,
                    variable_earnings_already_paid::text as "alreadyPaid",
                    delivered_order_earnings::text as earnings
               from payroll_entries where payroll_period_id=${periodId}::uuid
                and employee_id=${employeeId}::uuid`.execute(db)
        ).rows[0]!;
      const payrollLine = await lineOf(fixture.payrollEmployeeId);
      const adjustments = get(PayrollAdjustmentService);
      await as(fixture, () =>
        adjustments.create(
          payrollLine.id,
          {
            adjustmentType: "bonus",
            amount: 100,
            direction: "earning",
            reason: "Quarter bonus",
          } as never,
          key("bonus"),
          randomUUID(),
        ),
      );
      await as(fixture, () =>
        adjustments.create(
          payrollLine.id,
          {
            adjustmentType: "bonus",
            amount: 50,
            direction: "deduction",
            reason: "Uniform",
          } as never,
          key("deduction"),
          randomUUID(),
        ),
      );
      expect(Number((await lineOf(fixture.payrollEmployeeId)).net)).toBe(1050);
      const advanceLine = await lineOf(fixture.advanceEmployeeId);
      expect(Number(advanceLine.recovery)).toBe(500);
      expect(Number(advanceLine.net)).toBe(2500);
      const advance = await sql<{ status: string }>`select status from employee_salary_advances
        where company_id=${fixture.companyId}::uuid and employee_id=${fixture.advanceEmployeeId}::uuid`.execute(
        db,
      );
      expect(advance.rows[0]!.status).toBe("recovered");
      const earningLine = await lineOf(fixture.earningEmployeeId);
      expect(Number(earningLine.alreadyPaid)).toBe(earnedTotal);
      expect(Number(earningLine.net)).toBe(2000);
    });

    it("E2. payroll approval and payment: the drawer pays once; OFF no Event, ON Events captured", async () => {
      await as(fixture, () =>
        get(PayrollPeriodService).approve(periodId, key("approve"), randomUUID()),
      );
      const lines = await sql<{ id: string; employeeId: string; outstanding: string }>`
        select id, employee_id as "employeeId", outstanding_amount::text as outstanding
          from payroll_entries where payroll_period_id=${periodId}::uuid`.execute(db);
      const allocations = lines.rows.map((row) => ({
        amount: Number(row.outstanding),
        employeeId: row.employeeId,
        lineId: row.id,
      }));
      paidTotal = allocations.reduce((sum, row) => sum + row.amount, 0);
      const before = await balance(fixture);
      const paid = (await as(fixture, () =>
        get(PayrollPaymentService).confirm(
          {
            accountId: fixture.cashAccountId,
            acknowledgementType: "checkbox",
            allocations,
            cashVoucherReference: "VOUCHER-1",
            paymentDate: today,
            periodId,
          } as never,
          key("payroll-pay"),
          randomUUID(),
        ),
      )) as { paymentId: string };
      paymentId = paid.paymentId;
      expect(await balance(fixture)).toBe(before - paidTotal);
      expect(await events(fixture.companyId, "payroll_payment", paymentId)).toEqual(
        off ? [] : ["employee_payroll_paid"],
      );
    });

    it("E3. payroll payment reversal restores the drawer and reopens the lines", async () => {
      const before = await balance(fixture);
      await as(fixture, () =>
        get(PayrollPaymentService).reverse(
          paymentId,
          "Paid the wrong month",
          key("pay-reverse"),
          randomUUID(),
        ),
      );
      expect(await balance(fixture)).toBe(before + paidTotal);
      const lines = await sql<{
        outstanding: string;
      }>`select outstanding_amount::text as outstanding
        from payroll_entries where payroll_period_id=${periodId}::uuid`.execute(db);
      expect(lines.rows.reduce((sum, row) => sum + Number(row.outstanding), 0)).toBe(paidTotal);
      expect(
        (await operationalFindings(fixture.companyId)).filter((finding) =>
          finding.checkId.startsWith("payroll"),
        ),
      ).toEqual([]);
    });

    it("G. outsourced fee: accrued on delivery, paid once; OFF no trail, ON trail excluded through its Event", async () => {
      const orderId = await createOrder(
        fixture,
        0,
        "customer_pays_cod_and_fee",
        fixture.outsourcedDriverId,
      );
      await deliver(fixture, orderId);
      const accrual = await sql<{ earned: string }>`select earned_amount::text as earned
        from outsourced_driver_fee_accruals where order_id=${orderId}::uuid`.execute(db);
      expect(accrual.rows).toEqual([{ earned: "5.00" }]);
      const before = await balance(fixture);
      await as(fixture, () =>
        get(OutsourcedDriverFeeService).confirmPayment(
          {
            accountId: fixture.cashAccountId,
            amount: 5,
            driverId: fixture.outsourcedDriverId,
            paymentDate: today,
          } as never,
          key("fee"),
          randomUUID(),
        ),
      );
      expect(await balance(fixture)).toBe(before - 5);
      const payment = await sql<{ id: string }>`select id from outsourced_driver_fee_payments
        where company_id=${fixture.companyId}::uuid and driver_id=${fixture.outsourcedDriverId}::uuid`.execute(
        db,
      );
      const trail = await sql<{ eventId: string | null }>`select accounting_event_id as "eventId"
        from cash_bank_movements where company_id=${fixture.companyId}::uuid
          and correlation_id=${payment.rows[0]!.id}`.execute(db);
      if (off) {
        expect(trail.rows).toEqual([]);
      } else {
        // ON: at most one trail, and it is linked to the payment's Event.
        expect(trail.rows.length).toBeLessThanOrEqual(1);
        for (const row of trail.rows) expect(row.eventId).not.toBeNull();
      }
    });

    it("I. general expense: create, submit, approve, pay, reverse payment, reverse expense", async () => {
      const expenses = get(GeneralExpenseService);
      const categoryId = off
        ? (
            (await as(fixture, () =>
              expenses.createCategory(
                {
                  defaultExpenseMappingKey: "general_expense",
                  defaultVatTreatment: "out_of_scope",
                  effectiveFrom: today,
                  nameEn: "Office supplies",
                } as never,
                key("category"),
              ),
            )) as { id: string }
          ).id
        : (
            await sql<{ id: string }>`select id from general_expense_categories
              where company_id=${fixture.companyId}::uuid and code='EXP-OFFICE'`.execute(db)
          ).rows[0]!.id;
      const created = (await as(fixture, () =>
        expenses.create(
          {
            accountingDate: today,
            categoryId,
            expenseDate: today,
            lines: [
              {
                categoryId,
                description: "Stationery",
                quantity: "1",
                unitAmount: "100",
                vatRate: "0",
                vatTreatment: "out_of_scope",
              },
            ],
            payeeName: "ACME",
            payeeType: "supplier",
          } as never,
          key("expense"),
        ),
      )) as { id: string; version: string };
      const submitted = (await as(fixture, () =>
        expenses.submit(
          created.id,
          { reason: "Submit", version: Number(created.version) } as never,
          key("submit"),
        ),
      )) as { version: string };
      const approved = (await as(fixture, () =>
        expenses.approve(
          created.id,
          { reason: "OK", version: Number(submitted.version) } as never,
          key("approve"),
        ),
      )) as { version: string; status: string };
      expect(approved.status).toBe("approved");
      const before = await balance(fixture);
      const payment = (await as(fixture, () =>
        get(GeneralExpensePaymentService).createAndConfirm(
          created.id,
          {
            expenseVersion: Number(approved.version),
            paymentDate: today,
            rows: [
              { amount: "100", companyCashAccountId: fixture.cashAccountId, paymentMethod: "cash" },
            ],
          } as never,
          key("expense-pay"),
        ),
      )) as { paymentId: string; version?: string };
      expect(await balance(fixture)).toBe(before - 100);
      const paymentRow = await sql<{
        version: string;
      }>`select version::text from general_expense_payments
        where id=${payment.paymentId}::uuid`.execute(db);
      await as(fixture, () =>
        get(GeneralExpensePaymentService).reverse(
          payment.paymentId,
          { reason: "Duplicate payment", version: Number(paymentRow.rows[0]!.version) } as never,
          key("expense-pay-reverse"),
        ),
      );
      expect(await balance(fixture)).toBe(before);
      const expenseRow = await sql<{ version: string; paid: string }>`select version::text,
        paid_amount::text as paid from general_expenses where id=${created.id}::uuid`.execute(db);
      expect(Number(expenseRow.rows[0]!.paid)).toBe(0);
      await as(fixture, () =>
        expenses.reverse(
          created.id,
          { reason: "Raised in error", version: Number(expenseRow.rows[0]!.version) } as never,
          key("expense-reverse"),
        ),
      );
      const final = await sql<{ status: string }>`select status from general_expenses
        where id=${created.id}::uuid`.execute(db);
      expect(final.rows[0]!.status).toBe("reversed");
      expect(await balance(fixture)).toBe(before);
    });

    it("J. the whole lifecycle leaves no operational integrity finding; OFF wrote no Event or Journal", async () => {
      expect(await operationalFindings(fixture.companyId)).toEqual([]);
      if (off) expect(await events(fixture.companyId)).toEqual([]);
      expect(await journalCount(fixture.companyId)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // B (enable later). A Settlement confirmed while OFF, reversed after enable
  // ---------------------------------------------------------------------------

  it("B. enable later: an OFF-era Settlement's receivable reverses operationally after Accounting is enabled", async () => {
    const fixture = await createFixture("on");
    const setEnabled = (enabled: boolean) =>
      sql`update accounting_configurations set accounting_enabled = ${enabled}, version = version + 1
           where company_id = ${fixture.companyId}::uuid`.execute(db);
    await setEnabled(false);
    const { payableOrderId, receivableId } = await payableAndReceivable(fixture);
    const settlementId = await settle(
      fixture,
      [{ amount: 80, orderId: payableOrderId }],
      [{ amount: 20, receivableId }],
    );
    expect(await events(fixture.companyId, "trader_settlement", settlementId)).toEqual([]);
    await setEnabled(true);

    const reversal = get(ReceivableOffsetReversalService);
    const preview = await as(fixture, () => reversal.preview(receivableId));
    // The posted-Event precondition does not apply: this Settlement never
    // belonged to the ledger, so there is no AR residual to clear.
    expect(preview.blockedReasonCode).toBeNull();
    expect(preview.recognitionJournalWillBeReversed).toBe(false);
    const result = await as(fixture, () =>
      reversal.execute(receivableId, "Fee waived", randomUUID()),
    );
    expect(result.receivableStatus).toBe("reversed");
    // No backfill and no orphan GL entry: no Credit Event, no recognition
    // reversal of an Event that never existed, no Journal.
    expect(await events(fixture.companyId, "trader_credit", result.creditId)).toEqual([]);
    expect(await events(fixture.companyId, "trader_receivable", receivableId)).toEqual([]);
    expect(await journalCount(fixture.companyId)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // F. Legacy Accounting-OFF cash trails (written before the marker existed)
  // ---------------------------------------------------------------------------

  it("F. legacy OFF trails (no marker) are classified at query time: expected balance = actual balance", async () => {
    const fixture = await createFixture("off");
    const funded = await balance(fixture);
    // Real operations that write trails.
    const { payableOrderId, receivableId } = await payableAndReceivable(fixture);
    await as(fixture, () =>
      get(TraderReceivableService).confirmCollection(
        {
          allocations: [{ amount: 20, receivableId }],
          amountReceived: 20,
          paymentDate: today,
          paymentMethod: "cash",
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("collection"),
      ),
    );
    await settle(fixture, [{ amount: 80, orderId: payableOrderId }], []);
    await as(fixture, () =>
      get(DriverEarningsService).paySalaryAdvance(
        {
          accountId: fixture.cashAccountId,
          amount: 300,
          employeeId: fixture.advanceEmployeeId,
          paymentDate: today,
          paymentMethod: "cash",
        } as never,
        key("advance"),
        randomUUID(),
      ),
    );
    // Expected, from first principles: + Driver Cash 100 + collection 20
    // - settlement 80 - advance 300.
    const expected = funded + 100 + 20 - 80 - 300;
    expect(await balance(fixture)).toBe(expected);

    // Simulate rows written by an OFF Company BEFORE migration 20260984:
    // exactly the same rows, without the marker. Disposable database only;
    // `replica` bypasses the immutability triggers for this fixture rewrite.
    // `set local`: the bypass ends with this transaction, whatever happens.
    await db.transaction().execute(async (transaction) => {
      await sql`set local session_replication_role = replica`.execute(transaction);
      await sql`update cash_bank_movements set generated_by_source_type = null
                 where company_id=${fixture.companyId}::uuid`.execute(transaction);
    });
    const markers = await sql<{ n: number }>`select count(*)::int as n from cash_bank_movements
      where company_id=${fixture.companyId}::uuid and generated_by_source_type is not null`.execute(
      db,
    );
    expect(markers.rows[0]!.n).toBe(0);
    // No backfill, no rewrite -- and still the same, correct balance.
    expect(await balance(fixture)).toBe(expected);
    expect(await operationalFindings(fixture.companyId)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // J. Crafted defects are found
  // ---------------------------------------------------------------------------

  it("J. crafted defects ARE reported: an inconsistent Receivable and a counted duplicate trail", async () => {
    const fixture = await createFixture("off");
    const { receivableId } = await payableAndReceivable(fixture);
    await sql`update trader_receivables set amount_collected = 7, status='partially_collected'
               where id=${receivableId}::uuid`.execute(db);
    // A second counted copy of an inflow trail (a collection's cash recorded twice).
    const collection = (await as(fixture, () =>
      get(TraderReceivableService).confirmCollection(
        {
          allocations: [{ amount: 13, receivableId }],
          amountReceived: 13,
          paymentDate: today,
          paymentMethod: "cash",
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("collection"),
      ),
    )) as { collectionId?: string; id?: string };
    const collectionId = (collection.collectionId ?? collection.id)!;
    await sql`insert into cash_bank_movements(company_id,movement_number,movement_type,movement_date,
        accounting_date,destination_cash_account_id,amount,fee_amount,payment_method,status,
        correlation_id,idempotency_identity,created_by_account_id,confirmed_by_account_id,confirmed_at,
        description,currency)
      select company_id,movement_number||'-DUP',movement_type,movement_date,accounting_date,
        destination_cash_account_id,amount,fee_amount,payment_method,status,correlation_id,
        idempotency_identity||'-DUP',created_by_account_id,confirmed_by_account_id,confirmed_at,
        description,currency
        from cash_bank_movements where company_id=${fixture.companyId}::uuid
         and correlation_id=${collectionId}`.execute(db);
    const findings = await operationalFindings(fixture.companyId);
    const ids = new Set(findings.map((finding) => finding.checkId));
    expect(ids.has("receivable_outstanding_inconsistent")).toBe(true);
    expect(ids.has("cash_double_count_candidate")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // K. Tenant isolation
  // ---------------------------------------------------------------------------

  it("K. Company A can neither read nor mutate Company B's operational finance", async () => {
    const a = await createFixture("off");
    const b = await createFixture("off");
    const bOrders = await payableAndReceivable(b);
    const bSettlement = await settle(
      b,
      [{ amount: 80, orderId: bOrders.payableOrderId }],
      [{ amount: 20, receivableId: bOrders.receivableId }],
    );
    const bBalance = await balance(b);
    const attempts: Array<[string, () => Promise<unknown>]> = [
      [
        "order status",
        () =>
          get(OperationsService).changeOrderStatus(
            bOrders.payableOrderId,
            { status: "closed" } as never,
            randomUUID(),
          ),
      ],
      [
        "receivable detail",
        () => get(TraderReceivableService).receivableDetail(bOrders.receivableId),
      ],
      [
        "offset reversal preview",
        () => get(ReceivableOffsetReversalService).preview(bOrders.receivableId),
      ],
      [
        "offset reversal",
        () =>
          get(ReceivableOffsetReversalService).execute(
            bOrders.receivableId,
            "Cross tenant",
            randomUUID(),
          ),
      ],
      [
        "settlement reversal",
        () => get(TraderSettlementService).reverse(bSettlement, "Cross tenant", randomUUID()),
      ],
      [
        "settlement with B's receivable",
        () =>
          get(TraderSettlementService).createPayment(
            {
              allocations: [{ amount: 80, orderId: bOrders.payableOrderId }],
              amount: 60,
              cashAccountId: a.cashAccountId,
              paymentDate: today,
              paymentMethod: "cash",
              receivableOffsets: [{ amount: 20, receivableId: bOrders.receivableId }],
              traderId: b.traderId,
            } as never,
            randomUUID(),
            key("cross"),
          ),
      ],
      ["cash balance", () => get(FundingAccountBalanceService).current("cash", b.cashAccountId)],
      [
        "salary advance from B's employee",
        () =>
          get(DriverEarningsService).paySalaryAdvance(
            {
              accountId: a.cashAccountId,
              amount: 10,
              employeeId: b.advanceEmployeeId,
              paymentDate: today,
              paymentMethod: "cash",
            } as never,
            key("cross-advance"),
            randomUUID(),
          ),
      ],
      [
        "payroll payment reversal",
        () =>
          get(PayrollPaymentService).reverse(
            randomUUID(),
            "Cross tenant",
            key("cross-pay"),
            randomUUID(),
          ),
      ],
    ];
    for (const [label, attempt] of attempts) {
      const outcome = await as(a, attempt).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ error, ok: false as const }),
      );
      if (outcome.ok) {
        // A read may only "succeed" by returning nothing of B's.
        expect.soft(JSON.stringify(outcome.value ?? null), label).not.toContain(b.companyId);
        expect.soft(label === "cash balance" || label === "receivable detail", label).toBe(false);
      } else {
        expect(outcome.error, label).toBeInstanceOf(ApplicationException);
      }
    }
    // B is untouched.
    expect(await balance(b)).toBe(bBalance);
    expect((await receivable(bOrders.receivableId)).status).toBe("collected");
    expect((await order(bOrders.payableOrderId)).delivery).toBe("delivered");
    const reversals = await sql<{ n: number }>`select count(*)::int as n from trader_settlements
      where reversal_of_id=${bSettlement}::uuid`.execute(db);
    expect(reversals.rows[0]!.n).toBe(0);
    const advances = await sql<{
      n: number;
    }>`select count(*)::int as n from employee_salary_advances
      where employee_id=${b.advanceEmployeeId}::uuid`.execute(db);
    expect(advances.rows[0]!.n).toBe(0);
    // B's GL Accounting configuration is not readable or changed through A.
    const config = await sql<{ n: number }>`select count(*)::int as n from accounting_configurations
      where company_id=${b.companyId}::uuid`.execute(db);
    expect(config.rows[0]!.n).toBe(0);
  });
});
