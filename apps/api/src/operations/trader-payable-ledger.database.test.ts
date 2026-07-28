import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";
const rollbackMarker = Symbol("rollback trader payable ledger test");

// Schema-level guarantees behind partial Trader payments (§13, §17):
//  - the same Order may be allocated across several settlements, but never twice within one;
//  - trader_outstanding_balance is a generated column (payable - paid), so it cannot drift;
//  - overpayment and negative outstanding are impossible at the database.
// Service-level behaviours (confirmed allocation increments the cached paid total, oldest-first
// allocation, reversal excluded from the total, concurrency) are covered with the Phase 4
// allocation service that produces those rows.
describe.skipIf(!runDatabaseTests)("Trader payable ledger schema", () => {
  it("allows several partial payments per Order and forbids overpayment", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (transaction) => {
          let sequence = 0;
          const rejected = async (work: () => Promise<unknown>, code: string) => {
            const savepoint = `payable_${++sequence}`;
            await sql.raw(`savepoint ${savepoint}`).execute(transaction);
            try {
              await expect(work()).rejects.toMatchObject({ code });
            } finally {
              await sql.raw(`rollback to savepoint ${savepoint}`).execute(transaction);
              await sql.raw(`release savepoint ${savepoint}`).execute(transaction);
            }
          };

          const company = randomUUID();
          const actor = randomUUID();
          const trader = randomUUID();
          const traderAccount = randomUUID();
          const order = randomUUID();
          const settlementOne = randomUUID();
          const settlementTwo = randomUUID();

          await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
            (${company}::uuid,${`PL-${company.slice(0, 8)}`},${`pl-${company.slice(0, 8)}`},'Ledger Test','active',now())`.execute(
            transaction,
          );
          await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
            (${actor}::uuid,${company}::uuid,'company_user',${`pl.a.${actor}`},'x'),
            (${traderAccount}::uuid,${company}::uuid,'trader',${`pl.t.${trader}`},'x')`.execute(
            transaction,
          );
          await sql`insert into traders(id,company_id,account_id,code,name_en,mobile_number,created_by_account_id)
            values(${trader}::uuid,${company}::uuid,${traderAccount}::uuid,'TRD-000001','Ledger Trader','971501234567',${actor}::uuid)`.execute(
            transaction,
          );
          const dubai = (
            await sql<{ id: string }>`select id from emirates where code='DXB'`.execute(transaction)
          ).rows[0]!.id;
          const area = randomUUID();
          await sql`insert into areas(id,company_id,emirate_id,code,name_en)
            values(${area}::uuid,${company}::uuid,${dubai}::uuid,'AREA-000001','Deira')`.execute(
            transaction,
          );

          // A delivered Order that owes the Trader AED 100.00. Legacy provenance keeps the seed
          // minimal (no Customer/pricing rows) while satisfying every orders CHECK.
          await sql`insert into orders(
              id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
              customer_name, customer_mobile_number, customer_address, package_count, payment_condition,
              final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status,
              trader_gross_payable, trader_net_payable,
              delivery_status, driver_reconciliation_status, trader_settlement_status, return_status
            ) values(
              ${order}::uuid, ${company}::uuid, 'ORD-LEDGER-1', current_date, ${trader}::uuid, ${area}::uuid, ${actor}::uuid,
              'Ledger Customer', '971509999999', 'Ledger address', 1, 'customer_pays_cod_and_fee',
              0, 'legacy_unattributed', 'legacy_unattributed',
              100, 100,
              'delivered', 'reconciled', 'unsettled', 'not_applicable'
            )`.execute(transaction);

          const settlement = (id: string, number: string) =>
            sql`insert into trader_settlements(
                id, company_id, settlement_number, trader_id, business_date,
                gross_payable, net_payable, created_by_account_id
              ) values(${id}::uuid, ${company}::uuid, ${number}, ${trader}::uuid, current_date,
                100, 100, ${actor}::uuid)`.execute(transaction);
          await settlement(settlementOne, "SET-000001");
          await settlement(settlementTwo, "SET-000002");

          const allocate = (settlementId: string, amount: number) =>
            sql`insert into trader_settlement_orders(
                company_id, settlement_id, order_id, gross_payable,
                deductions_and_charges, adjustments, net_payable, allocated_amount
              ) values(${company}::uuid, ${settlementId}::uuid, ${order}::uuid, 100, 0, 0, 100, ${amount})`.execute(
              transaction,
            );

          const paid = (amount: number, status: string) =>
            sql`update orders set trader_paid_amount = ${amount}, trader_settlement_status = ${status}
                where id = ${order}::uuid`.execute(transaction);
          const outstanding = async () =>
            (
              await sql<{ v: string }>`select trader_outstanding_balance::text as v from orders where id = ${order}::uuid`.execute(
                transaction,
              )
            ).rows[0]!.v;

          // First partial payment: allocate 60, mark partially settled, cache the paid total.
          await allocate(settlementOne, 60);
          await paid(60, "partially_settled");
          expect(await outstanding()).toBe("40.00"); // generated = payable - paid

          // The same Order cannot be linked twice to the SAME settlement.
          await rejected(() => allocate(settlementOne, 10), "23505");

          // Second partial payment on the SAME Order, in a DIFFERENT settlement, while it is
          // already partially settled — this is what the corrected trigger now permits.
          await allocate(settlementTwo, 40);
          await paid(100, "settled");
          expect(await outstanding()).toBe("0.00");

          // Overpayment (and therefore negative outstanding) is rejected by the database.
          await rejected(() => paid(101, "settled"), "23514");
          await rejected(() => paid(-1, "unsettled"), "23514");

          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
    } finally {
      await database.destroy();
    }
  }, 60_000);

  // Focused regression test for migration 20260729100000: proves the
  // confirmation-guard trigger itself (raw SQL, no service layer) now accepts
  // confirming a SECOND settlement on an Order already `partially_settled` by
  // an earlier, independently confirmed settlement — which the unmigrated
  // trigger rejected with error 23514 even though the sibling insert-time
  // trigger already permitted the row to exist.
  it("allows confirming a second settlement on an already partially-settled Order", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (transaction) => {
          const company = randomUUID();
          const actor = randomUUID();
          const trader = randomUUID();
          const traderAccount = randomUUID();
          const order = randomUUID();
          const settlementOne = randomUUID();
          const settlementTwo = randomUUID();

          await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
            (${company}::uuid,${`TR-${company.slice(0, 8)}`},${`tr-${company.slice(0, 8)}`},'Trigger Test','active',now())`.execute(
            transaction,
          );
          await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
            (${actor}::uuid,${company}::uuid,'company_user',${`tr.a.${actor}`},'x'),
            (${traderAccount}::uuid,${company}::uuid,'trader',${`tr.t.${trader}`},'x')`.execute(
            transaction,
          );
          await sql`insert into traders(id,company_id,account_id,code,name_en,mobile_number,created_by_account_id)
            values(${trader}::uuid,${company}::uuid,${traderAccount}::uuid,'TRD-000001','Trigger Trader','971501234567',${actor}::uuid)`.execute(
            transaction,
          );
          const dubai = (
            await sql<{ id: string }>`select id from emirates where code='DXB'`.execute(transaction)
          ).rows[0]!.id;
          const area = randomUUID();
          await sql`insert into areas(id,company_id,emirate_id,code,name_en)
            values(${area}::uuid,${company}::uuid,${dubai}::uuid,'AREA-000001','Deira')`.execute(
            transaction,
          );
          await sql`insert into orders(
              id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
              customer_name, customer_mobile_number, customer_address, package_count, payment_condition,
              final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status,
              trader_gross_payable, trader_net_payable,
              delivery_status, driver_reconciliation_status, trader_settlement_status, return_status
            ) values(
              ${order}::uuid, ${company}::uuid, 'ORD-TRIGGER-1', current_date, ${trader}::uuid, ${area}::uuid, ${actor}::uuid,
              'Trigger Customer', '971509999999', 'Trigger address', 1, 'customer_pays_cod_and_fee',
              0, 'legacy_unattributed', 'legacy_unattributed',
              100, 100,
              'delivered', 'reconciled', 'unsettled', 'not_applicable'
            )`.execute(transaction);

          const confirmSettlement = async (
            settlementId: string,
            number: string,
            allocated: number,
          ): Promise<void> => {
            await sql`insert into trader_settlements(
                id, company_id, settlement_number, trader_id, business_date,
                gross_payable, net_payable, status, created_by_account_id
              ) values(${settlementId}::uuid, ${company}::uuid, ${number}, ${trader}::uuid, current_date,
                ${allocated}, ${allocated}, 'draft', ${actor}::uuid)`.execute(transaction);
            await sql`insert into trader_settlement_orders(
                company_id, settlement_id, order_id, gross_payable,
                deductions_and_charges, adjustments, net_payable, allocated_amount
              ) values(${company}::uuid, ${settlementId}::uuid, ${order}::uuid, 100, 0, 0, 100, ${allocated})`.execute(
              transaction,
            );
            await sql`insert into trader_settlement_payments(
                company_id, settlement_id, payment_method, amount, created_by_account_id, payment_at
              ) values(${company}::uuid, ${settlementId}::uuid, 'cash', ${allocated}, ${actor}::uuid, now())`.execute(
              transaction,
            );
            await sql`update trader_settlements
                 set status = 'confirmed', confirmed_by_account_id = ${actor}::uuid, confirmed_at = now()
               where id = ${settlementId}::uuid`.execute(transaction);
          };

          // First settlement: partial payment of 60. Confirms cleanly (this
          // already worked before the fix — a fresh 'unsettled' Order).
          await confirmSettlement(settlementOne, "SET-TRIGGER-001", 60);
          await sql`update orders set trader_paid_amount = 60, trader_settlement_status = 'partially_settled'
             where id = ${order}::uuid`.execute(transaction);

          // Second settlement on the SAME, now partially-settled Order. Before
          // the migration this UPDATE ... SET status = 'confirmed' raised 23514
          // ("Trader settlement contains an ineligible or wrong-Trader Order")
          // because the old trigger demanded trader_settlement_status = 'unsettled'
          // exactly. It must now succeed.
          await expect(confirmSettlement(settlementTwo, "SET-TRIGGER-002", 40)).resolves.toBeUndefined();

          const confirmed = await sql<{ status: string }>`
            select status from trader_settlements where id = ${settlementTwo}::uuid
          `.execute(transaction);
          expect(confirmed.rows[0]?.status).toBe("confirmed");

          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
    } finally {
      await database.destroy();
    }
  }, 60_000);
});
