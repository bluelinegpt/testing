import { createHash, randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { CashBankManagementService } from "../accounting/cash-bank-management.service.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
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
 * REPAIR CENTER PHASE 3 -- PROMPT 4: historical financial truth, reversal
 * safety and final Phase 3 certification (matrix 1-30).
 *
 * THE expected Trader receivable amount is what the Order required when its
 * obligation was set -- its own stored obligation (trader_deduction_v1:
 * greatest(total_deductions - COD, 0), coherent with its VAT snapshot) --
 * never a later Company VAT setting. A legacy Order without that snapshot is
 * never re-priced and never repaired automatically.
 *
 * Every case reads the Order through the reconciliation, Company Health,
 * Verify First and the Repair Preview (the Prompt 2 contract) and pins the
 * expected amount in each of them.
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

describe.skipIf(!runDatabaseTests)("Phase 3 Prompt 4 -- historical financial truth + reversal safety", () => {
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
      values (${adminId}::uuid, null, 'platform_administrator', ${`p4.exec.${adminId}`}, 'x', 'disabled')`.execute(db);
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

  const key = (label: string) => `p4.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`P4H-${tag}`},${`p4h-${tag}`},${`P4 history ${mode} ${tag}`},
              'active',now())`.execute(db);
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`p4h.${actorId}`},'x','disabled')`.execute(db);
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
          serialNumber: `P4-${Date.now()}-${serial}`,
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


  // ---------------------------------------------------------------------------
  // Prompt 3 helpers
  // ---------------------------------------------------------------------------

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const actor = () => ({
    accountId: adminId,
    authority: "platform.companies.repair_center.execute",
    correlationId: `p3-exec-${randomUUID()}`,
  });

  async function requestFor(fixture: Fixture, orderId: string, reasonCode?: string): Promise<RepairExecutionRequest> {
    const preview = await asPlatform(fixture.companyId, () =>
      previews.preview(fixture.companyId, orderId, reasonCode === undefined ? {} : { reasonCode }),
    );
    return {
      capabilityCode: preview.proposedRepair?.capabilityCode ?? "RECONCILE_TRADER_RECEIVABLE",
      findingId: preview.finding.findingId,
      idempotencyKey: `p3-exec-${randomUUID()}`,
      previewVersion: preview.previewVersion,
      reason: "Phase 3 Prompt 3 certification",
    };
  }

  function run(fixture: Fixture, orderId: string, request: RepairExecutionRequest) {
    return asPlatform(fixture.companyId, () => executions.execute(fixture.companyId, orderId, request, actor()));
  }

  async function finding(fixture: Fixture, orderId: string, reasonCode: string) {
    const analysis = await asPlatform(fixture.companyId, () => previews.analyze(fixture.companyId, orderId));
    const found = analysis.findings.find((item) => item.reasonCode === reasonCode);
    expect(found, `finding ${reasonCode}`).toBeDefined();
    return found!;
  }

  async function attempts(fixture: Fixture, orderId: string) {
    return (
      await sql<{ result: string; code: string | null }>`
        select result, error_code as code from platform_repair_attempts
         where company_id = ${fixture.companyId}::uuid and entity_id = ${orderId}::uuid order by created_at`.execute(db)
    ).rows;
  }

  /**
   * MANUAL_REVIEW in every interface, a useful explanation, no executable
   * repair, and an execution attempt that changes nothing (MATRIX 27).
   */
  async function expectManualReview(
    fixture: Fixture,
    orderId: string,
    code: string,
    health: "ISSUE" | "REVIEW",
    because?: string,
  ) {
    await expectCase(fixture, orderId, {
      classification: health === "ISSUE" ? "RECEIVABLE_INCONSISTENT" : "NEEDS_REVIEW",
      code,
      health,
      repairability: "MANUAL_REVIEW",
    });
    const item = await finding(fixture, orderId, code);
    expect(item.repairability).toBe("MANUAL_REVIEW");
    const review = item.manualReview;
    expect(review, "a MANUAL_REVIEW finding explains itself").not.toBeNull();
    expect(review!.headline).toBe("Manual review required");
    expect(review!.reason.length).toBeGreaterThan(0);
    expect(review!.whyAutomaticRepairIsUnavailable.length).toBeGreaterThan(0);
    expect(review!.financialComparison.traderOwes).toBe("25.00");
    expect(review!.financialComparison.receivables.length).toBeGreaterThan(0);
    if (because !== undefined) {
      expect(review!.whyAutomaticRepairIsUnavailable.join(" ")).toContain(because);
    }
    const preview = await asPlatform(fixture.companyId, () => previews.preview(fixture.companyId, orderId, { reasonCode: code }));
    expect(preview.repairability).toBe("MANUAL_REVIEW");
    expect(preview.execution.available).toBe(false);
    expect(preview.finding.manualReview).toEqual(review);
    // MATRIX 27: zero mutation, whatever is attempted.
    const request = await requestFor(fixture, orderId, code);
    const before = await footprint(fixture.companyId);
    await expect(run(fixture, orderId, request)).rejects.toMatchObject({
      errorCode: expect.stringMatching(/^repair_(not_ready|capability_not_applicable)$/u),
    });
    expect(await footprint(fixture.companyId), "a MANUAL_REVIEW finding is never mutated").toBe(before);
    return review!;
  }

  async function healthyEverywhere(fixture: Fixture, orderId: string, code: string, classification = code) {
    await expectCase(fixture, orderId, HEALTHY(code, classification));
    const analysis = await asPlatform(fixture.companyId, () => previews.analyze(fixture.companyId, orderId));
    expect(analysis.findings.every((item) => item.repairability === "NOT_REQUIRED" && item.manualReview === null)).toBe(true);
  }


  // ---------------------------------------------------------------------------
  // Prompt 4 helpers
  // ---------------------------------------------------------------------------

  /** The Company's CURRENT VAT policy (what new Orders are priced under). */
  async function setVat(fixture: Fixture, policy: { enabled: false } | { enabled: true; mode: "inclusive" | "exclusive"; rate: number }) {
    await sql`insert into company_settings (company_id, vat_enabled, vat_price_mode, vat_rate)
      values (${fixture.companyId}::uuid, ${policy.enabled}, ${policy.enabled ? policy.mode : null},
              ${policy.enabled ? policy.rate : null})
      on conflict (company_id) do update set vat_enabled = excluded.vat_enabled,
        vat_price_mode = excluded.vat_price_mode, vat_rate = excluded.vat_rate,
        version = company_settings.version + 1, updated_at = now()`.execute(db);
  }

  /** A zero-COD Trader-pays-fee Order priced under the Company's CURRENT VAT. */
  async function vatFeeOrder(fixture: Fixture) {
    const orderId = await deliveredOrder(fixture, 0, "customer_pays_cod_trader_pays_fee");
    const rows = await currentReceivables(fixture, orderId);
    expect(rows).toHaveLength(1);
    return { amountDue: rows[0]!.amountDue, orderId, receivableId: rows[0]!.id };
  }

  /**
   * THE expected amount, read through every interface; they must agree
   * (Company Health's evaluation, Verify First, the Repair Preview's current
   * state and the finding evidence).
   */
  async function expectedEverywhere(fixture: Fixture, orderId: string, amount: string, provable: boolean) {
    const evaluation = await health.orderEvaluation(db, fixture.companyId, orderId);
    const verify = await as(fixture, () => get(OrderMaintenanceService).financialVerification(orderId));
    const preview = await asPlatform(fixture.companyId, () => previews.preview(fixture.companyId, orderId));
    expect({
      evaluation: evaluation!.traderDue,
      evidence: preview.finding.evidence.traderOwes,
      preview: preview.currentState.traderOwes,
      provable: evaluation!.amountProvable,
      verify: verify.traderOwes,
    }).toEqual({
      evaluation: expect.stringMatching(new RegExp(`^${amount.replace(".", "\\.")}0*$`, "u")),
      evidence: expect.stringMatching(new RegExp(`^${amount.replace(".", "\\.")}0*$`, "u")),
      preview: expect.stringMatching(new RegExp(`^${amount.replace(".", "\\.")}0*$`, "u")),
      provable,
      verify: amount,
    });
  }

  /** A crafted LEGACY Order (no model version, no VAT snapshot), optionally with a receivable. */
  async function legacyOrder(fixture: Fixture, receivableAmount?: number) {
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
    let receivableId: string | undefined;
    if (receivableAmount !== undefined) {
      receivableId = await craftReceivable(fixture, orderId, "L");
      await crafted(sql`update trader_receivables set original_amount_due = ${receivableAmount} where id = ${receivableId}::uuid`);
    }
    return { orderId, receivableId };
  }

  /** Crafted: a CONFIRMED Collection allocated to the given receivables (disposable DB only). */
  async function craftCollection(fixture: Fixture, allocations: readonly { receivableId: string; amount: number }[]) {
    const collectionId = randomUUID();
    const total = allocations.reduce((sum, row) => sum + row.amount, 0);
    await crafted(sql`insert into trader_collections(id,company_id,collection_number,trader_id,payment_date,
        payment_method,amount_received,status,received_by_account_id)
      values (${collectionId}::uuid,${fixture.companyId}::uuid,${`COL-H${collectionId.slice(0, 6)}`},
        ${fixture.traderId}::uuid,current_date,'cash',${total},'confirmed',${fixture.actorId}::uuid)`);
    for (const row of allocations) {
      await crafted(sql`insert into trader_collection_allocations(company_id,collection_id,receivable_id,amount_allocated)
        values (${fixture.companyId}::uuid,${collectionId}::uuid,${row.receivableId}::uuid,${row.amount})`);
    }
    return collectionId;
  }

  async function receivableRow(receivableId: string) {
    return (
      await sql<{ status: string; amountCollected: string; updatedAt: string }>`
        select status, amount_collected::text as "amountCollected", updated_at::text as "updatedAt"
          from trader_receivables where id = ${receivableId}::uuid`.execute(db)
    ).rows[0]!;
  }

  // ---------------------------------------------------------------------------
  // VAT history (MATRIX 1-7, 17-19)
  // ---------------------------------------------------------------------------

  describe("historical VAT truth", () => {
    let fixture: Fixture;

    beforeAll(async () => {
      fixture = await createFixture("off");
    }, 240_000);

    it("MATRIX 1 + 2 + 3 + 7: an Order priced under VAT X stays HEALTHY at X after the Company moves to Y; a new Order uses Y; no cross-era contamination", async () => {
      await setVat(fixture, { enabled: true, mode: "exclusive", rate: 5 });
      const a = await vatFeeOrder(fixture);
      expect(a.amountDue).toBe("26.25");
      // MATRIX 1: Company still at X.
      await healthyEverywhere(fixture, a.orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      await expectedEverywhere(fixture, a.orderId, "26.25", true);
      // MATRIX 2 + 7: the Company changes to Y; Order A is NOT re-priced.
      await setVat(fixture, { enabled: true, mode: "exclusive", rate: 10 });
      await healthyEverywhere(fixture, a.orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      await expectedEverywhere(fixture, a.orderId, "26.25", true);
      // MATRIX 3: a new Order B is priced under Y by the normal domain path.
      const b = await vatFeeOrder(fixture);
      expect(b.amountDue).toBe("27.50");
      await healthyEverywhere(fixture, b.orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      await expectedEverywhere(fixture, b.orderId, "27.50", true);
      // ... and neither era contaminates the other: VAT off now, both still HEALTHY at their own amounts.
      await setVat(fixture, { enabled: false });
      await expectedEverywhere(fixture, a.orderId, "26.25", true);
      await expectedEverywhere(fixture, b.orderId, "27.50", true);
      await healthyEverywhere(fixture, a.orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      await healthyEverywhere(fixture, b.orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      // A collected historical receivable stays HEALTHY too.
      await collect(fixture, a.receivableId, 26.25);
      await healthyEverywhere(fixture, a.orderId, "ALREADY_PHYSICALLY_COLLECTED");
    });

    it("MATRIX 4: legacy Orders (no VAT snapshot) are never re-priced: matching -> HEALTHY; differing -> REVIEW / MANUAL_REVIEW; missing -> ISSUE but MANUAL_REVIEW", async () => {
      await setVat(fixture, { enabled: false });
      const matching = await legacyOrder(fixture, FEE);
      await healthyEverywhere(fixture, matching.orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      await expectedEverywhere(fixture, matching.orderId, "25.00", false);

      const differing = await legacyOrder(fixture, 20);
      await expectManualReview(fixture, differing.orderId, "RECEIVABLE_AMOUNT_NOT_PROVABLE", "REVIEW", "never used to re-price");

      const missing = await legacyOrder(fixture);
      await expectCase(fixture, missing.orderId, {
        action: "repair",
        classification: "MISSING_RECEIVABLE",
        code: "MISSING_RECEIVABLE",
        health: "ISSUE",
        repairability: "MANUAL_REVIEW",
      });
      const item = await finding(fixture, missing.orderId, "MISSING_RECEIVABLE");
      expect(item.manualReview?.whyAutomaticRepairIsUnavailable.join(" ")).toContain("cannot be proven");
      const request = await requestFor(fixture, missing.orderId);
      const before = await footprint(fixture.companyId);
      await expect(run(fixture, missing.orderId, request)).rejects.toMatchObject({ errorCode: "repair_not_ready" });
      expect(await footprint(fixture.companyId)).toBe(before);
    });

    it("MATRIX 5: wrong unused receivable, historical amount provable (priced under inclusive VAT, Company since moved to exclusive) -> READY; replaced at the HISTORICAL amount", async () => {
      await setVat(fixture, { enabled: true, mode: "inclusive", rate: 5 });
      const { orderId, receivableId } = await vatFeeOrder(fixture);
      await setVat(fixture, { enabled: true, mode: "exclusive", rate: 10 }); // today's rule would say 27.50
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${receivableId}::uuid`);
      await expectCase(fixture, orderId, {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "RECEIVABLE_AMOUNT_MISMATCH",
        health: "ISSUE",
        repairability: "READY",
      });
      await expectedEverywhere(fixture, orderId, "25.00", true);
      const result = await run(fixture, orderId, await requestFor(fixture, orderId));
      expect(result).toMatchObject({ afterHealth: "HEALTHY", capabilityCode: "REPLACE_UNUSED_TRADER_RECEIVABLE" });
      const rows = await currentReceivables(fixture, orderId);
      expect(rows.map((row) => row.amountDue)).toEqual(["25.00"]); // never 27.50
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      await setVat(fixture, { enabled: false });
    });

    it("MATRIX 5b: wrong unused receivable under exclusive VAT -> BLOCKED (the certified re-creation bills the fee without its VAT)", async () => {
      await setVat(fixture, { enabled: true, mode: "exclusive", rate: 5 });
      const { orderId, receivableId } = await vatFeeOrder(fixture);
      await setVat(fixture, { enabled: false });
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${receivableId}::uuid`);
      await expectCase(fixture, orderId, {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "RECEIVABLE_AMOUNT_MISMATCH",
        health: "ISSUE",
        repairability: "BLOCKED",
      });
      await expectedEverywhere(fixture, orderId, "26.25", true);
      expect((await finding(fixture, orderId, "RECEIVABLE_AMOUNT_MISMATCH")).blockers.map((b) => b.code)).toContain(
        "REPAIR_AMOUNT_DIFFERS_FROM_FINANCIAL_MODEL",
      );
    });

    it("MATRIX 6: wrong unused receivable on a legacy Order (amount not provable) -> MANUAL_REVIEW, zero mutation", async () => {
      await setVat(fixture, { enabled: false });
      const { orderId } = await legacyOrder(fixture, 30);
      await expectManualReview(fixture, orderId, "RECEIVABLE_AMOUNT_NOT_PROVABLE", "REVIEW");
    });

    it("MATRIX 17: a VAT-relevant change to the Order's stored obligation after the preview -> 409 stale, zero mutation", async () => {
      await setVat(fixture, { enabled: false });
      const { orderId, receivableId } = await vatFeeOrder(fixture);
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${receivableId}::uuid`);
      const request = await requestFor(fixture, orderId);
      // The Order's obligation moves (fee 25 -> 30), coherently with the v1 rules.
      await crafted(sql`update orders set service_fee = 30, final_service_fee_snapshot = 30, service_fee_net_amount = 30,
          total_deductions = 30, trader_paid_service_fee = 30 where id = ${orderId}::uuid`);
      const before = await footprint(fixture.companyId);
      await expect(run(fixture, orderId, request)).rejects.toMatchObject({ errorCode: "repair_preview_stale" });
      expect(await footprint(fixture.companyId)).toBe(before);
    });

    it("MATRIX 18: REPLACE_UNUSED stale protection -- money reaching the receivable after the preview refuses with zero mutation", async () => {
      await setVat(fixture, { enabled: false });
      const { orderId, receivableId } = await vatFeeOrder(fixture);
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${receivableId}::uuid`);
      const request = await requestFor(fixture, orderId);
      expect(request.capabilityCode).toBe("REPLACE_UNUSED_TRADER_RECEIVABLE");
      await collect(fixture, receivableId, 5);
      const before = await footprint(fixture.companyId);
      await expect(run(fixture, orderId, request)).rejects.toMatchObject({ errorCode: "repair_preview_stale" });
      expect(await footprint(fixture.companyId)).toBe(before);
      await expectManualReview(fixture, orderId, "RECEIVABLE_AMOUNT_MISMATCH", "ISSUE", "already carries collections");
    });

    it("MATRIX 19: duplicate cancellation keeps working across a VAT change (canonical amount is the historical one)", async () => {
      await setVat(fixture, { enabled: true, mode: "exclusive", rate: 5 });
      const { orderId, receivableId } = await vatFeeOrder(fixture);
      await collect(fixture, receivableId, 26.25);
      await setVat(fixture, { enabled: false });
      const duplicateId = await craftReceivable(fixture, orderId, "D");
      await expectCase(fixture, orderId, {
        classification: "NEEDS_REVIEW",
        code: "MULTIPLE_ACTIVE_RECEIVABLES",
        health: "REVIEW",
        repairability: "READY",
      });
      await run(fixture, orderId, await requestFor(fixture, orderId));
      expect((await receivableRow(duplicateId)).status).toBe("cancelled");
      await healthyEverywhere(fixture, orderId, "ALREADY_PHYSICALLY_COLLECTED");
      await expectedEverywhere(fixture, orderId, "26.25", true);
    });
  });

  // ---------------------------------------------------------------------------
  // Collection reversal safety (MATRIX 8-15) + regressions (20-30), Accounting OFF
  // ---------------------------------------------------------------------------

  describe("collection reversal safety and regressions (Accounting OFF)", () => {
    let fixture: Fixture;
    let companyB: Fixture;
    let bBefore = "";

    beforeAll(async () => {
      fixture = await createFixture("off");
      companyB = await createFixture("off");
      const b = await feeOrder(companyB);
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${b.receivableId}::uuid`);
      bBefore = await footprint(companyB.companyId);
    }, 240_000);

    afterAll(async () => {
      expect(await footprint(companyB.companyId)).toBe(bBefore);
    });

    it("MATRIX 8: reversing a Collection allocated to a CANCELLED receivable leaves it cancelled and untouched (history)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await cancelReceivable(fixture, receivableId);
      const collectionId = await craftCollection(fixture, [{ amount: 5, receivableId }]);
      const before = await receivableRow(receivableId);
      await reverseCollection(fixture, collectionId);
      expect(await receivableRow(receivableId)).toEqual(before);
      const audit = (
        await sql<{ unchanged: string | null }>`select after_data->>'receivableUnchanged' as unchanged from audit_events
          where company_id = ${fixture.companyId}::uuid and action = 'trader_receivable.collection_reversed'
            and subject_id = ${receivableId}`.execute(db)
      ).rows;
      expect(audit).toEqual([{ unchanged: "true" }]);
      // The orphan is gone (its Collection no longer counts); the Order needs its receivable.
      const observation = await observe(fixture, orderId);
      expect(observation.verify.reasonCode).toBe("REVERSED_NEEDS_REPAIR");
      expect(observation.anomalies.every((value) => value === null)).toBe(true);
    });

    it("MATRIX 9: reversing a Collection allocated to a REVERSED receivable never resurrects it", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await reverseReceivable(fixture, receivableId);
      const collectionId = await craftCollection(fixture, [{ amount: 5, receivableId }]);
      const before = await receivableRow(receivableId);
      expect(before.status).toBe("reversed");
      await reverseCollection(fixture, collectionId);
      expect(await receivableRow(receivableId)).toEqual(before);
      expect((await observe(fixture, orderId)).verify.reasonCode).toBe("REVERSED_NEEDS_REPAIR");
    });

    it("MATRIX 10: old receivable reversed + active replacement + one Collection over both: only the active one changes", async () => {
      const { orderId, receivableId: oldId } = await feeOrder(fixture);
      await offset(fixture, oldId, FEE);
      await reverseReceivable(fixture, oldId);
      await repairReceivable(fixture, orderId);
      const [replacement] = await currentReceivables(fixture, orderId);
      const collectionId = await craftCollection(fixture, [
        { amount: 5, receivableId: oldId },
        { amount: 10, receivableId: replacement!.id },
      ]);
      await crafted(sql`update trader_receivables set amount_collected = 10, status = 'partially_collected'
                         where id = ${replacement!.id}::uuid`);
      const oldBefore = await receivableRow(oldId);
      await reverseCollection(fixture, collectionId);
      expect(await receivableRow(oldId)).toEqual(oldBefore);
      expect(await receivableRow(replacement!.id)).toMatchObject({ amountCollected: "0.00", status: "outstanding" });
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
    });

    it("MATRIX 11: partial collection reversal -> the other collection still counts", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, 10);
      const second = await collect(fixture, receivableId, 5);
      await reverseCollection(fixture, second);
      expect(await receivableRow(receivableId)).toMatchObject({ amountCollected: "10.00", status: "partially_collected" });
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
    });

    it("MATRIX 12: collection 10 + offset 15 (collected), collection reversed -> settled 15, outstanding 10, partially_collected", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const collection = await collect(fixture, receivableId, 10);
      await offset(fixture, receivableId, 15);
      expect((await receivableRow(receivableId)).status).toBe("collected");
      await reverseCollection(fixture, collection);
      expect(await receivableRow(receivableId)).toMatchObject({ amountCollected: "15.00", status: "partially_collected" });
      const outstanding = (await sql<{ o: string }>`select outstanding_amount::text as o from trader_receivables
        where id = ${receivableId}::uuid`.execute(db)).rows[0]!.o;
      expect(outstanding).toBe("10.00");
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
    });

    it("MATRIX 13: a full effective offset still covers the receivable after a collection reversal -> collected (was partially_collected before Prompt 4)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      // Crafted: an extra confirmed collection of 10 (amount_collected stays 25: CHECK amount_collected <= due).
      const collectionId = await craftCollection(fixture, [{ amount: 10, receivableId }]);
      await reverseCollection(fixture, collectionId);
      expect(await receivableRow(receivableId)).toMatchObject({ amountCollected: "25.00", status: "collected" });
      await healthyEverywhere(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
    });

    it("MATRIX 14 + 15: full collection reversed, no offset -> outstanding; Accounting OFF creates no GL record", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const collection = await collect(fixture, receivableId, FEE);
      const events = await companyCount("accounting_events", fixture.companyId);
      await reverseCollection(fixture, collection);
      expect(await receivableRow(receivableId)).toMatchObject({ amountCollected: "0.00", status: "outstanding" });
      expect(await companyCount("accounting_events", fixture.companyId)).toBe(events);
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
    });

    it("MATRIX 20: status reconciliation regression (READY, executes, HEALTHY)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set status = 'collected' where id = ${receivableId}::uuid`);
      expect(await run(fixture, orderId, await requestFor(fixture, orderId))).toMatchObject({
        afterHealth: "HEALTHY",
        capabilityCode: "RECONCILE_TRADER_RECEIVABLE",
      });
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
    });

    it("MATRIX 15b: REPAIR_TRADER_RECEIVABLE regression on a current-era Order (READY, historical amount, HEALTHY)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await reverseReceivable(fixture, receivableId);
      expect(await run(fixture, orderId, await requestFor(fixture, orderId))).toMatchObject({
        afterHealth: "HEALTHY",
        capabilityCode: "REPAIR_TRADER_RECEIVABLE",
      });
      expect((await currentReceivables(fixture, orderId)).map((row) => row.amountDue)).toEqual(["25.00"]);
    });

    it("MATRIX 21-25: inconsistencies stay MANUAL_REVIEW (amount with activity, allocation, offset, over-collection, multiple settlements)", async () => {
      const a = await feeOrder(fixture);
      await collect(fixture, a.receivableId, 5);
      await crafted(sql`update trader_receivables set original_amount_due = 30 where id = ${a.receivableId}::uuid`);
      await expectManualReview(fixture, a.orderId, "RECEIVABLE_AMOUNT_MISMATCH", "ISSUE");

      const b = await feeOrder(fixture);
      await craftAllocation(fixture, await secondTrader(fixture), b.receivableId, FEE);
      await crafted(sql`update trader_receivables set amount_collected = 25, status = 'collected' where id = ${b.receivableId}::uuid`);
      await expectManualReview(fixture, b.orderId, "COLLECTION_ALLOCATION_MISMATCH", "ISSUE");

      const c = await feeOrder(fixture);
      await craftOffset(fixture, await secondTrader(fixture), c.receivableId, FEE);
      await crafted(sql`update trader_receivables set amount_collected = 25, status = 'collected' where id = ${c.receivableId}::uuid`);
      await expectManualReview(fixture, c.orderId, "SETTLEMENT_OFFSET_MISMATCH", "ISSUE");

      const d = await feeOrder(fixture);
      await collect(fixture, d.receivableId, 15);
      await craftOffset(fixture, fixture.traderId, d.receivableId, 15);
      await expectManualReview(fixture, d.orderId, "RECEIVABLE_OVER_COLLECTED", "REVIEW");

      const e = await feeOrder(fixture);
      await offset(fixture, e.receivableId, FEE);
      await craftOffset(fixture, fixture.traderId, e.receivableId, FEE);
      await expectManualReview(fixture, e.orderId, "MULTIPLE_EFFECTIVE_SETTLEMENTS", "REVIEW");
    });

    it("MATRIX 26: known historical patterns ORD-000108 / 111 / 110 / 008 / 088 / 100 stay HEALTHY, nothing actionable", async () => {
      const p108 = await feeOrder(fixture);
      await offset(fixture, p108.receivableId, FEE);
      await healthyEverywhere(fixture, p108.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");

      const p111a = await feeOrder(fixture);
      const p111b = await feeOrder(fixture);
      await settle(fixture, [
        { amount: FEE, receivableId: p111a.receivableId },
        { amount: FEE, receivableId: p111b.receivableId },
      ]);
      await healthyEverywhere(fixture, p111a.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
      await healthyEverywhere(fixture, p111b.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");

      const p110 = await feeOrder(fixture);
      await offset(fixture, p110.receivableId, FEE);
      await reverseReceivable(fixture, p110.receivableId);
      await repairReceivable(fixture, p110.orderId);
      await offset(fixture, (await currentReceivables(fixture, p110.orderId))[0]!.id, FEE);
      await healthyEverywhere(fixture, p110.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");

      const p008 = await feeOrder(fixture);
      await cancelReceivable(fixture, p008.receivableId);
      await offset(fixture, await craftReceivable(fixture, p008.orderId, "R"), FEE);
      await healthyEverywhere(fixture, p008.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");

      await healthyEverywhere(fixture, await deliveredOrder(fixture, COD, "customer_pays_cod_trader_pays_fee"), "NO_TRADER_RECEIVABLE_REQUIRED");

      const p100 = await feeOrder(fixture);
      await reverseSettlement(fixture, await offset(fixture, p100.receivableId, FEE));
      await reverseSettlement(fixture, await offset(fixture, p100.receivableId, FEE));
      await offset(fixture, p100.receivableId, FEE);
      await healthyEverywhere(fixture, p100.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
    });

    it("MATRIX 27: another Company cannot replace this Order's receivable (404, zero mutation in both Companies)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${receivableId}::uuid`);
      const request = await requestFor(fixture, orderId);
      const before = await footprint(fixture.companyId);
      await expect(
        asPlatform(companyB.companyId, () => executions.execute(companyB.companyId, orderId, request, actor())),
      ).rejects.toMatchObject({ errorCode: "order_not_found" });
      expect(await footprint(fixture.companyId)).toBe(before);
    });

    it("MATRIX 28 + 29 + 30: forced failure rolls back; the repair then runs once; replay is idempotent; provenance is recorded without a Company actor", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${receivableId}::uuid`);
      const failing = await requestFor(fixture, orderId);
      const before = await footprint(fixture.companyId);
      vi.spyOn(executions as never as { writeAudit: () => Promise<never> }, "writeAudit").mockRejectedValueOnce(
        new Error("Injected audit failure"),
      );
      await expect(run(fixture, orderId, failing)).rejects.toThrow(/Injected audit failure/u);
      expect(await footprint(fixture.companyId)).toBe(before);
      expect((await attempts(fixture, orderId)).map((row) => row.result)).toContain("FAILED");

      const request = await requestFor(fixture, orderId);
      const result = await run(fixture, orderId, request);
      expect(result).toMatchObject({ afterHealth: "HEALTHY", capabilityCode: "REPLACE_UNUSED_TRADER_RECEIVABLE" });
      const afterRepair = await footprint(fixture.companyId);
      expect(await run(fixture, orderId, request)).toMatchObject({ replayed: true, repairExecutionId: result.repairExecutionId });
      expect(await footprint(fixture.companyId)).toBe(afterRepair);

      // Provenance: the Platform administrator is on the immutable execution;
      // the cancel audit and the new receivable carry no Company actor.
      const execution = (
        await sql<{ actor: string; kind: string }>`
          select e.actor_account_id::text as actor, acc.account_kind as kind
            from platform_repair_executions e join accounts acc on acc.id = e.actor_account_id
           where e.company_id = ${fixture.companyId}::uuid and e.order_id = ${orderId}::uuid`.execute(db)
      ).rows;
      expect(execution).toEqual([{ actor: adminId, kind: "platform_administrator" }]);
      const cancelAudit = (
        await sql<{ actor: string | null; role: string }>`
          select actor_account_id::text as actor, after_data->>'actorRole' as role from audit_events
           where company_id = ${fixture.companyId}::uuid and action = 'trader_receivable.cancel'
             and subject_id = ${receivableId}`.execute(db)
      ).rows;
      expect(cancelAudit).toEqual([{ actor: null, role: "Platform Repair Center" }]);
      const [replacement] = await currentReceivables(fixture, orderId);
      const creator = (
        await sql<{ creator: string | null }>`select created_by_account_id::text as creator from trader_receivables
          where id = ${replacement!.id}::uuid`.execute(db)
      ).rows[0]!.creator;
      expect(creator).toBeNull();
      const analysis = await asPlatform(fixture.companyId, () => previews.analyze(fixture.companyId, orderId));
      expect(
        analysis.dependencies.current.find((node) => node.entityId === replacement!.id)?.relation,
      ).toContain("created by Platform Repair");
    });
  });

  // ---------------------------------------------------------------------------
  // MATRIX 16: Accounting ON
  // ---------------------------------------------------------------------------

  describe("Accounting ON company", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createFixture("on");
    }, 240_000);

    it("MATRIX 16: collection + offset, collection reversed with Accounting ON -> partially_collected via the certified path; no Platform actor, no manual journal", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const collection = await collect(fixture, receivableId, 10);
      await offset(fixture, receivableId, 15);
      await reverseCollection(fixture, collection);
      expect(await receivableRow(receivableId)).toMatchObject({ amountCollected: "15.00", status: "partially_collected" });
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      // Every accounting event of this Order's receivable / collection is attributed
      // to the Company user who acted (or the system), never to a Platform administrator.
      const actors = (
        await sql<{ actor: string | null }>`select distinct actor_id::text as actor from accounting_events
          where company_id = ${fixture.companyId}::uuid`.execute(db)
      ).rows.map((row) => row.actor);
      expect(actors).not.toContain(adminId);
    });

    it("MATRIX 16b: a historical-VAT Order stays HEALTHY with Accounting ON after a VAT change", async () => {
      await setVat(fixture, { enabled: true, mode: "exclusive", rate: 5 });
      const { orderId } = await vatFeeOrder(fixture);
      await setVat(fixture, { enabled: false });
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      await expectedEverywhere(fixture, orderId, "26.25", true);
    });
  });
});
