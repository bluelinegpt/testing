import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { CashBankManagementService } from "../accounting/cash-bank-management.service.js";
import { CompanyAccountingModeService } from "../accounting/company-accounting-mode.service.js";
import { FundingAccountBalanceService } from "../accounting/funding-account-balance.service.js";
import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { IntegrityCheckService } from "../observability/integrity-check.service.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsController } from "./operations.controller.js";
import { OperationsService } from "./operations.service.js";
import {
  type FinancialVerification,
  OrderMaintenanceService,
} from "./order-maintenance.service.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import { TraderReceivableService } from "./trader-receivable.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

/**
 * Phase 1 Prompt 4 -- Order Maintenance "Verify First" certification.
 *
 * Financial verification must use the SAME effective-settlement rule as the
 * rest of the system (effective-settlement-offsets.ts) and the Integrity
 * Checker must agree with it:
 *
 *   SET-A offsets AED 18 -> SET-A reversed -> SET-B offsets AED 18
 *     = ONE effective settlement of AED 18 (not AED 36), no anomaly;
 *   SET-A and SET-B both effective, no reversal
 *     = a genuine anomaly, found by BOTH.
 *
 * Everything runs through the real services (AppModule compiled, not
 * initialised) against the disposable database. The only rows written
 * directly are the two that no service can produce on purpose: a legacy Order
 * that never got its Receivable (case 8) and a second effective offset
 * (case 9 / scenario F) -- the corruption being detected.
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseTests =
  process.env.RUN_INTEGRITY_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

const today = new Date().toISOString().slice(0, 10);
const FEE = 18;

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
  "outsourced_driver_fees.view",
  "outsourced_driver_fees.manage",
  "users_roles.manage",
];

type Mode = "off" | "on";

interface Fixture {
  readonly mode: Mode;
  readonly companyId: string;
  readonly actorId: string;
  readonly areaId: string;
  readonly traderId: string;
  readonly driverId: string;
  readonly cashAccountId: string;
}

describe.skipIf(!runDatabaseTests)("Order financial verification (Verify First)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let store: RequestSecurityContextStore;
  let get: <T>(type: new (...args: never[]) => T) => T;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .compile();
    get = (type) => module.get(type, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
    await sql`insert into emirates(code,name_en,name_ar,display_order)
      values ('DXB','DXB','DXB',200) on conflict (code) do nothing`.execute(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  // ---------------------------------------------------------------------------
  // Helpers
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

  const key = (label: string) => `verify.${label}.${randomUUID()}`;

  async function createFixture(mode: Mode): Promise<Fixture> {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${companyId}::uuid,${`VERIFY-${tag}`},${`verify-${tag}`},${`Verify ${mode} ${tag}`},
              'active',now())`.execute(db);
    const actorId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actorId}::uuid,${companyId}::uuid,'company_user',${`verify.${actorId}`},'x','disabled')`.execute(
      db,
    );
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
                {
                  code: "CASH",
                  effectiveFrom: today,
                  name: "Main Cash",
                  type: "main_cash",
                } as never,
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
          serialNumber: `VF-${Date.now()}-${serial}`,
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("order"),
      ),
    )) as { id: string };
    for (const status of ["out_for_delivery", "delivered"]) {
      await as(fixture, () =>
        operations.changeOrderStatus(created.id, { status } as never, randomUUID()),
      );
    }
    return created.id;
  }

  /** A delivered COD Order with Driver cash reconciled: Trader payable 100 - 18 = 82. */
  async function payableOrder(fixture: Fixture): Promise<string> {
    const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
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
    return (
      await sql<{
        n: string;
      }>`select order_number as n from orders where id=${orderId}::uuid`.execute(db)
    ).rows[0]!.n;
  }

  /** The Order's one ACTIVE service-charge Receivable. */
  async function activeReceivable(fixture: Fixture, orderId: string): Promise<string> {
    const rows = await sql<{ id: string }>`select id from trader_receivables
      where company_id=${fixture.companyId}::uuid and source_type='service_charge'
        and source_reference=${await orderNumber(orderId)}
        and status not in ('reversed','cancelled')`.execute(db);
    expect(rows.rows).toHaveLength(1);
    return rows.rows[0]!.id;
  }

  /** A zero-COD Trader-pays-fee Order: the Trader owes the AED 18 fee. */
  async function feeOrder(fixture: Fixture) {
    const orderId = await deliveredOrder(fixture, 0, "customer_pays_cod_trader_pays_fee");
    return { orderId, receivableId: await activeReceivable(fixture, orderId) };
  }

  async function settleWithOffset(fixture: Fixture, receivableId: string, offset = FEE) {
    const payable = await payableOrder(fixture);
    const result = (await as(fixture, () =>
      get(TraderSettlementService).createPayment(
        {
          allocations: [{ amount: 82, orderId: payable }],
          amount: 82 - offset,
          cashAccountId: fixture.cashAccountId,
          paymentDate: today,
          paymentMethod: "cash",
          receivableOffsets: [{ amount: offset, receivableId }],
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("settle"),
      ),
    )) as { settlementId?: string; id?: string };
    return (result.settlementId ?? result.id)!;
  }

  async function reverseSettlement(fixture: Fixture, settlementId: string) {
    await as(fixture, () =>
      get(TraderSettlementService).reverse(settlementId, "Paid to the wrong account", randomUUID()),
    );
  }

  async function collectPhysically(fixture: Fixture, receivableId: string) {
    await as(fixture, () =>
      get(TraderReceivableService).confirmCollection(
        {
          allocations: [{ amount: FEE, receivableId }],
          amountReceived: FEE,
          paymentDate: today,
          paymentMethod: "cash",
          traderId: fixture.traderId,
        } as never,
        randomUUID(),
        key("collection"),
      ),
    );
  }

  async function reverseReceivable(fixture: Fixture, receivableId: string) {
    await as(fixture, () =>
      get(ReceivableOffsetReversalService).execute(receivableId, "Fee reset", randomUUID()),
    );
  }

  async function repair(fixture: Fixture, orderId: string) {
    return as(fixture, () => get(OperationsService).repairTraderReceivable(orderId, randomUUID()));
  }

  async function verify(fixture: Fixture, orderId: string): Promise<FinancialVerification> {
    return as(fixture, () => get(OrderMaintenanceService).financialVerification(orderId));
  }

  /** Integrity findings about the Order's Receivables (any status). */
  async function integrity(fixture: Fixture, orderId: string) {
    const ids = (
      await sql<{ id: string }>`select id from trader_receivables
        where company_id=${fixture.companyId}::uuid and source_reference=${await orderNumber(orderId)}`.execute(
        db,
      )
    ).rows.map((row) => row.id);
    const findings = await new IntegrityCheckService(db).runAll(fixture.companyId);
    return findings
      .filter((finding) => ids.includes(finding.subjectId))
      .map((finding) => finding.checkId)
      .sort();
  }

  /** Corruption no service will produce: a SECOND effective offset of the
   * same Receivable on a new confirmed Settlement (disposable DB only). */
  async function craftSecondEffectiveOffset(fixture: Fixture, receivableId: string) {
    const settlementId = randomUUID();
    // `set local`: the bypass ends with this transaction, whatever happens.
    await db.transaction().execute(async (transaction) => {
      await sql`set local session_replication_role = replica`.execute(transaction);
      await sql`insert into trader_settlements(id,company_id,settlement_number,trader_id,business_date,
          gross_payable,service_fee_deductions,other_deductions,charges,adjustments,net_payable,status,
          created_by_account_id,confirmed_by_account_id,confirmed_at)
        values (${settlementId}::uuid,${fixture.companyId}::uuid,${`SET-X${settlementId.slice(0, 6)}`},
          ${fixture.traderId}::uuid,current_date,${FEE},0,${FEE},0,0,0,'confirmed',
          ${fixture.actorId}::uuid,${fixture.actorId}::uuid,now())`.execute(transaction);
      await sql`insert into trader_settlement_receivable_offsets(company_id,settlement_id,receivable_id,
          amount_allocated)
        values (${fixture.companyId}::uuid,${settlementId}::uuid,${receivableId}::uuid,${FEE})`.execute(
        transaction,
      );
    });
    return settlementId;
  }

  async function events(companyId: string) {
    return (
      await sql<{ n: number }>`select count(*)::int as n from accounting_events
        where company_id=${companyId}::uuid`.execute(db)
    ).rows[0]!.n;
  }

  async function journals(companyId: string) {
    return (
      await sql<{ n: number }>`select count(*)::int as n from journal_entries
        where company_id=${companyId}::uuid`.execute(db)
    ).rows[0]!.n;
  }

  async function refusal(work: Promise<unknown>): Promise<ApplicationException> {
    try {
      await work;
    } catch (error) {
      if (error instanceof ApplicationException) return error;
      throw error;
    }
    throw new Error("expected the operation to be refused");
  }

  // ---------------------------------------------------------------------------
  // Part B: the ten classification cases (Accounting OFF)
  // ---------------------------------------------------------------------------

  describe("Part B -- classification cases", () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createFixture("off");
    }, 120_000);

    it("CASE 1: active AED 18 receivable, no collection, no offset -> HEALTHY_ACTIVE_RECEIVABLE", async () => {
      const { orderId } = await feeOrder(fixture);
      const result = await verify(fixture, orderId);
      expect(result).toMatchObject({
        classification: "HEALTHY_ACTIVE_RECEIVABLE",
        health: "HEALTHY",
        physicalCollectionAmount: "0.00",
        recommendedAction: "none",
        settlementOffsetAmount: "0.00",
        traderOwes: "18.00",
      });
    });

    it("CASE 2: physically collected AED 18 -> ALREADY_PHYSICALLY_COLLECTED", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await collectPhysically(fixture, receivableId);
      expect(await verify(fixture, orderId)).toMatchObject({
        classification: "ALREADY_PHYSICALLY_COLLECTED",
        health: "HEALTHY",
        physicalCollectionAmount: "18.00",
        settlementOffsetAmount: "0.00",
      });
    });

    it("CASE 3: one effective offset -> OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      const result = await verify(fixture, orderId);
      expect(result).toMatchObject({
        classification: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
        health: "HEALTHY",
        historicalSettlementOffsetAmount: "0.00",
        // Phase 3 Prompt 2: a valid offset settlement is HEALTHY everywhere --
        // no reset, no repair, no action (was "reset_then_repair").
        actionRequired: false,
        reasonCode: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
        recommendedAction: "none",
        repairability: "NOT_REQUIRED",
        settlementOffsetAmount: "18.00",
      });
      expect(result.settlementOffsets).toHaveLength(1);
      expect(result.settlementOffsets[0]!.effective).toBe(true);
    });

    it("CASE 4: SET-A -> SET-A reversed -> SET-B: effective AED 18 (not 36), no false anomaly", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      const setA = await settleWithOffset(fixture, receivableId);
      await reverseSettlement(fixture, setA);
      const setB = await settleWithOffset(fixture, receivableId);
      const result = await verify(fixture, orderId);
      expect(result.settlementOffsetAmount).toBe("18.00");
      expect(result.historicalSettlementOffsetAmount).toBe("18.00");
      expect(result.classification).toBe("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION");
      expect(result.classification).not.toBe("NEEDS_REVIEW");
      expect(result.health).toBe("HEALTHY");
      const numbers = await sql<{ id: string; n: string }>`select id, settlement_number as n
        from trader_settlements where id in (${setA}::uuid, ${setB}::uuid)`.execute(db);
      const numberOf = (id: string) => numbers.rows.find((row) => row.id === id)!.n;
      expect(result.settlementNumbers).toEqual([numberOf(setB)]);
      expect(result.historicalSettlementNumbers).toEqual([numberOf(setA)]);
      // History kept: both offset rows still stored.
      const stored = await sql<{ n: number }>`select count(*)::int as n
        from trader_settlement_receivable_offsets where receivable_id=${receivableId}::uuid`.execute(
        db,
      );
      expect(stored.rows[0]!.n).toBe(2);
      expect(await integrity(fixture, orderId)).toEqual([]);
    });

    it("CASE 5: historical reversed receivable + valid replacement -> judged on the replacement", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await reverseReceivable(fixture, receivableId);
      expect((await verify(fixture, orderId)).classification).toBe("REVERSED_NEEDS_REPAIR");
      expect(await repair(fixture, orderId)).toMatchObject({ created: true });
      const result = await verify(fixture, orderId);
      expect(result).toMatchObject({
        classification: "HEALTHY_ACTIVE_RECEIVABLE",
        health: "HEALTHY",
      });
      expect(result.receivables.map((row) => row.status).sort()).toEqual([
        "outstanding",
        "reversed",
      ]);
    });

    it("CASE 6: cancelled + reversed history + valid replacement -> judged on the replacement", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await as(fixture, () =>
        get(TraderReceivableService).cancelReceivable(
          receivableId,
          { reason: "Raised in error" } as never,
          randomUUID(),
        ),
      );
      expect(await repair(fixture, orderId)).toMatchObject({ created: true });
      const second = await activeReceivable(fixture, orderId);
      await settleWithOffset(fixture, second);
      await reverseReceivable(fixture, second);
      expect(await repair(fixture, orderId)).toMatchObject({ created: true });
      const result = await verify(fixture, orderId);
      expect(result).toMatchObject({
        classification: "HEALTHY_ACTIVE_RECEIVABLE",
        health: "HEALTHY",
      });
      expect(result.receivables.map((row) => row.status).sort()).toEqual([
        "cancelled",
        "outstanding",
        "reversed",
      ]);
    });

    it("CASE 7: COD covers the fee, no receivable required -> NO_TRADER_RECEIVABLE_REQUIRED", async () => {
      const covered = await deliveredOrder(fixture, 100, "customer_pays_cod_trader_pays_fee");
      const customerPays = await deliveredOrder(fixture, 100, "customer_pays_cod_and_fee");
      for (const orderId of [covered, customerPays]) {
        const result = await verify(fixture, orderId);
        expect(result).toMatchObject({
          classification: "NO_TRADER_RECEIVABLE_REQUIRED",
          health: "HEALTHY",
          receivables: [],
          traderOwes: "0.00",
        });
      }
    });

    it("CASE 8: fee required, COD cannot cover it, no receivable -> MISSING_RECEIVABLE", async () => {
      // A legacy Order that never got its Receivable (written directly: no
      // current service creates this state on purpose).
      const orderId = randomUUID();
      await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
        created_by_account_id,customer_name,customer_mobile_number,
        customer_address,package_count,payment_condition,service_fee,final_service_fee_snapshot,
        customer_provenance_status,pricing_provenance_status,customer_amount_due,trader_gross_payable,
        trader_paid_service_fee,trader_net_payable,trader_paid_amount,delivery_status,
        driver_reconciliation_status,trader_settlement_status,return_status,delivered_at)
      values (${orderId}::uuid,${fixture.companyId}::uuid,${`LEG-${orderId.slice(0, 8)}`},current_date,
        ${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
        'Customer','971500000001','Address',1,
        'customer_pays_cod_trader_pays_fee',${FEE},${FEE},'legacy_unattributed','legacy_unattributed',
        0,0,${FEE},0,0,'delivered','not_applicable','not_eligible','not_applicable',now())`.execute(
        db,
      );
      expect(await verify(fixture, orderId)).toMatchObject({
        classification: "MISSING_RECEIVABLE",
        health: "ISSUE",
        recommendedAction: "repair",
        traderOwes: "18.00",
      });
    });

    it("CASE 9: two genuinely effective offsets exceeding the amount due -> NEEDS_REVIEW, never healthy", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await craftSecondEffectiveOffset(fixture, receivableId);
      const result = await verify(fixture, orderId);
      expect(result).toMatchObject({
        classification: "NEEDS_REVIEW",
        health: "REVIEW",
        settlementOffsetAmount: "36.00",
      });
      expect(result.settlementOffsets.every((offset) => offset.effective)).toBe(true);
      expect(await integrity(fixture, orderId)).toEqual(
        expect.arrayContaining([
          "receivable_collected_beyond_due",
          "receivable_settled_more_than_once",
        ]),
      );
    });
  });

  it("CASE 10 + Part J: duplicate human-readable numbers in another Company never influence verification", async () => {
    const a = await createFixture("off");
    const b = await createFixture("off");
    // Same sequence in two fresh Companies -> the same Order and Receivable numbers.
    const aOrder = await feeOrder(a);
    const bOrder = await feeOrder(b);
    expect(await orderNumber(aOrder.orderId)).toBe(await orderNumber(bOrder.orderId));
    // Company B: settle, reverse, re-settle and craft a duplicate on its copy.
    const setA = await settleWithOffset(b, bOrder.receivableId);
    await reverseSettlement(b, setA);
    await settleWithOffset(b, bOrder.receivableId);
    await craftSecondEffectiveOffset(b, bOrder.receivableId);
    const aBalanceBefore = await as(a, () =>
      get(FundingAccountBalanceService).current("cash", a.cashAccountId),
    );

    const result = await verify(a, aOrder.orderId);
    expect(result).toMatchObject({
      classification: "HEALTHY_ACTIVE_RECEIVABLE",
      historicalSettlementNumbers: [],
      physicalCollectionAmount: "0.00",
      settlementNumbers: [],
      settlementOffsetAmount: "0.00",
    });
    expect(result.receivables.map((row) => row.id)).toEqual([aOrder.receivableId]);
    expect(await integrity(a, aOrder.orderId)).toEqual([]);
    // B's own findings are B's alone.
    const bFindings = await new IntegrityCheckService(db).runAll(b.companyId);
    expect(bFindings.some((f) => f.subjectId === bOrder.receivableId)).toBe(true);
    const aFindings = await new IntegrityCheckService(db).runAll(a.companyId);
    expect(aFindings.every((f) => f.companyId === a.companyId)).toBe(true);
    // Company A's cash balance and readiness are untouched by B.
    const aBalanceAfter = await as(a, () =>
      get(FundingAccountBalanceService).current("cash", a.cashAccountId),
    );
    expect(aBalanceAfter.balance).toBe(aBalanceBefore.balance);
    const preview = (await get(CompanyAccountingModeService).previewEnable(a.companyId)) as {
      blockers: readonly { code: string; detail: string }[];
    };
    const bCash = await sql<{ code: string }>`select cash_account_code as code
      from company_cash_accounts where id=${b.cashAccountId}::uuid`.execute(db);
    expect(
      preview.blockers.filter(
        (blocker) => blocker.code === "cash_account_without_gl" && blocker.detail !== "CASH",
      ),
    ).toEqual([]);
    expect(bCash.rows[0]!.code).toBe("CASH");
    // Verifying B's Order from Company A is impossible.
    const crossRead = await refusal(verify(a, bOrder.orderId));
    expect(crossRead.errorCode).toBe("order_not_found");
  });

  // ---------------------------------------------------------------------------
  // Part G: Maintenance and Integrity Checker agree
  // ---------------------------------------------------------------------------

  it("Part G: valid SET-A/REV/SET-B is healthy for BOTH; two effective offsets are an anomaly for BOTH", async () => {
    const fixture = await createFixture("off");
    const valid = await feeOrder(fixture);
    const setA = await settleWithOffset(fixture, valid.receivableId);
    await reverseSettlement(fixture, setA);
    await settleWithOffset(fixture, valid.receivableId);
    const validResult = await verify(fixture, valid.orderId);
    expect(validResult.settlementOffsetAmount).toBe("18.00");
    expect(validResult.health).toBe("HEALTHY");
    expect(await integrity(fixture, valid.orderId)).toEqual([]);

    const invalid = await feeOrder(fixture);
    await settleWithOffset(fixture, invalid.receivableId);
    await craftSecondEffectiveOffset(fixture, invalid.receivableId);
    const invalidResult = await verify(fixture, invalid.orderId);
    expect(invalidResult).toMatchObject({ classification: "NEEDS_REVIEW", health: "REVIEW" });
    expect(await integrity(fixture, invalid.orderId)).toContain(
      "receivable_settled_more_than_once",
    );
  });

  // ---------------------------------------------------------------------------
  // Part I: production-like historical scenarios, per Accounting mode
  // ---------------------------------------------------------------------------

  describe.each(["off", "on"] as const)("Part I scenarios -- Accounting %s", (mode) => {
    let fixture: Fixture;
    const off = mode === "off";
    beforeAll(async () => {
      fixture = await createFixture(mode);
    }, 120_000);

    async function certify(orderId: string) {
      const result = await verify(fixture, orderId);
      const order = await sql<{ delivery: string; settlement: string }>`
        select delivery_status as delivery, trader_settlement_status as settlement
          from orders where id=${orderId}::uuid`.execute(db);
      const active = result.receivables.filter(
        (row) => row.status !== "reversed" && row.status !== "cancelled",
      );
      return {
        activeOutstanding: active.map((row) => row.outstanding),
        classification: result.classification,
        delivery: order.rows[0]!.delivery,
        effectiveOffsets: result.settlementOffsetAmount,
        health: result.health,
        historicalOffsets: result.historicalSettlementOffsetAmount,
        historicalReceivables: result.receivables
          .filter((row) => row.status === "reversed" || row.status === "cancelled")
          .map((row) => row.status)
          .sort(),
        integrity: await integrity(fixture, orderId),
        physical: result.physicalCollectionAmount,
      };
    }

    async function ledgerExpectation(eventsBefore: number) {
      const after = await events(fixture.companyId);
      if (off) expect(after).toBe(0);
      else expect(after).toBeGreaterThan(eventsBefore);
      expect(await journals(fixture.companyId)).toBe(0); // processor not running
    }

    it("SCENARIO A: receivable -> settlement -> settlement reversal -> re-settlement", async () => {
      const before = await events(fixture.companyId);
      const { orderId, receivableId } = await feeOrder(fixture);
      const setA = await settleWithOffset(fixture, receivableId);
      await reverseSettlement(fixture, setA);
      await settleWithOffset(fixture, receivableId);
      expect(await certify(orderId)).toEqual({
        activeOutstanding: ["0.00"],
        classification: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
        delivery: "delivered",
        effectiveOffsets: "18.00",
        health: "HEALTHY",
        historicalOffsets: "18.00",
        historicalReceivables: [],
        integrity: [],
        physical: "0.00",
      });
      await ledgerExpectation(before);
    });

    it("SCENARIO B: receivable -> receivable-level reversal -> Trader Credit -> replacement -> settlement", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      if (!off) {
        // ON: the certified guard -- the clearing Settlement's Event has not
        // posted (no processor here) -- refuses, unchanged.
        const refused = await refusal(
          as(fixture, () =>
            get(ReceivableOffsetReversalService).execute(receivableId, "Fee reset", randomUUID()),
          ),
        );
        expect(refused.errorCode).toBe("trader_settlement_accounting_not_posted");
        return;
      }
      await reverseReceivable(fixture, receivableId);
      const credits = await sql<{ n: number }>`select count(*)::int as n from trader_credits
        where source_receivable_id=${receivableId}::uuid and status <> 'cancelled'`.execute(db);
      expect(credits.rows[0]!.n).toBe(1);
      await repair(fixture, orderId);
      const replacement = await activeReceivable(fixture, orderId);
      await settleWithOffset(fixture, replacement);
      expect(await certify(orderId)).toEqual({
        activeOutstanding: ["0.00"],
        classification: "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
        delivery: "delivered",
        effectiveOffsets: "18.00",
        health: "HEALTHY",
        historicalOffsets: "0.00",
        historicalReceivables: ["reversed"],
        integrity: [],
        physical: "0.00",
      });
      // Both offsets are listed. The reversed Receivable's offset is still an
      // effective settlement fact (its Settlement stands) but that Receivable
      // was compensated by a Trader Credit, so only the replacement's offset
      // is current state.
      const result = await verify(fixture, orderId);
      expect(result.settlementOffsets).toHaveLength(2);
      expect(result.settlementOffsets.map((x) => x.receivableStatus).sort()).toEqual([
        "collected",
        "reversed",
      ]);
      await ledgerExpectation(0);
    });

    it("SCENARIO C: cancelled + reversed historical receivables + replacement active receivable", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await as(fixture, () =>
        get(TraderReceivableService).cancelReceivable(
          receivableId,
          { reason: "Raised in error" } as never,
          randomUUID(),
        ),
      );
      await repair(fixture, orderId);
      const second = await activeReceivable(fixture, orderId);
      if (!off) {
        expect(await certify(orderId)).toMatchObject({
          classification: "HEALTHY_ACTIVE_RECEIVABLE",
          historicalReceivables: ["cancelled"],
          integrity: [],
        });
        return;
      }
      await settleWithOffset(fixture, second);
      await reverseReceivable(fixture, second);
      await repair(fixture, orderId);
      expect(await certify(orderId)).toEqual({
        activeOutstanding: ["18.00"],
        classification: "HEALTHY_ACTIVE_RECEIVABLE",
        delivery: "delivered",
        // The reversed Receivable's offset is history of that Receivable, not
        // current state of the replacement.
        effectiveOffsets: "0.00",
        health: "HEALTHY",
        historicalOffsets: "0.00",
        historicalReceivables: ["cancelled", "reversed"],
        integrity: [],
        physical: "0.00",
      });
      await ledgerExpectation(0);
    });

    it("SCENARIO D: COD covers the service fee, no separate receivable required", async () => {
      const orderId = await deliveredOrder(fixture, 100, "customer_pays_cod_trader_pays_fee");
      expect(await certify(orderId)).toEqual({
        activeOutstanding: [],
        classification: "NO_TRADER_RECEIVABLE_REQUIRED",
        delivery: "delivered",
        effectiveOffsets: "0.00",
        health: "HEALTHY",
        historicalOffsets: "0.00",
        historicalReceivables: [],
        integrity: [],
        physical: "0.00",
      });
    });

    it("SCENARIO E: zero COD, the Trader fee requires a receivable", async () => {
      const before = await events(fixture.companyId);
      const { orderId } = await feeOrder(fixture);
      expect(await certify(orderId)).toEqual({
        activeOutstanding: ["18.00"],
        classification: "HEALTHY_ACTIVE_RECEIVABLE",
        delivery: "delivered",
        effectiveOffsets: "0.00",
        health: "HEALTHY",
        historicalOffsets: "0.00",
        historicalReceivables: [],
        integrity: [],
        physical: "0.00",
      });
      await ledgerExpectation(before);
    });

    it("SCENARIO F: genuine duplicate effective settlement offsets", async () => {
      const { orderId, receivableId } = await feeOrder(fixture);
      await settleWithOffset(fixture, receivableId);
      await craftSecondEffectiveOffset(fixture, receivableId);
      const certified = await certify(orderId);
      expect(certified).toMatchObject({
        classification: "NEEDS_REVIEW",
        effectiveOffsets: "36.00",
        health: "REVIEW",
        historicalOffsets: "0.00",
      });
      expect(certified.integrity).toEqual(
        expect.arrayContaining([
          "receivable_collected_beyond_due",
          "receivable_settled_more_than_once",
        ]),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Part D: the legacy single-Order settle route now uses the canonical service
  // ---------------------------------------------------------------------------

  describe.each(["off", "on"] as const)("Part D legacy settle route -- Accounting %s", (mode) => {
    it("settles a priced COD Order through TraderSettlementService (one implementation)", async () => {
      const fixture = await createFixture(mode);
      const orderId = await payableOrder(fixture);
      const before = await as(fixture, () =>
        get(FundingAccountBalanceService).current("cash", fixture.cashAccountId),
      );
      const request = { headers: { "x-correlation-id": randomUUID() } } as never;
      const settle = () =>
        as(fixture, () =>
          get(OperationsController).settleOrderTrader(
            orderId,
            { cashAccountId: fixture.cashAccountId, paymentMethod: "cash" } as never,
            request,
          ),
        );
      const order = (await settle()) as { traderSettlementStatus?: string };
      expect(order).toBeDefined();
      const settlement = await sql<{
        gross: string;
        fee: string;
        net: string;
        status: string;
        id: string;
      }>`select s.id, s.gross_payable::text as gross, s.service_fee_deductions::text as fee,
                s.net_payable::text as net, s.status
           from trader_settlements s
           join trader_settlement_orders l on l.settlement_id=s.id and l.company_id=s.company_id
          where l.order_id=${orderId}::uuid`.execute(db);
      // The canonical shape the confirmation trigger requires.
      expect(settlement.rows).toEqual([
        { fee: "0.00", gross: "82.00", id: expect.any(String), net: "82.00", status: "confirmed" },
      ]);
      const after = await as(fixture, () =>
        get(FundingAccountBalanceService).current("cash", fixture.cashAccountId),
      );
      expect(Number(after.balance)).toBe(Number(before.balance) - 82);
      const settledEvents = await sql<{
        n: number;
      }>`select count(*)::int as n from accounting_events
        where company_id=${fixture.companyId}::uuid and source_entity_type='trader_settlement'
          and source_entity_id=${settlement.rows[0]!.id}::uuid`.execute(db);
      expect(settledEvents.rows[0]!.n).toBe(mode === "off" ? 0 : 1);
      // A second call is refused exactly as the legacy route did.
      const again = await refusal(settle());
      expect(again.errorCode).toBe("settlement_not_pending");
    });
  });
});
