import { randomUUID } from "node:crypto";
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

import { OperationsHistoryWriter } from "./operations-history.writer.js";
import type { CreateTraderSettlementDto } from "./operations.dto.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

const runDatabaseTests = process.env.RUN_SETTLEMENT_DATABASE === "true";
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

describe.skipIf(!runDatabaseTests)("trader settlement", () => {
  it("enforces eligibility, allocation, payment, Money Received, reversal, idempotency and reporting", async () => {
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
          identities as unknown as IdentityContextAccessor,
          new OperationsHistoryWriter(),
          companyProfile,
        );

        const createCompany = async (label: string): Promise<CompanyFixture> => {
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
            insert into company_bank_accounts (id, company_id, bank_name, account_name, iban) values
              (${companyBankAccountId}::uuid, ${companyId}::uuid, 'Settlement Bank', 'Main Account',
               ${`AE${suffix}COMPANY0001`})
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
        const companyB = await createCompany("B");

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
              id, company_id, order_number, order_date, trader_id, area_id,
              created_by_account_id, customer_name, customer_mobile_number, customer_address,
              package_count, payment_condition, final_service_fee_snapshot,
              customer_provenance_status, pricing_provenance_status,
              trader_gross_payable, trader_paid_service_fee, trader_net_payable, trader_paid_amount,
              delivery_status, driver_reconciliation_status, trader_settlement_status, return_status,
              delivered_at
            ) values (
              ${orderId}::uuid, ${company.companyId}::uuid, ${number}, current_date,
              ${traderId}::uuid, ${areaId}::uuid, ${company.accountId}::uuid,
              'Settlement Customer', '971509999998', 'Settlement address', 1,
              'customer_pays_cod_and_fee', 0, 'legacy_unattributed', 'legacy_unattributed',
              ${net}, 0, ${net}, ${paid},
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

        useCompany(companyA);

        // --- §23 Eligibility --------------------------------------------------
        const eligibleOrder = await createOrder(companyA, { netPayable: 100 });
        const eligible = await service.eligibleOrders({
          page: 1,
          pageSize: 25,
          traderId: companyA.traderId,
        });
        expect(eligible.items.some((row) => row.id === eligibleOrder.id)).toBe(true);
        expect(eligible.items.find((row) => row.id === eligibleOrder.id)?.outstandingBalance).toBe(
          "100.00",
        );

        const cancelledOrder = await createOrder(companyA, {
          deliveryStatus: "cancelled",
          netPayable: 50,
        });
        await expectRejection(
          () =>
            service.createPayment(
              basePayment(companyA.traderId, [{ amount: 50, orderId: cancelledOrder.id }]),
              randomUUID(),
              `key-cancelled-${randomUUID()}`,
            ),
          "settlement_order_ineligible",
        );

        const wrongTraderOrder = await createOrder(companyA, {
          netPayable: 40,
          traderId: companyA.traderId,
        });
        const otherTrader = randomUUID();
        await sql`
          insert into accounts (id, company_id, account_kind, username, password_hash)
          values (${randomUUID()}::uuid, ${companyA.companyId}::uuid, 'trader',
                  ${`other.trader.${otherTrader.slice(0, 8)}`}, 'test-only')
        `.execute(transaction);
        // Attempting to pay this Order under a DIFFERENT (non-existent) Trader ID
        // must be rejected as a Trader mismatch, not silently accepted.
        await expectRejection(
          () =>
            service.createPayment(
              basePayment(otherTrader, [{ amount: 40, orderId: wrongTraderOrder.id }]),
              randomUUID(),
              `key-wrongtrader-${randomUUID()}`,
            ),
          "settlement_trader_mismatch",
        );

        const companyBOrder = await createOrder(companyB, { netPayable: 60 });
        useCompany(companyB);
        // Sanity: Company B's own order is eligible under Company B's tenant context.
        const companyBEligible = await service.eligibleOrders({
          page: 1,
          pageSize: 25,
          traderId: companyB.traderId,
        });
        expect(companyBEligible.items.some((row) => row.id === companyBOrder.id)).toBe(true);
        useCompany(companyA);
        // Company A cannot pay against Company B's order at all: it simply will
        // not resolve under Company A's lock query, producing the generic
        // "allocate to at least one order" rejection rather than ever touching it.
        await expectRejection(
          () =>
            service.createPayment(
              basePayment(companyA.traderId, [{ amount: 60, orderId: companyBOrder.id }]),
              randomUUID(),
              `key-crosscompany-${randomUUID()}`,
            ),
          "settlement_allocation_empty",
        );

        const zeroOutstandingOrder = await createOrder(companyA, {
          netPayable: 30,
          settlementStatus: "money_sent_to_trader",
          traderPaidAmount: 30,
        });
        await expectRejection(
          () =>
            service.createPayment(
              basePayment(companyA.traderId, [{ amount: 1, orderId: zeroOutstandingOrder.id }]),
              randomUUID(),
              `key-zerooutstanding-${randomUUID()}`,
            ),
          "settlement_order_ineligible",
        );

        // --- §24 Allocation: oldest-first, partial, manual, validation --------
        const orderOld = await createOrder(companyA, {
          deliveredAt: "2026-01-01T08:00:00Z",
          netPayable: 100,
        });
        const orderMid = await createOrder(companyA, {
          deliveredAt: "2026-01-02T08:00:00Z",
          netPayable: 75,
        });
        const orderNew = await createOrder(companyA, {
          deliveredAt: "2026-01-03T08:00:00Z",
          netPayable: 50,
        });
        const proposal = await service.proposeAllocation({
          amount: 160,
          traderId: companyA.traderId,
        });
        const proposedFor = (orderId: string) =>
          proposal.allocations.find((line) => line.orderId === orderId);
        // Matches the worked example in §6 exactly: A fully, B partially, C untouched.
        expect(proposedFor(orderOld.id)?.allocatedAmount).toBe("100.00");
        expect(proposedFor(orderMid.id)?.allocatedAmount).toBe("60.00");
        expect(proposedFor(orderNew.id)).toBeUndefined();
        expect(proposal.unallocatedAmount).toBe("0.00");
        // Stable tie-break: two Orders delivered at the exact same instant still
        // resolve in the same order every time (by Serial/Order Number). Dated
        // earlier than every other eligible Order in this scenario so a small
        // request unambiguously reaches this tied pair first.
        const tieA = await createOrder(companyA, {
          deliveredAt: "2020-01-01T08:00:00Z",
          netPayable: 10,
        });
        const tieB = await createOrder(companyA, {
          deliveredAt: "2020-01-01T08:00:00Z",
          netPayable: 10,
        });
        const tieProposal = await service.proposeAllocation({
          amount: 10,
          traderId: companyA.traderId,
        });
        const tieWinner = tieProposal.allocations.find(
          (line) => line.orderId === tieA.id || line.orderId === tieB.id,
        );
        expect(tieWinner?.orderId).toBe(
          [tieA, tieB].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber))[0]?.id,
        );

        // Oldest-first FULL allocation actually pays the proposed Orders.
        const oldestFirstResult = await service.createPayment(
          basePayment(companyA.traderId, [
            { amount: 100, orderId: orderOld.id },
            { amount: 60, orderId: orderMid.id },
          ]),
          randomUUID(),
          `key-oldestfirst-${randomUUID()}`,
        );
        expect(oldestFirstResult.amount).toBe("160.00");
        expect(oldestFirstResult.orderCount).toBe(2);
        expect((await statusOf(orderOld.id)).status).toBe("money_sent_to_trader");
        expect((await statusOf(orderOld.id)).outstanding).toBe("0.00");
        expect((await statusOf(orderMid.id)).status).toBe("partially_settled");
        expect((await statusOf(orderMid.id)).outstanding).toBe("15.00");

        // Manual adjustment: pay orderNew a smaller, hand-picked amount instead
        // of following the proposal.
        const manualResult = await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 20, orderId: orderNew.id }]),
          randomUUID(),
          `key-manual-${randomUUID()}`,
        );
        expect(manualResult.amount).toBe("20.00");
        expect((await statusOf(orderNew.id)).status).toBe("partially_settled");
        expect((await statusOf(orderNew.id)).outstanding).toBe("30.00");

        // Allocation exceeding outstanding is rejected.
        await expectRejection(
          () =>
            service.createPayment(
              basePayment(companyA.traderId, [{ amount: 999, orderId: orderNew.id }]),
              randomUUID(),
              `key-exceeds-${randomUUID()}`,
            ),
          "settlement_allocation_exceeds_outstanding",
        );
        // Duplicate Order rows in one allocation are rejected before any lock.
        await expectRejection(
          () =>
            service.createPayment(
              {
                allocations: [
                  { amount: 5, orderId: orderNew.id },
                  { amount: 5, orderId: orderNew.id },
                ],
                amount: 10,
                paymentMethod: "cash",
                traderId: companyA.traderId,
              },
              randomUUID(),
              `key-dup-${randomUUID()}`,
            ),
          "settlement_allocation_duplicate_order",
        );
        // Allocation total not matching the declared payment amount is rejected.
        await expectRejection(
          () =>
            service.createPayment(
              {
                allocations: [{ amount: 5, orderId: orderNew.id }],
                amount: 10,
                paymentMethod: "cash",
                traderId: companyA.traderId,
              },
              randomUUID(),
              `key-mismatch-${randomUUID()}`,
            ),
          "settlement_allocation_mismatch",
        );
        // Every rejected attempt above left orderNew's balance untouched.
        expect((await statusOf(orderNew.id)).outstanding).toBe("30.00");

        // --- One Order across multiple payments; one payment across many Orders
        const finalOrderNewPayment = await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 30, orderId: orderNew.id }]),
          randomUUID(),
          `key-final-${randomUUID()}`,
        );
        expect(finalOrderNewPayment.amount).toBe("30.00");
        expect((await statusOf(orderNew.id)).status).toBe("money_sent_to_trader");
        expect((await statusOf(orderNew.id)).outstanding).toBe("0.00");
        const orderMidFinal = await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 15, orderId: orderMid.id }]),
          randomUUID(),
          `key-midfinal-${randomUUID()}`,
        );
        expect(orderMidFinal.amount).toBe("15.00");
        expect((await statusOf(orderMid.id)).status).toBe("money_sent_to_trader");

        // --- §25 Payment: bank accounts, references, overpayment, stale balance
        const bankOrder = await createOrder(companyA, { netPayable: 200 });
        await expectRejection(
          () =>
            service.createPayment(
              {
                allocations: [{ amount: 200, orderId: bankOrder.id }],
                amount: 200,
                bankAccountId: randomUUID(),
                bankReference: "REF-BANK-1",
                paymentMethod: "bank_transfer",
                traderBankAccountId: companyA.traderBankAccountId,
                traderId: companyA.traderId,
              },
              randomUUID(),
              `key-badcompanybank-${randomUUID()}`,
            ),
          "bank_account_not_found",
        );
        await sql`update company_bank_accounts set is_active = false where id = ${companyA.companyBankAccountId}::uuid`.execute(
          transaction,
        );
        await expectRejection(
          () =>
            service.createPayment(
              {
                allocations: [{ amount: 200, orderId: bankOrder.id }],
                amount: 200,
                bankAccountId: companyA.companyBankAccountId,
                bankReference: "REF-BANK-2",
                paymentMethod: "bank_transfer",
                traderBankAccountId: companyA.traderBankAccountId,
                traderId: companyA.traderId,
              },
              randomUUID(),
              `key-inactivesource-${randomUUID()}`,
            ),
          "bank_account_not_found",
        );
        await sql`update company_bank_accounts set is_active = true where id = ${companyA.companyBankAccountId}::uuid`.execute(
          transaction,
        );
        // A default beneficiary account cannot be inactive (`trader_bank_accounts_default_active`),
        // so clear the default flag in the same statement.
        await sql`update trader_bank_accounts set is_active = false, is_default = false where id = ${companyA.traderBankAccountId}::uuid`.execute(
          transaction,
        );
        await expectRejection(
          () =>
            service.createPayment(
              {
                allocations: [{ amount: 200, orderId: bankOrder.id }],
                amount: 200,
                bankAccountId: companyA.companyBankAccountId,
                bankReference: "REF-BANK-3",
                paymentMethod: "bank_transfer",
                traderBankAccountId: companyA.traderBankAccountId,
                traderId: companyA.traderId,
              },
              randomUUID(),
              `key-inactivebeneficiary-${randomUUID()}`,
            ),
          "trader_beneficiary_required",
        );
        await sql`update trader_bank_accounts set is_active = true where id = ${companyA.traderBankAccountId}::uuid`.execute(
          transaction,
        );
        // Cross-Company Bank Account (Company B's account used under Company A).
        await expectRejection(
          () =>
            service.createPayment(
              {
                allocations: [{ amount: 200, orderId: bankOrder.id }],
                amount: 200,
                bankAccountId: companyB.companyBankAccountId,
                bankReference: "REF-BANK-4",
                paymentMethod: "bank_transfer",
                traderBankAccountId: companyA.traderBankAccountId,
                traderId: companyA.traderId,
              },
              randomUUID(),
              `key-crossbank-${randomUUID()}`,
            ),
          "bank_account_not_found",
        );
        // Cross-Trader beneficiary (Company B's Trader bank account used for Company A's Trader).
        await expectRejection(
          () =>
            service.createPayment(
              {
                allocations: [{ amount: 200, orderId: bankOrder.id }],
                amount: 200,
                bankAccountId: companyA.companyBankAccountId,
                bankReference: "REF-BANK-5",
                paymentMethod: "bank_transfer",
                traderBankAccountId: companyB.traderBankAccountId,
                traderId: companyA.traderId,
              },
              randomUUID(),
              `key-crosstraderbank-${randomUUID()}`,
            ),
          "trader_beneficiary_required",
        );
        // A real, valid bank-transfer payment naming a specific (non-default) beneficiary.
        const bankResult = await service.createPayment(
          {
            allocations: [{ amount: 200, orderId: bankOrder.id }],
            amount: 200,
            bankAccountId: companyA.companyBankAccountId,
            bankReference: "REF-BANK-OK",
            paymentMethod: "bank_transfer",
            traderBankAccountId: companyA.traderBankAccountTwoId,
            traderId: companyA.traderId,
          },
          randomUUID(),
          `key-bankok-${randomUUID()}`,
        );
        expect(bankResult.paymentMethod).toBe("bank_transfer");
        // Duplicate (case-insensitive) Bank Reference is rejected by the new index.
        const dupRefOrder = await createOrder(companyA, { netPayable: 20 });
        await expect(
          service.createPayment(
            {
              allocations: [{ amount: 20, orderId: dupRefOrder.id }],
              amount: 20,
              bankAccountId: companyA.companyBankAccountId,
              bankReference: "ref-bank-ok",
              paymentMethod: "bank_transfer",
              traderBankAccountId: companyA.traderBankAccountId,
              traderId: companyA.traderId,
            },
            randomUUID(),
            `key-dupref-${randomUUID()}`,
          ),
        ).rejects.toMatchObject({ code: "23505" });
        expect((await statusOf(dupRefOrder.id)).status).toBe("unsettled");

        // Stale balance: lock a second, independent copy of the SAME order state
        // by paying it fully, then attempt to pay it again with a stale (already
        // fully-consumed) view — must be rejected as ineligible, not overpaid.
        const staleOrder = await createOrder(companyA, { netPayable: 45 });
        await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 45, orderId: staleOrder.id }]),
          randomUUID(),
          `key-stale-first-${randomUUID()}`,
        );
        await expectRejection(
          () =>
            service.createPayment(
              basePayment(companyA.traderId, [{ amount: 45, orderId: staleOrder.id }]),
              randomUUID(),
              `key-stale-second-${randomUUID()}`,
            ),
          "settlement_order_ineligible",
        );

        // Overpayment: allocate more than the Order's outstanding balance.
        const overpayOrder = await createOrder(companyA, { netPayable: 25 });
        await expectRejection(
          () =>
            service.createPayment(
              basePayment(companyA.traderId, [{ amount: 26, orderId: overpayOrder.id }]),
              randomUUID(),
              `key-overpay-${randomUUID()}`,
            ),
          "settlement_allocation_exceeds_outstanding",
        );

        // Historical snapshots are preserved: the Order's ORIGINAL trader_net_payable
        // never changes because of a partial payment.
        const snapshotOrder = await createOrder(companyA, { netPayable: 88 });
        await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 30, orderId: snapshotOrder.id }]),
          randomUUID(),
          `key-snapshot-${randomUUID()}`,
        );
        const snapshotRow = await sql<{ netPayable: string }>`
          select trader_net_payable::text as "netPayable" from orders where id = ${snapshotOrder.id}::uuid
        `.execute(transaction);
        expect(snapshotRow.rows[0]?.netPayable).toBe("88.00");

        // --- Double submission (idempotency) ----------------------------------
        const idempotentOrder = await createOrder(companyA, { netPayable: 70 });
        const replayKey = `key-replay-${randomUUID()}`;
        const replayInput = basePayment(companyA.traderId, [
          { amount: 70, orderId: idempotentOrder.id },
        ]);
        const first = await service.createPayment(replayInput, randomUUID(), replayKey);
        const replay = await service.createPayment(replayInput, randomUUID(), replayKey);
        expect(replay.settlementId).toBe(first.settlementId);
        const linkCount = await sql<{ total: number }>`
          select count(*)::int as total from trader_settlement_orders
           where order_id = ${idempotentOrder.id}::uuid
        `.execute(transaction);
        expect(linkCount.rows[0]?.total).toBe(1);
        await expectRejection(
          () =>
            service.createPayment(
              basePayment(companyA.traderId, [{ amount: 70, orderId: idempotentOrder.id }]),
              randomUUID(),
              "short",
            ),
          "idempotency_key_invalid",
        );

        // --- §26 Money Received ------------------------------------------------
        const receiptOrder = await createOrder(companyA, { netPayable: 55 });
        const receiptSettlement = await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 55, orderId: receiptOrder.id }]),
          randomUUID(),
          `key-receipt-base-${randomUUID()}`,
        );
        const receiptKey = `key-receipt-${randomUUID()}`;
        const receiptResult = await service.confirmMoneyReceived(
          receiptSettlement.settlementId,
          { notes: "Confirmed by phone", receivedDate: "2026-01-10", reference: "ACK-1" },
          randomUUID(),
          receiptKey,
        );
        expect(receiptResult.orderCount).toBe(1);
        expect((await statusOf(receiptOrder.id)).status).toBe("money_received_by_trader");
        // Amount/allocations unchanged by a receipt confirmation.
        expect((await statusOf(receiptOrder.id)).paid).toBe("55.00");
        // Duplicate confirmation rejected.
        await expectRejection(
          () =>
            service.confirmMoneyReceived(
              receiptSettlement.settlementId,
              {},
              randomUUID(),
              `key-receipt-dup-${randomUUID()}`,
            ),
          "trader_settlement_receipt_already_confirmed",
        );
        // Idempotent replay of the SAME key returns the same result rather than erroring.
        const receiptReplay = await service.confirmMoneyReceived(
          receiptSettlement.settlementId,
          { notes: "Confirmed by phone", receivedDate: "2026-01-10", reference: "ACK-1" },
          randomUUID(),
          receiptKey,
        );
        expect(receiptReplay.settlementId).toBe(receiptSettlement.settlementId);

        // Confirming receipt before Money Sent (a never-confirmed settlement) is
        // not directly reachable through the public API (creation always confirms
        // atomically), so this proves the guard defensively via a synthetic draft row.
        const draftSettlementNumber = `SET-DRAFT-${randomUUID().slice(0, 6)}`;
        const draftSettlement = await sql<{ id: string }>`
          insert into trader_settlements (
            company_id, settlement_number, trader_id, business_date,
            gross_payable, net_payable, status, created_by_account_id
          ) values (${companyA.companyId}::uuid, ${draftSettlementNumber}, ${companyA.traderId}::uuid,
                    current_date, 10, 10, 'draft', ${companyA.accountId}::uuid)
          returning id
        `.execute(transaction);
        await expectRejection(
          () =>
            service.confirmMoneyReceived(
              draftSettlement.rows[0]!.id,
              {},
              randomUUID(),
              `key-notsent-${randomUUID()}`,
            ),
          "trader_settlement_not_sent",
        );

        // --- §27 Reversal --------------------------------------------------------
        const reversalOrder = await createOrder(companyA, { netPayable: 65 });
        const reversalTarget = await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 65, orderId: reversalOrder.id }]),
          randomUUID(),
          `key-reversal-target-${randomUUID()}`,
        );
        expect((await statusOf(reversalOrder.id)).status).toBe("money_sent_to_trader");
        // Reason required.
        await expectRejection(
          () => service.reverse(reversalTarget.settlementId, "   ", randomUUID()),
          "settlement_reversal_reason_required",
        );
        const reversal = await service.reverse(
          reversalTarget.settlementId,
          "Incorrect trader selected",
          randomUUID(),
        );
        expect(reversal.orderCount).toBe(1);
        expect(reversal.reversalSettlementNumber).not.toBe(reversalTarget.settlementNumber);
        expect((await statusOf(reversalOrder.id)).status).toBe("unsettled");
        expect((await statusOf(reversalOrder.id)).paid).toBe("0.00");
        expect((await statusOf(reversalOrder.id)).outstanding).toBe("65.00");
        // Orders become eligible again.
        const reversedEligible = await service.eligibleOrders({
          page: 1,
          pageSize: 100,
          traderId: companyA.traderId,
        });
        expect(reversedEligible.items.some((row) => row.id === reversalOrder.id)).toBe(true);
        // Already reversed is rejected.
        await expectRejection(
          () => service.reverse(reversalTarget.settlementId, "second attempt", randomUUID()),
          "settlement_already_reversed",
        );
        // A reversal record itself cannot be reversed.
        await expectRejection(
          () => service.reverse(reversal.reversalSettlementId, "reverse the reversal", randomUUID()),
          "settlement_reversal_invalid",
        );
        // The original settlement, its lines and its payment are preserved untouched.
        const originalStillExists = await sql<{ netPayable: string; status: string }>`
          select status, net_payable::text as "netPayable" from trader_settlements
           where id = ${reversalTarget.settlementId}::uuid
        `.execute(transaction);
        expect(originalStillExists.rows[0]).toEqual({ netPayable: "65.00", status: "confirmed" });

        // Reversal is blocked once Money Received has been confirmed.
        const blockedOrder = await createOrder(companyA, { netPayable: 33 });
        const blockedSettlement = await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 33, orderId: blockedOrder.id }]),
          randomUUID(),
          `key-blocked-base-${randomUUID()}`,
        );
        await service.confirmMoneyReceived(
          blockedSettlement.settlementId,
          {},
          randomUUID(),
          `key-blocked-receipt-${randomUUID()}`,
        );
        await expectRejection(
          () => service.reverse(blockedSettlement.settlementId, "attempt after receipt", randomUUID()),
          "settlement_reversal_blocked_by_receipt",
        );

        // Partial-payment reversal restores partially_settled, not unsettled,
        // when a DIFFERENT settlement's allocation remains on the same Order.
        const multiPayOrder = await createOrder(companyA, { netPayable: 90 });
        await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 30, orderId: multiPayOrder.id }]),
          randomUUID(),
          `key-multi-first-${randomUUID()}`,
        );
        const multiPaySecond = await service.createPayment(
          basePayment(companyA.traderId, [{ amount: 30, orderId: multiPayOrder.id }]),
          randomUUID(),
          `key-multi-second-${randomUUID()}`,
        );
        expect((await statusOf(multiPayOrder.id)).paid).toBe("60.00");
        await service.reverse(multiPaySecond.settlementId, "reverse second payment only", randomUUID());
        expect((await statusOf(multiPayOrder.id)).status).toBe("partially_settled");
        expect((await statusOf(multiPayOrder.id)).paid).toBe("30.00");
        expect((await statusOf(multiPayOrder.id)).outstanding).toBe("60.00");

        // --- §28 Report data -----------------------------------------------------
        const report = await service.reportData(bankResult.settlementId);
        expect(report.header.settlementNumber).toBe(bankResult.settlementNumber);
        expect(report.header.traderName).toBe("Settlement Trader");
        expect(report.orders).toHaveLength(1);
        expect(report.orders[0]?.serialNumber).toBe(bankOrder.orderNumber);
        expect(report.orders[0]?.amountPaidNow).toBe("200.00");
        expect(report.header.beneficiaryBank?.accountNumberMasked).toBe("******3210");
        expect(report.header.beneficiaryBank?.ibanMasked).not.toContain("TRADER00002");
        // No internal database IDs anywhere in the report payload.
        expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
          JSON.stringify(report),
        )).toBe(false);
        // Regeneration returns stable values.
        const reportAgain = await service.reportData(bankResult.settlementId);
        expect(reportAgain).toEqual(report);
        // Money Received details surface when present.
        const receiptReport = await service.reportData(receiptSettlement.settlementId);
        expect(receiptReport.header.moneyReceivedReference).toBe("ACK-1");
        expect(receiptReport.header.moneyReceivedNotes).toBe("Confirmed by phone");

        // --- List / summary / detail ---------------------------------------------
        const list = await service.list({ page: 1, pageSize: 50, traderId: companyA.traderId });
        expect(list.items.some((row) => row.settlementId === bankResult.settlementId)).toBe(true);
        const reversedRow = list.items.find(
          (row) => row.settlementId === reversalTarget.settlementId,
        );
        expect(reversedRow?.status).toBe("reversed");
        const summary = await service.summary({ traderId: companyA.traderId });
        expect(Number(summary.moneySentAmount)).toBeGreaterThan(0);
        expect(Number(summary.moneyReceivedAmount)).toBeGreaterThan(0);
        const detail = await service.detail(bankResult.settlementId);
        expect(detail.settlementNumber).toBe(bankResult.settlementNumber);
        expect(detail.orders).toHaveLength(1);
        expect(detail.beneficiaryBank?.accountNumberMasked).toBe("******3210");

        // --- Company isolation ----------------------------------------------------
        useCompany(companyB);
        await expectRejection(() => service.detail(bankResult.settlementId), "settlement_not_found");
        await expectRejection(
          () => service.reportData(bankResult.settlementId),
          "settlement_not_found",
        );
        const companyBList = await service.list({ page: 1, pageSize: 50 });
        expect(companyBList.items.some((row) => row.settlementId === bankResult.settlementId)).toBe(
          false,
        );
        useCompany(companyA);

        // --- Permissions -----------------------------------------------------------
        identities.set({
          companyId: companyA.companyId,
          forcePasswordChange: false,
          identityId: companyA.accountId,
          kind: "company_user",
          permissions: new Set(),
          sessionId: randomUUID(),
        });
        await expectRejection(
          () => service.eligibleOrders({ page: 1, pageSize: 25, traderId: companyA.traderId }),
          "permission_denied",
        );
        await expectRejection(() => service.list({}), "permission_denied");
        await expectRejection(() => service.detail(bankResult.settlementId), "permission_denied");
        await expectRejection(
          () => service.reportData(bankResult.settlementId),
          "permission_denied",
        );
        await expectRejection(
          () => service.reverse(receiptSettlement.settlementId, "no permission", randomUUID()),
          "permission_denied",
        );
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

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  }, 120_000);
});
