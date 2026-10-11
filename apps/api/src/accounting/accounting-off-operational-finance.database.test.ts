import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DriverCashReconciliationService } from "../operations/driver-cash-reconciliation.service.js";
import { OperationsService } from "../operations/operations.service.js";
import { TraderReceivableService } from "../operations/trader-receivable.service.js";
import { TraderSettlementService } from "../operations/trader-settlement.service.js";
import { DriverEarningsService } from "../payroll/driver-earnings.service.js";
import { OutsourcedDriverFeeService } from "../payroll/outsourced-driver-fee.service.js";
import { PayrollCalculationService } from "../payroll/payroll-calculation.service.js";
import { PayrollPaymentService } from "../payroll/payroll-payment.service.js";
import { PayrollPeriodService } from "../payroll/payroll-period.service.js";
import { PlatformCompanyService } from "../platform/platform-company.service.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { CashBankManagementService } from "./cash-bank-management.service.js";
import { CompanyAccountingModeService } from "./company-accounting-mode.service.js";
import { FundingAccountBalanceService } from "./funding-account-balance.service.js";
import { GeneralExpensePaymentService } from "./general-expense-payment.service.js";
import { GeneralExpenseService } from "./general-expense.service.js";

/**
 * Accounting OFF / Accounting ON -- the dual-mode operational finance matrix.
 *
 * Every flow runs through the REAL service (resolved from the compiled
 * AppModule, called inside the real request security context) once for a
 * Company with GL Accounting OFF and once for one with it ON:
 *
 *   OFF: a bare Company -- no accounting configuration, no Chart of Accounts,
 *        no mappings, no fiscal calendar. Operations must succeed, record the
 *        right amounts and statuses, and write NO Accounting Event and NO
 *        Journal.
 *   ON:  an existing-style Company -- the approved template setup with
 *        `accounting_enabled = true` set the way a pre-existing production row
 *        already is. Operations must behave as before and capture their
 *        Accounting Events.
 *
 * Fixtures are committed to the disposable database under fresh `ACCOFF-`
 * Companies (services open their own transactions, so a rolled-back outer
 * transaction would hide them). The AppModule is compiled but NOT initialised,
 * so the Accounting Event processor never starts and no Event is posted.
 *
 * Gated twice: RUN_INTEGRITY_DATABASE=true, and DATABASE_URL must name the
 * database in BLUELINE_DISPOSABLE_DB_NAME.
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
  "orders.update_delivery_status",
  "trader_receivables.create",
  "settlements.create",
  "payroll.manage",
  "payroll.approve",
  "payroll.pay",
  "payroll.reverse",
  "outsourced_driver_fees.pay",
  "outsourced_driver_fees.view",
  "outsourced_driver_fees.manage",
  "reconciliations.create",
];

type Mode = "off" | "on";

interface Fixture {
  readonly mode: Mode;
  readonly companyId: string;
  readonly actorId: string;
  readonly cashAccountId: string;
  readonly traderId: string;
  readonly areaId: string;
  readonly driverId: string;
  readonly payrollEmployeeId: string;
  readonly advanceEmployeeId: string;
  readonly earningEmployeeId: string;
  readonly earningDriverId: string;
}

describe.skipIf(!runDatabaseTests)("Accounting OFF / ON operational finance", () => {
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
  // Fixtures
  // ---------------------------------------------------------------------------

  function as<T>(fixture: Fixture, work: () => Promise<T>): Promise<T> {
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

  const key = (label: string) => `accoff.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`ACCOFF-${tag}`},${`accoff-${tag}`},${`Accounting ${mode} ${tag}`},
              'active',now())`.execute(db);
    const actorId = randomUUID();
    // Disabled: an account needs no role to be an audit actor, and services
    // read permissions from the security context, not from roles.
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`accoff.${actorId}`},'x','disabled')`.execute(
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
      // Exactly the state an existing accounting-ON production Company is in.
      await sql`update accounting_configurations set accounting_enabled = true, version = version + 1
                 where company_id = ${companyId}::uuid`.execute(db);
    }

    const areaId = randomUUID();
    const traderId = randomUUID();
    const driverId = randomUUID();
    const emirate = await sql<{ id: string }>`select id from emirates where code='DXB'`.execute(db);
    await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
      values (${areaId}::uuid,${companyId}::uuid,${`A-${tag}`},${`Area ${tag}`},'منطقة',
              ${emirate.rows[0]!.id}::uuid)`.execute(db);
    await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id)
      values (${traderId}::uuid,${companyId}::uuid,${`T-${tag}`},'Trader','971500000003',
              ${areaId}::uuid,${actorId}::uuid)`.execute(db);
    await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,
        outsourced_fee_per_delivered_order)
      values (${driverId}::uuid,${companyId}::uuid,${`D-${tag}`},'Outsourced driver','971500000004',
              'outsourced',5)`.execute(db);
    await sql`insert into outsourced_driver_fee_versions(company_id,driver_id,effective_from,
        fee_per_order,status,created_by_account_id)
      values (${companyId}::uuid,${driverId}::uuid,'-infinity'::date,5,'active',${actorId}::uuid)`.execute(
      db,
    );

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
    const earningEmployeeId = await employee("Earning employee", 2000);
    const earningDriverId = randomUUID();
    await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,employee_id)
      values (${earningDriverId}::uuid,${companyId}::uuid,${`ED-${tag}`},'Employee driver',
              '971500000005','employee',${earningEmployeeId}::uuid)`.execute(db);

    const partial = {
      actorId,
      advanceEmployeeId,
      areaId,
      cashAccountId: "",
      companyId,
      driverId,
      earningDriverId,
      earningEmployeeId,
      mode,
      payrollEmployeeId,
      traderId,
    };

    // Cash drawer + operating funds, through the REAL Cash/Bank service.
    const cashAccountId =
      mode === "off"
        ? (
            (await as(partial, () =>
              get(CashBankManagementService).createCashAccount(
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
    return { ...partial, cashAccountId };
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

  async function balance(fixture: Fixture): Promise<string> {
    const result = await as(fixture, () =>
      get(FundingAccountBalanceService).current("cash", fixture.cashAccountId),
    );
    return result.balance;
  }

  async function movementFor(companyId: string, correlationId: string) {
    const row = await sql<{ eventId: string | null; generated: string | null; amount: string }>`
      select accounting_event_id as "eventId", generated_by_source_type as generated,
             amount::text from cash_bank_movements
       where company_id=${companyId}::uuid and correlation_id=${correlationId}`.execute(db);
    return row.rows;
  }

  async function refusal(work: Promise<unknown>): Promise<ApplicationException> {
    try {
      await work;
    } catch (error) {
      if (error instanceof ApplicationException) return error;
      throw error;
    }
    throw new Error("expected the operation to be refused");
  }

  async function deliveredOrder(fixture: Fixture, netPayable: number, customerDue = 0) {
    const orderId = randomUUID();
    // One transaction: the Driver/assignment consistency trigger is deferred.
    await db.transaction().execute(async (transaction) => {
      await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
        created_by_account_id,assigned_driver_id,customer_name,customer_mobile_number,
        customer_address,package_count,payment_condition,final_service_fee_snapshot,
        service_fee_override_reason,customer_provenance_status,pricing_provenance_status,
        customer_amount_due,trader_gross_payable,trader_paid_service_fee,trader_net_payable,
        trader_paid_amount,delivery_status,driver_reconciliation_status,trader_settlement_status,
        return_status)
      values (${orderId}::uuid,${fixture.companyId}::uuid,${`O-${orderId.slice(0, 8)}`},current_date,
        ${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
        ${fixture.driverId}::uuid,'Customer','971500000001','Address',1,'customer_pays_cod_and_fee',0,
        'Zero configured Service Fee (fixture)','legacy_unattributed','legacy_unattributed',
        ${customerDue},${netPayable},0,${netPayable},0,'out_for_delivery','not_applicable','not_eligible',
        'not_applicable')`.execute(transaction);
      await sql`insert into order_assignments(company_id,order_id,driver_id,assigned_by_account_id)
      values (${fixture.companyId}::uuid,${orderId}::uuid,${fixture.driverId}::uuid,
              ${fixture.actorId}::uuid)`.execute(transaction);
    });
    await as(fixture, () =>
      get(OperationsService).changeOrderStatus(
        orderId,
        { status: "delivered" } as never,
        randomUUID(),
      ),
    );
    return orderId;
  }

  // ---------------------------------------------------------------------------
  // The matrix
  // ---------------------------------------------------------------------------

  describe.each(["off", "on"] as const)("Accounting %s", (mode) => {
    let fixture: Fixture;
    const off = mode === "off";

    beforeAll(async () => {
      fixture = await createFixture(mode);
    }, 120_000);

    it("13. cash inflow: funds the drawer (OFF: opening balance with no GL; ON: owner deposit)", async () => {
      const cash = get(CashBankManagementService);
      const movement = (await as(fixture, () =>
        cash.createMovement(
          off
            ? ({
                accountingDate: today,
                amount: "100000",
                destinationCashAccountId: fixture.cashAccountId,
                movementDate: today,
                movementType: "opening_balance",
              } as never)
            : ({
                accountingDate: today,
                amount: "100000",
                classificationMappingKey: "cash_bank_deposit_owner_contribution",
                destinationCashAccountId: fixture.cashAccountId,
                movementDate: today,
                movementType: "cash_deposit",
              } as never),
          key("inflow"),
        ),
      )) as { id: string };
      const confirmed = (await as(fixture, () =>
        cash.confirmMovement(movement.id, undefined, key("inflow-confirm")),
      )) as { accountingEventId: string | null; status: string };
      expect(confirmed.status).toBe("confirmed");
      expect(await balance(fixture)).toBe("100000.00");
      if (off) {
        expect(confirmed.accountingEventId).toBeNull();
        expect(await events(fixture.companyId, "cash_bank_movement")).toEqual([]);
      } else {
        expect(await events(fixture.companyId, "cash_bank_movement", movement.id)).toEqual([
          "cash_deposit_confirmed",
        ]);
      }
    });

    it("14. cash outflow: an owner withdrawal reduces the operational balance", async () => {
      const cash = get(CashBankManagementService);
      const movement = (await as(fixture, () =>
        cash.createMovement(
          {
            accountingDate: today,
            amount: "500",
            classificationMappingKey: "cash_bank_withdrawal_owner",
            movementDate: today,
            movementType: "cash_withdrawal",
            sourceCashAccountId: fixture.cashAccountId,
          } as never,
          key("outflow"),
        ),
      )) as { id: string };
      const confirmed = (await as(fixture, () =>
        cash.confirmMovement(movement.id, undefined, key("outflow-confirm")),
      )) as { accountingEventId: string | null };
      expect(await balance(fixture)).toBe("99500.00");
      expect(await events(fixture.companyId, "cash_bank_movement", movement.id)).toEqual(
        off ? [] : ["cash_withdrawal_confirmed"],
      );
      expect(confirmed.accountingEventId === null).toBe(off);
    });

    it("operational balance is enforced in both modes (a withdrawal beyond funds is refused)", async () => {
      const cash = get(CashBankManagementService);
      const movement = (await as(fixture, () =>
        cash.createMovement(
          {
            accountingDate: today,
            amount: "1000000",
            classificationMappingKey: "cash_bank_withdrawal_owner",
            movementDate: today,
            movementType: "cash_withdrawal",
            sourceCashAccountId: fixture.cashAccountId,
          } as never,
          key("overdraw"),
        ),
      )) as { id: string };
      const refused = await refusal(
        as(fixture, () => cash.confirmMovement(movement.id, undefined, key("overdraw-confirm"))),
      );
      expect(refused.errorCode).toBe("balance_would_go_negative");
      expect(await balance(fixture)).toBe("99500.00");
    });

    let orderId: string;

    it("1 + 12a. order delivery (and the outsourced fee accrual it writes)", async () => {
      orderId = await deliveredOrder(fixture, 25);
      const order = await sql<{ status: string; settlement: string }>`
        select delivery_status as status, trader_settlement_status as settlement
          from orders where id=${orderId}::uuid`.execute(db);
      expect(order.rows[0]).toEqual({ settlement: "unsettled", status: "delivered" });
      expect(await events(fixture.companyId, "order", orderId)).toEqual(
        off ? [] : ["order_delivered"],
      );
      const accrual = await sql<{ status: string; earned: string }>`
        select status, earned_amount::text as earned from outsourced_driver_fee_accruals
         where company_id=${fixture.companyId}::uuid and order_id=${orderId}::uuid`.execute(db);
      expect(accrual.rows).toEqual([{ earned: "5.00", status: "accrued" }]);
    });

    it("5. driver cash reconciliation (service unchanged: Driver Cash Reconciliation is on hold)", async () => {
      const codOrderId = await deliveredOrder(fixture, 0, 60);
      const before = Number(await balance(fixture));
      const result = (await as(fixture, () =>
        get(DriverCashReconciliationService).confirm(
          {
            collectionPaymentMethod: "cash",
            excludedOrderIds: [],
            expenses: [],
            orderIds: [codOrderId],
            payments: [{ amount: 60, paymentMethod: "cash" }],
            selectionMode: "ids",
          } as never,
          randomUUID(),
          key("reconciliation"),
        ),
      )) as {
        grossCollections: string;
        orderCount: number;
        reconciliationId?: string;
        id?: string;
      };
      expect(result).toMatchObject({ grossCollections: "60.00", orderCount: 1 });
      const order = await sql<{ cash: string }>`
        select driver_reconciliation_status as cash from orders where id=${codOrderId}::uuid`.execute(
        db,
      );
      expect(order.rows[0]!.cash).toBe("reconciled");
      const reconciliation = await sql<{ id: string }>`
        select r.id from driver_reconciliations r
          join driver_reconciliation_orders o on o.reconciliation_id=r.id and o.company_id=r.company_id
         where r.company_id=${fixture.companyId}::uuid and o.order_id=${codOrderId}::uuid`.execute(
        db,
      );
      expect(
        await events(fixture.companyId, "driver_reconciliation", reconciliation.rows[0]!.id),
      ).toEqual(off ? [] : ["driver_collection_confirmed"]);
      // OFF: the reconciliation's trail is the only record of the collected
      // cash arriving in the drawer, so the operational balance counts it once
      // (cash-trail-classification.ts). ON: the balance excludes the
      // Event-linked trail, exactly as before (unchanged GL-mode behaviour).
      expect(Number(await balance(fixture))).toBe(off ? before + 60 : before);
    });

    let receivableId: string;

    it("2. trader receivable", async () => {
      const created = (await as(fixture, () =>
        get(TraderReceivableService).createReceivable(
          {
            amountDue: 40,
            businessDate: today,
            reason: "Dual-mode receivable",
            sourceType: "manual_adjustment",
            traderId: fixture.traderId,
          } as never,
          randomUUID(),
          key("receivable"),
        ),
      )) as { receivableId?: string; id?: string };
      receivableId = (created.receivableId ?? created.id)!;
      const row = await sql<{ status: string; due: string }>`
        select status, original_amount_due::text as due from trader_receivables
         where id=${receivableId}::uuid`.execute(db);
      expect(row.rows[0]).toEqual({ due: "40.00", status: "outstanding" });
      expect(await events(fixture.companyId, "trader_receivable", receivableId)).toEqual(
        off ? [] : ["trader_receivable_recognized"],
      );
    });

    it("3. trader collection: physical cash, allocation, status; trail not double-counted", async () => {
      const before = await balance(fixture);
      const collected = (await as(fixture, () =>
        get(TraderReceivableService).confirmCollection(
          {
            allocations: [{ amount: 40, receivableId }],
            amountReceived: 40,
            paymentDate: today,
            paymentMethod: "cash",
            traderId: fixture.traderId,
          } as never,
          randomUUID(),
          key("collection"),
        ),
      )) as { collectionId?: string; id?: string };
      const collectionId = (collected.collectionId ?? collected.id)!;
      const receivable = await sql<{ status: string; collected: string }>`
        select status, amount_collected::text as collected from trader_receivables
         where id=${receivableId}::uuid`.execute(db);
      expect(receivable.rows[0]).toEqual({ collected: "40.00", status: "collected" });
      const trail = await movementFor(fixture.companyId, collectionId);
      expect(trail).toHaveLength(1);
      expect(trail[0]!.generated).toBe(off ? "trader_collection" : null);
      expect(trail[0]!.eventId === null).toBe(off);
      expect(await events(fixture.companyId, "trader_collection", collectionId)).toEqual(
        off ? [] : ["trader_receivable_payment_received"],
      );
      // OFF: the trail is the only record of the cash arriving, so it counts
      // exactly once. ON: unchanged (the Event-linked trail is excluded).
      expect(Number(await balance(fixture))).toBe(off ? Number(before) + 40 : Number(before));
    });

    it("4. trader settlement: confirmed, order settled, paid once from the drawer", async () => {
      const before = Number(await balance(fixture));
      const result = (await as(fixture, () =>
        get(TraderSettlementService).createPayment(
          {
            allocations: [{ amount: 25, orderId }],
            amount: 25,
            cashAccountId: fixture.cashAccountId,
            paymentDate: today,
            paymentMethod: "cash",
            traderId: fixture.traderId,
          } as never,
          randomUUID(),
          key("settlement"),
        ),
      )) as { settlementId?: string; id?: string };
      const settlementId = (result.settlementId ?? result.id)!;
      const settlement = await sql<{ status: string; net: string }>`
        select status, net_payable::text as net from trader_settlements where id=${settlementId}::uuid`.execute(
        db,
      );
      expect(settlement.rows[0]).toEqual({ net: "25.00", status: "confirmed" });
      const order = await sql<{ settlement: string }>`
        select trader_settlement_status as settlement from orders where id=${orderId}::uuid`.execute(
        db,
      );
      expect(order.rows[0]!.settlement).toBe("money_sent_to_trader");
      expect(await events(fixture.companyId, "trader_settlement", settlementId)).toEqual(
        off ? [] : ["trader_settlement_confirmed"],
      );
      const trail = await movementFor(fixture.companyId, settlementId);
      expect(trail[0]!.generated).toBe(off ? "trader_settlement" : null);
      // Paid exactly once: the trail is not counted a second time.
      expect(Number(await balance(fixture))).toBe(before - 25);
    });

    let periodId: string;
    let lineId: string;

    it("6 + 7. payroll calculation and approval", async () => {
      const payroll = get(PayrollPeriodService);
      const period = (await as(fixture, () =>
        payroll.create(payrollMonth, undefined, key("period"), randomUUID()),
      )) as { periodId: string };
      periodId = period.periodId;
      await as(fixture, () =>
        get(PayrollCalculationService).calculate(periodId, key("calculate"), randomUUID(), false),
      );
      const lines = await sql<{ id: string; employeeId: string; net: string; status: string }>`
        select id, employee_id as "employeeId", net_salary::text as net, status
          from payroll_entries where payroll_period_id=${periodId}::uuid`.execute(db);
      const line = lines.rows.find((row) => row.employeeId === fixture.payrollEmployeeId)!;
      expect(line).toMatchObject({ net: "1000.00", status: "calculated" });
      lineId = line.id;
      await as(fixture, () => payroll.approve(periodId, key("approve"), randomUUID()));
      const approved = await sql<{ status: string }>`select status from payroll_periods
        where id=${periodId}::uuid`.execute(db);
      expect(approved.rows[0]!.status).toBe("approved");
      expect(await events(fixture.companyId, "payroll_period", periodId)).toEqual(
        off ? [] : ["employee_payroll_approved"],
      );
    });

    it("8. payroll payment (OFF used to fail with payroll_cash_movement_not_created)", async () => {
      const before = Number(await balance(fixture));
      const lines = await sql<{ id: string; employeeId: string; outstanding: string }>`
        select id, employee_id as "employeeId", outstanding_amount::text as outstanding
          from payroll_entries where payroll_period_id=${periodId}::uuid`.execute(db);
      const allocations = lines.rows.map((row) => ({
        amount: Number(row.outstanding),
        employeeId: row.employeeId,
        lineId: row.id,
      }));
      const total = allocations.reduce((sum, row) => sum + row.amount, 0);
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
      const line = await sql<{ status: string; outstanding: string }>`
        select status, outstanding_amount::text as outstanding from payroll_entries
         where id=${lineId}::uuid`.execute(db);
      expect(line.rows[0]).toEqual({ outstanding: "0.00", status: "paid" });
      expect(await events(fixture.companyId, "payroll_payment", paid.paymentId)).toEqual(
        off ? [] : ["employee_payroll_paid"],
      );
      const trail = await movementFor(fixture.companyId, paid.paymentId);
      expect(trail).toHaveLength(1);
      expect(trail[0]!.generated).toBe(off ? "payroll_payment" : null);
      expect(trail[0]!.eventId === null).toBe(off);
      expect(Number(await balance(fixture))).toBe(before - total);
    });

    it("9. employee salary advance (OFF used to fail with employee_payment_cash_movement_not_created)", async () => {
      const before = Number(await balance(fixture));
      const paid = (await as(fixture, () =>
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
      )) as Record<string, unknown>;
      const advance = await sql<{ id: string; status: string; outstanding: string }>`
        select id, status, outstanding_amount::text as outstanding from employee_salary_advances
         where company_id=${fixture.companyId}::uuid and employee_id=${fixture.advanceEmployeeId}::uuid`.execute(
        db,
      );
      expect(advance.rows).toHaveLength(1);
      expect(advance.rows[0]).toMatchObject({ outstanding: "500.00", status: "confirmed" });
      expect(paid).toBeDefined();
      expect(
        await events(fixture.companyId, "employee_salary_advance", advance.rows[0]!.id),
      ).toEqual(off ? [] : ["employee_salary_advance_paid"]);
      const trail = await movementFor(fixture.companyId, advance.rows[0]!.id);
      expect(trail[0]!.generated).toBe(off ? "employee_payment" : null);
      expect(Number(await balance(fixture))).toBe(before - 500);
    });

    it("10 + 11. interim payment of a driver's variable earnings", async () => {
      // One delivered-Order earning of AED 2, exactly as the accrual writes it.
      const ruleId = randomUUID();
      await sql`insert into employee_delivery_earning_rules(id,company_id,employee_id,
          amount_per_order,effective_from)
        values (${ruleId}::uuid,${fixture.companyId}::uuid,${fixture.earningEmployeeId}::uuid,2,
                '2026-01-01'::date)`.execute(db);
      const earningOrderId = randomUUID();
      await db.transaction().execute(async (transaction) => {
        await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
          created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
          payment_condition,final_service_fee_snapshot,service_fee,assigned_driver_id,
          customer_provenance_status,pricing_provenance_status,delivered_at)
        values (${earningOrderId}::uuid,${fixture.companyId}::uuid,${`EO-${earningOrderId.slice(0, 8)}`},
          current_date,${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
          'Customer','971500000009','Address',1,'customer_pays_cod_and_fee',10,10,
          ${fixture.earningDriverId}::uuid,'legacy_unattributed','legacy_unattributed',now())`.execute(
          transaction,
        );
        await sql`insert into order_assignments(company_id,order_id,driver_id,assigned_by_account_id)
        values (${fixture.companyId}::uuid,${earningOrderId}::uuid,${fixture.earningDriverId}::uuid,
                ${fixture.actorId}::uuid)`.execute(transaction);
      });
      await sql`insert into employee_order_earnings(company_id,employee_id,order_id,rule_id,
          order_number,delivered_at,applied_amount,earning_month)
        values (${fixture.companyId}::uuid,${fixture.earningEmployeeId}::uuid,${earningOrderId}::uuid,
          ${ruleId}::uuid,${`EO-${earningOrderId.slice(0, 8)}`},now(),2,
          ${`${payrollMonth}-01`}::date)`.execute(db);
      const before = Number(await balance(fixture));
      await as(fixture, () =>
        get(DriverEarningsService).payVariableEarnings(
          {
            accountId: fixture.cashAccountId,
            amount: 2,
            employeeId: fixture.earningEmployeeId,
            paymentDate: today,
            paymentMethod: "cash",
          } as never,
          key("interim"),
          randomUUID(),
        ),
      );
      const payment = await sql<{ id: string; status: string; paid: string }>`
        select id, status, amount_paid::text as paid from employee_variable_earning_payments
         where company_id=${fixture.companyId}::uuid and employee_id=${fixture.earningEmployeeId}::uuid`.execute(
        db,
      );
      expect(payment.rows).toEqual([
        expect.objectContaining({ paid: "2.00", status: "confirmed" }),
      ]);
      expect(
        await events(fixture.companyId, "employee_variable_earning_payment", payment.rows[0]!.id),
      ).toEqual(off ? [] : ["employee_variable_earnings_interim_paid"]);
      expect(Number(await balance(fixture))).toBe(before - 2);
    });

    it("12b. outsourced driver fee payment", async () => {
      const before = Number(await balance(fixture));
      const paid = (await as(fixture, () =>
        get(OutsourcedDriverFeeService).confirmPayment(
          {
            accountId: fixture.cashAccountId,
            amount: 5,
            driverId: fixture.driverId,
            paymentDate: today,
          } as never,
          key("fee"),
          randomUUID(),
        ),
      )) as Record<string, unknown>;
      expect(paid).toBeDefined();
      const accrual = await sql<{ status: string; outstanding: string }>`
        select status, outstanding_amount::text as outstanding from outsourced_driver_fee_accruals
         where company_id=${fixture.companyId}::uuid and order_id=${orderId}::uuid`.execute(db);
      expect(accrual.rows[0]).toEqual({ outstanding: "0.00", status: "paid" });
      const payments = await sql<{ id: string }>`select id from outsourced_driver_fee_payments
        where company_id=${fixture.companyId}::uuid and driver_id=${fixture.driverId}::uuid`.execute(
        db,
      );
      expect(
        await events(fixture.companyId, "outsourced_driver_fee_payment", payments.rows[0]!.id),
      ).toEqual(off ? [] : ["outsourced_driver_fee_paid"]);
      expect(Number(await balance(fixture))).toBe(before - 5);
    });

    let expensePaymentId: string;

    it("15. general expense: category, approval and cash payment", async () => {
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
          key("approve-expense"),
        ),
      )) as { eventId: string | null; version: string; status: string };
      expect(approved.status).toBe("approved");
      expect(approved.eventId === null).toBe(off);
      const before = Number(await balance(fixture));
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
      )) as { accountingEventId: string | null; paymentId: string; status: string };
      expensePaymentId = payment.paymentId;
      expect(payment.status).toBe("confirmed");
      expect(payment.accountingEventId === null).toBe(off);
      expect(await events(fixture.companyId, "general_expense", created.id)).toEqual(
        off ? [] : ["general_expense_approved"],
      );
      const expense = await sql<{ status: string }>`select status from general_expenses
        where id=${created.id}::uuid`.execute(db);
      expect(expense.rows[0]!.status).toBe("paid");
      const trail = await sql<{ generated: string | null }>`
        select generated_by_source_type as generated from cash_bank_movements
         where company_id=${fixture.companyId}::uuid
           and idempotency_identity like 'general_expense_payment:%'`.execute(db);
      expect(trail.rows).toEqual([{ generated: off ? "general_expense_payment" : null }]);
      expect(Number(await balance(fixture))).toBe(before - 100);
    });

    it("E. OFF: no Accounting Event and no Journal anywhere; ON: Events captured, none posted", async () => {
      const all = await events(fixture.companyId);
      if (off) {
        expect(all).toEqual([]);
        // And the bare Company never needed any GL artifact.
        const gl = await sql<{ coa: number; periods: number; mappings: number; config: number }>`
          select (select count(*)::int from chart_of_accounts where company_id=${fixture.companyId}::uuid) as coa,
                 (select count(*)::int from accounting_periods where company_id=${fixture.companyId}::uuid) as periods,
                 (select count(*)::int from account_mappings where company_id=${fixture.companyId}::uuid) as mappings,
                 (select count(*)::int from accounting_configurations where company_id=${fixture.companyId}::uuid) as config`.execute(
          db,
        );
        expect(gl.rows[0]).toEqual({ coa: 0, config: 0, mappings: 0, periods: 0 });
      } else {
        expect(all.length).toBeGreaterThanOrEqual(12);
      }
      expect(await journalCount(fixture.companyId)).toBe(0);
      expect(expensePaymentId).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // F. Turning Accounting on later
  // ---------------------------------------------------------------------------

  it("F. OFF-period transactions stay valid after enable: no backfill, reversal is not an error", async () => {
    // A Company that operated OFF, with the full setup in place so it can be enabled.
    const fixture = await createFixture("on");
    await sql`update accounting_configurations set accounting_enabled = false, version = version + 1
               where company_id = ${fixture.companyId}::uuid`.execute(db);
    const cash = get(CashBankManagementService);
    const deposit = (await as(fixture, () =>
      cash.createMovement(
        {
          accountingDate: today,
          amount: "1000",
          classificationMappingKey: "cash_bank_deposit_owner_contribution",
          destinationCashAccountId: fixture.cashAccountId,
          movementDate: today,
          movementType: "cash_deposit",
        } as never,
        key("f-deposit"),
      ),
    )) as { id: string };
    await as(fixture, () => cash.confirmMovement(deposit.id, undefined, key("f-confirm")));
    expect(await events(fixture.companyId)).toEqual([]);

    const mode = get(CompanyAccountingModeService);
    const preview = await mode.previewEnable(fixture.companyId);
    expect(preview.blockers).toEqual([]);
    const platformActor = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${platformActor}::uuid,null,'platform_administrator',${`accoff.p.${platformActor}`},'x','disabled')`.execute(
      db,
    );
    await mode.enable(
      fixture.companyId,
      {
        confirmation: preview.confirmation,
        expectedConfigurationVersion: preview.expectedConfigurationVersion,
        reason: "Start GL",
      },
      { accountId: platformActor, correlationId: randomUUID() },
    );
    // No historical Event appeared for the OFF-period deposit.
    expect(await events(fixture.companyId, "cash_bank_movement", deposit.id)).toEqual([]);
    // Reversing it now (Accounting ON) is not an accounting error, and writes
    // no reversal Event -- there is nothing in the ledger to reverse.
    const reversed = (await as(fixture, () =>
      cash.reverseMovement(deposit.id, today, "Entered in error", key("f-reverse")),
    )) as { status: string; reversalMovementId: string };
    expect(reversed.status).toBe("reversed");
    expect(await events(fixture.companyId)).toEqual([]);
    // A NEW transaction after activation is captured normally.
    const fresh = (await as(fixture, () =>
      cash.createMovement(
        {
          accountingDate: today,
          amount: "10",
          classificationMappingKey: "cash_bank_deposit_owner_contribution",
          destinationCashAccountId: fixture.cashAccountId,
          movementDate: today,
          movementType: "cash_deposit",
        } as never,
        key("f-fresh"),
      ),
    )) as { id: string };
    await as(fixture, () => cash.confirmMovement(fresh.id, undefined, key("f-fresh-confirm")));
    expect(await events(fixture.companyId, "cash_bank_movement", fresh.id)).toEqual([
      "cash_deposit_confirmed",
    ]);
  });

  // ---------------------------------------------------------------------------
  // K. New Company, end to end
  // ---------------------------------------------------------------------------

  it("K. a Company created through the Platform starts OFF, operates, and can then be enabled", async () => {
    const platformActor = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${platformActor}::uuid,null,'platform_administrator',${`accoff.k.${platformActor}`},'x','disabled')`.execute(
      db,
    );
    const suffix = platformActor.slice(0, 8);
    const created = await get(PlatformCompanyService).create(
      {
        accountingTemplateCode: "UAE_DELIVERY_STANDARD",
        baseCurrency: "AED",
        businessDayStart: "07:30",
        contactName: "Ops Lead",
        countryCode: "AE",
        defaultLanguage: "en",
        environment: "sandbox",
        name: `E2E Delivery ${suffix}`,
        subdomain: `e2e${suffix}`,
        timezone: "Asia/Dubai",
      },
      { accountId: platformActor, correlationId: randomUUID() },
    );
    const companyId = created.companyId;

    // Accounting OFF, with no unexpected activation and nothing captured.
    const mode = get(CompanyAccountingModeService);
    const status = await mode.status(companyId);
    expect(status).toMatchObject({
      accountingEnabled: false,
      accountingMode: "disabled",
      automaticPostingEnabled: false,
      configurationExists: true,
    });

    // Operational finance is available straight away.
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`accoff.k.${actorId}`},'x','disabled')`.execute(
      db,
    );
    const cashAccountId = (
      await sql<{ id: string }>`select id from company_cash_accounts
        where company_id=${companyId}::uuid and cash_account_type='main_cash'`.execute(db)
    ).rows[0]!.id;
    const traderId = randomUUID();
    await sql`insert into traders(id,company_id,code,name_en,mobile_number)
      values (${traderId}::uuid,${companyId}::uuid,${`T-${suffix}`},'Trader','971500000003')`.execute(
      db,
    );
    const fixture = { actorId, cashAccountId, companyId, traderId } as unknown as Fixture;
    const receivable = (await as(fixture, () =>
      get(TraderReceivableService).createReceivable(
        {
          amountDue: 15,
          businessDate: today,
          reason: "First operation",
          sourceType: "manual_adjustment",
          traderId,
        } as never,
        randomUUID(),
        key("k-receivable"),
      ),
    )) as { receivableId?: string; id?: string };
    await as(fixture, () =>
      get(TraderReceivableService).confirmCollection(
        {
          allocations: [{ amount: 15, receivableId: (receivable.receivableId ?? receivable.id)! }],
          amountReceived: 15,
          paymentDate: today,
          paymentMethod: "cash",
          traderId,
        } as never,
        randomUUID(),
        key("k-collection"),
      ),
    );
    expect(await events(companyId)).toEqual([]);

    // Enable preview and readiness work: the template left it fully ready.
    const preview = await mode.previewEnable(companyId);
    expect(preview).toMatchObject({ alreadyEnabled: false, blockers: [], executable: true });
    const enabled = await mode.enable(
      companyId,
      {
        confirmation: preview.confirmation,
        expectedConfigurationVersion: preview.expectedConfigurationVersion,
        reason: "Go live with GL",
      },
      { accountId: platformActor, correlationId: randomUUID() },
    );
    expect(enabled.changed).toBe(true);
    expect((await mode.status(companyId)).accountingEnabled).toBe(true);
    // The OFF-period operations were not backfilled.
    expect(await events(companyId)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // H. Tenant isolation
  // ---------------------------------------------------------------------------

  it("H. an Accounting-OFF Company cannot use another Company's records", async () => {
    const companyA = await createFixture("off");
    const companyB = await createFixture("on");
    const bBalanceBefore = await balance(companyB);

    const payroll = await refusal(
      as(companyA, () =>
        get(PayrollPaymentService).confirm(
          {
            accountId: companyB.cashAccountId,
            acknowledgementType: "checkbox",
            allocations: [],
            cashVoucherReference: "X",
            paymentDate: today,
            periodId: randomUUID(),
          } as never,
          key("h-payroll"),
          randomUUID(),
        ),
      ),
    );
    expect(payroll).toBeInstanceOf(ApplicationException);

    const receivable = await refusal(
      as(companyA, () =>
        get(TraderReceivableService).createReceivable(
          {
            amountDue: 1,
            businessDate: today,
            reason: "x",
            sourceType: "manual_adjustment",
            traderId: companyB.traderId,
          } as never,
          randomUUID(),
          key("h-receivable"),
        ),
      ),
    );
    expect(receivable.getStatus()).toBe(404);

    const advance = await refusal(
      as(companyA, () =>
        get(DriverEarningsService).paySalaryAdvance(
          {
            accountId: companyA.cashAccountId,
            amount: 1,
            employeeId: companyB.advanceEmployeeId,
            paymentDate: today,
            paymentMethod: "cash",
          } as never,
          key("h-advance"),
          randomUUID(),
        ),
      ),
    );
    expect(advance).toBeInstanceOf(ApplicationException);

    const foreignBalance = await refusal(
      as(companyA, () => get(FundingAccountBalanceService).current("cash", companyB.cashAccountId)),
    );
    expect(foreignBalance.errorCode).toBe("funding_account_balance_not_found");

    const cashMove = (await as(companyA, () =>
      get(CashBankManagementService)
        .createMovement(
          {
            accountingDate: today,
            amount: "1",
            classificationMappingKey: "cash_bank_withdrawal_owner",
            movementDate: today,
            movementType: "cash_withdrawal",
            sourceCashAccountId: companyB.cashAccountId,
          } as never,
          key("h-move"),
        )
        .catch((error: unknown) => error),
    )) as unknown;
    if (!(cashMove instanceof ApplicationException)) {
      const refused = await refusal(
        as(companyA, () =>
          get(CashBankManagementService).confirmMovement(
            (cashMove as { id: string }).id,
            undefined,
            key("h-move-confirm"),
          ),
        ),
      );
      expect(refused).toBeInstanceOf(ApplicationException);
    }

    // Company B (Accounting ON) is untouched by all of it and still captures.
    expect(await balance(companyB)).toBe(bBalanceBefore);
    expect(await events(companyA.companyId)).toEqual([]);
    const bReceivable = (await as(companyB, () =>
      get(TraderReceivableService).createReceivable(
        {
          amountDue: 3,
          businessDate: today,
          reason: "B still captures",
          sourceType: "manual_adjustment",
          traderId: companyB.traderId,
        } as never,
        randomUUID(),
        key("h-b"),
      ),
    )) as { receivableId?: string; id?: string };
    expect(
      await events(
        companyB.companyId,
        "trader_receivable",
        (bReceivable.receivableId ?? bReceivable.id)!,
      ),
    ).toEqual(["trader_receivable_recognized"]);
  });
});
