import { randomUUID } from "node:crypto";
import { permissiveBalanceEnforcement } from "../test/balance-enforcement-stub.js";
import {
  createBusinessDayServiceStub,
  createCalendarDateReportModeServiceStub,
} from "../test/business-day-stubs.js";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import type { ConfigService } from "@nestjs/config";

import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import type { AppConfiguration } from "../configuration/environment.js";
import { configuration } from "../configuration/environment.js";
import type { FileStoragePort } from "../files/file-storage.port.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import type { IdentityContext, IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContext, TenantContextAccessor } from "../tenancy/tenant-context.js";

import type { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import type { PaymentFundingAccountService } from "../accounting/payment-funding-account.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import type { CreateTraderSettlementDto } from "./operations.dto.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

const runDatabaseTests = process.env.RUN_SETTLEMENT_DATABASE === "true";
const databaseUrl = process.env.DATABASE_URL;
if (runDatabaseTests) {
  if (databaseUrl === undefined) throw new Error("RUN_SETTLEMENT_DATABASE requires an explicit DATABASE_URL");
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || parsed.pathname !== "/blueline_stage1_drafts_schema_20260929") {
    throw new Error("Settlement database tests require the verified disposable 127.0.0.1:55432 database");
  }
}
const rollbackMarker = Symbol("rollback trader settlement test");

class SavepointTransactionManager {
  private sequence = 0;

  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}

  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `settle_${++this.sequence}`;
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
  readonly companyBankAccountId: string;
  readonly companyId: string;
  readonly traderBankAccountId: string;
  readonly traderBankAccountTwoId: string;
  readonly traderId: string;
}

