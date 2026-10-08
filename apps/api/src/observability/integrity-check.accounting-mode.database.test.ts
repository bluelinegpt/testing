import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { IntegrityCheckService } from "./integrity-check.service.js";

/**
 * The Integrity Checker's "delivered Order with no Accounting Event" check is
 * judged by the Company's GL Accounting mode AT DELIVERY:
 *
 *   - OFF at delivery: no Event is healthy -- never a finding, including after
 *     Accounting is later enabled.
 *   - ON at delivery: a missing Event IS a finding -- including after the
 *     Company is later switched OFF. Legitimate failures are not hidden.
 *
 * Committed fixtures under fresh `INTMODE-` Companies in the disposable
 * database; gated like the other Accounting-mode suites.
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseTests =
  process.env.RUN_INTEGRITY_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

describe.skipIf(!runDatabaseTests)("Integrity Checker and Company Accounting mode", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let checker: IntegrityCheckService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    checker = new IntegrityCheckService(db);
    await sql`insert into emirates(code,name_en,name_ar,display_order)
      values ('DXB','Dubai','Dubai',1) on conflict (code) do nothing`.execute(db);
  });

  afterAll(async () => {
    await db?.destroy();
  });

  async function company(accounting: "none" | "off" | "on") {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${id}::uuid,${`INTMODE-${tag}`},${`intmode-${tag}`},'Integrity mode','active',now())`.execute(
      db,
    );
    if (accounting !== "none") {
      await sql`insert into accounting_configurations(company_id, accounting_enabled)
        values (${id}::uuid, ${accounting === "on"})`.execute(db);
    }
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${id}::uuid,'company_user',${`intmode.${actorId}`},'x','disabled')`.execute(
      db,
    );
    const areaId = randomUUID();
    const traderId = randomUUID();
    await sql`insert into areas(id,company_id,code,name_en,emirate_id)
      values (${areaId}::uuid,${id}::uuid,${`A-${tag}`},${`Area ${tag}`},
              (select id from emirates where code='DXB'))`.execute(db);
    await sql`insert into traders(id,company_id,code,name_en,mobile_number)
      values (${traderId}::uuid,${id}::uuid,${`T-${tag}`},'Trader','971500000003')`.execute(db);
    return { actorId, areaId, id, traderId };
  }

  /** A delivered Order with a Trader payable and NO Accounting Event (inserted directly). */
  async function deliveredWithoutEvent(fixture: Awaited<ReturnType<typeof company>>) {
    const orderId = randomUUID();
    await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
        created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
        payment_condition,final_service_fee_snapshot,service_fee_override_reason,
        customer_provenance_status,pricing_provenance_status,customer_amount_due,trader_gross_payable,
        trader_paid_service_fee,trader_net_payable,trader_paid_amount,delivery_status,
        driver_reconciliation_status,trader_settlement_status,return_status,delivered_at)
      values (${orderId}::uuid,${fixture.id}::uuid,${`IO-${orderId.slice(0, 8)}`},current_date,
        ${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,'C','971500000001',
        'Addr',1,'customer_pays_cod_and_fee',0,'Zero configured Service Fee (fixture)',
        'legacy_unattributed','legacy_unattributed',0,25,0,25,0,'delivered','not_applicable',
        'unsettled','not_applicable',clock_timestamp())`.execute(db);
    return orderId;
  }

  async function flagged(companyId: string, orderId: string) {
    const findings = await checker.runAll(companyId);
    return findings.some(
      (finding) =>
        finding.checkId === "order_missing_accounting_event" && finding.subjectId === orderId,
    );
  }

  const setEnabled = (companyId: string, enabled: boolean) =>
    sql`update accounting_configurations set accounting_enabled = ${enabled}, version = version + 1
         where company_id = ${companyId}::uuid`.execute(db);

  it("Accounting OFF (or never configured): no Event is healthy, never a finding", async () => {
    const off = await company("off");
    const never = await company("none");
    expect(await flagged(off.id, await deliveredWithoutEvent(off))).toBe(false);
    expect(await flagged(never.id, await deliveredWithoutEvent(never))).toBe(false);
  });

  it("Accounting ON: a delivered Order with no Event IS a finding", async () => {
    const on = await company("on");
    expect(await flagged(on.id, await deliveredWithoutEvent(on))).toBe(true);
  });

  it("delivered while OFF stays healthy after Accounting is enabled later", async () => {
    const later = await company("off");
    const orderId = await deliveredWithoutEvent(later);
    await setEnabled(later.id, true);
    expect(await flagged(later.id, orderId)).toBe(false);
  });

  it("a failure that happened while ON is still reported after switching OFF", async () => {
    const was = await company("on");
    const orderId = await deliveredWithoutEvent(was);
    await setEnabled(was.id, false);
    expect(await flagged(was.id, orderId)).toBe(true);
  });
});
