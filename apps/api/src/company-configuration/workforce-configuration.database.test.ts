import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";
const rollbackMarker = Symbol("rollback workforce database test");

describe.skipIf(!runDatabaseTests)("workforce database protections", () => {
  it("prevents overlapping rules, fifth allowances, and duplicate paid-order allocation", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (transaction) => {
          let savepointSequence = 0;
          const expectIntegrityFailure = async (work: () => Promise<unknown>, code: string) => {
            const savepoint = `workforce_${++savepointSequence}`;
            await sql.raw(`savepoint ${savepoint}`).execute(transaction);
            try {
              await expect(work()).rejects.toMatchObject({ code });
            } finally {
              await sql.raw(`rollback to savepoint ${savepoint}`).execute(transaction);
              await sql.raw(`release savepoint ${savepoint}`).execute(transaction);
            }
          };
          const companyId = randomUUID(),
            actorId = randomUUID(),
            employeeId = randomUUID(),
            driverId = randomUUID(),
            ruleId = randomUUID(),
            calculationA = randomUUID(),
            calculationB = randomUUID(),
            orderId = randomUUID(),
            traderId = randomUUID(),
            traderAccountId = randomUUID(),
            areaId = randomUUID();
          await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values(${companyId}::uuid,${`WF-${companyId.slice(0, 8)}`},${`wf-${companyId.slice(0, 8)}`},'Workforce Test','active',now())`.execute(
            transaction,
          );
          await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values(${actorId}::uuid,${companyId}::uuid,'company_user','wf.actor','test'),(${traderAccountId}::uuid,${companyId}::uuid,'trader','wf.trader','test')`.execute(
            transaction,
          );
          await sql`insert into company_users(company_id,account_id,name_en,display_name) values(${companyId}::uuid,${actorId}::uuid,'Actor','Actor')`.execute(
            transaction,
          );
          await sql`insert into employees(id,company_id,employee_number,name_en,mobile_number,basic_salary) values(${employeeId}::uuid,${companyId}::uuid,'EMP-1','Employee','971501234567',1000)`.execute(
            transaction,
          );
          await sql`insert into drivers(id,company_id,employee_id,code,name_en,mobile_number,driver_type,outsourced_fee_per_delivered_order) values(${driverId}::uuid,${companyId}::uuid,${employeeId}::uuid,'DRV-1','Driver','971501234568','employee',null)`.execute(
            transaction,
          );
          await sql`insert into driver_commission_rules(id,company_id,driver_id,name,commission_method,commission_basis,commission_rate,calculation_frequency,effective_from,created_by_account_id) values(${ruleId}::uuid,${companyId}::uuid,${driverId}::uuid,'Monthly','fixed',null,2,'monthly','2026-01-01',${actorId}::uuid)`.execute(
            transaction,
          );
          await expectIntegrityFailure(
            () =>
              sql`insert into driver_commission_rules(company_id,driver_id,name,commission_method,commission_basis,commission_rate,calculation_frequency,effective_from,created_by_account_id) values(${companyId}::uuid,${driverId}::uuid,'Overlap','fixed',null,3,'monthly','2026-02-01',${actorId}::uuid)`.execute(
                transaction,
              ),
            "23505",
          );
          await sql`insert into areas(id,company_id,emirate_id,code,name_en) values(${areaId}::uuid,${companyId}::uuid,(select id from emirates where code='DXB'),'AREA','Area')`.execute(
            transaction,
          );
          await sql`insert into traders(id,company_id,account_id,code,name_en,mobile_number) values(${traderId}::uuid,${companyId}::uuid,${traderAccountId}::uuid,'TRD','Trader','971501234569')`.execute(
            transaction,
          );
          await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,assigned_driver_id,customer_name,customer_mobile_number,customer_address,package_count,payment_condition,cod_amount,service_fee,vat_amount,customer_amount_due,amount_collected,company_revenue,order_profit,trader_gross_payable,trader_net_payable,delivery_status,delivered_at,pricing_provenance_status,customer_provenance_status,final_service_fee_snapshot) values(${orderId}::uuid,${companyId}::uuid,'WF-ORD','2026-07-01',${traderId}::uuid,${areaId}::uuid,${actorId}::uuid,${driverId}::uuid,'Customer','971501234570','Dubai',1,'customer_pays_cod_and_fee',0,10,0,10,10,10,10,0,0,'delivered','2026-07-01','legacy_unattributed','legacy_unattributed',10)`.execute(
            transaction,
          );
          for (const [id, reference] of [
            [calculationA, "CAL-A"],
            [calculationB, "CAL-B"],
          ] as const)
            await sql`insert into driver_commission_calculations(id,company_id,driver_id,commission_rule_id,calculation_reference,calculation_frequency,period_start,period_end,eligible_order_count,commission_method,commission_basis,commission_rate,gross_commission,net_payable,status,created_by_account_id) values(${id}::uuid,${companyId}::uuid,${driverId}::uuid,${ruleId}::uuid,${reference},'monthly','2026-07-01','2026-07-31',1,'fixed',null,2,2,2,'consumed',${actorId}::uuid)`.execute(
              transaction,
            );
          await sql`insert into driver_commission_orders(company_id,calculation_id,driver_id,order_id,allocation_kind,delivery_date,service_fee_snapshot,commission_amount) values(${companyId}::uuid,${calculationA}::uuid,${driverId}::uuid,${orderId}::uuid,'payment','2026-07-01',10,2)`.execute(
            transaction,
          );
          await expectIntegrityFailure(
            () =>
              sql`insert into driver_commission_orders(company_id,calculation_id,driver_id,order_id,allocation_kind,delivery_date,service_fee_snapshot,commission_amount) values(${companyId}::uuid,${calculationB}::uuid,${driverId}::uuid,${orderId}::uuid,'payment','2026-07-01',10,2)`.execute(
                transaction,
              ),
            "23505",
          );
          const allowanceTypes = [] as string[];
          for (let index = 0; index < 5; index++) {
            const typeId = randomUUID();
            allowanceTypes.push(typeId);
            await sql`insert into allowance_types(id,company_id,code,name) values(${typeId}::uuid,${companyId}::uuid,${`A${index}`},${`Allowance ${index}`})`.execute(
              transaction,
            );
          }
          for (let index = 0; index < 4; index++)
            await sql`insert into employee_allowances(company_id,employee_id,allowance_type_id,amount,effective_from,created_by_account_id) values(${companyId}::uuid,${employeeId}::uuid,${allowanceTypes[index]}::uuid,10,'2026-01-01',${actorId}::uuid)`.execute(
              transaction,
            );
          await expectIntegrityFailure(
            () =>
              sql`insert into employee_allowances(company_id,employee_id,allowance_type_id,amount,effective_from,created_by_account_id) values(${companyId}::uuid,${employeeId}::uuid,${allowanceTypes[4]}::uuid,10,'2026-01-01',${actorId}::uuid)`.execute(
                transaction,
              ),
            "23514",
          );
          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
    } finally {
      await database.destroy();
    }
  });
});
