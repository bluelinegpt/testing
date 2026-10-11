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
 * REPAIR CENTER PHASE 3 -- PROMPT 3: collection / settlement inconsistency
 * repairability (matrix 1-27).
 *
 * Automation must be earned by proof. Every finding below is read through
 * the same four interfaces as the Prompt 2 contract (reconciliation, Company
 * Health, Verify First, Repair Preview), and for each one this suite proves
 * EITHER a certified repair is READY and resolves it atomically,
 * idempotently and verifiably, OR it is MANUAL_REVIEW / BLOCKED with a useful
 * explanation and an execution attempt changes nothing at all.
 *
 * Fixtures are disposable. "Crafted" rows only produce states the certified
 * writers refuse to create.
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

describe.skipIf(!runDatabaseTests)("Phase 3 Prompt 3 -- inconsistency repairability", () => {
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
      values (${adminId}::uuid, null, 'platform_administrator', ${`p3.exec.${adminId}`}, 'x', 'disabled')`.execute(db);
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

  const key = (label: string) => `p3.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`P3R-${tag}`},${`p3r-${tag}`},${`P3 repair ${mode} ${tag}`},
              'active',now())`.execute(db);
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`p3r.${actorId}`},'x','disabled')`.execute(db);
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
          serialNumber: `P3-${Date.now()}-${serial}`,
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

  async function allReceivables(fixture: Fixture, orderId: string) {
    return (
      await sql<{ id: string; status: string; amountDue: string; amountCollected: string }>`
        select id::text as id, status, original_amount_due::text as "amountDue", amount_collected::text as "amountCollected"
          from trader_receivables
         where company_id = ${fixture.companyId}::uuid and source_type = 'service_charge'
           and source_reference = ${await orderNumber(orderId)} order by created_at, id`.execute(db)
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
  // Accounting OFF company
  // ---------------------------------------------------------------------------

  describe("Accounting OFF company", () => {
    let fixture: Fixture;
    let companyB: Fixture;
    let bBefore = "";

    beforeAll(async () => {
      fixture = await createFixture("off");
      companyB = await createFixture("off");
      const b = await feeOrder(companyB);
      await craftReceivable(companyB, b.orderId, "B");
      bBefore = await footprint(companyB.companyId);
    }, 240_000);

    afterAll(async () => {
      // Nothing done to Company A ever changes Company B.
      expect(await footprint(companyB.companyId)).toBe(bBefore);
    });

    // ------------------------------------------------ RECEIVABLE_AMOUNT_MISMATCH

    it("MATRIX 1 + 23: amount mismatch, no financial activity -> READY (REPLACE_UNUSED_TRADER_RECEIVABLE); executes; HEALTHY; no GL", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${receivableId}::uuid`);
      await expectCase(fixture, orderId, {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "RECEIVABLE_AMOUNT_MISMATCH",
        health: "ISSUE",
        repairability: "READY",
      });
      const item = await finding(fixture, orderId, "RECEIVABLE_AMOUNT_MISMATCH");
      expect(item.repairCapability).toBe("REPLACE_UNUSED_TRADER_RECEIVABLE");
      expect(item.manualReview).toBeNull();
      const preview = await asPlatform(fixture.companyId, () => previews.preview(fixture.companyId, orderId));
      expect(preview.execution.available).toBe(true);
      expect(preview.proposedChanges.some((change) => change.action === "delete")).toBe(false);
      const events = await companyCount("accounting_events", fixture.companyId);
      const result = await run(fixture, orderId, await requestFor(fixture, orderId));
      expect(result).toMatchObject({ afterHealth: "HEALTHY", capabilityCode: "REPLACE_UNUSED_TRADER_RECEIVABLE", replayed: false });
      const rows = await allReceivables(fixture, orderId);
      expect(rows.map((row) => [row.status, row.amountDue])).toEqual([
        ["cancelled", "20.00"],
        ["outstanding", "25.00"],
      ]);
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
      expect(await companyCount("accounting_events", fixture.companyId)).toBe(events);
      const audit = (
        await sql<{ actor: string | null; role: string }>`
          select actor_account_id::text as actor, after_data->>'actorRole' as role from audit_events
           where company_id = ${fixture.companyId}::uuid and action = 'trader_receivable.cancel'
             and subject_id = ${receivableId}`.execute(db)
      ).rows;
      expect(audit).toEqual([{ actor: null, role: "Platform Repair Center" }]);
    });

    it("MATRIX 2: amount mismatch on a receivable with a collection -> MANUAL_REVIEW, zero mutation", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, 5);
      await crafted(sql`update trader_receivables set original_amount_due = 30 where id = ${receivableId}::uuid`);
      await expectManualReview(fixture, orderId, "RECEIVABLE_AMOUNT_MISMATCH", "ISSUE", "already carries collections");
    });

    it("MATRIX 3: amount mismatch on a receivable with a settlement offset -> MANUAL_REVIEW, zero mutation", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, 10);
      await crafted(sql`update trader_receivables set original_amount_due = 30 where id = ${receivableId}::uuid`);
      const review = await expectManualReview(fixture, orderId, "RECEIVABLE_AMOUNT_MISMATCH", "ISSUE", "1 offset(s)");
      expect(review.affectedRecords.settlements).toHaveLength(1);
      expect(review.affectedRecords.settlements[0]).toMatchObject({ effective: true, offsetAmount: "10.00", sameTraderAsReceivable: true });
    });

    it("MATRIX 3b: amount mismatch whose expected amount is not provable (incoherent VAT snapshot) -> REVIEW (RECEIVABLE_AMOUNT_NOT_PROVABLE), MANUAL_REVIEW", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${receivableId}::uuid`);
      await crafted(sql`update orders set vat_enabled_snapshot = true, vat_price_mode_snapshot = 'exclusive', vat_rate_snapshot = 5
                         where id = ${orderId}::uuid`);
      // Phase 3 Prompt 4: the stored fee VAT no longer matches the snapshot it
      // claims, so the historical amount is not proven -- REVIEW, never ISSUE.
      await expectManualReview(fixture, orderId, "RECEIVABLE_AMOUNT_NOT_PROVABLE", "REVIEW", "cannot be proven");
    });

    // ------------------------------------------- COLLECTION_ALLOCATION_MISMATCH

    it("MATRIX 5: allocation mismatch, one foreign Collection exactly paying one receivable -> still MANUAL_REVIEW (no certified re-allocation)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await craftAllocation(fixture, await secondTrader(fixture), receivableId, FEE);
      await crafted(sql`update trader_receivables set amount_collected = 25, status = 'collected' where id = ${receivableId}::uuid`);
      const review = await expectManualReview(fixture, orderId, "COLLECTION_ALLOCATION_MISMATCH", "ISSUE", "re-allocates a Collection");
      expect(review.affectedRecords.collections).toEqual([
        expect.objectContaining({ allocatedToReceivable: "25.00", collectionStatus: "confirmed", sameTraderAsReceivable: false }),
      ]);
    });

    it("MATRIX 6: allocation mismatch, one over-allocated Collection paying two Orders -> MANUAL_REVIEW on both", async () => {
      const a = await feeOrder(fixture);
      const b = await feeOrder(fixture);
      const collectionId = randomUUID();
      await crafted(sql`insert into trader_collections(id,company_id,collection_number,trader_id,payment_date,
          payment_method,amount_received,status,received_by_account_id)
        values (${collectionId}::uuid,${fixture.companyId}::uuid,${`COL-O${collectionId.slice(0, 6)}`},
          ${fixture.traderId}::uuid,current_date,'cash',25,'confirmed',${fixture.actorId}::uuid)`);
      for (const receivableId of [a.receivableId, b.receivableId]) {
        await crafted(sql`insert into trader_collection_allocations(company_id,collection_id,receivable_id,amount_allocated)
          values (${fixture.companyId}::uuid,${collectionId}::uuid,${receivableId}::uuid,25)`);
        await crafted(sql`update trader_receivables set amount_collected = 25, status = 'collected' where id = ${receivableId}::uuid`);
      }
      const review = await expectManualReview(fixture, a.orderId, "COLLECTION_ALLOCATION_MISMATCH", "ISSUE");
      expect(review.affectedRecords.collections[0]).toMatchObject({ collectionAllocatedTotal: "50.00", collectionAmountReceived: "25.00" });
      await expectManualReview(fixture, b.orderId, "COLLECTION_ALLOCATION_MISMATCH", "ISSUE");
    });

    // --------------------------------------------- ORPHAN_COLLECTION_ALLOCATION

    it("MATRIX 7: a historical (reversed) collection on a cancelled receivable is history, never an orphan", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await reverseCollection(fixture, await collect(fixture, receivableId, FEE));
      await cancelReceivable(fixture, receivableId);
      const observation = await observe(fixture, orderId);
      expect(observation.verify.reasonCode).toBe("REVERSED_NEEDS_REPAIR");
      expect(observation.anomalies.every((value) => value === null)).toBe(true);
      await repairReceivable(fixture, orderId);
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
    });

    it("MATRIX 8: a confirmed collection still allocated to a cancelled receivable -> MANUAL_REVIEW (orphan)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await cancelReceivable(fixture, receivableId);
      await craftAllocation(fixture, fixture.traderId, receivableId, 5);
      const review = await expectManualReview(fixture, orderId, "ORPHAN_COLLECTION_ALLOCATION", "ISSUE", "does not guard closed receivables");
      expect(review.affectedRecords.collections[0]).toMatchObject({ collectionStatus: "confirmed", current: false });
      expect(review.financialComparison.receivables[0]).toMatchObject({ current: false, status: "cancelled" });
    });

    // ----------------------------------------------- SETTLEMENT_OFFSET_MISMATCH

    it("MATRIX 9: offset mismatch with one identifiable cause (reversed receivable whose compensating Credit was cancelled) -> MANUAL_REVIEW", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await reverseReceivable(fixture, receivableId);
      await crafted(sql`update trader_credits set status = 'cancelled', cancelled_at = now(),
          cancelled_by_account_id = ${fixture.actorId}::uuid, cancelled_reason = 'crafted'
        where source_receivable_id = ${receivableId}::uuid`);
      const review = await expectManualReview(fixture, orderId, "SETTLEMENT_OFFSET_MISMATCH", "ISSUE", "never edited directly");
      expect(review.affectedRecords.credits).toEqual([expect.objectContaining({ status: "cancelled" })]);
    });

    it("MATRIX 10: offset from another Trader's settlement -> MANUAL_REVIEW", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await craftOffset(fixture, await secondTrader(fixture), receivableId, FEE);
      await crafted(sql`update trader_receivables set amount_collected = 25, status = 'collected' where id = ${receivableId}::uuid`);
      const review = await expectManualReview(fixture, orderId, "SETTLEMENT_OFFSET_MISMATCH", "ISSUE");
      expect(review.affectedRecords.settlements[0]).toMatchObject({ effective: true, sameTraderAsReceivable: false });
    });

    // -------------------------------------------------- MULTIPLE_ACTIVE_RECEIVABLES

    it("MATRIX 11: duplicate active receivable, the canonical one provably carries the money -> READY (CANCEL_DUPLICATE); executes; HEALTHY", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, FEE);
      const duplicateId = await craftReceivable(fixture, orderId, "D");
      await expectCase(fixture, orderId, {
        classification: "NEEDS_REVIEW",
        code: "MULTIPLE_ACTIVE_RECEIVABLES",
        health: "REVIEW",
        repairability: "READY",
      });
      expect((await finding(fixture, orderId, "MULTIPLE_ACTIVE_RECEIVABLES")).repairCapability).toBe("CANCEL_DUPLICATE_TRADER_RECEIVABLE");
      const result = await run(fixture, orderId, await requestFor(fixture, orderId));
      expect(result).toMatchObject({ afterHealth: "HEALTHY", capabilityCode: "CANCEL_DUPLICATE_TRADER_RECEIVABLE" });
      const rows = await allReceivables(fixture, orderId);
      expect(rows.find((row) => row.id === duplicateId)).toMatchObject({ status: "cancelled" });
      expect(rows.find((row) => row.id === receivableId)).toMatchObject({ amountCollected: "25.00", status: "collected" });
      await healthyEverywhere(fixture, orderId, "ALREADY_PHYSICALLY_COLLECTED");
    });

    it("MATRIX 12: duplicate active receivables, neither touched by money -> MANUAL_REVIEW (age is not proof)", async () => {
      const { orderId } = await feeOrder(fixture);
      await craftReceivable(fixture, orderId, "D");
      await expectManualReview(fixture, orderId, "MULTIPLE_ACTIVE_RECEIVABLES", "REVIEW", "age is not proof");
    });

    it("MATRIX 13: duplicate active receivables, both financially active -> MANUAL_REVIEW", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, 10);
      const duplicateId = await craftReceivable(fixture, orderId, "D");
      await collect(fixture, duplicateId, 5);
      await expectManualReview(fixture, orderId, "MULTIPLE_ACTIVE_RECEIVABLES", "REVIEW", "Both current receivables carry");
    });

    // ---------------------------------------------------- RECEIVABLE_OVER_COLLECTED

    it("MATRIX 14: over-collection from physical collections -> MANUAL_REVIEW", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, FEE);
      await craftAllocation(fixture, fixture.traderId, receivableId, 5);
      const review = await expectManualReview(fixture, orderId, "RECEIVABLE_OVER_COLLECTED", "REVIEW", "never removed by inference");
      expect(review.financialComparison.receivables[0]).toMatchObject({ effectivePhysicalCollections: "30.00" });
    });

    it("MATRIX 15: over-collection from a settlement offset -> MANUAL_REVIEW", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await craftOffset(fixture, fixture.traderId, receivableId, 30);
      const review = await expectManualReview(fixture, orderId, "RECEIVABLE_OVER_COLLECTED", "REVIEW");
      expect(review.financialComparison.receivables[0]).toMatchObject({ effectiveSettlementOffsets: "30.00" });
    });

    it("MATRIX 16: over-collection from mixed sources (could be either) -> MANUAL_REVIEW", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, 15);
      await craftOffset(fixture, fixture.traderId, receivableId, 15);
      const review = await expectManualReview(fixture, orderId, "RECEIVABLE_OVER_COLLECTED", "REVIEW");
      expect(review.financialComparison.receivables[0]).toMatchObject({
        effectivePhysicalCollections: "15.00",
        effectiveSettlementOffsets: "15.00",
        effectiveSettled: "30.00",
      });
    });

    // ----------------------------------------------- MULTIPLE_EFFECTIVE_SETTLEMENTS

    it("MATRIX 17: an identical second effective settlement (same Trader, same amount) -> MANUAL_REVIEW (identity is not provable)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await craftOffset(fixture, fixture.traderId, receivableId, FEE);
      const review = await expectManualReview(fixture, orderId, "MULTIPLE_EFFECTIVE_SETTLEMENTS", "REVIEW", "accidental duplicate");
      expect(review.affectedRecords.settlements.filter((row) => row.effective)).toHaveLength(2);
    });

    it("MATRIX 18: two partial effective settlements together beyond the amount due -> MANUAL_REVIEW", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await craftOffset(fixture, fixture.traderId, receivableId, 15);
      await craftOffset(fixture, fixture.traderId, receivableId, 15);
      await expectManualReview(fixture, orderId, "MULTIPLE_EFFECTIVE_SETTLEMENTS", "REVIEW");
    });

    // ------------------------------------------------------------ execution safety

    it("MATRIX 19: stale -- money reaching the duplicate after the preview refuses execution with zero mutation", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, FEE);
      const duplicateId = await craftReceivable(fixture, orderId, "D");
      const request = await requestFor(fixture, orderId);
      await collect(fixture, duplicateId, 5);
      const before = await footprint(fixture.companyId);
      await expect(run(fixture, orderId, request)).rejects.toMatchObject({ errorCode: "repair_preview_stale" });
      expect(await footprint(fixture.companyId)).toBe(before);
      expect((await attempts(fixture, orderId)).map((row) => `${row.result}:${row.code}`)).toContain("REFUSED:repair_preview_stale");
      // ... and it is now (correctly) MANUAL_REVIEW: both receivables carry money.
      await expectManualReview(fixture, orderId, "MULTIPLE_ACTIVE_RECEIVABLES", "REVIEW");
    });

    it("MATRIX 20: a forced failure after the domain operation rolls everything back (FAILED attempt), and the repair still runs after", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${receivableId}::uuid`);
      const request = await requestFor(fixture, orderId);
      const before = await footprint(fixture.companyId);
      vi.spyOn(executions as never as { writeAudit: () => Promise<never> }, "writeAudit").mockRejectedValueOnce(
        new Error("Injected audit failure"),
      );
      await expect(run(fixture, orderId, request)).rejects.toThrow(/Injected audit failure/u);
      expect(await footprint(fixture.companyId)).toBe(before);
      expect((await allReceivables(fixture, orderId)).map((row) => row.status)).toEqual(["outstanding"]);
      expect((await attempts(fixture, orderId)).map((row) => row.result)).toContain("FAILED");
      await run(fixture, orderId, await requestFor(fixture, orderId));
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
    });

    it("MATRIX 21: a repeat execution replays; a fresh request finds nothing to repair; nothing changes", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await craftReceivable(fixture, orderId, "D");
      const request = await requestFor(fixture, orderId);
      const result = await run(fixture, orderId, request);
      const before = await footprint(fixture.companyId);
      expect(await run(fixture, orderId, request)).toMatchObject({ replayed: true, repairExecutionId: result.repairExecutionId });
      await expect(run(fixture, orderId, { ...request, idempotencyKey: `p3-exec-${randomUUID()}` })).rejects.toMatchObject({
        errorCode: "repair_finding_not_current",
      });
      expect(await footprint(fixture.companyId)).toBe(before);
      await healthyEverywhere(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
    });

    it("MATRIX 22: another Company cannot repair the Order (404, zero mutation)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collect(fixture, receivableId, FEE);
      await craftReceivable(fixture, orderId, "D");
      const request = await requestFor(fixture, orderId);
      const before = await footprint(fixture.companyId);
      await expect(
        asPlatform(companyB.companyId, () => executions.execute(companyB.companyId, orderId, request, actor())),
      ).rejects.toMatchObject({ errorCode: "order_not_found" });
      expect(await footprint(fixture.companyId)).toBe(before);
    });

    it("MATRIX 25: the certified status-only reconciliation is unchanged (READY, executes, HEALTHY)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set status = 'collected' where id = ${receivableId}::uuid`);
      await expectCase(fixture, orderId, {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT",
        health: "ISSUE",
        repairability: "READY",
      });
      expect(await run(fixture, orderId, await requestFor(fixture, orderId))).toMatchObject({
        afterHealth: "HEALTHY",
        capabilityCode: "RECONCILE_TRADER_RECEIVABLE",
      });
      await healthyEverywhere(fixture, orderId, "HEALTHY_ACTIVE_RECEIVABLE");
    });

    // --------------------------------------------------------- MATRIX 26

    it("MATRIX 26 / ORD-000108 + ORD-000088: offset-only and COD-covers-fee stay HEALTHY, nothing actionable", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await healthyEverywhere(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
      await healthyEverywhere(fixture, await deliveredOrder(fixture, COD, "customer_pays_cod_trader_pays_fee"), "NO_TRADER_RECEIVABLE_REQUIRED");
    });

    it("MATRIX 26 / ORD-000111: one settlement offsetting two Orders -> both HEALTHY", async () => {
      const a = await feeOrder(fixture);
      const b = await feeOrder(fixture);
      await settle(fixture, [
        { amount: FEE, receivableId: a.receivableId },
        { amount: FEE, receivableId: b.receivableId },
      ]);
      await healthyEverywhere(fixture, a.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
      await healthyEverywhere(fixture, b.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
    });

    it("MATRIX 26 / ORD-000110 + ORD-000008 + ORD-000100: history beside a valid current settlement stays HEALTHY", async () => {
      const reversed = await feeOrder(fixture);
      await offset(fixture, reversed.receivableId, FEE);
      await reverseReceivable(fixture, reversed.receivableId);
      await repairReceivable(fixture, reversed.orderId);
      await offset(fixture, (await currentReceivables(fixture, reversed.orderId))[0]!.id, FEE);
      await healthyEverywhere(fixture, reversed.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");

      const cancelled = await feeOrder(fixture);
      await cancelReceivable(fixture, cancelled.receivableId);
      await offset(fixture, await craftReceivable(fixture, cancelled.orderId, "R"), FEE);
      await healthyEverywhere(fixture, cancelled.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");

      const repeated = await feeOrder(fixture);
      await reverseSettlement(fixture, await offset(fixture, repeated.receivableId, FEE));
      await reverseSettlement(fixture, await offset(fixture, repeated.receivableId, FEE));
      await offset(fixture, repeated.receivableId, FEE);
      await healthyEverywhere(fixture, repeated.orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
    });
  });

  // ---------------------------------------------------------------------------
  // MATRIX 4 / 24: Accounting ON company
  // ---------------------------------------------------------------------------

  describe("Accounting ON company", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createFixture("on");
    }, 240_000);

    it("MATRIX 4 + 24: amount mismatch on an unused receivable is BLOCKED (PLATFORM_ACTOR_CANNOT_POST_JOURNAL); refused with zero mutation", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await crafted(sql`update trader_receivables set original_amount_due = 20 where id = ${receivableId}::uuid`);
      await expectCase(fixture, orderId, {
        classification: "RECEIVABLE_INCONSISTENT",
        code: "RECEIVABLE_AMOUNT_MISMATCH",
        health: "ISSUE",
        repairability: "BLOCKED",
      });
      const item = await finding(fixture, orderId, "RECEIVABLE_AMOUNT_MISMATCH");
      expect(item.blockers.map((blocker) => blocker.code)).toContain("PLATFORM_ACTOR_CANNOT_POST_JOURNAL");
      const request = await requestFor(fixture, orderId);
      const before = await footprint(fixture.companyId);
      await expect(run(fixture, orderId, request)).rejects.toMatchObject({ errorCode: "repair_not_ready" });
      expect(await footprint(fixture.companyId)).toBe(before);
    });

    it("MATRIX 24: a duplicate recognised in the GL is BLOCKED (its reversal would be attributed to a Company user)", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      // Inserted normally (not crafted): the capture trigger recognises it.
      const duplicateId = randomUUID();
      await sql`insert into trader_receivables(id,company_id,receivable_number,trader_id,source_type,
          source_reference,business_date,original_amount_due,status,reason,created_by_account_id)
        values (${duplicateId}::uuid,${fixture.companyId}::uuid,${`RCV-G${duplicateId.slice(0, 6)}`},
          ${fixture.traderId}::uuid,'service_charge',${await orderNumber(orderId)},current_date,${FEE},'outstanding',
          'Order service fee owed by Trader',${fixture.actorId}::uuid)`.execute(db);
      expect(
        (await sql<{ n: number }>`select count(*)::int as n from accounting_events
           where company_id = ${fixture.companyId}::uuid and source_entity_id = ${duplicateId}::uuid`.execute(db)).rows[0]!.n,
      ).toBe(1);
      await expectCase(fixture, orderId, {
        classification: "NEEDS_REVIEW",
        code: "MULTIPLE_ACTIVE_RECEIVABLES",
        health: "REVIEW",
        repairability: "BLOCKED",
      });
      expect((await finding(fixture, orderId, "MULTIPLE_ACTIVE_RECEIVABLES")).blockers.map((b) => b.code)).toContain(
        "PLATFORM_ACTOR_CANNOT_POST_JOURNAL",
      );
      const request = await requestFor(fixture, orderId);
      const before = await footprint(fixture.companyId);
      await expect(run(fixture, orderId, request)).rejects.toMatchObject({ errorCode: "repair_not_ready" });
      expect(await footprint(fixture.companyId)).toBe(before);
    });

    it("MATRIX 24: a never-recognised duplicate is READY with Accounting ON; cancelling it creates no event and no journal", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      const duplicateId = await craftReceivable(fixture, orderId, "D");
      await expectCase(fixture, orderId, {
        classification: "NEEDS_REVIEW",
        code: "MULTIPLE_ACTIVE_RECEIVABLES",
        health: "REVIEW",
        repairability: "READY",
      });
      const events = await companyCount("accounting_events", fixture.companyId);
      const journals = await companyCount("journal_entries", fixture.companyId);
      await run(fixture, orderId, await requestFor(fixture, orderId));
      expect(await companyCount("accounting_events", fixture.companyId)).toBe(events);
      expect(await companyCount("journal_entries", fixture.companyId)).toBe(journals);
      expect((await allReceivables(fixture, orderId)).find((row) => row.id === duplicateId)).toMatchObject({ status: "cancelled" });
      await healthyEverywhere(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
    });

    it("MATRIX 24 + 25: status reconciliation stays READY with Accounting ON and creates no GL record", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await offset(fixture, receivableId, FEE);
      await crafted(sql`update trader_receivables set status = 'outstanding' where id = ${receivableId}::uuid`);
      const events = await companyCount("accounting_events", fixture.companyId);
      await run(fixture, orderId, await requestFor(fixture, orderId));
      expect(await companyCount("accounting_events", fixture.companyId)).toBe(events);
      await healthyEverywhere(fixture, orderId, "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
    });
  });
});