describe.skipIf(!runDatabaseTests)("trader settlement reversal reopens closed orders", () => {
  it("reopens a closed Order when its Settlement is reversed, so the Trader can be paid", async () => {
    if (process.env.BLUELINE_DISABLE_DOTENV !== "1") {
      loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    }
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

    try {
      await database.transaction().execute(async (transaction) => {
        const manager = new SavepointTransactionManager(transaction);
        await sql`
          insert into permissions (code, description)
          values ('users_roles.manage', 'Test permission for settlement integration fixtures')
          on conflict (code) do nothing
        `.execute(transaction);
        await sql`
          insert into emirates (code, name_en, name_ar, display_order)
          values ('DXB', 'Dubai', 'دبي', 1)
          on conflict (code) do nothing
        `.execute(transaction);
        const tenants = new StubTenantAccessor({ companyId: "", identityId: "" });
        const identities = new StubIdentityAccessor({
          companyId: null,
          forcePasswordChange: false,
          identityId: "",
          kind: "company_user",
          permissions: new Set(["settlements.create", "settlements.reverse"]),
          sessionId: randomUUID(),
        });
        const companyProfile = new CompanyProfileService(
          transaction as unknown as Kysely<DatabaseSchema>,
          manager as unknown as KyselyTransactionManager,
          tenants as unknown as TenantContextAccessor,
          identities as unknown as IdentityContextAccessor,
          {} as unknown as FileStoragePort,
          { get: () => "local" } as unknown as ConfigService<AppConfiguration, true>,
        );
        const service = new TraderSettlementService(
          transaction as unknown as Kysely<DatabaseSchema>,
          manager as unknown as KyselyTransactionManager,
          tenants as unknown as TenantContextAccessor,
          {
            resolve: async (accountId: string) => ({
              accountId,
              kind: "cash",
              name: "Harness Cash Account",
            }),
          } as unknown as PaymentFundingAccountService,
          createCalendarDateReportModeServiceStub(),
          createBusinessDayServiceStub(),
          identities as unknown as IdentityContextAccessor,
          new OperationsHistoryWriter(),
          companyProfile,
          {} as unknown as DriverCollectionPdfService,
          // Always-allow: these cases assert settlement behaviour, not balance
          // policy. Enforcing here would make them fail on seeded Cash balances
          // for a reason they were never written to test.
          permissiveBalanceEnforcement(),
        );

        const createCompany = async (
          label: string,
          options: { readonly accountingEnabled?: boolean } = {},
        ): Promise<CompanyFixture> => {
          const accountingEnabled = options.accountingEnabled ?? true;
          const companyId = randomUUID();
          const accountId = randomUUID();
          const roleId = randomUUID();
          const traderAccountId = randomUUID();
          const traderId = randomUUID();
          const companyBankAccountId = randomUUID();
          const traderBankAccountId = randomUUID();
          const traderBankAccountTwoId = randomUUID();
          const suffix = companyId.slice(0, 8);
          await sql`
            insert into companies (id, code, subdomain, name_en, status, activated_at) values
              (${companyId}::uuid, ${`SET-${label}-${suffix}`},
               ${`set-${label.toLowerCase()}-${suffix}`},
               ${`Settlement ${label}`}, 'active', now())
          `.execute(transaction);
          // Companies here run with Accounting enabled so that confirming a
          // Settlement captures its owning Accounting Event (the trigger's
          // durable gate records nothing for disabled companies) — except the
          // scenario that proves disabled companies still confirm cleanly.
          if (accountingEnabled) {
            await sql`
              insert into accounting_configurations (company_id, accounting_enabled)
              values (${companyId}::uuid, true)
            `.execute(transaction);
          }
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash) values
              (${accountId}::uuid, ${companyId}::uuid, 'company_user', ${`set.actor.${suffix}`}, 'test-only'),
              (${traderAccountId}::uuid, ${companyId}::uuid, 'trader', ${`set.trader.${suffix}`}, 'test-only')
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
            insert into traders (
              id, company_id, account_id, code, name_en, mobile_number, created_by_account_id
            ) values (${traderId}::uuid, ${companyId}::uuid, ${traderAccountId}::uuid,
                      ${`TRD-${suffix}`}, 'Settlement Trader', '971509999999', ${accountId}::uuid)
          `.execute(transaction);
          await sql`
            insert into company_bank_accounts (id, company_id, bank_account_code, bank_name, account_name, iban) values
              (${companyBankAccountId}::uuid, ${companyId}::uuid, ${`SET-BANK-${suffix}`}, 'Settlement Bank', 'Main Account',
               ${`AE${suffix}COMPANY0001`})
          `.execute(transaction);
          // A main Cash account: cash settlement payments draw on it, and the
          // generated cash_withdrawal Movement's structure CHECK requires a
          // source cash account on a confirmed row.
          const cashGlId = randomUUID();
          await sql`
            insert into chart_of_accounts (
              id, company_id, code, name_en, account_type, account_class,
              normal_balance, is_posting_account, is_active
            ) values
              (${cashGlId}::uuid, ${companyId}::uuid, '1010', 'Cash on hand',
               'asset', 'cash', 'debit', true, true)
          `.execute(transaction);
          await sql`
            insert into company_cash_accounts (
              id, company_id, cash_account_code, cash_account_name, cash_account_type,
              linked_gl_account_id, effective_from, created_by_account_id
            ) values
              (${randomUUID()}::uuid, ${companyId}::uuid, ${`SET-CASH-${suffix}`},
               'Main Cash', 'main_cash', ${cashGlId}::uuid, current_date, ${accountId}::uuid)
          `.execute(transaction);
          await sql`
            insert into trader_bank_accounts (
              id, company_id, trader_id, bank_name, account_name, account_number, iban,
              is_default, created_by_account_id
            ) values
              (${traderBankAccountId}::uuid, ${companyId}::uuid, ${traderId}::uuid,
               'Trader Bank', 'Trader Account', '1234567890', ${`AE${suffix}TRADER00001`},
               true, ${accountId}::uuid),
              (${traderBankAccountTwoId}::uuid, ${companyId}::uuid, ${traderId}::uuid,
               'Trader Second Bank', 'Trader Second Account', '9876543210',
               ${`AE${suffix}TRADER00002`}, false, ${accountId}::uuid)
          `.execute(transaction);
          return {
            accountId,
            companyBankAccountId,
            companyId,
            traderBankAccountId,
            traderBankAccountTwoId,
            traderId,
          };
        };

        const companyA = await createCompany("A");

        const useCompany = (company: CompanyFixture): void => {
          tenants.set({ companyId: company.companyId, identityId: company.accountId });
          identities.set({
            companyId: company.companyId,
            forcePasswordChange: false,
            identityId: company.accountId,
            kind: "company_user",
            permissions: new Set(["settlements.create", "settlements.reverse"]),
            sessionId: randomUUID(),
          });
        };

        let orderSequence = 0;
        const createOrder = async (
          company: CompanyFixture,
          options: {
            readonly deliveredAt?: string;
            readonly deliveryStatus?: string;
            readonly driverReconciliationStatus?: string;
            readonly netPayable: number;
            readonly grossPayable?: number;
            readonly paidServiceFee?: number;
            readonly settlementStatus?: string;
            readonly traderId?: string;
            readonly traderPaidAmount?: number;
          },
        ): Promise<{ id: string; orderNumber: string }> => {
          const orderId = randomUUID();
          const areaId = randomUUID();
          orderSequence += 1;
          const number = `SET-${company.companyId.slice(0, 4)}-${String(orderSequence).padStart(4, "0")}`;
          await sql`
            insert into areas (id, company_id, emirate_id, code, name_en) values
              (${areaId}::uuid, ${company.companyId}::uuid,
               (select id from emirates where code='DXB'), ${`A${orderSequence}`}, ${`Area ${orderSequence}`})
          `.execute(transaction);
          const traderId = options.traderId ?? company.traderId;
          const net = options.netPayable;
          const paid = options.traderPaidAmount ?? 0;
          await sql`
            insert into orders (
              service_fee_override_reason, id, company_id, order_number, order_date, trader_id, area_id,
              created_by_account_id, customer_name, customer_mobile_number, customer_address,
              package_count, payment_condition, final_service_fee_snapshot,
              customer_provenance_status, pricing_provenance_status,
              trader_gross_payable, trader_paid_service_fee, trader_net_payable, trader_paid_amount,
              delivery_status, driver_reconciliation_status, trader_settlement_status, return_status,
              delivered_at
            ) values (
              'Zero configured Service Fee (fixture)', ${orderId}::uuid, ${company.companyId}::uuid, ${number}, current_date,
              ${traderId}::uuid, ${areaId}::uuid, ${company.accountId}::uuid,
              'Settlement Customer', '971509999998', 'Settlement address', 1,
              'customer_pays_cod_and_fee', 0, 'legacy_unattributed', 'legacy_unattributed',
              ${options.grossPayable ?? net}, ${options.paidServiceFee ?? 0}, ${net}, ${paid},
              ${options.deliveryStatus ?? "delivered"},
              ${options.driverReconciliationStatus ?? "reconciled"},
              ${options.settlementStatus ?? "unsettled"}, 'not_applicable',
              ${options.deliveredAt ?? null}::timestamptz
            )
          `.execute(transaction);
          if (options.deliveredAt === undefined) {
            await sql`update orders set delivered_at = now() where id = ${orderId}::uuid`.execute(
              transaction,
            );
          }
          return { id: orderId, orderNumber: number };
        };

        const expectRejection = async (
          work: () => Promise<unknown>,
          errorCode: string,
        ): Promise<void> => {
          await expect(work()).rejects.toMatchObject({ errorCode });
        };

        const statusOf = async (
          orderId: string,
        ): Promise<{ paid: string; outstanding: string; status: string }> => {
          const result = await sql<{ outstanding: string; paid: string; status: string }>`
            select trader_paid_amount::text as paid, trader_outstanding_balance::text as outstanding,
                   trader_settlement_status as status
              from orders where id = ${orderId}::uuid
          `.execute(transaction);
          return result.rows[0] ?? { outstanding: "0", paid: "0", status: "" };
        };

        const basePayment = (
          traderId: string,
          allocations: readonly { amount: number; orderId: string }[],
        ): CreateTraderSettlementDto => ({
          allocations,
          amount: allocations.reduce((sum, line) => sum + line.amount, 0),
          paymentMethod: "cash",
          traderId,
        });


        // The SET-000017 sequence, start to finish.
        //
        // The shape that stranded 31 Orders worth AED 8,676 on 05 Oct 2026:
        //
        //   01:13:24  SET-000017 confirmed   -> money_sent_to_trader
        //   01:15:17  Orders closed          -> delivery_status = 'closed'
        //   01:30:57  SET-000018 reverses it -> trader_settlement_status = 'unsettled'
        //
        // The reversal restored the settlement fields but left `delivery_status`
        // at `closed`, and EVERY settlement path requires `delivered` (five query
        // sites in trader-settlement.service.ts, plus
        // `validate_trader_settlement_confirmation()`), so the Trader could never
        // be paid. §27 above never closed its Order, which is how this survived.
        //
        // The close is applied here with SQL rather than through OperationsService
        // (not wired into this harness). The close GATE is covered by
        // order-close-eligibility.test.ts; what is under test here is what the
        // REVERSAL does to an Order that is already closed.
        const closedOrder = await createOrder(companyA, { netPayable: 461 });
        const closedTarget = await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 461, orderId: closedOrder.id }]),
          randomUUID(),
          `key-closed-target-${randomUUID()}`,
        );
        expect((await statusOf(closedOrder.id)).status).toBe("money_sent_to_trader");
        await sql`
          update orders set delivery_status = 'closed', closed_at = now()
           where id = ${closedOrder.id}::uuid and company_id = ${companyA.companyId}::uuid
        `.execute(transaction);
        await sql`
          insert into order_status_history (
            company_id, order_id, status_dimension, from_status, to_status,
            reason, changed_by_account_id
          ) values (${companyA.companyId}::uuid, ${closedOrder.id}::uuid, 'delivery',
                    'delivered', 'closed', 'closed after settlement',
                    ${companyA.accountId}::uuid)
        `.execute(transaction);

        const closedReversal = await service.reverse(
          closedTarget.settlementId,
          "بالحطاء",
          randomUUID(),
        );
        expect(closedReversal.orderCount).toBe(1);

        const unclosed = await sql<{
          closedAt: string | null;
          deliveryStatus: string;
          deliveredAt: string | null;
          driverReconciliationStatus: string;
          returnStatus: string;
        }>`
          select delivery_status as "deliveryStatus", closed_at::text as "closedAt",
                 delivered_at::text as "deliveredAt", return_status as "returnStatus",
                 driver_reconciliation_status as "driverReconciliationStatus"
            from orders where id = ${closedOrder.id}::uuid
        `.execute(transaction);
        // The Order is back where it came from, and `closed_at` no longer claims a
        // close that has been undone.
        expect(unclosed.rows[0]?.deliveryStatus).toBe("delivered");
        expect(unclosed.rows[0]?.closedAt).toBeNull();
        // Everything the close PRESERVED stays preserved: the unclose reverses the
        // one field the close changed, unlike reopenDeliveredOrder which undoes the
        // delivery itself.
        expect(unclosed.rows[0]?.deliveredAt).not.toBeNull();
        expect(unclosed.rows[0]?.returnStatus).toBe("not_applicable");
        expect(unclosed.rows[0]?.driverReconciliationStatus).toBe("reconciled");
        // The settlement fields were restored as before.
        expect((await statusOf(closedOrder.id)).status).toBe("unsettled");
        expect((await statusOf(closedOrder.id)).paid).toBe("0.00");
        expect((await statusOf(closedOrder.id)).outstanding).toBe("461.00");

        // THE POINT: the Trader can be paid again. This is the assertion the
        // original defect would have failed -- every other field looked right.
        const unclosedEligible = await service.eligibleOrders({
          page: 1,
          pageSize: 100,
          traderId: companyA.traderId,
        });
        expect(unclosedEligible.items.some((row) => row.id === closedOrder.id)).toBe(true);
        const resettled = await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 461, orderId: closedOrder.id }]),
          randomUUID(),
          `key-closed-resettle-${randomUUID()}`,
        );
        expect(resettled.settlementId).not.toBe(closedTarget.settlementId);
        expect((await statusOf(closedOrder.id)).status).toBe("money_sent_to_trader");

        // The unclose is recorded on the delivery dimension. The 31 real Orders
        // left `closed` with no transition anywhere, which is most of why the case
        // took so long to find.
        const uncloseHistory = await sql<{ fromStatus: string; reason: string | null }>`
          select from_status as "fromStatus", reason from order_status_history
           where order_id = ${closedOrder.id}::uuid and status_dimension = 'delivery'
             and from_status = 'closed' and to_status = 'delivered'
        `.execute(transaction);
        expect(uncloseHistory.rows).toHaveLength(1);
        expect(uncloseHistory.rows[0]?.reason).toBe("بالحطاء");
        const uncloseEvent = await sql<{ count: string }>`
          select count(*)::text as count from order_events
           where order_id = ${closedOrder.id}::uuid and event_type = 'order.delivery_unclosed'
        `.execute(transaction);
        expect(uncloseEvent.rows[0]?.count).toBe("1");

        // A closed Order the Company owes the Trader NOTHING on stays closed: the
        // close gate's `trader_net_payable <= 0` clause still holds, so the
        // reversal invalidated nothing. Forcing it open would assert a payable that
        // does not exist and push it into payable-settlement eligibility, which
        // filters `not in ('not_eligible','reversed')`.
        const feeOnlyOrder = await createOrder(companyA, {
          netPayable: 0,
          settlementStatus: "not_eligible",
        });
        await sql`
          update orders set delivery_status = 'closed', closed_at = now()
           where id = ${feeOnlyOrder.id}::uuid and company_id = ${companyA.companyId}::uuid
        `.execute(transaction);
        const feeOnlySettlement = await sql<{ id: string }>`
          insert into trader_settlements (
            company_id, settlement_number, trader_id, business_date,
            gross_payable, net_payable, status, created_by_account_id,
            confirmed_by_account_id, confirmed_at
          ) values (${companyA.companyId}::uuid, ${`SET-FEEONLY-${randomUUID().slice(0, 6)}`},
                    ${companyA.traderId}::uuid, current_date, 0, 0, 'confirmed',
                    ${companyA.accountId}::uuid, ${companyA.accountId}::uuid, now())
          returning id
        `.execute(transaction);
        const feeOnlySettlementId = feeOnlySettlement.rows[0]!.id;
        await sql`
          insert into trader_settlement_orders (company_id, settlement_id, order_id, allocated_amount)
          values (${companyA.companyId}::uuid, ${feeOnlySettlementId}::uuid,
                  ${feeOnlyOrder.id}::uuid, 0)
        `.execute(transaction);
        await service.reverse(feeOnlySettlementId, "nothing was owed", randomUUID());
        const feeOnlyAfter = await sql<{ closedAt: string | null; deliveryStatus: string }>`
          select delivery_status as "deliveryStatus", closed_at::text as "closedAt"
            from orders where id = ${feeOnlyOrder.id}::uuid
        `.execute(transaction);
        expect(feeOnlyAfter.rows[0]?.deliveryStatus).toBe("closed");
        expect(feeOnlyAfter.rows[0]?.closedAt).not.toBeNull();

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  }, 120_000);
});
