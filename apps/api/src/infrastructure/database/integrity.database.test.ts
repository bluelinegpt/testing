import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../../configuration/environment.js";
import type { DatabaseSchema } from "./database.types.js";

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";
const rollbackMarker = Symbol("rollback integrity database test");

describe.skipIf(!runDatabaseTests)("database integrity protections", () => {
  it("protects operational history, assignments, and financial confirmation", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

    try {
      await database.transaction().execute(async (transaction) => {
        let savepointSequence = 0;
        const expectIntegrityFailure = async (work: () => Promise<unknown>): Promise<void> => {
          const savepoint = `integrity_${++savepointSequence}`;
          await sql.raw(`savepoint ${savepoint}`).execute(transaction);
          try {
            await expect(work()).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
          } finally {
            await sql.raw(`rollback to savepoint ${savepoint}`).execute(transaction);
            await sql.raw(`release savepoint ${savepoint}`).execute(transaction);
          }
        };

        const companyA = randomUUID();
        const companyB = randomUUID();
        const actorA = randomUUID();
        const actorB = randomUUID();
        const traderAccountA = randomUUID();
        const driverAccountA = randomUUID();
        const traderA = randomUUID();
        const driverA = randomUUID();
        const areaA = randomUUID();
        const roleA = randomUUID();
        const roleB = randomUUID();
        const suffix = companyA.slice(0, 8);

        await sql`
          insert into companies (id, code, subdomain, name_en, status, activated_at) values
            (${companyA}::uuid, ${`INT-A-${suffix}`}, ${`int-a-${suffix}`}, 'Integrity A', 'active', now()),
            (${companyB}::uuid, ${`INT-B-${suffix}`}, ${`int-b-${suffix}`}, 'Integrity B', 'active', now())
        `.execute(transaction);
        await sql`
          insert into accounts (id, company_id, account_kind, username, password_hash) values
            (${actorA}::uuid, ${companyA}::uuid, 'company_user', 'integrity.actor', 'test-only'),
            (${actorB}::uuid, ${companyB}::uuid, 'company_user', 'integrity.actor', 'test-only'),
            (${traderAccountA}::uuid, ${companyA}::uuid, 'trader', 'integrity.trader', 'test-only'),
            (${driverAccountA}::uuid, ${companyA}::uuid, 'driver', 'integrity.driver', 'test-only')
        `.execute(transaction);
        // Active company_user accounts must hold an active Role (validate_active_account_roles).
        await sql`
          insert into roles (id, company_id, code, name, is_system) values
            (${roleA}::uuid, ${companyA}::uuid, 'company_admin', 'Company Administrator', true),
            (${roleB}::uuid, ${companyB}::uuid, 'company_admin', 'Company Administrator', true)
        `.execute(transaction);
        await sql`
          insert into role_permissions (role_id, permission_code) values
            (${roleA}::uuid, 'users_roles.manage'),
            (${roleB}::uuid, 'users_roles.manage')
        `.execute(transaction);
        await sql`
          insert into account_roles (account_id, role_id, company_id) values
            (${actorA}::uuid, ${roleA}::uuid, ${companyA}::uuid),
            (${actorB}::uuid, ${roleB}::uuid, ${companyB}::uuid)
        `.execute(transaction);
        await sql`
          insert into areas (id, company_id, emirate_id, code, name_en)
          values (${areaA}::uuid, ${companyA}::uuid, (select id from emirates where code='DXB'), 'INT', 'Integrity Area')
        `.execute(transaction);
        await sql`
          insert into traders (id, company_id, account_id, code, name_en, mobile_number)
          values (${traderA}::uuid, ${companyA}::uuid, ${traderAccountA}::uuid, 'INT-T', 'Integrity Trader', '971501234567')
        `.execute(transaction);
        await sql`
          insert into drivers (
            id, company_id, account_id, code, name_en, mobile_number, driver_type,
            outsourced_fee_per_delivered_order
          ) values (
            ${driverA}::uuid, ${companyA}::uuid, ${driverAccountA}::uuid, 'INT-D',
            'Integrity Driver', '0500000001', 'outsourced', 0
          )
        `.execute(transaction);

        const createAssignedOrder = async (
          orderNumber: string,
          amounts: {
            collected: number;
            gross: number;
            fee: number;
            deductions?: number;
            charges?: number;
            adjustments?: number;
            net: number;
          },
        ): Promise<{ assignmentId: string; orderId: string }> => {
          const orderId = randomUUID();
          const assignmentId = randomUUID();
          await sql`
            insert into orders (
              id, company_id, order_number, order_date, trader_id, area_id,
              created_by_account_id, assigned_driver_id, customer_name,
              customer_mobile_number, customer_address, package_count, payment_condition,
              amount_collected, trader_gross_payable, trader_paid_service_fee,
              trader_deductions, trader_charges, trader_adjustments, trader_net_payable,
              delivery_status, driver_reconciliation_status, trader_settlement_status,
              delivered_at, pricing_provenance_status, final_service_fee_snapshot,
              customer_provenance_status
            ) values (
              ${orderId}::uuid, ${companyA}::uuid, ${orderNumber}, current_date,
              ${traderA}::uuid, ${areaA}::uuid, ${actorA}::uuid, ${driverA}::uuid,
              'Integrity Customer', '0500000002', 'Integrity Address', 1,
              'customer_pays_cod_and_fee', ${amounts.collected}, ${amounts.gross},
              ${amounts.fee}, ${amounts.deductions ?? 0}, ${amounts.charges ?? 0},
              ${amounts.adjustments ?? 0}, ${amounts.net}, 'assigned_to_driver', 'not_applicable',
              'not_eligible', null, 'legacy_unattributed', 0, 'legacy_unattributed'
            )
          `.execute(transaction);
          await sql`
            insert into order_assignments (
              id, company_id, order_id, driver_id, assigned_by_account_id
            ) values (
              ${assignmentId}::uuid, ${companyA}::uuid, ${orderId}::uuid,
              ${driverA}::uuid, ${actorA}::uuid
            )
          `.execute(transaction);
          await sql`
            update orders
            set delivery_status = 'delivered', driver_reconciliation_status = 'pending',
                trader_settlement_status = 'unsettled', delivered_at = now()
            where id = ${orderId}::uuid
          `.execute(transaction);
          return { assignmentId, orderId };
        };

        const operational = await createAssignedOrder("INT-OP", {
          collected: 10,
          fee: 1,
          gross: 9,
          net: 8,
        });
        const historyId = randomUUID();
        await sql`
          insert into order_status_history (
            id, company_id, order_id, status_dimension, from_status, to_status,
            changed_by_account_id
          ) values (
            ${historyId}::uuid, ${companyA}::uuid, ${operational.orderId}::uuid,
            'delivery', 'out_for_delivery', 'delivered', ${actorA}::uuid
          )
        `.execute(transaction);
        await expectIntegrityFailure(() =>
          sql`update order_status_history set reason = 'rewrite' where id = ${historyId}::uuid`.execute(
            transaction,
          ),
        );
        await expectIntegrityFailure(() =>
          sql`delete from order_status_history where id = ${historyId}::uuid`.execute(transaction),
        );
        const orderEventId = randomUUID();
        await sql`
          insert into order_events (
            id, company_id, order_id, event_type, event_category, new_value,
            actor_account_id, actor_role, source, correlation_id
          ) values (
            ${orderEventId}::uuid, ${companyA}::uuid, ${operational.orderId}::uuid,
            'order.test_event', 'system_action', to_jsonb('created'::text),
            ${actorA}::uuid, 'Integrity Test', 'system', 'integrity-test'
          )
        `.execute(transaction);
        await expectIntegrityFailure(() =>
          sql`update order_events set reason = 'rewrite' where id = ${orderEventId}::uuid`.execute(
            transaction,
          ),
        );
        await expectIntegrityFailure(() =>
          sql`delete from order_events where id = ${orderEventId}::uuid`.execute(transaction),
        );
        await expectIntegrityFailure(() =>
          sql`
            insert into order_status_history (
              company_id, order_id, status_dimension, to_status, changed_by_account_id
            ) values (
              ${companyA}::uuid, ${operational.orderId}::uuid, 'delivery',
              'reconciled', ${actorA}::uuid
            )
          `.execute(transaction),
        );
        await expectIntegrityFailure(() =>
          sql`delete from order_assignments where id = ${operational.assignmentId}::uuid`.execute(
            transaction,
          ),
        );
        await expectIntegrityFailure(() =>
          sql`
            update order_assignments set driver_id = ${randomUUID()}::uuid
            where id = ${operational.assignmentId}::uuid
          `.execute(transaction),
        );
        await expectIntegrityFailure(() =>
          sql`
            update orders set assigned_driver_id = null
            where id = ${operational.orderId}::uuid
          `.execute(transaction),
        );

        const positiveOrder = await createAssignedOrder("INT-REC-P", {
          collected: 100,
          fee: 10,
          gross: 90,
          net: 80,
        });
        const reconciliationId = randomUUID();
        await sql`
          insert into driver_reconciliations (
            id, company_id, reconciliation_number, driver_id, business_date,
            gross_collections, driver_payable_deduction, reconciliation_expenses,
            net_amount_received, created_by_account_id
          ) values (
            ${reconciliationId}::uuid, ${companyA}::uuid, 'INT-REC-P', ${driverA}::uuid,
            current_date, 100, 10, 0, 90, ${actorA}::uuid
          )
        `.execute(transaction);
        await sql`
          insert into driver_reconciliation_orders (
            company_id, reconciliation_id, order_id, customer_collection_amount,
            driver_payable_deduction
          ) values (
            ${companyA}::uuid, ${reconciliationId}::uuid, ${positiveOrder.orderId}::uuid,
            100, 10
          )
        `.execute(transaction);
        await expectIntegrityFailure(() =>
          sql`
            update driver_reconciliation_orders set customer_collection_amount = 99
            where reconciliation_id = ${reconciliationId}::uuid
          `.execute(transaction),
        );
        await sql`
          insert into driver_reconciliation_payments (
            company_id, reconciliation_id, payment_method, amount,
            created_by_account_id, payment_at
          ) values (
            ${companyA}::uuid, ${reconciliationId}::uuid, 'cash', 89,
            null, now()
          )
        `.execute(transaction);
        await expectIntegrityFailure(() =>
          sql`
            update driver_reconciliations
            set status = 'confirmed', confirmed_by_account_id = ${actorA}::uuid,
                confirmed_at = now()
            where id = ${reconciliationId}::uuid
          `.execute(transaction),
        );
        await sql`
          update driver_reconciliation_payments set amount = 90
          where reconciliation_id = ${reconciliationId}::uuid
        `.execute(transaction);
        await expectIntegrityFailure(() =>
          sql`
            update driver_reconciliations
            set status = 'confirmed', confirmed_by_account_id = ${actorA}::uuid,
                confirmed_at = now()
            where id = ${reconciliationId}::uuid
          `.execute(transaction),
        );
        await sql`
          update driver_reconciliation_payments set created_by_account_id = ${actorA}::uuid
          where reconciliation_id = ${reconciliationId}::uuid
        `.execute(transaction);
        await sql`
          update driver_reconciliations
          set status = 'confirmed', confirmed_by_account_id = ${actorA}::uuid,
              confirmed_at = now()
          where id = ${reconciliationId}::uuid
        `.execute(transaction);
        await expectIntegrityFailure(() =>
          sql`
            update driver_reconciliation_payments set amount = 89
            where reconciliation_id = ${reconciliationId}::uuid
          `.execute(transaction),
        );

        // Migration 20260718020000: reference immutability, Order-link uniqueness and
        // Bank Reference normalization/uniqueness. Drafts are used so that the guards
        // under test are reached rather than the confirmed-record immutability triggers.
        const createDraftReconciliation = async (number: string): Promise<string> => {
          const draftId = randomUUID();
          await sql`
            insert into driver_reconciliations (
              id, company_id, reconciliation_number, driver_id, business_date,
              gross_collections, driver_payable_deduction, reconciliation_expenses,
              net_amount_received, created_by_account_id
            ) values (
              ${draftId}::uuid, ${companyA}::uuid, ${number}, ${driverA}::uuid,
              current_date, 0, 0, 0, 0, ${actorA}::uuid
            )
          `.execute(transaction);
          return draftId;
        };

        const draftOne = await createDraftReconciliation("INT-REC-D1");
        const draftTwo = await createDraftReconciliation("INT-REC-D2");

        await expectIntegrityFailure(() =>
          sql`
            update driver_reconciliations set reconciliation_number = 'INT-REC-D1-RENAMED'
            where id = ${draftOne}::uuid
          `.execute(transaction),
        );

        // A still-pending Order linked to one reconciliation cannot be linked to another.
        const duplicateLinkOrder = await createAssignedOrder("INT-REC-DUP", {
          collected: 50,
          fee: 5,
          gross: 45,
          net: 40,
        });
        await sql`
          insert into driver_reconciliation_orders (
            company_id, reconciliation_id, order_id, customer_collection_amount,
            driver_payable_deduction
          ) values (
            ${companyA}::uuid, ${draftOne}::uuid, ${duplicateLinkOrder.orderId}::uuid, 50, 0
          )
        `.execute(transaction);
        await expectIntegrityFailure(() =>
          sql`
            insert into driver_reconciliation_orders (
              company_id, reconciliation_id, order_id, customer_collection_amount,
              driver_payable_deduction
            ) values (
              ${companyA}::uuid, ${draftTwo}::uuid, ${duplicateLinkOrder.orderId}::uuid, 50, 0
            )
          `.execute(transaction),
        );

        const bankAccountA = randomUUID();
        await sql`
          insert into company_bank_accounts (id, company_id, bank_name, account_name) values
            (${bankAccountA}::uuid, ${companyA}::uuid, 'Integrity Bank', 'Integrity Account')
        `.execute(transaction);
        await sql`
          insert into driver_reconciliation_payments (
            company_id, reconciliation_id, payment_method, amount,
            company_bank_account_id, bank_reference, created_by_account_id, payment_at
          ) values (
            ${companyA}::uuid, ${draftOne}::uuid, 'bank_transfer', 10,
            ${bankAccountA}::uuid, 'REC-REF-1', ${actorA}::uuid, now()
          )
        `.execute(transaction);
        // Bank Reference uniqueness is case-insensitive within the Company.
        await expectIntegrityFailure(() =>
          sql`
            insert into driver_reconciliation_payments (
              company_id, reconciliation_id, payment_method, amount,
              company_bank_account_id, bank_reference, created_by_account_id, payment_at
            ) values (
              ${companyA}::uuid, ${draftTwo}::uuid, 'bank_transfer', 10,
              ${bankAccountA}::uuid, 'rec-ref-1', ${actorA}::uuid, now()
            )
          `.execute(transaction),
        );
        // Surrounding whitespace is trimmed before storage and uniqueness evaluation.
        await sql`
          insert into driver_reconciliation_payments (
            company_id, reconciliation_id, payment_method, amount,
            company_bank_account_id, bank_reference, created_by_account_id, payment_at
          ) values (
            ${companyA}::uuid, ${draftTwo}::uuid, 'bank_transfer', 10,
            ${bankAccountA}::uuid, '   REC-REF-2   ', ${actorA}::uuid, now()
          )
        `.execute(transaction);
        const trimmedReference = await sql<{ bankReference: string }>`
          select bank_reference as "bankReference" from driver_reconciliation_payments
          where reconciliation_id = ${draftTwo}::uuid
        `.execute(transaction);
        expect(trimmedReference.rows[0]?.bankReference).toBe("REC-REF-2");

        const zeroOrder = await createAssignedOrder("INT-REC-Z", {
          collected: 0,
          fee: 0,
          gross: 0,
          net: 0,
        });
        const zeroReconciliationId = randomUUID();
        await sql`
          insert into driver_reconciliations (
            id, company_id, reconciliation_number, driver_id, business_date,
            gross_collections, driver_payable_deduction, reconciliation_expenses,
            net_amount_received, created_by_account_id
          ) values (
            ${zeroReconciliationId}::uuid, ${companyA}::uuid, 'INT-REC-Z', ${driverA}::uuid,
            current_date, 0, 0, 0, 0, ${actorA}::uuid
          )
        `.execute(transaction);
        await sql`
          insert into driver_reconciliation_orders (
            company_id, reconciliation_id, order_id, customer_collection_amount,
            driver_payable_deduction
          ) values (
            ${companyA}::uuid, ${zeroReconciliationId}::uuid, ${zeroOrder.orderId}::uuid,
            0, 0
          )
        `.execute(transaction);
        await expectIntegrityFailure(() =>
          sql`
            insert into driver_reconciliation_payments (
              company_id, reconciliation_id, payment_method, amount,
              created_by_account_id, payment_at
            ) values (
              ${companyA}::uuid, ${zeroReconciliationId}::uuid, 'cash', 0,
              ${actorA}::uuid, now()
            )
          `.execute(transaction),
        );
        await sql`
          update driver_reconciliations
          set status = 'confirmed', confirmed_by_account_id = ${actorA}::uuid,
              confirmed_at = now()
          where id = ${zeroReconciliationId}::uuid
        `.execute(transaction);
        await sql`
          update orders set driver_reconciliation_status = 'reconciled'
          where id = ${zeroOrder.orderId}::uuid
        `.execute(transaction);
        const zeroSettlementId = randomUUID();
        await sql`
          insert into trader_settlements (
            id, company_id, settlement_number, trader_id, business_date,
            gross_payable, service_fee_deductions, other_deductions, charges,
            adjustments, net_payable, created_by_account_id
          ) values (
            ${zeroSettlementId}::uuid, ${companyA}::uuid, 'INT-SET-Z', ${traderA}::uuid,
            current_date, 0, 0, 0, 0, 0, 0, ${actorA}::uuid
          )
        `.execute(transaction);
        await sql`
          insert into trader_settlement_orders (
            company_id, settlement_id, order_id, gross_payable,
            deductions_and_charges, adjustments, net_payable
          ) values (
            ${companyA}::uuid, ${zeroSettlementId}::uuid, ${zeroOrder.orderId}::uuid,
            0, 0, 0, 0
          )
        `.execute(transaction);
        await sql`
          update trader_settlements
          set status = 'confirmed', confirmed_by_account_id = ${actorA}::uuid,
              confirmed_at = now()
          where id = ${zeroSettlementId}::uuid
        `.execute(transaction);

        const settlementOrder = await createAssignedOrder("INT-SET-P", {
          adjustments: 3,
          charges: 2,
          collected: 0,
          deductions: 5,
          fee: 10,
          gross: 100,
          net: 86,
        });
        await sql`
          update orders set driver_reconciliation_status = 'reconciled'
          where id = ${settlementOrder.orderId}::uuid
        `.execute(transaction);
        const settlementId = randomUUID();
        await sql`
          insert into trader_settlements (
            id, company_id, settlement_number, trader_id, business_date,
            gross_payable, service_fee_deductions, other_deductions, charges,
            adjustments, net_payable, created_by_account_id
          ) values (
            ${settlementId}::uuid, ${companyA}::uuid, 'INT-SET-P', ${traderA}::uuid,
            current_date, 100, 10, 5, 2, 3, 86, ${actorA}::uuid
          )
        `.execute(transaction);
        await sql`
          insert into trader_settlement_orders (
            company_id, settlement_id, order_id, gross_payable,
            deductions_and_charges, adjustments, net_payable
          ) values (
            ${companyA}::uuid, ${settlementId}::uuid, ${settlementOrder.orderId}::uuid,
            100, 17, 3, 86
          )
        `.execute(transaction);
        await expectIntegrityFailure(() =>
          sql`
            update trader_settlement_orders set deductions_and_charges = 18, net_payable = 85
            where settlement_id = ${settlementId}::uuid
          `.execute(transaction),
        );
        await expectIntegrityFailure(() =>
          sql`
            insert into trader_settlement_payments (
              company_id, settlement_id, payment_method, amount,
              created_by_account_id, payment_at
            ) values (
              ${companyA}::uuid, ${settlementId}::uuid, 'cash', 86,
              ${actorB}::uuid, now()
            )
          `.execute(transaction),
        );
        await sql`
          insert into trader_settlement_payments (
            company_id, settlement_id, payment_method, amount,
            created_by_account_id, payment_at
          ) values (
            ${companyA}::uuid, ${settlementId}::uuid, 'cash', 86,
            ${actorA}::uuid, now()
          )
        `.execute(transaction);
        await sql`
          update trader_settlements
          set status = 'confirmed', confirmed_by_account_id = ${actorA}::uuid,
              confirmed_at = now()
          where id = ${settlementId}::uuid
        `.execute(transaction);
        await expectIntegrityFailure(() =>
          sql`
            delete from trader_settlement_orders
            where settlement_id = ${settlementId}::uuid
          `.execute(transaction),
        );

        await expectIntegrityFailure(() =>
          sql`
            insert into trader_settlements (
              company_id, settlement_number, trader_id, business_date, gross_payable,
              adjustments, net_payable, created_by_account_id
            ) values (
              ${companyA}::uuid, 'INT-SET-N', ${traderA}::uuid, current_date,
              0, -1, -1, ${actorA}::uuid
            )
          `.execute(transaction),
        );

        await sql`set constraints all immediate`.execute(transaction);
        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) {
        throw error;
      }
    } finally {
      await database.destroy();
    }
  }, 30_000);
});
