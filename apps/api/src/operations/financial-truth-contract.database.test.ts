import { createHash, randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { CashBankManagementService } from "../accounting/cash-bank-management.service.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { markTraderDeductionV1Order } from "./order-obligation-snapshot.fixture.js";
import { CompanyOrderHealthService } from "./company-order-health.service.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsService } from "./operations.service.js";
import { type FinancialVerification, OrderMaintenanceService } from "./order-maintenance.service.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import { type RepairExecutionRequest, RepairExecutionService } from "./repair-execution.service.js";
import { RepairPreviewService } from "./repair-preview.service.js";
import {
  correlatedReceivableInputs,
  expectedReceivableStatus,
  receivableAnomalySql,
} from "./trader-receivable-reconciliation.js";
import { TraderReceivableService } from "./trader-receivable.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

/**
 * REPAIR CENTER PHASE 3 -- PROMPT 2: ONE FINANCIAL TRUTH (contract test,
 * matrix 1-27).
 *
 * Table-driven. Every case builds an Order with REAL domain services (Trader
 * Collections, Trader Settlements, reversals, the receivable reversal), or a
 * "crafted" row only for a state no service produces on purpose, and then
 * reads it through ALL FOUR interfaces:
 *
 *   1. the receivable reconciliation itself (trader-receivable-reconciliation.ts)
 *   2. Company Health -- the company-wide, set-based list
 *   3. Verify First   -- OrderMaintenanceService.financialVerification
 *   4. Repair Preview -- RepairPreviewService.analyze / preview
 *
 * and pins that they agree on the reason code, the health
 * (HEALTHY / ISSUE / REVIEW), whether action is required, and the
 * repairability (NOT_REQUIRED / READY / BLOCKED / MANUAL_REVIEW).
 *
 * Amounts follow the prompt: the Trader owes AED 25.
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseTests =
  process.env.RUN_INTEGRITY_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

const today = new Date().toISOString().slice(0, 10);
const FEE = 25;
const COD = 100;
const PAYABLE = COD - FEE;

const PERMISSIONS = [
  "accounting.view",
  "accounting.manage",
  "accounting.configuration.manage",
  "orders.create",
  "orders.view",
  "orders.update",
  "orders.update_delivery_status",
  "trader_receivables.create",
  "trader_receivables.view",
  "trader_receivables.reverse",
  "settlements.create",
  "settlements.view",
  "settlements.reverse",
  "reconciliations.create",
  "users_roles.manage",
];

type Mode = "off" | "on";
type Health = "HEALTHY" | "ISSUE" | "REVIEW";
type Repairability = "NOT_REQUIRED" | "READY" | "BLOCKED" | "MANUAL_REVIEW";

interface Fixture {
  readonly mode: Mode;
  readonly companyId: string;
  readonly actorId: string;
  readonly areaId: string;
  readonly traderId: string;
  readonly driverId: string;
  readonly cashAccountId: string;
}

/** What every interface must report for one case. */
interface Expected {
  readonly code: string;
  readonly classification: string;
  readonly health: Health;
  readonly repairability: Repairability;
  /** Verify First's Company-side action. */
  readonly action?: "none" | "repair";
  /** The current receivable after the arrangement (domain writers). */
  readonly receivable?: { readonly status: string; readonly amountCollected: string } | null;
}

describe.skipIf(!runDatabaseTests)("Phase 3 Prompt 2 -- one financial truth (contract)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let store: RequestSecurityContextStore;
  let get: <T>(type: new (...args: never[]) => T) => T;
  let previews: RepairPreviewService;
  let executions: RepairExecutionService;
  let health: CompanyOrderHealthService;
  const adminId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .compile();
    get = (type) => module.get(type, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
    previews = get(RepairPreviewService);
    executions = get(RepairExecutionService);
    health = get(CompanyOrderHealthService);
    await sql`insert into accounts (id, company_id, account_kind, username, password_hash, status)
      values (${adminId}::uuid, null, 'platform_administrator', ${`ft.exec.${adminId}`}, 'x', 'disabled')`.execute(db);
    await sql`insert into emirates(code,name_en,name_ar,display_order)
      values ('DXB','DXB','DXB',200) on conflict (code) do nothing`.execute(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  // ---------------------------------------------------------------------------
  // Fixture helpers (same construction as the Phase 3 Prompt 1 suite)
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

  function asPlatform<T>(companyId: string, work: () => Promise<T>) {
    return store.run(
      {
        identity: {
          companyId: null,
          forcePasswordChange: false,
          identityId: adminId,
          kind: "platform_administrator",
          permissions: new Set([
            "platform.access",
            "platform.companies.read",
            "platform.companies.repair_center.read",
            "platform.companies.repair_center.execute",
          ]),
          sessionId: randomUUID(),
        },
        tenant: { companyId, identityId: adminId },
      } as never,
      work,
    );
  }

  const key = (label: string) => `truth.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`TRUTH-${tag}`},${`truth-${tag}`},${`Truth ${mode} ${tag}`},
              'active',now())`.execute(db);
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`truth.${actorId}`},'x','disabled')`.execute(db);
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
    const driverId = randomUUID();
    const emirate = await sql<{ id: string }>`select id from emirates where code='DXB'`.execute(db);
    await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
      values (${areaId}::uuid,${companyId}::uuid,${`A-${tag}`},${`Area ${tag}`},'منطقة',
              ${emirate.rows[0]!.id}::uuid)`.execute(db);
    await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id)
      values (${traderId}::uuid,${companyId}::uuid,${`T-${tag}`},'Trader','971500000003',
              ${areaId}::uuid,${actorId}::uuid)`.execute(db);
    await sql`insert into trader_service_prices(company_id,trader_id,emirate_id,area_id,service_fee,
        created_by_account_id)
      values (${companyId}::uuid,${traderId}::uuid,${emirate.rows[0]!.id}::uuid,${areaId}::uuid,${FEE},
              ${actorId}::uuid)`.execute(db);
    const employeeId = randomUUID();
    await sql`insert into employees(id,company_id,employee_number,name_en,employee_type,hired_on,
        payroll_eligible,is_active)
      values (${employeeId}::uuid,${companyId}::uuid,${`E-${tag}`},'Driver','employee',
              '2026-01-01'::date,true,true)`.execute(db);
    await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,employee_id)
      values (${driverId}::uuid,${companyId}::uuid,${`D-${tag}`},'Driver','971500000005','employee',
              ${employeeId}::uuid)`.execute(db);
    const partial = { actorId, areaId, cashAccountId: "", companyId, driverId, mode, traderId };
    const cash = get(CashBankManagementService);
    const cashAccountId =
      mode === "off"
        ? (
            (await as(partial, () =>
              cash.createCashAccount(
                { code: "CASH", effectiveFrom: today, name: "Main Cash", type: "main_cash" } as never,
                key("cash"),
              ),
            )) as { id: string }
          ).id
        : (
            await sql<{ id: string }>`select id from company_cash_accounts
              where company_id=${companyId}::uuid and cash_account_type='main_cash'`.execute(db)
          ).rows[0]!.id;
    const fixture = { ...partial, cashAccountId };
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
  async function deliveredOrder(
    fixture: Fixture,
    codAmount: number,
    paymentCondition: "customer_pays_cod_and_fee" | "customer_pays_cod_trader_pays_fee",
  ): Promise<string> {
    serial += 1;
    const operations = get(OperationsService);
    const created = (await as(fixture, () =>
      operations.createOrder(
        {
          areaId: fixture.areaId,
          codAmount,
          customerAddress: "Address",
          customerMobileNumber: "0501234567",
          customerName: "Customer",
          driverId: fixture.driverId,
          packageCount: 1,
          paymentCondition,
          serialNumber: `FT-${Date.now()}-${serial}`,
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("order"),
      ),
    )) as { id: string };
    for (const status of ["out_for_delivery", "delivered"]) {
      await as(fixture, () => operations.changeOrderStatus(created.id, { status } as never, randomUUID()));
    }
    return created.id;
  }

  /** A delivered COD Order with Driver cash reconciled: Trader payable 100 - 25 = 75. */
  async function payableOrder(fixture: Fixture): Promise<string> {
    const orderId = await deliveredOrder(fixture, COD, "customer_pays_cod_and_fee");
    await as(fixture, () =>
      get(DriverCashReconciliationService).confirmSingleOrder(
        orderId,
        { paymentMethod: "cash" } as never,
        randomUUID(),
        key("reconcile"),
      ),
    );
    return orderId;
  }

  async function orderNumber(orderId: string) {
    return (await sql<{ n: string }>`select order_number as n from orders where id=${orderId}::uuid`.execute(db)).rows[0]!.n;
  }

  async function currentReceivables(fixture: Fixture, orderId: string) {
    return (
      await sql<{ id: string; status: string; amountCollected: string; amountDue: string }>`
        select id, status, amount_collected::text as "amountCollected", original_amount_due::text as "amountDue"
          from trader_receivables
         where company_id = ${fixture.companyId}::uuid and source_type = 'service_charge'
           and source_reference = ${await orderNumber(orderId)} and status not in ('reversed', 'cancelled')
         order by created_at`.execute(db)
    ).rows;
  }

  /** A zero-COD Trader-pays-fee Order: the Trader owes the AED 25 fee. */
  async function feeOrder(fixture: Fixture) {
    const orderId = await deliveredOrder(fixture, 0, "customer_pays_cod_trader_pays_fee");
    const rows = await currentReceivables(fixture, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountDue: "25.00", status: "outstanding" });
    return { orderId, receivableId: rows[0]!.id };
  }

  /** ONE Trader Settlement offsetting one or more receivables (the certified writer). */
  async function settle(fixture: Fixture, offsets: readonly { receivableId: string; amount: number }[]) {
    const payable = await payableOrder(fixture);
    const total = offsets.reduce((sum, row) => sum + row.amount, 0);
    const result = (await as(fixture, () =>
      get(TraderSettlementService).createPayment(
        {
          allocations: [{ amount: PAYABLE, orderId: payable }],
          amount: PAYABLE - total,
          cashAccountId: fixture.cashAccountId,
          paymentDate: today,
          paymentMethod: "cash",
          receivableOffsets: offsets.map((row) => ({ amount: row.amount, receivableId: row.receivableId })),
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("settle"),
      ),
    )) as { settlementId?: string; id?: string };
    return (result.settlementId ?? result.id)!;
  }

  const offset = (fixture: Fixture, receivableId: string, amount: number) => settle(fixture, [{ amount, receivableId }]);

  async function reverseSettlement(fixture: Fixture, settlementId: string) {
    await as(fixture, () => get(TraderSettlementService).reverse(settlementId, "Paid to the wrong account", randomUUID()));
  }

  /** A Trader Collection (the certified writer). Returns the Collection id. */
  async function collect(fixture: Fixture, receivableId: string, amount: number): Promise<string> {
    const result = await as(fixture, () =>
      get(TraderReceivableService).confirmCollection(
        {
          allocations: [{ amount, receivableId }],
          amountReceived: amount,
          paymentDate: today,
          paymentMethod: "cash",
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("collection"),
      ),
    );
    return result.collectionId;
  }

  async function reverseCollection(fixture: Fixture, collectionId: string) {
    await as(fixture, () => get(TraderReceivableService).reverseCollection(collectionId, "Wrong Trader paid", randomUUID()));
  }

  async function reverseReceivable(fixture: Fixture, receivableId: string) {
    await as(fixture, () => get(ReceivableOffsetReversalService).execute(receivableId, "Fee reset", randomUUID()));
  }

  async function repairReceivable(fixture: Fixture, orderId: string) {
    return as(fixture, () => get(OperationsService).repairTraderReceivable(orderId, randomUUID()));
  }

  async function cancelReceivable(fixture: Fixture, receivableId: string) {
    await as(fixture, () =>
      get(TraderReceivableService).cancelReceivable(receivableId, { reason: "Raised in error" } as never, randomUUID()),
    );
  }

  /** Crafted (disposable DB only): bypasses triggers for one statement. */
  async function crafted(statement: ReturnType<typeof sql>) {
    await db.transaction().execute(async (transaction) => {
      await sql`set local session_replication_role = replica`.execute(transaction);
      await statement.execute(transaction);
    });
  }

  async function craftReceivable(fixture: Fixture, orderId: string, label: string): Promise<string> {
    const id = randomUUID();
    await crafted(sql`insert into trader_receivables(id,company_id,receivable_number,trader_id,source_type,
        source_reference,business_date,original_amount_due,status,reason,created_by_account_id)
      values (${id}::uuid,${fixture.companyId}::uuid,${`RCV-${label}${id.slice(0, 6)}`},
        ${fixture.traderId}::uuid,'service_charge',${await orderNumber(orderId)},current_date,${FEE},'outstanding',
        'Order service fee owed by Trader',${fixture.actorId}::uuid)`);
    return id;
  }

  async function secondTrader(fixture: Fixture): Promise<string> {
    const traderId = randomUUID();
    await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id)
      values (${traderId}::uuid,${fixture.companyId}::uuid,${`T2-${traderId.slice(0, 6)}`},'Other Trader',
              '971500000099',${fixture.areaId}::uuid,${fixture.actorId}::uuid)`.execute(db);
    return traderId;
  }

  async function craftAllocation(fixture: Fixture, traderId: string, receivableId: string, amount: number) {
    const collectionId = randomUUID();
    await crafted(sql`insert into trader_collections(id,company_id,collection_number,trader_id,payment_date,
        payment_method,amount_received,status,received_by_account_id)
      values (${collectionId}::uuid,${fixture.companyId}::uuid,${`COL-X${collectionId.slice(0, 6)}`},
        ${traderId}::uuid,current_date,'cash',${amount},'confirmed',${fixture.actorId}::uuid)`);
    await crafted(sql`insert into trader_collection_allocations(company_id,collection_id,receivable_id,amount_allocated)
      values (${fixture.companyId}::uuid,${collectionId}::uuid,${receivableId}::uuid,${amount})`);
  }

  async function craftOffset(fixture: Fixture, traderId: string, receivableId: string, amount: number) {
    const settlementId = randomUUID();
    await crafted(sql`insert into trader_settlements(id,company_id,settlement_number,trader_id,business_date,
        gross_payable,service_fee_deductions,other_deductions,charges,adjustments,net_payable,status,
        created_by_account_id,confirmed_by_account_id,confirmed_at)
      values (${settlementId}::uuid,${fixture.companyId}::uuid,${`SET-X${settlementId.slice(0, 6)}`},
        ${traderId}::uuid,current_date,${amount},0,${amount},0,0,0,'confirmed',
        ${fixture.actorId}::uuid,${fixture.actorId}::uuid,now())`);
    await crafted(sql`insert into trader_settlement_receivable_offsets(company_id,settlement_id,receivable_id,amount_allocated)
      values (${fixture.companyId}::uuid,${settlementId}::uuid,${receivableId}::uuid,${amount})`);
  }

  /**
   * Crafted: a delivered Trader-pays-fee Order (trader_deduction_v1, VAT off, its
   * obligation snapshot stored) that never got its Receivable. Phase 3 Prompt 4:
   * a true legacy Order (no snapshot) is never repaired automatically.
   */
  async function legacyOrderWithoutReceivable(fixture: Fixture): Promise<string> {
    const orderId = randomUUID();
    await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
      created_by_account_id,customer_name,customer_mobile_number,
      customer_address,package_count,payment_condition,cod_amount,service_fee,final_service_fee_snapshot,
      customer_provenance_status,pricing_provenance_status,customer_amount_due,trader_gross_payable,
      trader_paid_service_fee,trader_net_payable,trader_paid_amount,delivery_status,
      driver_reconciliation_status,trader_settlement_status,return_status,delivered_at)
    values (${orderId}::uuid,${fixture.companyId}::uuid,${`LEG-${orderId.slice(0, 8)}`},${today}::date,
      ${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
      'Customer','971500000001','Address',1,
      'customer_pays_cod_trader_pays_fee',0,${FEE},${FEE},
      'legacy_unattributed','legacy_unattributed',
      0,0,${FEE},0,0,'delivered','not_applicable','not_eligible',
      'not_applicable',now())`.execute(db);
    await markTraderDeductionV1Order(db, orderId);
    return orderId;
  }

  /** Content checksum of every table a repair could touch, for one Company. */
  async function footprint(companyId: string): Promise<string> {
    const tables = [
      "orders",
      "trader_receivables",
      "trader_collection_allocations",
      "trader_collections",
      "trader_settlement_receivable_offsets",
      "trader_settlements",
      "trader_credits",
      "accounting_events",
      "journal_entries",
      "audit_events",
      "order_maintenance_findings",
      "platform_repair_executions",
    ];
    const parts: string[] = [];
    for (const table of tables) {
      const result = await sql<{ digest: string | null; n: number }>`
        select count(*)::int as n, md5(string_agg(t::text, '|' order by t::text)) as digest
          from ${sql.table(table)} t where t.company_id = ${companyId}::uuid`.execute(db);
      parts.push(`${table}:${result.rows[0]!.n}:${result.rows[0]!.digest ?? "-"}`);
    }
    return createHash("sha256").update(parts.join("\n")).digest("hex");
  }

  async function companyCount(table: "accounting_events" | "journal_entries", companyId: string) {
    return (
      await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}
        where company_id = ${companyId}::uuid`.execute(db)
    ).rows[0]!.n;
  }

  // ---------------------------------------------------------------------------
  // THE contract: read one Order through all four interfaces, prove agreement
  // ---------------------------------------------------------------------------

  interface Observation {
    readonly anomalies: readonly (string | null)[];
    readonly company: { readonly health: Health; readonly reasonCode: string; readonly recommendedAction: string };
    readonly verify: FinancialVerification;
    readonly analysisHealth: Health;
    readonly financial: { readonly reasonCode: string; readonly health: Health; readonly repairability: Repairability; readonly repairCapability: string | null };
    readonly preview: { readonly repairability: Repairability; readonly executionAvailable: boolean; readonly proposedRepair: unknown };
  }

  async function observe(fixture: Fixture, orderId: string): Promise<Observation> {
    const number = await orderNumber(orderId);
    // 1. The reconciliation itself, per receivable of the Order.
    const anomalies = (
      await sql<{ anomaly: string | null }>`
        select ${receivableAnomalySql(correlatedReceivableInputs("r"))} as anomaly
          from trader_receivables r
         where r.company_id = ${fixture.companyId}::uuid and r.source_type = 'service_charge'
           and r.source_reference = ${number}`.execute(db)
    ).rows.map((row) => row.anomaly);
    // 2. Company Health: the company-wide, set-based statement.
    const page = await health.list(fixture.companyId, { health: "all", pageSize: 100, scope: "all", search: number });
    const company = page.items.find((row) => row.orderId === orderId);
    expect(company, "Company Health lists the Order").toBeDefined();
    // 3. Verify First (Company user).
    const verify = await as(fixture, () => get(OrderMaintenanceService).financialVerification(orderId));
    // 4. Repair Preview (Platform administrator).
    const analysis = await asPlatform(fixture.companyId, () => previews.analyze(fixture.companyId, orderId));
    const financial = analysis.findings.find((finding) => finding.reasonCode === verify.reasonCode);
    expect(financial, `the Repair Center shows Verify First's finding ${verify.reasonCode}`).toBeDefined();
    const preview = await asPlatform(fixture.companyId, () =>
      previews.preview(fixture.companyId, orderId, { reasonCode: verify.reasonCode }),
    );
    const observation: Observation = {
      analysisHealth: analysis.health,
      anomalies,
      company: { health: company!.health, reasonCode: company!.reasonCode, recommendedAction: company!.recommendedAction },
      financial: {
        health: financial!.health,
        reasonCode: financial!.reasonCode,
        repairCapability: financial!.repairCapability,
        repairability: financial!.repairability,
      },
      preview: {
        executionAvailable: preview.execution.available,
        proposedRepair: preview.proposedRepair,
        repairability: preview.repairability,
      },
      verify,
    };
    // ---- Agreement, whatever the case.
    // Company Health (company-wide) == Repair Center (one Order) == Verify First's view of the Order.
    expect(observation.company.health).toBe(observation.analysisHealth);
    expect(observation.company.reasonCode).toBe(analysis.findings[0]!.reasonCode);
    expect(verify.orderHealth).toBe(observation.company.health);
    expect(verify.findingCodes).toEqual(analysis.findings.filter((f) => f.health !== "HEALTHY").map((f) => f.reasonCode));
    // The Trader receivable finding: health, action required, repairability.
    expect(verify.health).toBe(observation.financial.health);
    expect(verify.actionRequired).toBe(verify.health !== "HEALTHY");
    expect(verify.repairability).toBe(observation.financial.repairability);
    expect(verify.repairCapability).toBe(observation.financial.repairCapability);
    expect(observation.preview.repairability).toBe(verify.repairability);
    // The reconciliation names the same anomaly (or none when healthy).
    if (verify.health === "HEALTHY") {
      expect(anomalies.every((value) => value === null)).toBe(true);
      expect(verify.recommendedAction).toBe("none");
      expect(verify.repairability).toBe("NOT_REQUIRED");
      expect(observation.preview.proposedRepair).toBeNull();
      expect(observation.preview.executionAvailable).toBe(false);
    } else if (anomalies.some((value) => value !== null)) {
      expect(anomalies).toContain(verify.reasonCode);
    }
    expect(JSON.stringify(verify)).not.toContain("reset_then_repair");
    return observation;
  }

  async function expectCase(fixture: Fixture, orderId: string, expected: Expected) {
    const observation = await observe(fixture, orderId);
    expect({
      classification: observation.verify.classification,
      code: observation.verify.reasonCode,
      health: observation.verify.health,
      repairability: observation.verify.repairability,
    }).toEqual({
      classification: expected.classification,
      code: expected.code,
      health: expected.health,
      repairability: expected.repairability,
    });
    expect(observation.verify.recommendedAction).toBe(expected.action ?? "none");
    if (expected.receivable !== undefined) {
      const rows = await currentReceivables(fixture, orderId);
      if (expected.receivable === null) expect(rows).toHaveLength(0);
      else {
        expect(rows[0]).toMatchObject(expected.receivable);
        // The writers applied THE domain status rule.
        expect(rows[0]!.status).toBe(expectedReceivableStatus(rows[0]!.amountCollected, rows[0]!.amountDue));
      }
    }
    return observation;
  }

  const HEALTHY = (code: string, classification = code): Pick<Expected, "classification" | "code" | "health" | "repairability"> => ({
    classification,
    code,
    health: "HEALTHY",
    repairability: "NOT_REQUIRED",
  });

  interface Case {
    readonly n: string;
    readonly title: string;
    readonly arrange: (fixture: Fixture) => Promise<string>;
    readonly expected: Expected;
  }

  // ---------------------------------------------------------------------------
  // The table (Accounting OFF company)
  // ---------------------------------------------------------------------------

  const CASES: readonly Case[] = [
    {
      arrange: async (f) => (await feeOrder(f)).orderId,
      expected: { ...HEALTHY("HEALTHY_ACTIVE_RECEIVABLE"), receivable: { amountCollected: "0.00", status: "outstanding" } },
      n: "1",
      title: "no payment -> outstanding, HEALTHY",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await collect(f, receivableId, 10);
        return orderId;
      },
      expected: { ...HEALTHY("HEALTHY_ACTIVE_RECEIVABLE"), receivable: { amountCollected: "10.00", status: "partially_collected" } },
      n: "2",
      title: "collection writer: 25 due, collect 10 -> partially_collected",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await collect(f, receivableId, 10);
        await collect(f, receivableId, 15);
        return orderId;
      },
      expected: { ...HEALTHY("ALREADY_PHYSICALLY_COLLECTED"), receivable: { amountCollected: "25.00", status: "collected" } },
      n: "3",
      title: "collection writer: collect 10, then 15 more -> collected",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await offset(f, receivableId, 10);
        return orderId;
      },
      expected: { ...HEALTHY("HEALTHY_ACTIVE_RECEIVABLE"), receivable: { amountCollected: "10.00", status: "partially_collected" } },
      n: "4",
      title: "settlement writer: offset 10 -> partially_collected",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await offset(f, receivableId, FEE);
        return orderId;
      },
      expected: { ...HEALTHY("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"), receivable: { amountCollected: "25.00", status: "collected" } },
      n: "5",
      title: "settlement writer: offset 25 -> collected; offset-only is HEALTHY, NOT_REQUIRED, never reset",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await collect(f, receivableId, 5);
        await offset(f, receivableId, 10);
        return orderId;
      },
      expected: { ...HEALTHY("HEALTHY_ACTIVE_RECEIVABLE"), receivable: { amountCollected: "15.00", status: "partially_collected" } },
      n: "6",
      title: "partial collection + partial offset -> partially_collected, HEALTHY",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await collect(f, receivableId, 10);
        await offset(f, receivableId, 15);
        return orderId;
      },
      expected: {
        ...HEALTHY("SETTLED_BY_COLLECTION_AND_OFFSET", "ALREADY_PHYSICALLY_COLLECTED"),
        receivable: { amountCollected: "25.00", status: "collected" },
      },
      n: "7",
      title: "mixed: collection 10 + offset 15 -> collected, HEALTHY, NOT_REQUIRED",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        const settlement = await offset(f, receivableId, FEE);
        await reverseSettlement(f, settlement);
        return orderId;
      },
      expected: { ...HEALTHY("HEALTHY_ACTIVE_RECEIVABLE"), receivable: { amountCollected: "0.00", status: "outstanding" } },
      n: "8",
      title: "reversed offset excluded: the settlement reversal restores outstanding; the historical offset never counts",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await offset(f, receivableId, FEE);
        await reverseReceivable(f, receivableId);
        return orderId;
      },
      expected: {
        action: "repair",
        classification: "REVERSED_NEEDS_REPAIR",
        code: "REVERSED_NEEDS_REPAIR",
        health: "ISSUE",
        receivable: null,
        repairability: "READY",
      },
      n: "9",
      title: "historical reversed receivable (with its Credit) is history, not an anomaly; the Order needs a current one",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await offset(f, receivableId, FEE);
        await reverseReceivable(f, receivableId);
        await repairReceivable(f, orderId);
        const [replacement] = await currentReceivables(f, orderId);
        await offset(f, replacement!.id, FEE);
        return orderId;
      },
      expected: { ...HEALTHY("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"), receivable: { amountCollected: "25.00", status: "collected" } },
      n: "10",
      title: "replacement receivable settled by an effective offset -> HEALTHY (history never makes it unhealthy)",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        // Money has touched it (Phase 3 Prompt 3: never replaced automatically).
        await collect(f, receivableId, 5);
        await crafted(sql`update trader_receivables set original_amount_due = 30 where id = ${receivableId}::uuid`);
        return orderId;
      },
      expected: {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "RECEIVABLE_AMOUNT_MISMATCH",
        health: "ISSUE",
        repairability: "MANUAL_REVIEW",
      },
      n: "11",
      title: "amount mismatch on a receivable with a collection -> ISSUE, MANUAL_REVIEW (no automatic re-amount)",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await crafted(sql`update trader_receivables set amount_collected = 25, status = 'collected' where id = ${receivableId}::uuid`);
        return orderId;
      },
      expected: {
        classification: "NEEDS_REVIEW",
        code: "RECEIVABLE_COLLECTED_AMOUNT_MISMATCH",
        health: "REVIEW",
        repairability: "MANUAL_REVIEW",
      },
      n: "12",
      title: "recorded collected amount with no supporting records -> REVIEW",
    },
    {
      arrange: async (f) => {
        const { orderId } = await feeOrder(f);
        await craftReceivable(f, orderId, "D");
        return orderId;
      },
      expected: { classification: "NEEDS_REVIEW", code: "MULTIPLE_ACTIVE_RECEIVABLES", health: "REVIEW", repairability: "MANUAL_REVIEW" },
      n: "13",
      title: "duplicate active receivable -> REVIEW",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await collect(f, receivableId, FEE);
        await craftOffset(f, f.traderId, receivableId, 10);
        return orderId;
      },
      expected: { classification: "NEEDS_REVIEW", code: "RECEIVABLE_OVER_COLLECTED", health: "REVIEW", repairability: "MANUAL_REVIEW" },
      n: "14",
      title: "over-collected (collection + offset beyond the amount due) -> REVIEW",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await craftAllocation(f, await secondTrader(f), receivableId, FEE);
        await crafted(sql`update trader_receivables set amount_collected = 25, status = 'collected' where id = ${receivableId}::uuid`);
        return orderId;
      },
      expected: {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "COLLECTION_ALLOCATION_MISMATCH",
        health: "ISSUE",
        repairability: "MANUAL_REVIEW",
      },
      n: "15",
      title: "allocation mismatch (another Trader's collection) -> ISSUE, MANUAL_REVIEW",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await cancelReceivable(f, receivableId);
        await craftAllocation(f, f.traderId, receivableId, 5);
        return orderId;
      },
      expected: {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "ORPHAN_COLLECTION_ALLOCATION",
        health: "ISSUE",
        repairability: "MANUAL_REVIEW",
      },
      n: "16",
      title: "orphan allocation on a cancelled receivable -> ISSUE, MANUAL_REVIEW",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await craftOffset(f, await secondTrader(f), receivableId, FEE);
        await crafted(sql`update trader_receivables set amount_collected = 25, status = 'collected' where id = ${receivableId}::uuid`);
        return orderId;
      },
      expected: {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "SETTLEMENT_OFFSET_MISMATCH",
        health: "ISSUE",
        repairability: "MANUAL_REVIEW",
      },
      n: "17",
      title: "offset mismatch (another Trader's settlement) -> ISSUE, MANUAL_REVIEW",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await crafted(sql`update trader_receivables set status = 'collected' where id = ${receivableId}::uuid`);
        return orderId;
      },
      expected: {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT",
        health: "ISSUE",
        repairability: "READY",
      },
      n: "18",
      title: "marked collected without effective settlement -> ISSUE, READY",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await offset(f, receivableId, FEE);
        await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);
        return orderId;
      },
      expected: {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN",
        health: "ISSUE",
        repairability: "READY",
      },
      n: "19",
      title: "financially settled but still open -> ISSUE, READY",
    },
    {
      arrange: async (f) => {
        const { orderId, receivableId } = await feeOrder(f);
        await collect(f, receivableId, 10);
        await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);
        return orderId;
      },
      expected: {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "RECEIVABLE_PARTIAL_STATE_MISMATCH",
        health: "ISSUE",
        repairability: "READY",
      },
      n: "20",
      title: "partial-state mismatch -> ISSUE, READY",
    },
    {
      arrange: (f) => deliveredOrder(f, COD, "customer_pays_cod_trader_pays_fee"),
      expected: { ...HEALTHY("NO_TRADER_RECEIVABLE_REQUIRED"), receivable: null },
      n: "21",
      title: "COD covers the fee -> no receivable required, HEALTHY",
    },
    {
      arrange: (f) => legacyOrderWithoutReceivable(f),
      expected: {
        action: "repair",
        classification: "MISSING_RECEIVABLE",
        code: "MISSING_RECEIVABLE",
        health: "ISSUE",
        receivable: null,
        repairability: "READY",
      },
      n: "22",
      title: "Accounting OFF: a missing required receivable -> ISSUE, READY",
    },
  ];

  describe("Accounting OFF company -- matrix table", () => {
    let fixture: Fixture;
    let companyB: Fixture;
    let bBefore = "";

    beforeAll(async () => {
      fixture = await createFixture("off");
      companyB = await createFixture("off");
      const b = await feeOrder(companyB);
      await offset(companyB, b.receivableId, FEE);
      bBefore = await footprint(companyB.companyId);
    }, 240_000);

    it("allows correcting a service fee on a zero-COD customer-pays-fee order without changing COD", async () => {
      const order = (await as(fixture, () =>
        get(OperationsService).createOrder(
          {
            areaId: fixture.areaId,
            codAmount: 0,
            customerAddress: "Address",
            customerMobileNumber: "0501234567",
            customerName: "Customer",
            packageCount: 1,
            paymentCondition: "customer_pays_cod_and_fee",
            serialNumber: `FT-EDIT-${randomUUID().slice(0, 8)}`,
            traderId: fixture.traderId,
          } as never,
          randomUUID(),
          key("zero-cod-edit-create"),
        ),
      )) as { id: string };

      await as(fixture, () =>
        get(OperationsService).updateOrder(
          order.id,
          { serviceFee: 20, serviceFeeReason: "Correcting the entered fee" } as never,
          randomUUID(),
        ),
      );

      const saved = await sql<{
        codAmount: string;
        customerAmountDue: string;
        serviceFee: string;
        totalDeductions: string;
        traderDeductions: string;
        traderNetPayable: string;
        traderPaidServiceFee: string;
      }>`select cod_amount::text as "codAmount",
                customer_amount_due::text as "customerAmountDue",
                service_fee::text as "serviceFee",
                total_deductions::text as "totalDeductions",
                trader_deductions::text as "traderDeductions",
                trader_net_payable::text as "traderNetPayable",
                trader_paid_service_fee::text as "traderPaidServiceFee"
           from orders where id=${order.id}::uuid and company_id=${fixture.companyId}::uuid`.execute(db);
      expect(saved.rows[0]).toEqual({
        codAmount: "0.00",
        customerAmountDue: "20.00",
        serviceFee: "20.00",
        totalDeductions: "0.00",
        traderDeductions: "0.00",
        traderNetPayable: "0.00",
        traderPaidServiceFee: "0.00",
      });
    });

    afterAll(async () => {
      // Nothing done to Company A ever changes Company B.
      expect(await footprint(companyB.companyId)).toBe(bBefore);
    });

    for (const testCase of CASES) {
      it(`MATRIX ${testCase.n}: ${testCase.title}`, async () => {
        const orderId = await testCase.arrange(fixture);
        // Reading is read-only through every interface.
        const before = await footprint(fixture.companyId);
        await expectCase(fixture, orderId, testCase.expected);
        expect(await footprint(fixture.companyId), "no interface writes while reading").toBe(before);
      });
    }

    // -------------------------------------------------------------- reversals
    // The EXISTING reversal contract of the certified writers (documented, not
    // invented): a reversal backs out exactly its own contribution from
    // amount_collected and re-applies THE domain status rule; every other
    // effective collection / offset keeps counting.

    it("REVERSAL: collection 25 reversed -> outstanding, HEALTHY", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const collection = await collect(fixture, receivableId, FEE);
      await reverseCollection(fixture, collection);
      await expectCase(fixture, orderId, { ...HEALTHY("HEALTHY_ACTIVE_RECEIVABLE"), receivable: { amountCollected: "0.00", status: "outstanding" } });
    });

    it("REVERSAL: offset 15 + collection 10, collection reversed -> 15 remains, partially_collected, HEALTHY", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, 15);
      const collection = await collect(fixture, receivableId, 10);
      await reverseCollection(fixture, collection);
      await expectCase(fixture, orderId, {
        ...HEALTHY("HEALTHY_ACTIVE_RECEIVABLE"),
        receivable: { amountCollected: "15.00", status: "partially_collected" },
      });
    });

    it("REVERSAL: collection 10 + offset 15, settlement reversed -> 10 remains, partially_collected, HEALTHY", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, 10);
      const settlement = await offset(fixture, receivableId, 15);
      await reverseSettlement(fixture, settlement);
      const observation = await expectCase(fixture, orderId, {
        ...HEALTHY("HEALTHY_ACTIVE_RECEIVABLE"),
        receivable: { amountCollected: "10.00", status: "partially_collected" },
      });
      expect(observation.verify.historicalSettlementOffsetAmount).toBe("15.00");
      expect(observation.verify.settlementOffsetAmount).toBe("0.00");
    });

    it("REVERSAL: a reversal that left the status behind is detected as ISSUE (READY to reconcile)", async () => {
      // What a status-skipping reversal would leave: the amount is backed out,
      // the status is not. The certified writers never do this; the
      // reconciliation catches it if anything ever does.
      const { orderId, receivableId } = await feeOrder(fixture);
      const collection = await collect(fixture, receivableId, FEE);
      await reverseCollection(fixture, collection);
      await crafted(sql`update trader_receivables set status = 'collected' where id = ${receivableId}::uuid`);
      await expectCase(fixture, orderId, {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT",
        health: "ISSUE",
        repairability: "READY",
      });
    });

    // ----------------------------------------------------- MATRIX 24 / 25 / 26

    async function requestFor(orderId: string, reason: string): Promise<RepairExecutionRequest> {
      const preview = await asPlatform(fixture.companyId, () => previews.preview(fixture.companyId, orderId));
      return {
        capabilityCode: preview.proposedRepair?.capabilityCode ?? "RECONCILE_TRADER_RECEIVABLE",
        findingId: preview.finding.findingId,
        idempotencyKey: `ft-exec-${randomUUID()}`,
        previewVersion: preview.previewVersion,
        reason,
      };
    }

    const actor = () => ({
      accountId: adminId,
      authority: "platform.companies.repair_center.execute",
      correlationId: `ft-exec-${randomUUID()}`,
    });

    const run = (orderId: string, request: RepairExecutionRequest) =>
      asPlatform(fixture.companyId, () => executions.execute(fixture.companyId, orderId, request, actor()));

    it("MATRIX 24: stale -- a relevant change after the preview refuses execution with zero mutation", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);
      const request = await requestFor(orderId, "Settled but left open");
      await crafted(sql`update orders set version = version + 1 where id = ${orderId}::uuid`);
      const before = await footprint(fixture.companyId);
      await expect(run(orderId, request)).rejects.toMatchObject({ errorCode: "repair_preview_stale" });
      // The refusal only records its attempt (platform_repair_attempts is not in the footprint).
      expect(await footprint(fixture.companyId)).toBe(before);
    });

    it("MATRIX 25 + 26: a successful reconcile converges all four interfaces on HEALTHY; a replay and a re-run change nothing", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, 10);
      await offset(fixture, receivableId, 15);
      await crafted(sql`update trader_receivables set status = 'partially_collected' where id = ${receivableId}::uuid`);
      await expectCase(fixture, orderId, {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN",
        health: "ISSUE",
        repairability: "READY",
      });
      const request = await requestFor(orderId, "Mixed settlement left open");
      const result = await run(orderId, request);
      expect(result).toMatchObject({ afterHealth: "HEALTHY", capabilityCode: "RECONCILE_TRADER_RECEIVABLE", replayed: false });
      await expectCase(fixture, orderId, {
        ...HEALTHY("SETTLED_BY_COLLECTION_AND_OFFSET", "ALREADY_PHYSICALLY_COLLECTED"),
        receivable: { amountCollected: "25.00", status: "collected" },
      });
      // MATRIX 26: idempotent.
      const before = await footprint(fixture.companyId);
      expect(await run(orderId, request)).toMatchObject({ replayed: true, repairExecutionId: result.repairExecutionId });
      const again = await db.transaction().execute((transaction) =>
        get(TraderReceivableService).reconcileReceivableStatusInTransaction(transaction, fixture.companyId, receivableId, "x", {
          actorAccountId: null,
          actorRole: "test",
        }),
      );
      expect(again.changed).toBe(false);
      expect(await footprint(fixture.companyId)).toBe(before);
      // Verify First is itself idempotent and read-only.
      const first = await as(fixture, () => get(OrderMaintenanceService).financialVerification(orderId));
      const second = await as(fixture, () => get(OrderMaintenanceService).financialVerification(orderId));
      expect(second).toEqual(first);
      expect(await footprint(fixture.companyId)).toBe(before);
    });

    // ------------------------------------------------------------- MATRIX 27
    // Known production patterns, synthetic (no production data is read).

    it("MATRIX 27 / ORD-000108: offset-only settlement -> HEALTHY everywhere, no reset, no repair", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      const observation = await expectCase(fixture, orderId, HEALTHY("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"));
      expect(observation.company).toMatchObject({ health: "HEALTHY", recommendedAction: "none" });
      expect(observation.verify).toMatchObject({ actionRequired: false, recommendedAction: "none" });
    });

    it("MATRIX 27 / ORD-000111: ONE settlement offsetting two Orders' receivables -> both HEALTHY", async () => {
      const a = await feeOrder(fixture);
      const b = await feeOrder(fixture);
      await settle(fixture, [
        { amount: FEE, receivableId: a.receivableId },
        { amount: FEE, receivableId: b.receivableId },
      ]);
      await expectCase(fixture, a.orderId, HEALTHY("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"));
      await expectCase(fixture, b.orderId, HEALTHY("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"));
    });

    it("MATRIX 27 / ORD-000110: reversed receivable (with Credit) + replacement settled by offset -> HEALTHY", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await reverseReceivable(fixture, receivableId);
      await repairReceivable(fixture, orderId);
      const [replacement] = await currentReceivables(fixture, orderId);
      await offset(fixture, replacement!.id, FEE);
      await expectCase(fixture, orderId, HEALTHY("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"));
    });

    it("MATRIX 27 / ORD-000008: cancelled receivable + replacement fully settled by offset -> HEALTHY", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await cancelReceivable(fixture, receivableId);
      const replacement = await craftReceivable(fixture, orderId, "R");
      await offset(fixture, replacement, FEE);
      await expectCase(fixture, orderId, HEALTHY("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"));
    });

    it("MATRIX 27 / ORD-000088: COD covers the fee -> HEALTHY, no receivable", async () => {
      const orderId = await deliveredOrder(fixture, COD, "customer_pays_cod_trader_pays_fee");
      await expectCase(fixture, orderId, { ...HEALTHY("NO_TRADER_RECEIVABLE_REQUIRED"), receivable: null });
    });

    it("MATRIX 27 / ORD-000100: two reversed settlements then an effective one -> HEALTHY, history not counted", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await reverseSettlement(fixture, await offset(fixture, receivableId, FEE));
      await reverseSettlement(fixture, await offset(fixture, receivableId, FEE));
      await offset(fixture, receivableId, FEE);
      const observation = await expectCase(fixture, orderId, {
        ...HEALTHY("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"),
        receivable: { amountCollected: "25.00", status: "collected" },
      });
      expect(observation.verify.settlementOffsetAmount).toBe("25.00");
      expect(observation.verify.historicalSettlementOffsetAmount).toBe("50.00");
    });
  });

  // ---------------------------------------------------------------------------
  // MATRIX 23: Accounting ON
  // ---------------------------------------------------------------------------

  describe("Accounting ON company", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createFixture("on");
    }, 240_000);

    it("MATRIX 23: offset-only settlement is HEALTHY with Accounting ON too", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await expectCase(fixture, orderId, {
        ...HEALTHY("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"),
        receivable: { amountCollected: "25.00", status: "collected" },
      });
    });

    it("MATRIX 23: a missing receivable is ISSUE / BLOCKED for the Platform (PLATFORM_ACTOR_CANNOT_POST_JOURNAL), everywhere", async () => {
      const orderId = await legacyOrderWithoutReceivable(fixture);
      const observation = await expectCase(fixture, orderId, {
        action: "repair",
        classification: "MISSING_RECEIVABLE",
        code: "MISSING_RECEIVABLE",
        health: "ISSUE",
        repairability: "BLOCKED",
      });
      const preview = await asPlatform(fixture.companyId, () => previews.preview(fixture.companyId, orderId));
      expect(preview.blockers.map((blocker) => blocker.code)).toContain("PLATFORM_ACTOR_CANNOT_POST_JOURNAL");
      expect(observation.preview.executionAvailable).toBe(false);
    });

    it("MATRIX 23: status reconcile creates no journal, no accounting event, and impersonates no Company user", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);
      await expectCase(fixture, orderId, {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN",
        health: "ISSUE",
        repairability: "READY",
      });
      const events = await companyCount("accounting_events", fixture.companyId);
      const journals = await companyCount("journal_entries", fixture.companyId);
      const preview = await asPlatform(fixture.companyId, () => previews.preview(fixture.companyId, orderId));
      await asPlatform(fixture.companyId, () =>
        executions.execute(
          fixture.companyId,
          orderId,
          {
            capabilityCode: "RECONCILE_TRADER_RECEIVABLE",
            findingId: preview.finding.findingId,
            idempotencyKey: `ft-on-${randomUUID()}`,
            previewVersion: preview.previewVersion,
            reason: "Settled by offset but left open",
          },
          { accountId: adminId, authority: "platform.companies.repair_center.execute", correlationId: `ft-on-${randomUUID()}` },
        ),
      );
      expect(await companyCount("accounting_events", fixture.companyId)).toBe(events);
      expect(await companyCount("journal_entries", fixture.companyId)).toBe(journals);
      // No Company user is impersonated: the domain audit carries NO Company
      // actor (only the role), and the Platform administrator is recorded on
      // the immutable Platform repair execution.
      const audit = (
        await sql<{ actor: string | null; role: string }>`
          select actor_account_id::text as actor, after_data->>'actorRole' as role
            from audit_events
           where company_id = ${fixture.companyId}::uuid and action = 'trader_receivable.status_reconciled'
             and subject_id = ${receivableId}`.execute(db)
      ).rows;
      expect(audit).toEqual([{ actor: null, role: "Platform Repair Center" }]);
      const execution = (
        await sql<{ actor: string; kind: string }>`
          select e.actor_account_id::text as actor, acc.account_kind as kind
            from platform_repair_executions e join accounts acc on acc.id = e.actor_account_id
           where e.company_id = ${fixture.companyId}::uuid and e.order_id = ${orderId}::uuid`.execute(db)
      ).rows;
      expect(execution).toEqual([{ actor: adminId, kind: "platform_administrator" }]);
      await expectCase(fixture, orderId, HEALTHY("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"));
    });
  });
});
