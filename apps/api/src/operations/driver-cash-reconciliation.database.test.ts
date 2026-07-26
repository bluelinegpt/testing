import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import type { IdentityContext, IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContext, TenantContextAccessor } from "../tenancy/tenant-context.js";

import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import type { CreateDriverReconciliationDto } from "./operations.dto.js";

const runDatabaseTests = process.env.RUN_RECONCILIATION_DATABASE === "true";
const rollbackMarker = Symbol("rollback reconciliation database test");

/**
 * Runs each confirm() call inside its own savepoint so that a rejected
 * confirmation rolls back exactly as a real transaction would, while the whole
 * suite still runs inside one outer transaction that is discarded at the end.
 */
class SavepointTransactionManager {
  private sequence = 0;

  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}

  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `confirm_${++this.sequence}`;
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

class StubTenantAccessor {
  public constructor(private context: TenantContext) {}
  public current(): TenantContext {
    return this.context;
  }
  public async run<T>(context: TenantContext, operation: () => Promise<T>): Promise<T> {
    const previous = this.context;
    this.context = context;
    try {
      return await operation();
    } finally {
      this.context = previous;
    }
  }
  public set(context: TenantContext): void {
    this.context = context;
  }
}

class StubIdentityAccessor {
  public constructor(private context: IdentityContext) {}
  public current(): IdentityContext {
    return this.context;
  }
  public set(context: IdentityContext): void {
    this.context = context;
  }
}

interface CompanyFixture {
  readonly accountId: string;
  readonly bankAccountId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly expenseTypes: Record<string, string>;
  readonly secondDriverId: string;
}

