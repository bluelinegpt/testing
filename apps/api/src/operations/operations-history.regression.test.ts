import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { Test } from "@nestjs/testing";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import {
  KyselyTransactionManager,
  type TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { type IdentityContext, IdentityContextAccessor } from "../security/identity-context.js";
import { type TenantContext, TenantContextAccessor } from "../tenancy/tenant-context.js";

import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { OrdersWorkflowService } from "./orders-workflow.service.js";

const runDatabaseTests = process.env.RUN_HISTORY_DATABASE === "true";
const rollbackMarker = Symbol("rollback history regression test");

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `history_${++this.sequence}`;
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
  public async run<T>(_context: TenantContext, operation: () => Promise<T>): Promise<T> {
    return operation();
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

describe.skipIf(!runDatabaseTests)("OperationsHistoryWriter consumers", () => {
  it("preserves history, actor, source, correlation and tenant scope after extraction", async () => {
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
          permissions: new Set(["orders.assign_driver", "orders.update_delivery_status"]),
          sessionId: randomUUID(),
        });
        const history = new OperationsHistoryWriter();
        const workflow = new OrdersWorkflowService(
          transaction as unknown as Kysely<DatabaseSchema>,
          manager as unknown as KyselyTransactionManager,
          tenants as unknown as TenantContextAccessor,
          identities as unknown as IdentityContextAccessor,
          history,
        );

        const makeCompany = async (label: string) => {
          const companyId = randomUUID();
          const accountId = randomUUID();
          const roleId = randomUUID();
          const driverAccountId = randomUUID();
          const driverId = randomUUID();
          const traderAccountId = randomUUID();
          const traderId = randomUUID();
          const areaId = randomUUID();
          const suffix = companyId.slice(0, 8);
          await sql`
            insert into companies (id, code, subdomain, name_en, status, activated_at)
            values (${companyId}::uuid, ${`HIS-${label}-${suffix}`},
                    ${`his-${label.toLowerCase()}-${suffix}`}, 'History Co', 'active', now())
          `.execute(transaction);
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash) values
              (${accountId}::uuid, ${companyId}::uuid, 'company_user', ${`his.actor.${suffix}`}, 'x'),
              (${driverAccountId}::uuid, ${companyId}::uuid, 'driver', ${`his.driver.${suffix}`}, 'x'),
              (${traderAccountId}::uuid, ${companyId}::uuid, 'trader', ${`his.trader.${suffix}`}, 'x')
          `.execute(transaction);
          await sql`
            insert into roles (id, company_id, code, name, is_system)
            values (${roleId}::uuid, ${companyId}::uuid, 'company_admin', 'Operations Supervisor', true)
          `.execute(transaction);
          await sql`
            insert into role_permissions (role_id, permission_code)
            values (${roleId}::uuid, 'users_roles.manage')
          `.execute(transaction);
          await sql`
            insert into account_roles (account_id, role_id, company_id)
            values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
          `.execute(transaction);
          await sql`
            insert into drivers (
              id, company_id, account_id, code, driver_type, name_en, mobile_number,
              outsourced_fee_per_delivered_order, account_status
            ) values (${driverId}::uuid, ${companyId}::uuid, ${driverAccountId}::uuid,
                      ${`DRV-${suffix}`}, 'outsourced', 'History Driver', '971500000001', 0, 'active')
          `.execute(transaction);
          await sql`
            insert into traders (
              id, company_id, account_id, code, name_en, mobile_number, account_status
            ) values (${traderId}::uuid, ${companyId}::uuid, ${traderAccountId}::uuid,
                      ${`T-${suffix}`}, 'History Trader', '971500000003', 'active')
          `.execute(transaction);
          await sql`
            insert into areas (id, company_id, emirate_id, code, name_en)
            values (${areaId}::uuid, ${companyId}::uuid, (select id from emirates where code='DXB'), ${`A-${suffix}`}, ${`Area ${suffix}`})
          `.execute(transaction);
          return { accountId, areaId, companyId, driverId, traderId };
        };

        const companyA = await makeCompany("A");
        const companyB = await makeCompany("B");

        const use = (company: { accountId: string; companyId: string }) => {
          tenants.set({ companyId: company.companyId, identityId: company.accountId });
          identities.set({
            companyId: company.companyId,
            forcePasswordChange: false,
            identityId: company.accountId,
            kind: "company_user",
            permissions: new Set(["orders.assign_driver", "orders.update_delivery_status"]),
            sessionId: randomUUID(),
          });
        };

        const makeOrder = async (
          company: { accountId: string; areaId: string; companyId: string; traderId: string },
          options: {
            readonly amountCollected?: number;
            readonly deliveryStatus?: string;
            readonly driverId?: string;
            readonly reconciliationStatus?: string;
            readonly settlementStatus?: string;
          } = {},
        ): Promise<string> => {
          const orderId = randomUUID();
          const suffix = orderId.slice(0, 8);
          await sql`
            insert into orders (
              id, company_id, order_number, order_date, trader_id, area_id,
              created_by_account_id, assigned_driver_id, customer_name,
              customer_mobile_number, customer_address, package_count, payment_condition,
              amount_collected, customer_amount_due, driver_cost,
              trader_gross_payable, trader_paid_service_fee, trader_deductions,
              trader_charges, trader_adjustments, trader_net_payable,
              delivery_status, driver_reconciliation_status, trader_settlement_status,
              pricing_provenance_status, final_service_fee_snapshot, customer_provenance_status
            ) values (
              ${orderId}::uuid, ${company.companyId}::uuid, ${`HIS-${suffix}`}, current_date,
              ${company.traderId}::uuid, ${company.areaId}::uuid, ${company.accountId}::uuid,
              ${options.driverId ?? null}::uuid,
              'Customer', '971500000004', 'Address', 1, 'customer_pays_cod_and_fee',
              ${options.amountCollected ?? 0}, 100, 0, 100, 0, 0, 0, 0, 100,
              ${options.deliveryStatus ?? "new"},
              ${options.reconciliationStatus ?? "not_applicable"},
              ${options.settlementStatus ?? "not_eligible"},
              'legacy_unattributed', 0, 'legacy_unattributed'
            )
          `.execute(transaction);
          return orderId;
        };

        use(companyA);

        // --- Bulk Assign Driver -------------------------------------------
        const eligible = await makeOrder(companyA);
        const alreadyAssigned = await makeOrder(companyA, {
          deliveryStatus: "assigned_to_driver",
          driverId: companyA.driverId,
        });
        const correlationId = `corr-${randomUUID()}`;
        const assignResult = await workflow.bulkAssignDriver(
          {
            driverIdToAssign: companyA.driverId,
            excludedOrderIds: [],
            orderIds: [eligible, alreadyAssigned],
            selectionMode: "ids",
          },
          correlationId,
        );
        // Only the eligible New unassigned Order is processed.
        expect(assignResult.processedCount).toBe(1);

        const assignEvents = await sql<{
          actorRole: string;
          correlationId: string;
          eventType: string;
          source: string;
        }>`
          select event_type as "eventType", actor_role as "actorRole", source,
                 correlation_id as "correlationId"
            from order_events where order_id = ${eligible}::uuid
        `.execute(transaction);
        expect(assignEvents.rows).toHaveLength(1);
        // Actor role is resolved from the Company's Roles, not hard-coded.
        expect(assignEvents.rows[0]?.actorRole).toBe("Operations Supervisor");
        expect(assignEvents.rows[0]?.source).toBe("web_portal");
        expect(assignEvents.rows[0]?.correlationId).toBe(correlationId);
        expect(assignEvents.rows[0]?.eventType).toBe("order.driver_assigned");

        const assignHistory = await sql<{ from: string; to: string }>`
          select from_status as "from", to_status as "to" from order_status_history
           where order_id = ${eligible}::uuid and status_dimension = 'delivery'
        `.execute(transaction);
        expect(assignHistory.rows).toHaveLength(1);
        expect(assignHistory.rows[0]).toEqual({ from: "new", to: "assigned_to_driver" });

        // The skipped Order gained no history.
        const skipped = await sql<{ value: number }>`
          select count(*)::int as value from order_events where order_id = ${alreadyAssigned}::uuid
        `.execute(transaction);
        expect(skipped.rows[0]?.value).toBe(0);

        // The audit event shares the same correlation ID.
        const assignAudit = await sql<{ correlationId: string; action: string }>`
          select action, correlation_id as "correlationId" from audit_events
           where company_id = ${companyA.companyId}::uuid and action = 'orders.bulk_assign_driver'
        `.execute(transaction);
        expect(assignAudit.rows).toHaveLength(1);
        expect(assignAudit.rows[0]?.correlationId).toBe(correlationId);

        // No reconciliation event was produced by an assignment.
        const strayCash = await sql<{ value: number }>`
          select count(*)::int as value from order_events
           where order_id = ${eligible}::uuid and event_type like 'driver_cash%'
        `.execute(transaction);
        expect(strayCash.rows[0]?.value).toBe(0);

        // --- Bulk Delivery Status change -----------------------------------
        const cancellable = await makeOrder(companyA);
        const notCancellable = await makeOrder(companyA, { deliveryStatus: "delivered" });
        const statusCorrelation = `corr-${randomUUID()}`;

        // A cancellation without a reason is rejected outright.
        await expect(
          workflow.bulkChangeStatus(
            {
              excludedOrderIds: [],
              orderIds: [cancellable],
              selectionMode: "ids",
              targetStatus: "cancelled",
            },
            statusCorrelation,
          ),
        ).rejects.toMatchObject({ errorCode: "cancellation_reason_required" });

        // A mixed selection without allowPartial is rejected as a whole.
        await expect(
          workflow.bulkChangeStatus(
            {
              excludedOrderIds: [],
              orderIds: [cancellable, notCancellable],
              reason: "Customer cancelled",
              selectionMode: "ids",
              targetStatus: "cancelled",
            },
            statusCorrelation,
          ),
        ).rejects.toMatchObject({ errorCode: "bulk_status_ineligible" });
        expect(
          (
            await sql<{ value: number }>`
              select count(*)::int as value from order_status_history
               where order_id = ${cancellable}::uuid
            `.execute(transaction)
          ).rows[0]?.value,
        ).toBe(0);

        const statusResult = await workflow.bulkChangeStatus(
          {
            allowPartial: true,
            excludedOrderIds: [],
            orderIds: [cancellable, notCancellable],
            reason: "Customer cancelled",
            selectionMode: "ids",
            targetStatus: "cancelled",
          },
          statusCorrelation,
        );
        expect(statusResult.processedCount).toBe(1);

        const statusHistory = await sql<{ from: string; reason: string; to: string }>`
          select from_status as "from", to_status as "to", reason from order_status_history
           where order_id = ${cancellable}::uuid and status_dimension = 'delivery'
        `.execute(transaction);
        expect(statusHistory.rows).toHaveLength(1);
        expect(statusHistory.rows[0]?.to).toBe("cancelled");
        expect(statusHistory.rows[0]?.reason).toBe("Customer cancelled");

        const statusEvents = await sql<{
          actorRole: string;
          correlationId: string;
          source: string;
        }>`
          select actor_role as "actorRole", source, correlation_id as "correlationId"
            from order_events where order_id = ${cancellable}::uuid
        `.execute(transaction);
        expect(statusEvents.rows[0]?.actorRole).toBe("Operations Supervisor");
        expect(statusEvents.rows[0]?.source).toBe("web_portal");
        expect(statusEvents.rows[0]?.correlationId).toBe(statusCorrelation);
        // The ineligible Order was untouched.
        expect(
          (
            await sql<{ value: number }>`
              select count(*)::int as value from order_status_history
               where order_id = ${notCancellable}::uuid
            `.execute(transaction)
          ).rows[0]?.value,
        ).toBe(0);

        // --- Hold lifecycle -------------------------------------------------
        const heldOrder = await makeOrder(companyA);
        await expect(
          workflow.bulkChangeStatus(
            {
              orderIds: [heldOrder],
              selectionMode: "ids",
              targetStatus: "hold",
            },
            randomUUID(),
          ),
        ).rejects.toMatchObject({ errorCode: "hold_reason_required" });
        await workflow.bulkChangeStatus(
          {
            orderIds: [heldOrder],
            reason: "Customer requested a later delivery",
            selectionMode: "ids",
            targetStatus: "hold",
          },
          randomUUID(),
        );
        await expect(
          workflow.bulkChangeStatus(
            {
              orderIds: [heldOrder],
              selectionMode: "ids",
              targetStatus: "out_for_delivery",
            },
            randomUUID(),
          ),
        ).rejects.toMatchObject({ errorCode: "bulk_status_ineligible" });

        const heldAssignment = await workflow.bulkAssignDriver(
          {
            driverIdToAssign: companyA.driverId,
            orderIds: [heldOrder],
            selectionMode: "ids",
          },
          randomUUID(),
        );
        expect(heldAssignment.processedCount).toBe(1);
        expect(
          (
            await sql<{ driverId: string | null; status: string }>`
              select assigned_driver_id as "driverId", delivery_status as status
              from orders where id = ${heldOrder}::uuid
            `.execute(transaction)
          ).rows[0],
        ).toEqual({ driverId: companyA.driverId, status: "hold" });

        const dispatchedFromHold = await workflow.bulkChangeStatus(
          {
            orderIds: [heldOrder],
            selectionMode: "ids",
            targetStatus: "out_for_delivery",
          },
          randomUUID(),
        );
        expect(dispatchedFromHold.processedCount).toBe(1);
        expect(
          (
            await sql<{ status: string }>`
              select delivery_status as status from orders where id = ${heldOrder}::uuid
            `.execute(transaction)
          ).rows[0]?.status,
        ).toBe("out_for_delivery");

        const returnedOrder = await makeOrder(companyA);
        await workflow.bulkChangeStatus(
          {
            orderIds: [returnedOrder],
            reason: "Awaiting trader return",
            selectionMode: "ids",
            targetStatus: "hold",
          },
          randomUUID(),
        );
        await workflow.bulkChangeStatus(
          {
            orderIds: [returnedOrder],
            reason: "Trader accepted the return",
            selectionMode: "ids",
            targetStatus: "returned_to_trader",
          },
          randomUUID(),
        );
        expect(
          (
            await sql<{ returnStatus: string; status: string }>`
              select delivery_status as status, return_status as "returnStatus"
              from orders where id = ${returnedOrder}::uuid
            `.execute(transaction)
          ).rows[0],
        ).toEqual({ returnStatus: "returned_to_trader", status: "returned_to_trader" });

        // Money sent to the Trader is the final financial step required before an
        // operator closes the Order; a separate receipt-confirmation state is optional.
        const paidOrder = await makeOrder(companyA, {
          amountCollected: 100,
          deliveryStatus: "delivered",
          driverId: companyA.driverId,
          reconciliationStatus: "reconciled",
          settlementStatus: "money_sent_to_trader",
        });
        const closedAfterPayment = await workflow.bulkChangeStatus(
          {
            orderIds: [paidOrder],
            selectionMode: "ids",
            targetStatus: "closed",
          },
          randomUUID(),
        );
        expect(closedAfterPayment.processedCount).toBe(1);

        // --- Company isolation ---------------------------------------------
        const companyBOrder = await makeOrder(companyB);
        use(companyA);
        const crossResult = await workflow.bulkAssignDriver(
          {
            driverIdToAssign: companyA.driverId,
            excludedOrderIds: [],
            orderIds: [companyBOrder],
            selectionMode: "ids",
          },
          randomUUID(),
        );
        expect(crossResult.processedCount).toBe(0);
        expect(
          (
            await sql<{ value: number }>`
              select count(*)::int as value from order_events
               where order_id = ${companyBOrder}::uuid
            `.execute(transaction)
          ).rows[0]?.value,
        ).toBe(0);

        // Assigning a Driver from another Company is refused.
        use(companyB);
        await expect(
          workflow.bulkAssignDriver(
            {
              driverIdToAssign: companyA.driverId,
              excludedOrderIds: [],
              orderIds: [companyBOrder],
              selectionMode: "ids",
            },
            randomUUID(),
          ),
        ).rejects.toMatchObject({ errorCode: "driver_not_found" });

        // --- Reference generation -------------------------------------------
        use(companyA);
        const references = await Promise.all(
          Array.from({ length: 5 }, () =>
            history.nextReferenceNumber(transaction, companyA.companyId, "reconciliation", "REC"),
          ),
        );
        expect(new Set(references).size).toBe(5);
        const otherCompanyReference = await history.nextReferenceNumber(
          transaction,
          companyB.companyId,
          "reconciliation",
          "REC",
        );
        // Counters are Company-scoped, so Company B restarts at 1.
        expect(otherCompanyReference).toBe("REC-000001");

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  }, 120_000);

  it("resolves the operations providers without circular or duplicate instances", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const context = { companyId: "", identityId: "" };
    const identity = {
      companyId: null,
      forcePasswordChange: false,
      identityId: "",
      kind: "company_user" as const,
      permissions: new Set<string>(),
      sessionId: "",
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: DATABASE, useValue: database },
        {
          provide: TenantContextAccessor,
          useValue: { current: () => context, run: async (_c: unknown, op: () => unknown) => op() },
        },
        { provide: IdentityContextAccessor, useValue: { current: () => identity } },
        KyselyTransactionManager,
        OperationsHistoryWriter,
        OrdersWorkflowService,
        DriverCashReconciliationService,
      ],
    }).compile();

    try {
      const writer = moduleRef.get(OperationsHistoryWriter);
      const workflow = moduleRef.get(OrdersWorkflowService);
      const reconciliation = moduleRef.get(DriverCashReconciliationService);
      expect(writer).toBeInstanceOf(OperationsHistoryWriter);
      expect(workflow).toBeInstanceOf(OrdersWorkflowService);
      expect(reconciliation).toBeInstanceOf(DriverCashReconciliationService);
      // A single shared writer instance, not one per consumer.
      expect(moduleRef.get(OperationsHistoryWriter)).toBe(writer);
      expect((workflow as unknown as { history: OperationsHistoryWriter }).history).toBe(writer);
      expect((reconciliation as unknown as { history: OperationsHistoryWriter }).history).toBe(
        writer,
      );
    } finally {
      await moduleRef.close();
      await database.destroy();
    }
  }, 60_000);
});