describe.skipIf(!runDatabaseTests)("driver cash reconciliation confirm()", () => {
  it("enforces eligibility, formula, payments, expenses, rollback and idempotency", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

    try {
      await database.transaction().execute(async (transaction) => {
        const manager = new SavepointTransactionManager(transaction);
        const tenants = new StubTenantAccessor({ companyId: "", identityId: "" });
        const identities = new StubIdentityAccessor({
          companyId: null,
          forcePasswordChange: false,
          identityId: "",
          kind: "company_user",
          permissions: new Set(["reconciliations.create"]),
          sessionId: randomUUID(),
        });
        const service = new DriverCashReconciliationService(
          transaction as unknown as Kysely<DatabaseSchema>,
          manager as unknown as KyselyTransactionManager,
          tenants as unknown as TenantContextAccessor,
          identities as unknown as IdentityContextAccessor,
          new OperationsHistoryWriter(),
        );

        const createCompany = async (label: string): Promise<CompanyFixture> => {
          const companyId = randomUUID();
          const accountId = randomUUID();
          const roleId = randomUUID();
          const driverAccountId = randomUUID();
          const secondDriverAccountId = randomUUID();
          const driverId = randomUUID();
          const secondDriverId = randomUUID();
          const bankAccountId = randomUUID();
          const suffix = companyId.slice(0, 8);
          await sql`
            insert into companies (id, code, subdomain, name_en, status, activated_at) values
              (${companyId}::uuid, ${`REC-${label}-${suffix}`},
               ${`rec-${label.toLowerCase()}-${suffix}`},
               ${`Reconciliation ${label}`}, 'active', now())
          `.execute(transaction);
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash) values
              (${accountId}::uuid, ${companyId}::uuid, 'company_user', ${`rec.actor.${suffix}`}, 'test-only'),
              (${driverAccountId}::uuid, ${companyId}::uuid, 'driver', ${`rec.driver.${suffix}`}, 'test-only'),
              (${secondDriverAccountId}::uuid, ${companyId}::uuid, 'driver', ${`rec.driver2.${suffix}`}, 'test-only')
          `.execute(transaction);
          await sql`
            insert into roles (id, company_id, code, name, is_system) values
              (${roleId}::uuid, ${companyId}::uuid, 'company_admin', 'Company Administrator', true)
          `.execute(transaction);
          await sql`
            insert into role_permissions (role_id, permission_code) values
              (${roleId}::uuid, 'users_roles.manage')
          `.execute(transaction);
          await sql`
            insert into account_roles (account_id, role_id, company_id) values
              (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
          `.execute(transaction);
          await sql`
            insert into drivers (
              id, company_id, account_id, code, driver_type, name_en, mobile_number, account_status
            ) values
              (${driverId}::uuid, ${companyId}::uuid, ${driverAccountId}::uuid,
               ${`DRV-${suffix}-1`}, 'outsourced', 'Primary Driver', '971500000001', 'active'),
              (${secondDriverId}::uuid, ${companyId}::uuid, ${secondDriverAccountId}::uuid,
               ${`DRV-${suffix}-2`}, 'outsourced', 'Second Driver', '971500000002', 'active')
          `.execute(transaction);
          await sql`
            insert into company_bank_accounts (id, company_id, bank_name, account_name) values
              (${bankAccountId}::uuid, ${companyId}::uuid, 'Reconciliation Bank', 'Main Account')
          `.execute(transaction);
          await sql`
            insert into expense_types (company_id, code, name_en, display_name)
            select ${companyId}::uuid, seed.code, seed.name, seed.name
              from (values ('PETROL','Petrol'),('OTHER','Other'),('PARKING','Parking'))
                as seed (code, name)
          `.execute(transaction);
          const types = await sql<{ code: string; id: string }>`
            select code, id from expense_types where company_id = ${companyId}::uuid
          `.execute(transaction);
          const expenseTypes: Record<string, string> = {};
          for (const row of types.rows) expenseTypes[row.code] = row.id;
          return {
            accountId,
            bankAccountId,
            companyId,
            driverId,
            expenseTypes,
            secondDriverId,
          };
        };

        const companyA = await createCompany("A");
        const companyB = await createCompany("B");

        const useCompany = (company: CompanyFixture): void => {
          tenants.set({ companyId: company.companyId, identityId: company.accountId });
          identities.set({
            companyId: company.companyId,
            forcePasswordChange: false,
            identityId: company.accountId,
            kind: "company_user",
            permissions: new Set(["reconciliations.create"]),
            sessionId: randomUUID(),
          });
        };

        let orderSequence = 0;
        const createOrder = async (
          company: CompanyFixture,
          options: {
            readonly collected: number;
            readonly deliveryStatus?: string;
            readonly driverCost?: number;
            readonly driverId?: string;
            readonly cashStatus?: string;
          },
        ): Promise<string> => {
          const orderId = randomUUID();
          const traderId = randomUUID();
          const areaId = randomUUID();
          orderSequence += 1;
          const number = `REC-${company.companyId.slice(0, 4)}-${String(orderSequence).padStart(4, "0")}`;
          await sql`
            insert into areas (id, company_id, emirate_id, code, name_en) values
              (${areaId}::uuid, ${company.companyId}::uuid, (select id from emirates where code='DXB'), ${`A${orderSequence}`}, ${`Area ${orderSequence}`})
          `.execute(transaction);
          const traderAccountId = randomUUID();
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash)
            values (${traderAccountId}::uuid, ${company.companyId}::uuid, 'trader',
                    ${`rec.trader.${company.companyId.slice(0, 4)}.${orderSequence}`}, 'test-only')
          `.execute(transaction);
          await sql`
            insert into traders (
              id, company_id, account_id, code, name_en, mobile_number, account_status
            ) values (${traderId}::uuid, ${company.companyId}::uuid, ${traderAccountId}::uuid,
                      ${`T${orderSequence}`}, ${`Trader ${orderSequence}`}, '971500000003', 'active')
          `.execute(transaction);
          const driver = options.driverId ?? company.driverId;
          await sql`
            insert into orders (
              id, company_id, order_number, order_date, trader_id, area_id,
              created_by_account_id, assigned_driver_id, customer_name,
              customer_mobile_number, customer_address, package_count, payment_condition,
              amount_collected, customer_amount_due, driver_cost,
              trader_gross_payable, trader_paid_service_fee, trader_deductions,
              trader_charges, trader_adjustments, trader_net_payable,
              delivery_status, driver_reconciliation_status, trader_settlement_status,
              delivered_at, pricing_provenance_status, final_service_fee_snapshot,
              customer_provenance_status
            ) values (
              ${orderId}::uuid, ${company.companyId}::uuid, ${number}, current_date,
              ${traderId}::uuid, ${areaId}::uuid, ${company.accountId}::uuid, ${driver}::uuid,
              'Customer', '971500000004', 'Address', 1, 'customer_pays_cod_and_fee',
              ${options.collected}, ${options.collected}, ${options.driverCost ?? 7.5},
              ${options.collected}, 0, 0, 0, 0, ${options.collected},
              'assigned_to_driver', 'not_applicable', 'not_eligible', null,
              'legacy_unattributed', 0, 'legacy_unattributed'
            )
          `.execute(transaction);
          await sql`
            insert into order_assignments (company_id, order_id, driver_id, assigned_by_account_id)
            values (${company.companyId}::uuid, ${orderId}::uuid, ${driver}::uuid,
                    ${company.accountId}::uuid)
          `.execute(transaction);
          await sql`
            update orders
               set delivery_status = ${options.deliveryStatus ?? "delivered"},
                   driver_reconciliation_status = ${options.cashStatus ?? "pending"},
                   trader_settlement_status = 'unsettled',
                   delivered_at = now()
             where id = ${orderId}::uuid
          `.execute(transaction);
          return orderId;
        };

        const selection = (
          orderIds: readonly string[],
          overrides: Partial<CreateDriverReconciliationDto> = {},
        ): CreateDriverReconciliationDto => ({
          excludedOrderIds: [],
          expenses: [],
          orderIds: [...orderIds],
          payments: [],
          selectionMode: "ids",
          ...overrides,
        });

        const expectRejection = async (
          work: () => Promise<unknown>,
          errorCode: string,
        ): Promise<void> => {
          await expect(work()).rejects.toMatchObject({ errorCode });
        };

        const countsFor = async (orderId: string) => {
          const result = await sql<{
            events: number;
            history: number;
            links: number;
          }>`
            select
              (select count(*)::int from driver_reconciliation_orders
                where order_id = ${orderId}::uuid) as links,
              (select count(*)::int from order_status_history
                where order_id = ${orderId}::uuid and status_dimension = 'driver_reconciliation')
                as history,
              (select count(*)::int from order_events
                where order_id = ${orderId}::uuid
                  and event_type = 'driver_cash.money_received') as events
          `.execute(transaction);
          return result.rows[0] ?? { events: 0, history: 0, links: 0 };
        };

        const statusOf = async (orderId: string): Promise<Record<string, string>> => {
          const result = await sql<Record<string, string>>`
            select delivery_status as "deliveryStatus",
                   driver_reconciliation_status as "cashStatus",
                   return_status as "returnStatus",
                   trader_settlement_status as "settlementStatus"
              from orders where id = ${orderId}::uuid
          `.execute(transaction);
          return result.rows[0] ?? {};
        };

        useCompany(companyA);

        // --- 1. One valid Delivered Order -------------------------------------
        const single = await createOrder(companyA, { collected: 100 });
        const singleResult = await service.confirm(
          selection([single], { payments: [{ amount: 100, paymentMethod: "cash" }] }),
          randomUUID(),
          `key-single-${randomUUID()}`,
        );
        expect(singleResult.grossCollections).toBe("100.00");
        expect(singleResult.driverPayableDeduction).toBe("0.00");
        expect(singleResult.netAmountExpected).toBe("100.00");
        expect(singleResult.orderCount).toBe(1);
        // Only the Driver Cash Status changed.
        const afterSingle = await statusOf(single);
        expect(afterSingle.cashStatus).toBe("reconciled");
        expect(afterSingle.deliveryStatus).toBe("delivered");
        expect(afterSingle.settlementStatus).toBe("unsettled");
        const singleCounts = await countsFor(single);
        expect(singleCounts).toEqual({ events: 1, history: 1, links: 1 });
        // Driver cost was 7.50 and must have been ignored entirely.
        const deduction = await sql<{ headerDeduction: string; linkDeduction: string }>`
          select r.driver_payable_deduction::text as "headerDeduction",
                 l.driver_payable_deduction::text as "linkDeduction"
            from driver_reconciliations r
            join driver_reconciliation_orders l on l.reconciliation_id = r.id
           where r.id = ${singleResult.reconciliationId}::uuid
        `.execute(transaction);
        expect(deduction.rows[0]?.headerDeduction).toBe("0.00");
        expect(deduction.rows[0]?.linkDeduction).toBe("0.00");

        // --- 2. Multiple Orders, same Driver, exact decimal arithmetic --------
        const multiA = await createOrder(companyA, { collected: 33.33 });
        const multiB = await createOrder(companyA, { collected: 33.33 });
        const multiC = await createOrder(companyA, { collected: 33.34 });
        const multiResult = await service.confirm(
          selection([multiA, multiB, multiC], {
            payments: [{ amount: 100, paymentMethod: "cash" }],
          }),
          randomUUID(),
          `key-multi-${randomUUID()}`,
        );
        expect(multiResult.grossCollections).toBe("100.00");
        expect(multiResult.netAmountExpected).toBe("100.00");
        expect(multiResult.orderCount).toBe(3);

        // --- 3. Expenses reduce Net Expected ---------------------------------
        const expenseOrder = await createOrder(companyA, { collected: 100 });
        const expenseResult = await service.confirm(
          selection([expenseOrder], {
            expenses: [
              { amount: 10.5, expenseTypeId: companyA.expenseTypes.PETROL ?? "" },
              { amount: 4.25, expenseTypeId: companyA.expenseTypes.PARKING ?? "" },
            ],
            payments: [{ amount: 85.25, paymentMethod: "cash" }],
          }),
          randomUUID(),
          `key-expense-${randomUUID()}`,
        );
        expect(expenseResult.expenseTotal).toBe("14.75");
        expect(expenseResult.netAmountExpected).toBe("85.25");
        // Expense actor and recorded timestamp are populated (closes the Stage 2 gap).
        const expenseRows = await sql<{ actor: string | null; recordedAt: string | null }>`
          select created_by_account_id as actor, recorded_at as "recordedAt"
            from driver_reconciliation_expenses
           where reconciliation_id = ${expenseResult.reconciliationId}::uuid
        `.execute(transaction);
        expect(expenseRows.rows).toHaveLength(2);
        expect(expenseRows.rows.every((row) => row.actor === companyA.accountId)).toBe(true);
        expect(expenseRows.rows.every((row) => row.recordedAt !== null)).toBe(true);

        // --- 4. Eligibility rejections ---------------------------------------
        const mixedOne = await createOrder(companyA, { collected: 10 });
        const mixedTwo = await createOrder(companyA, {
          collected: 10,
          driverId: companyA.secondDriverId,
        });
        await expectRejection(
          () =>
            service.confirm(
              selection([mixedOne, mixedTwo], {
                payments: [{ amount: 20, paymentMethod: "cash" }],
              }),
              randomUUID(),
              `key-mixed-${randomUUID()}`,
            ),
          "reconciliation_driver_mismatch",
        );
        expect(await countsFor(mixedOne)).toEqual({ events: 0, history: 0, links: 0 });
        expect((await statusOf(mixedOne)).cashStatus).toBe("pending");

        const notDelivered = await createOrder(companyA, {
          collected: 10,
          deliveryStatus: "out_for_delivery",
        });
        await expectRejection(
          () =>
            service.confirm(
              selection([notDelivered], { payments: [{ amount: 10, paymentMethod: "cash" }] }),
              randomUUID(),
              `key-notdelivered-${randomUUID()}`,
            ),
          "reconciliation_order_ineligible",
        );

        const notPending = await createOrder(companyA, {
          cashStatus: "not_applicable",
          collected: 10,
        });
        await expectRejection(
          () =>
            service.confirm(
              selection([notPending], { payments: [{ amount: 10, paymentMethod: "cash" }] }),
              randomUUID(),
              `key-notpending-${randomUUID()}`,
            ),
          "reconciliation_order_ineligible",
        );

        // Already reconciled Order cannot be reconciled again.
        await expectRejection(
          () =>
            service.confirm(
              selection([single], { payments: [{ amount: 100, paymentMethod: "cash" }] }),
              randomUUID(),
              `key-again-${randomUUID()}`,
            ),
          "reconciliation_order_ineligible",
        );

        // One invalid Order rejects the entire request.
        const validOfPair = await createOrder(companyA, { collected: 40 });
        const invalidOfPair = await createOrder(companyA, {
          collected: 10,
          deliveryStatus: "out_for_delivery",
        });
        await expectRejection(
          () =>
            service.confirm(
              selection([validOfPair, invalidOfPair], {
                payments: [{ amount: 50, paymentMethod: "cash" }],
              }),
              randomUUID(),
              `key-partial-${randomUUID()}`,
            ),
          "reconciliation_order_ineligible",
        );
        expect(await countsFor(validOfPair)).toEqual({ events: 0, history: 0, links: 0 });
        expect((await statusOf(validOfPair)).cashStatus).toBe("pending");

        // --- 5. Cross-Company isolation --------------------------------------
        const companyBOrder = await createOrder(companyB, { collected: 25 });
        await expectRejection(
          () =>
            service.confirm(
              selection([companyBOrder], { payments: [{ amount: 25, paymentMethod: "cash" }] }),
              randomUUID(),
              `key-crossorder-${randomUUID()}`,
            ),
          "reconciliation_empty",
        );
        expect(await countsFor(companyBOrder)).toEqual({ events: 0, history: 0, links: 0 });

        // Cross-Company Bank Account is rejected.
        const crossBankOrder = await createOrder(companyA, { collected: 30 });
        await expectRejection(
          () =>
            service.confirm(
              selection([crossBankOrder], {
                payments: [
                  {
                    amount: 30,
                    bankAccountId: companyB.bankAccountId,
                    bankReference: `X-${randomUUID().slice(0, 8)}`,
                    paymentMethod: "bank_transfer",
                  },
                ],
              }),
              randomUUID(),
              `key-crossbank-${randomUUID()}`,
            ),
          "bank_account_not_found",
        );
        // Cross-Company Expense Type is rejected.
        await expectRejection(
          () =>
            service.confirm(
              selection([crossBankOrder], {
                expenses: [{ amount: 5, expenseTypeId: companyB.expenseTypes.PETROL ?? "" }],
                payments: [{ amount: 25, paymentMethod: "cash" }],
              }),
              randomUUID(),
              `key-crosstype-${randomUUID()}`,
            ),
          "expense_type_not_found",
        );

        // --- 6. Disabled Driver ----------------------------------------------
        const disabledDriverOrder = await createOrder(companyA, {
          collected: 60,
          driverId: companyA.secondDriverId,
        });
        await sql`
          update drivers set account_status = 'disabled'
           where id = ${companyA.secondDriverId}::uuid
        `.execute(transaction);
        const disabledResult = await service.confirm(
          selection([disabledDriverOrder], {
            payments: [{ amount: 60, paymentMethod: "cash" }],
          }),
          randomUUID(),
          `key-disabled-${randomUUID()}`,
        );
        expect(disabledResult.netAmountExpected).toBe("60.00");
        await sql`
          update drivers set account_status = 'active'
           where id = ${companyA.secondDriverId}::uuid
        `.execute(transaction);

        // --- 7. Payments ------------------------------------------------------
        const bankOrder = await createOrder(companyA, { collected: 70 });
        const bankReference = `REF-${randomUUID().slice(0, 8)}`;
        const bankResult = await service.confirm(
          selection([bankOrder], {
            payments: [
              {
                amount: 70,
                bankAccountId: companyA.bankAccountId,
                bankReference,
                paymentMethod: "bank_transfer",
              },
            ],
          }),
          randomUUID(),
          `key-bank-${randomUUID()}`,
        );
        expect(bankResult.paymentTotal).toBe("70.00");

        // Case-insensitive duplicate Bank Reference is rejected.
        const duplicateReferenceOrder = await createOrder(companyA, { collected: 20 });
        await expect(
          service.confirm(
            selection([duplicateReferenceOrder], {
              payments: [
                {
                  amount: 20,
                  bankAccountId: companyA.bankAccountId,
                  bankReference: bankReference.toLowerCase(),
                  paymentMethod: "bank_transfer",
                },
              ],
            }),
            randomUUID(),
            `key-dupref-${randomUUID()}`,
          ),
        ).rejects.toMatchObject({ code: "23505" });
        expect(await countsFor(duplicateReferenceOrder)).toEqual({
          events: 0,
          history: 0,
          links: 0,
        });

        // Mixed Cash and Bank Transfer.
        const mixedPaymentOrder = await createOrder(companyA, { collected: 90 });
        const mixedPaymentResult = await service.confirm(
          selection([mixedPaymentOrder], {
            payments: [
              { amount: 40, paymentMethod: "cash" },
              {
                amount: 50,
                bankAccountId: companyA.bankAccountId,
                bankReference: `MIX-${randomUUID().slice(0, 8)}`,
                paymentMethod: "bank_transfer",
              },
            ],
          }),
          randomUUID(),
          `key-mixedpay-${randomUUID()}`,
        );
        expect(mixedPaymentResult.paymentTotal).toBe("90.00");

        const paymentFailureOrder = await createOrder(companyA, { collected: 50 });
        await expectRejection(
          () =>
            service.confirm(
              selection([paymentFailureOrder], {
                payments: [{ amount: 49.99, paymentMethod: "cash" }],
              }),
              randomUUID(),
              `key-mismatch-${randomUUID()}`,
            ),
          "reconciliation_payment_difference",
        );
        await expectRejection(
          () =>
            service.confirm(
              selection([paymentFailureOrder], { payments: [] }),
              randomUUID(),
              `key-nopayment-${randomUUID()}`,
            ),
          "reconciliation_payment_difference",
        );
        await expectRejection(
          () =>
            service.confirm(
              selection([paymentFailureOrder], {
                payments: [
                  {
                    amount: 50,
                    bankAccountId: companyA.bankAccountId,
                    paymentMethod: "bank_transfer",
                  },
                ],
              }),
              randomUUID(),
              `key-noref-${randomUUID()}`,
            ),
          "bank_payment_details_required",
        );
        await expectRejection(
          () =>
            service.confirm(
              selection([paymentFailureOrder], {
                payments: [
                  {
                    amount: 50,
                    bankReference: "NO-ACCOUNT",
                    paymentMethod: "bank_transfer",
                  },
                ],
              }),
              randomUUID(),
              `key-noaccount-${randomUUID()}`,
            ),
          "bank_payment_details_required",
        );
        await expectRejection(
          () =>
            service.confirm(
              selection([paymentFailureOrder], {
                payments: [
                  {
                    amount: 50,
                    bankAccountId: companyA.bankAccountId,
                    paymentMethod: "cash",
                  },
                ],
              }),
              randomUUID(),
              `key-cashbank-${randomUUID()}`,
            ),
          "cash_payment_bank_details",
        );
        // Every rejection above must have left the Order untouched.
        expect(await countsFor(paymentFailureOrder)).toEqual({ events: 0, history: 0, links: 0 });
        expect((await statusOf(paymentFailureOrder)).cashStatus).toBe("pending");

        // Inactive Bank Account is rejected.
        await sql`
          update company_bank_accounts set is_active = false
           where id = ${companyA.bankAccountId}::uuid
        `.execute(transaction);
        await expectRejection(
          () =>
            service.confirm(
              selection([paymentFailureOrder], {
                payments: [
                  {
                    amount: 50,
                    bankAccountId: companyA.bankAccountId,
                    bankReference: `INACTIVE-${randomUUID().slice(0, 6)}`,
                    paymentMethod: "bank_transfer",
                  },
                ],
              }),
              randomUUID(),
              `key-inactivebank-${randomUUID()}`,
            ),
          "bank_account_not_found",
        );
        await sql`
          update company_bank_accounts set is_active = true
           where id = ${companyA.bankAccountId}::uuid
        `.execute(transaction);

        // --- 8. Expense rules -------------------------------------------------
        const expenseRuleOrder = await createOrder(companyA, { collected: 80 });
        // Petrol succeeds with no description.
        const petrolResult = await service.confirm(
          selection([expenseRuleOrder], {
            expenses: [{ amount: 5, expenseTypeId: companyA.expenseTypes.PETROL ?? "" }],
            payments: [{ amount: 75, paymentMethod: "cash" }],
          }),
          randomUUID(),
          `key-petrol-${randomUUID()}`,
        );
        expect(petrolResult.netAmountExpected).toBe("75.00");

        const otherOrder = await createOrder(companyA, { collected: 80 });
        await expectRejection(
          () =>
            service.confirm(
              selection([otherOrder], {
                expenses: [{ amount: 5, expenseTypeId: companyA.expenseTypes.OTHER ?? "" }],
                payments: [{ amount: 75, paymentMethod: "cash" }],
              }),
              randomUUID(),
              `key-other-${randomUUID()}`,
            ),
          "expense_description_required",
        );
        await expectRejection(
          () =>
            service.confirm(
              selection([otherOrder], {
                expenses: [
                  { amount: 5, expenseTypeId: companyA.expenseTypes.OTHER ?? "", notes: "   " },
                ],
                payments: [{ amount: 75, paymentMethod: "cash" }],
              }),
              randomUUID(),
              `key-otherblank-${randomUUID()}`,
            ),
          "expense_description_required",
        );
        const otherResult = await service.confirm(
          selection([otherOrder], {
            expenses: [
              { amount: 5, expenseTypeId: companyA.expenseTypes.OTHER ?? "", notes: "Ferry toll" },
            ],
            payments: [{ amount: 75, paymentMethod: "cash" }],
          }),
          randomUUID(),
          `key-otherok-${randomUUID()}`,
        );
        expect(otherResult.netAmountExpected).toBe("75.00");

        const zeroExpenseOrder = await createOrder(companyA, { collected: 20 });
        await expectRejection(
          () =>
            service.confirm(
              selection([zeroExpenseOrder], {
                expenses: [{ amount: 0, expenseTypeId: companyA.expenseTypes.PETROL ?? "" }],
                payments: [{ amount: 20, paymentMethod: "cash" }],
              }),
              randomUUID(),
              `key-zeroexpense-${randomUUID()}`,
            ),
          "expense_amount_invalid",
        );
        await expectRejection(
          () =>
            service.confirm(
              selection([zeroExpenseOrder], {
                expenses: [{ amount: -5, expenseTypeId: companyA.expenseTypes.PETROL ?? "" }],
                payments: [{ amount: 25, paymentMethod: "cash" }],
              }),
              randomUUID(),
              `key-negexpense-${randomUUID()}`,
            ),
          "expense_amount_invalid",
        );
        // Inactive Expense Type is rejected.
        await sql`
          update expense_types set is_active = false
           where id = ${companyA.expenseTypes.PARKING ?? ""}::uuid
        `.execute(transaction);
        await expectRejection(
          () =>
            service.confirm(
              selection([zeroExpenseOrder], {
                expenses: [{ amount: 5, expenseTypeId: companyA.expenseTypes.PARKING ?? "" }],
                payments: [{ amount: 15, paymentMethod: "cash" }],
              }),
              randomUUID(),
              `key-inactivetype-${randomUUID()}`,
            ),
          "expense_type_not_found",
        );
        await sql`
          update expense_types set is_active = true
           where id = ${companyA.expenseTypes.PARKING ?? ""}::uuid
        `.execute(transaction);

        // --- 9. Zero and negative Net Expected --------------------------------
        const zeroOrder = await createOrder(companyA, { collected: 0 });
        await expectRejection(
          () =>
            service.confirm(
              selection([zeroOrder], { payments: [{ amount: 1, paymentMethod: "cash" }] }),
              randomUUID(),
              `key-zeropay-${randomUUID()}`,
            ),
          "reconciliation_payment_difference",
        );
        const zeroResult = await service.confirm(
          selection([zeroOrder], { payments: [] }),
          randomUUID(),
          `key-zerook-${randomUUID()}`,
        );
        expect(zeroResult.netAmountExpected).toBe("0.00");
        const zeroPayments = await sql<{ total: number }>`
          select count(*)::int as total from driver_reconciliation_payments
           where reconciliation_id = ${zeroResult.reconciliationId}::uuid
        `.execute(transaction);
        expect(zeroPayments.rows[0]?.total).toBe(0);

        const negativeOrder = await createOrder(companyA, { collected: 10 });
        await expectRejection(
          () =>
            service.confirm(
              selection([negativeOrder], {
                expenses: [{ amount: 50, expenseTypeId: companyA.expenseTypes.PETROL ?? "" }],
                payments: [],
              }),
              randomUUID(),
              `key-negative-${randomUUID()}`,
            ),
          "reconciliation_negative_net",
        );
        expect(await countsFor(negativeOrder)).toEqual({ events: 0, history: 0, links: 0 });
        expect((await statusOf(negativeOrder)).cashStatus).toBe("pending");
        const negativeResidue = await sql<{ expenses: number; headers: number }>`
          select
            (select count(*)::int from driver_reconciliations
              where company_id = ${companyA.companyId}::uuid and net_amount_received < 0) as headers,
            (select count(*)::int from driver_reconciliation_expenses e
              join driver_reconciliations r on r.id = e.reconciliation_id
             where r.company_id = ${companyA.companyId}::uuid and e.amount = 50) as expenses
        `.execute(transaction);
        expect(negativeResidue.rows[0]).toEqual({ expenses: 0, headers: 0 });

        // --- 10. Rollback after partial writes --------------------------------
        // The Bank Reference collision above fails at the payment INSERT, i.e.
        // after the header, Order links and expenses have already been written.
        // Re-run it while counting rows to prove nothing survived.
        const rollbackOrder = await createOrder(companyA, { collected: 45 });
        const beforeRollback = await sql<{ headers: number; links: number; payments: number }>`
          select
            (select count(*)::int from driver_reconciliations
              where company_id = ${companyA.companyId}::uuid) as headers,
            (select count(*)::int from driver_reconciliation_orders
              where company_id = ${companyA.companyId}::uuid) as links,
            (select count(*)::int from driver_reconciliation_payments
              where company_id = ${companyA.companyId}::uuid) as payments
        `.execute(transaction);
        await expect(
          service.confirm(
            selection([rollbackOrder], {
              expenses: [{ amount: 5, expenseTypeId: companyA.expenseTypes.PETROL ?? "" }],
              payments: [
                {
                  amount: 40,
                  bankAccountId: companyA.bankAccountId,
                  bankReference: bankReference.toUpperCase(),
                  paymentMethod: "bank_transfer",
                },
              ],
            }),
            randomUUID(),
            `key-rollback-${randomUUID()}`,
          ),
        ).rejects.toBeDefined();
        const afterRollback = await sql<{ headers: number; links: number; payments: number }>`
          select
            (select count(*)::int from driver_reconciliations
              where company_id = ${companyA.companyId}::uuid) as headers,
            (select count(*)::int from driver_reconciliation_orders
              where company_id = ${companyA.companyId}::uuid) as links,
            (select count(*)::int from driver_reconciliation_payments
              where company_id = ${companyA.companyId}::uuid) as payments
        `.execute(transaction);
        expect(afterRollback.rows[0]).toEqual(beforeRollback.rows[0]);
        expect(await countsFor(rollbackOrder)).toEqual({ events: 0, history: 0, links: 0 });
        expect((await statusOf(rollbackOrder)).cashStatus).toBe("pending");
        const rollbackIdempotency = await sql<{ total: number }>`
          select count(*)::int as total from idempotency_records
           where company_id = ${companyA.companyId}::uuid and resource_id is null
        `.execute(transaction);
        expect(rollbackIdempotency.rows[0]?.total).toBe(0);

        // --- 11. Idempotency --------------------------------------------------
        const idempotentOrderOne = await createOrder(companyA, { collected: 15 });
        const idempotentOrderTwo = await createOrder(companyA, { collected: 25 });
        const replayKey = `key-replay-${randomUUID()}`;
        const replayInput = selection([idempotentOrderOne, idempotentOrderTwo], {
          expenses: [
            { amount: 2, expenseTypeId: companyA.expenseTypes.PETROL ?? "" },
            { amount: 3, expenseTypeId: companyA.expenseTypes.PARKING ?? "" },
          ],
          payments: [
            { amount: 20, paymentMethod: "cash" },
            {
              amount: 15,
              bankAccountId: companyA.bankAccountId,
              bankReference: `IDEM-${randomUUID().slice(0, 8)}`,
              paymentMethod: "bank_transfer",
            },
          ],
        });
        const first = await service.confirm(replayInput, randomUUID(), replayKey);
        expect(first.netAmountExpected).toBe("35.00");
        // Exact replay returns the original result and creates nothing new.
        const replay = await service.confirm(replayInput, randomUUID(), replayKey);
        expect(replay.reconciliationId).toBe(first.reconciliationId);
        // Reordered Orders, expenses and payments still replay.
        const reordered = selection([idempotentOrderTwo, idempotentOrderOne], {
          expenses: [
            { amount: 3, expenseTypeId: companyA.expenseTypes.PARKING ?? "" },
            { amount: 2, expenseTypeId: companyA.expenseTypes.PETROL ?? "" },
          ],
          payments: [...replayInput.payments].reverse(),
        });
        const reorderedReplay = await service.confirm(reordered, randomUUID(), replayKey);
        expect(reorderedReplay.reconciliationId).toBe(first.reconciliationId);
        // Only one reconciliation exists for that key.
        const replayCount = await sql<{ total: number }>`
          select count(*)::int as total from driver_reconciliation_orders
           where order_id = ${idempotentOrderOne}::uuid
        `.execute(transaction);
        expect(replayCount.rows[0]?.total).toBe(1);
        // A materially different payload under the same key is rejected.
        await expectRejection(
          () =>
            service.confirm(
              selection([idempotentOrderOne, idempotentOrderTwo], {
                expenses: [{ amount: 5, expenseTypeId: companyA.expenseTypes.PETROL ?? "" }],
                payments: [{ amount: 35, paymentMethod: "cash" }],
              }),
              randomUUID(),
              replayKey,
            ),
          "idempotency_key_reused",
        );
        // An invalid key is rejected outright.
        await expectRejection(
          () => service.confirm(selection([idempotentOrderOne]), randomUUID(), "short"),
          "idempotency_key_invalid",
        );


        // --- 12. Stage 5 read APIs -------------------------------------------
        // Driver search: Active by default, with pending counts and totals.
        const driverPage = await service.searchDrivers({ page: 1, pageSize: 50 });
        const primary = driverPage.items.find((row) => row.id === companyA.driverId);
        expect(primary).toBeDefined();
        expect(primary?.accountStatus).toBe("active");
        expect(primary?.code).toContain("DRV-");
        expect(primary?.driverType).toBe("outsourced");
        expect(driverPage.items.some((row) => row.id === companyB.driverId)).toBe(false);
        const byName = await service.searchDrivers({ search: "Primary" });
        expect(byName.items.map((row) => row.id)).toContain(companyA.driverId);
        const byMobile = await service.searchDrivers({ search: "971500000001" });
        expect(byMobile.items.map((row) => row.id)).toContain(companyA.driverId);
        const byCode = await service.searchDrivers({ search: primary?.code ?? "" });
        expect(byCode.items.map((row) => row.id)).toContain(companyA.driverId);

        // A Disabled Driver with no eligible pending Orders is hidden by default,
        // and reappears once it holds one.
        await sql`
          update drivers set account_status = 'disabled'
           where id = ${companyA.secondDriverId}::uuid
        `.execute(transaction);
        // A Disabled Driver holding no eligible pending Orders is hidden by default.
        const idleDriverId = randomUUID();
        const idleDriverAccountId = randomUUID();
        await sql`
          insert into accounts (id, company_id, account_kind, username, password_hash)
          values (${idleDriverAccountId}::uuid, ${companyA.companyId}::uuid, 'driver',
                  ${`rec.idle.${companyA.companyId.slice(0, 8)}`}, 'test-only')
        `.execute(transaction);
        await sql`
          insert into drivers (
            id, company_id, account_id, code, driver_type, name_en, mobile_number, account_status
          ) values (
            ${idleDriverId}::uuid, ${companyA.companyId}::uuid, ${idleDriverAccountId}::uuid,
            ${`DRV-IDLE-${companyA.companyId.slice(0, 4)}`}, 'outsourced', 'Idle Driver',
            '971500000009', 'disabled'
          )
        `.execute(transaction);
        const hidden = await service.searchDrivers({ pageSize: 50 });
        expect(hidden.items.some((row) => row.id === idleDriverId)).toBe(false);
        const strandedOrder = await createOrder(companyA, {
          collected: 12,
          driverId: companyA.secondDriverId,
        });
        const revealed = await service.searchDrivers({ pageSize: 50 });
        const disabledDriver = revealed.items.find((row) => row.id === companyA.secondDriverId);
        expect(disabledDriver).toBeDefined();
        expect(disabledDriver?.accountStatus).toBe("disabled");
        expect(disabledDriver?.pendingOrderCount).toBeGreaterThanOrEqual(1);
        expect(Number(disabledDriver?.pendingCollectionTotal ?? 0)).toBeGreaterThanOrEqual(12);
        const allDrivers = await service.searchDrivers({ pageSize: 50, status: "all" });
        expect(allDrivers.items.some((row) => row.id === idleDriverId)).toBe(true);

        // Eligible Orders: only Delivered + Pending + unlinked, Company scoped.
        const eligible = await service.eligibleOrders({
          driverId: companyA.secondDriverId,
          page: 1,
          pageSize: 25,
        });
        expect(eligible.items.map((row) => row.id)).toContain(strandedOrder);
        expect(eligible.total).toBe(eligible.filteredTotals.orderCount);
        expect(Number(eligible.filteredTotals.collectionTotal)).toBeGreaterThanOrEqual(12);
        expect(eligible.items[0]?.cashStatusLabel).toBe("Pending Collection");
        const reconciledVisible = await service.eligibleOrders({
          driverId: companyA.driverId,
          pageSize: 100,
        });
        expect(reconciledVisible.items.map((row) => row.id)).not.toContain(single);
        const pageOne = await service.eligibleOrders({
          driverId: companyA.driverId,
          page: 1,
          pageSize: 25,
          sortBy: "orderNumber",
          sortDirection: "asc",
        });
        expect(pageOne.pageSize).toBe(25);
        expect(pageOne.page).toBe(1);
        // Ascending sort is honoured.
        const ascending = pageOne.items.map((row) => row.orderNumber);
        expect([...ascending].sort()).toEqual(ascending);
        const descending = await service.eligibleOrders({
          driverId: companyA.driverId,
          pageSize: 25,
          sortBy: "orderNumber",
          sortDirection: "desc",
        });
        expect(descending.items.map((row) => row.orderNumber)).toEqual([...ascending].reverse());
        // Paging past the result set yields no rows but keeps the echoed page.
        const beyond = await service.eligibleOrders({
          driverId: companyA.driverId,
          page: 99,
          pageSize: 25,
        });
        expect(beyond.items).toHaveLength(0);
        expect(beyond.page).toBe(99);
        // An unapproved page size normalises to the default of 25.
        const normalised = await service.eligibleOrders({
          driverId: companyA.driverId,
          pageSize: 7 as unknown as 25,
        });
        expect(normalised.pageSize).toBe(25);
        const normalisedPage = await service.list({ page: 0 as unknown as 1, pageSize: 25 });
        expect(normalisedPage.page).toBe(1);
        const searchTarget = pageOne.items[0]?.orderNumber ?? "";
        const searched = await service.eligibleOrders({
          driverId: companyA.driverId,
          search: searchTarget,
        });
        expect(searched.items.every((row) => row.orderNumber.includes(searchTarget))).toBe(true);
        const crossDriver = await service.eligibleOrders({ driverId: companyB.driverId });
        expect(crossDriver.items).toHaveLength(0);

        // Preview is authoritative and writes nothing.
        const previewCounts = await sql<{ headers: number; links: number }>`
          select
            (select count(*)::int from driver_reconciliations
              where company_id = ${companyA.companyId}::uuid) as headers,
            (select count(*)::int from driver_reconciliation_orders
              where company_id = ${companyA.companyId}::uuid) as links
        `.execute(transaction);
        const previewResult = await service.preview({
          excludedOrderIds: [],
          expenses: [{ amount: 2, expenseTypeId: companyA.expenseTypes.PETROL ?? "" }],
          orderIds: [strandedOrder],
          payments: [{ amount: 9, paymentMethod: "cash" }],
          selectionMode: "ids",
        });
        expect(previewResult.grossCollections).toBe("12.00");
        expect(previewResult.driverPayableDeduction).toBe("0.00");
        expect(previewResult.expenseTotal).toBe("2.00");
        expect(previewResult.netAmountExpected).toBe("10.00");
        expect(previewResult.paymentTotal).toBe("9.00");
        expect(previewResult.difference).toBe("-1.00");
        expect(previewResult.orders).toHaveLength(1);
        expect(previewResult.orders[0]?.cashStatusLabel).toBe("Pending Collection");
        expect(previewResult.warnings).toEqual([]);
        const afterPreview = await sql<{ headers: number; links: number }>`
          select
            (select count(*)::int from driver_reconciliations
              where company_id = ${companyA.companyId}::uuid) as headers,
            (select count(*)::int from driver_reconciliation_orders
              where company_id = ${companyA.companyId}::uuid) as links
        `.execute(transaction);
        expect(afterPreview.rows[0]).toEqual(previewCounts.rows[0]);
        expect((await statusOf(strandedOrder)).cashStatus).toBe("pending");

        // Stale selection surfaces a warning rather than silently recalculating.
        const staleWarning = await service.preview({
          excludedOrderIds: [],
          expenses: [],
          orderIds: [single],
          payments: [],
          selectionMode: "ids",
        });
        expect(staleWarning.warnings.length).toBeGreaterThan(0);

        // Reconciliation list: pagination, filters, sorting and labels.
        const list = await service.list({ page: 1, pageSize: 25 });
        expect(list.items.length).toBeGreaterThan(0);
        expect(list.total).toBeGreaterThan(0);
        expect(list.items[0]?.statusLabel).toBe("Confirmed");
        expect(list.items.every((row) => row.driverType === "outsourced")).toBe(true);
        const filteredByDriver = await service.list({
          driverId: companyA.secondDriverId,
          pageSize: 50,
        });
        expect(filteredByDriver.items.every((row) => row.driverName === "Second Driver")).toBe(true);
        const bankFiltered = await service.list({ pageSize: 50, paymentMethod: "bank_transfer" });
        expect(bankFiltered.items.some((row) => row.id === bankResult.reconciliationId)).toBe(true);
        const cashOnly = await service.list({ pageSize: 50, paymentMethod: "cash" });
        expect(cashOnly.items.some((row) => row.id === bankResult.reconciliationId)).toBe(false);
        const sortedAsc = await service.list({
          pageSize: 50,
          sortBy: "reconciliationNumber",
          sortDirection: "asc",
        });
        const numbers = sortedAsc.items.map((row) => row.reconciliationNumber);
        expect([...numbers].sort()).toEqual(numbers);

        // Details: overview, Orders, payments, expenses and audit.
        const details = (await service.details(expenseResult.reconciliationId)) as {
          audit: readonly { action: string; actor: string }[];
          expenses: readonly { expenseType: string; recordedBy: string }[];
          orders: readonly { cashStatusLabel: string }[];
          overview: { statusLabel: string };
          payments: readonly { paymentMethodLabel: string }[];
        };
        expect(details.overview.statusLabel).toBe("Confirmed");
        expect(details.orders[0]?.cashStatusLabel).toBe("Money Received from Driver");
        expect(details.payments[0]?.paymentMethodLabel).toBe("Cash");
        expect(details.expenses).toHaveLength(2);
        expect(details.expenses.every((row) => row.recordedBy !== "Legacy/Unknown")).toBe(true);
        expect(details.audit.some((row) => row.action === "driver_reconciliation.confirm")).toBe(
          true,
        );

        // Cross-Company details are not readable.
        useCompany(companyB);
        await expectRejection(
          () => service.details(expenseResult.reconciliationId),
          "reconciliation_not_found",
        );
        const companyBList = await service.list({ pageSize: 50 });
        expect(companyBList.items.some((row) => row.id === expenseResult.reconciliationId)).toBe(
          false,
        );
        useCompany(companyA);

        // Authorization is enforced in the backend on every read surface.
        identities.set({
          companyId: companyA.companyId,
          forcePasswordChange: false,
          identityId: companyA.accountId,
          kind: "company_user",
          permissions: new Set(),
          sessionId: randomUUID(),
        });
        await expectRejection(() => service.searchDrivers({}), "permission_denied");
        await expectRejection(
          () => service.eligibleOrders({ driverId: companyA.driverId }),
          "permission_denied",
        );
        await expectRejection(() => service.list({}), "permission_denied");
        await expectRejection(
          () => service.details(expenseResult.reconciliationId),
          "permission_denied",
        );
        await expectRejection(() => service.expenseTypes(), "permission_denied");
        identities.set({
          companyId: companyA.companyId,
          forcePasswordChange: false,
          identityId: companyA.accountId,
          kind: "company_user",
          permissions: new Set(["users_roles.manage"]),
          sessionId: randomUUID(),
        });
        expect((await service.list({ pageSize: 25 })).items.length).toBeGreaterThan(0);
        useCompany(companyA);

        // Expense Types API exposes display_name, immutable code and the OTHER rule.
        const availableTypes = await service.expenseTypes();
        expect(availableTypes.map((row) => row.code).sort()).toEqual([
          "OTHER",
          "PARKING",
          "PETROL",
        ]);
        expect(availableTypes.find((row) => row.code === "OTHER")?.requiresDescription).toBe(true);
        expect(availableTypes.find((row) => row.code === "PETROL")?.requiresDescription).toBe(false);
        expect(availableTypes.every((row) => row.name.length > 0)).toBe(true);

        // Legacy wrapper delegates to the authoritative service.
        const legacyOrder = await createOrder(companyA, { collected: 55 });
        const legacyKey = `legacy-key-${randomUUID()}`;
        const legacyResult = await service.confirmSingleOrder(
          legacyOrder,
          { paymentMethod: "cash" },
          randomUUID(),
          legacyKey,
        );
        expect(legacyResult.netAmountExpected).toBe("55.00");
        expect(legacyResult.driverPayableDeduction).toBe("0.00");
        expect((await statusOf(legacyOrder)).cashStatus).toBe("reconciled");
        const legacyReplay = await service.confirmSingleOrder(
          legacyOrder,
          { paymentMethod: "cash" },
          randomUUID(),
          legacyKey,
        );
        expect(legacyReplay.reconciliationId).toBe(legacyResult.reconciliationId);
        await expectRejection(
          () => service.confirmSingleOrder(legacyOrder, { paymentMethod: "cash" }, randomUUID()),
          "reconciliation_order_ineligible",
        );
        useCompany(companyB);
        await expectRejection(
          () => service.confirmSingleOrder(legacyOrder, { paymentMethod: "cash" }, randomUUID()),
          "order_not_found",
        );
        useCompany(companyA);

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) {
        throw error;
      }
    } finally {
      await database.destroy();
    }
  }, 120_000);
});
