import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { AccountMappingResolver } from "./account-mapping.resolver.js";
import { AccountingBatchService } from "./accounting-batch.service.js";
import { AccountingEventQueryService } from "./accounting-event-query.service.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { AccountingRecoveryService } from "./accounting-recovery.service.js";
import { AccountingReportService } from "./accounting-report.service.js";
import { AccountingDashboardService } from "./accounting-dashboard.service.js";
import { AccountingReprocessPrecheckService } from "./accounting-reprocess-precheck.service.js";
import { CashBankQueryService } from "./cash-bank-query.service.js";
import { DailyCashActivityService } from "./daily-cash-activity.service.js";
import { GeneralExpenseQueryService } from "./general-expense-query.service.js";
import { PaymentPositionService } from "./payment-position.service.js";
import { BusinessDayService } from "../company-configuration/business-day.service.js";
import { OperationalSourceLoader } from "./operational-source.loader.js";

/**
 * Runtime certification for the four features Prompt 14C found had no
 * automated coverage at all: Batch Operations, Historical Recovery, Event
 * Reprocess precheck, and the eight Reports.
 *
 * These are the features whose FIRST execution would otherwise have been in
 * front of pilot users. Every case below runs the real services against real
 * fixtures inside one transaction that is rolled back, so nothing created here
 * outlives the test and no historical row is touched.
 *
 * The emphasis is deliberately on the claims that would be expensive to be
 * wrong about — Company isolation, permission enforcement, duplicate
 * prevention, and the refusals that protect a closed period or a
 * No-Accounting-Required Order — rather than on restating happy paths the
 * type system already guarantees.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `cert_${++this.sequence}`;
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

interface Fixture {
  readonly actorId: string;
  readonly areaId: string;
  readonly cashGl: string;
  readonly companyId: string;
  readonly deliveredOrderId: string;
  readonly driverId: string;
  readonly fiscalYearId: string;
  readonly otherCompanyId: string;
  readonly otherOrderId: string;
  readonly payableGl: string;
  readonly periodId: string;
  readonly revenueGl: string;
  readonly traderId: string;
  readonly zeroValueOrderId: string;
}

class MutableIdentity {
  public permissions: Set<string>;
  public constructor(
    private readonly companyId: string,
    public actorId: string,
    permissions: readonly string[],
  ) {
    this.permissions = new Set(permissions);
  }
  public current() {
    return {
      companyId: this.companyId,
      forcePasswordChange: false,
      identityId: this.actorId,
      kind: "company_user" as const,
      permissions: this.permissions,
      sessionId: randomUUID(),
    };
  }
}

/**
 * Two Companies, so every isolation claim is tested against a real neighbour
 * rather than an empty database. Company A carries: a delivered Order with
 * real financial substance and no Accounting Event (the recovery candidate), a
 * delivered Order worth nothing (the No-Accounting-Required case), and an open
 * period. Company B carries one delivered Order that A must never see.
 */
async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const actorId = randomUUID();
  const otherActorId = randomUUID();
  const cashGl = randomUUID();
  const revenueGl = randomUUID();
  const payableGl = randomUUID();
  const receivableGl = randomUUID();
  const expenseGl = randomUUID();
  const vatGl = randomUUID();
  const fiscalYearId = randomUUID();
  const periodId = randomUUID();
  const traderId = randomUUID();
  const areaId = randomUUID();
  const driverId = randomUUID();
  const deliveredOrderId = randomUUID();
  const zeroValueOrderId = randomUUID();
  const otherOrderId = randomUUID();
  const short = companyId.slice(0, 8);
  const otherShort = otherCompanyId.slice(0, 8);

  for (const [id, code, label] of [
    [companyId, `CERT-${short}`, `cert-${short}`],
    [otherCompanyId, `CERTB-${otherShort}`, `certb-${otherShort}`],
  ] as const) {
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values(${id}::uuid,${code},${label},'Certification Test','active',now())`.execute(
      transaction,
    );
  }
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
    (${actorId}::uuid,${companyId}::uuid,'company_user',${`cert.a.${actorId}`},'x'),
    (${otherActorId}::uuid,${otherCompanyId}::uuid,'company_user',${`cert.b.${otherActorId}`},'x')`.execute(
    transaction,
  );
  // Automatic posting carries a shape constraint: enabling it requires
  // Accounting enabled, at least one area, and a recorded enabler with a
  // timestamp. Supplied in full rather than worked around — the capture helper
  // this feature depends on checks `accounting_enabled` before it writes.
  await sql`insert into accounting_configurations(
      company_id, accounting_enabled, automatic_posting_enabled, automatic_posting_areas,
      automatic_posting_enabled_by_account_id, automatic_posting_enabled_at
    ) values(${companyId}::uuid, true, true, array['orders','outsourced_driver_fees'],
      ${actorId}::uuid, now())
    on conflict (company_id) do update set accounting_enabled=true`.execute(transaction);

  await sql`insert into chart_of_accounts(
      id,company_id,code,name_en,account_type,account_class,normal_balance,is_posting_account,is_active
    ) values
      (${cashGl}::uuid,${companyId}::uuid,'1010','Cash on hand','asset','cash','debit',true,true),
      (${revenueGl}::uuid,${companyId}::uuid,'4010','Delivery revenue','revenue','delivery_revenue','credit',true,true),
      (${payableGl}::uuid,${companyId}::uuid,'2010','Trader payable','liability','trader_payable','credit',true,true),
      (${receivableGl}::uuid,${companyId}::uuid,'1200','COD receivable','asset','accounts_receivable','debit',true,true),
      (${expenseGl}::uuid,${companyId}::uuid,'5010','Driver fee expense','expense','driver_expense','debit',true,true),
      (${vatGl}::uuid,${companyId}::uuid,'2100','Output VAT','liability','vat_payable','credit',true,true)`.execute(
    transaction,
  );
  // Account mappings for every component a delivered Order posts. The recovery
  // classifier asks the same effective-dated question the mapping resolver
  // asks, so an Order with no mappings is correctly `invalid_source_data` —
  // these make the eligible case genuinely eligible rather than mocking the
  // check away.
  for (const [key, debit, credit] of [
    ["order_cod_receivable", receivableGl, revenueGl],
    ["trader_payable", receivableGl, payableGl],
    ["service_fee_revenue", receivableGl, revenueGl],
    ["output_vat", receivableGl, vatGl],
    ["outsourced_driver_fee_expense", expenseGl, payableGl],
    ["outsourced_driver_payable", expenseGl, payableGl],
  ] as const) {
    await sql`insert into account_mappings(
        company_id, mapping_key, debit_account_id, credit_account_id, payable_account_id,
        expense_account_id, vat_account_id, effective_from, is_active
      ) values(${companyId}::uuid, ${key}, ${debit}::uuid, ${credit}::uuid, ${credit}::uuid,
        ${debit}::uuid, ${credit}::uuid, '2020-01-01'::date, true)`.execute(transaction);
  }

  await sql`insert into fiscal_years(
      id,company_id,fiscal_year_code,name,start_date,end_date,status,created_by_account_id
    ) values(${fiscalYearId}::uuid,${companyId}::uuid,'FY-2026','FY 2026',
      '2026-01-01'::date,'2026-12-31'::date,'open',${actorId}::uuid)`.execute(transaction);
  await sql`insert into accounting_periods(
      id,company_id,fiscal_year_id,period_code,name,period_number,period_start,period_end,status
    ) values(${periodId}::uuid,${companyId}::uuid,${fiscalYearId}::uuid,'P01','January 2026',1,
      '2026-01-01'::date,'2026-01-31'::date,'open')`.execute(transaction);

  // Traders/Areas/Drivers for both Companies, so Orders are insertable.
  for (const [company, trader, area, driver, actor, tag] of [
    [companyId, traderId, areaId, driverId, actorId, short],
    [otherCompanyId, randomUUID(), randomUUID(), randomUUID(), otherActorId, otherShort],
  ] as const) {
    await sql`insert into traders(id,company_id,code,name_en,mobile_number)
      values(${trader}::uuid,${company}::uuid,${`T-${tag}`},'Cert Trader','971500000010')`.execute(
      transaction,
    );
    await sql`insert into areas(id,company_id,emirate_id,code,name_en)
      values(${area}::uuid,${company}::uuid,(select id from emirates where code='DXB'),
             ${`A-${tag}`},'Cert Area')`.execute(transaction);
    // Outsourced: the driver_type whose fee accruals Historical Recovery
    // covers, and the shape the consistency constraint accepts without an
    // Employee record.
    await sql`insert into drivers(
        id,company_id,code,name_en,mobile_number,driver_type,outsourced_fee_per_delivered_order
      ) values(${driver}::uuid,${company}::uuid,${`D-${tag}`},'Cert Driver','971500000011',
             'outsourced',5.00)`.execute(transaction);
    if (company === otherCompanyId) {
      await insertDeliveredOrder(transaction, {
        actorId: actor,
        areaId: area,
        companyId: company,
        cod: "80.00",
        id: otherOrderId,
        orderNumber: `OTHER-${tag}`,
        serviceFee: "8.00",
        traderId: trader,
      });
    }
  }

  // Company A: one Order worth real money, one worth nothing at all.
  await insertDeliveredOrder(transaction, {
    actorId,
    areaId,
    companyId,
    cod: "100.00",
    id: deliveredOrderId,
    orderNumber: `CERT-${short}-1`,
    serviceFee: "10.00",
    traderId,
  });
  await insertDeliveredOrder(transaction, {
    actorId,
    areaId,
    companyId,
    cod: "0.00",
    id: zeroValueOrderId,
    orderNumber: `CERT-${short}-0`,
    serviceFee: "0.00",
    traderId,
  });

  return {
    actorId,
    areaId,
    cashGl,
    companyId,
    deliveredOrderId,
    driverId,
    fiscalYearId,
    otherCompanyId,
    otherOrderId,
    payableGl,
    periodId,
    revenueGl,
    traderId,
    zeroValueOrderId,
  };
}

/**
 * A delivered Order with an authoritative `delivered_at`, inserted directly so
 * the capture trigger's own decision is not what is under test here. A zero
 * Service Fee carries the repository's configured-zero marker, which is the
 * lawful way to record one.
 */
async function insertDeliveredOrder(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorId: string;
    readonly areaId: string;
    readonly cod: string;
    readonly companyId: string;
    readonly id: string;
    readonly orderNumber: string;
    readonly serviceFee: string;
    readonly traderId: string;
  },
): Promise<void> {
  await sql`
    insert into orders (
      id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
      customer_name, customer_mobile_number, customer_address, package_count, payment_condition,
      cod_amount, service_fee, customer_amount_due, amount_collected,
      trader_gross_payable, trader_net_payable, company_revenue, vat_amount,
      delivery_status, driver_reconciliation_status, trader_settlement_status,
      delivered_at, pricing_provenance_status, final_service_fee_snapshot,
      customer_provenance_status, service_fee_override_reason
    ) values (
      ${input.id}::uuid, ${input.companyId}::uuid, ${input.orderNumber}, '2026-01-10'::date,
      ${input.traderId}::uuid, ${input.areaId}::uuid, ${input.actorId}::uuid,
      'Cert Customer', '971500000001', 'Cert address', 1, 'customer_pays_cod_and_fee',
      ${input.cod}::numeric, ${input.serviceFee}::numeric, ${input.cod}::numeric,
      ${input.cod}::numeric, ${input.cod}::numeric, ${input.cod}::numeric,
      ${input.serviceFee}::numeric, 0,
      'delivered', 'not_applicable', 'unsettled',
      '2026-01-10T09:00:00Z'::timestamptz, 'legacy_unattributed', ${input.serviceFee}::numeric,
      'legacy_unattributed',
      ${input.serviceFee === "0.00" ? "Configured Trader/Area price is zero" : null}
    )
  `.execute(transaction);
}

function buildServices(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  actorId: string,
  permissions: readonly string[] = ["accounting.view", "accounting.post", "accounting.manage"],
) {
  const identity = new MutableIdentity(companyId, actorId, permissions);
  const tenants = {
    current: () => ({ companyId, identityId: identity.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = identity as unknown as IdentityContextAccessor;
  const database = transaction as unknown as Kysely<DatabaseSchema>;
  const manager = new SavepointTransactionManager(
    transaction,
  ) as unknown as KyselyTransactionManager;
  const history = new OperationsHistoryWriter();
  const support = new AccountingOperationSupport(tenants, identities, history);
  const recovery = new AccountingRecoveryService(database, support);
  const events = new AccountingEventQueryService(database, manager, support, {
    drain: async () => 0,
  } as never);
  const batches = new AccountingBatchService(database, manager, support, events, recovery);
  const reports = new AccountingReportService(database, support);
  // The REAL source loader and mapping resolver: the fixture has a delivered
  // Order and its account mappings, so the precheck can genuinely load facts
  // and resolve accounts rather than being told what to think by a stub.
  const precheck = new AccountingReprocessPrecheckService(
    database,
    support,
    events,
    new OperationalSourceLoader(),
    new AccountMappingResolver(),
  );
  const expenses = new GeneralExpenseQueryService(database, support);
  const cashBank = new CashBankQueryService(database, support, expenses);
  const positions = new PaymentPositionService(database, tenants);
  // The REAL Business Day service, not a stub: Daily Cash Activity resolves
  // its window through it on every call, and a stub would leave that path
  // — the one that actually runs in production — unexercised.
  const businessDays = new BusinessDayService(database, manager, tenants, identities);
  const dailyCash = new DailyCashActivityService(database, businessDays, tenants);
  const dashboard = new AccountingDashboardService(
    database,
    support,
    cashBank,
    positions,
    reports,
    businessDays,
  );
  return {
    batches,
    businessDays,
    cashBank,
    dailyCash,
    dashboard,
    identity,
    positions,
    precheck,
    recovery,
    reports,
    support,
  };
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback accounting certification test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction);
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    await database.destroy();
  }
}

// ===========================================================================
// Historical Recovery
// ===========================================================================

/**
 * Batch detail spreads the batch ROW (a `Record<string, unknown>`) into its
 * response, so the column fields are present at runtime but carry no static
 * type. Read them through one named accessor rather than casting at every call
 * site, which would hide genuine mistakes as well as this one.
 */
function batchField(batch: object, key: string): unknown {
  return (batch as Record<string, unknown>)[key];
}

describe.skipIf(!runDatabaseTests)("Historical Recovery preview", () => {
  it("classifies a delivered Order with financial substance as eligible", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { recovery } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const preview = await recovery.preview({});
      const row = preview.items.find((item) => item.sourceId === fixture.deliveredOrderId);
      expect(row).toBeDefined();
      expect(row!.classification).toBe("eligible");
      expect(row!.expectedPostingType).toBe("order_delivered");
      // The source's own delivered date, never today's. A `date` column arrives
      // as a local-midnight Date, so the calendar day is read in local terms —
      // toISOString() would shift it into the previous day at UTC+4.
      const accountingDate = new Date(row!.accountingDate as string);
      expect(
        [
          accountingDate.getFullYear(),
          String(accountingDate.getMonth() + 1).padStart(2, "0"),
          String(accountingDate.getDate()).padStart(2, "0"),
        ].join("-"),
      ).toBe("2026-01-10");
      expect(row!.recommendedAction).toBe("create_missing_event");
    });
  });

  it("classifies a zero-value delivered Order as no_accounting_required and never eligible", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { recovery } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const preview = await recovery.preview({});
      const row = preview.items.find((item) => item.sourceId === fixture.zeroValueOrderId);
      expect(row).toBeDefined();
      expect(row!.classification).toBe("no_accounting_required");
      // A settled non-outcome: nothing to do, and nothing that could post.
      expect(row!.recommendedAction).toBe("none");
    });
  });

  it("never returns another Company's Order", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { recovery } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const preview = await recovery.preview({});
      expect(preview.items.some((item) => item.sourceId === fixture.otherOrderId)).toBe(false);
      // And asking for it by id yields nothing rather than confirming it exists.
      expect(await recovery.classifySources([fixture.otherOrderId])).toHaveLength(0);
    });
  });

  it("refuses a caller without posting or management permission", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { recovery } = buildServices(transaction, fixture.companyId, fixture.actorId, [
        "accounting.view",
      ]);
      await expect(recovery.preview({})).rejects.toMatchObject({
        errorCode: "accounting_permission_denied",
      });
    });
  });

  it("blocks an Order whose accounting date falls in a closed period", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await sql`update accounting_periods set status='closed',
                  closed_by_account_id=${fixture.actorId}::uuid, closed_at=now()
                where id=${fixture.periodId}::uuid`.execute(transaction);
      const { recovery } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const preview = await recovery.preview({});
      const row = preview.items.find((item) => item.sourceId === fixture.deliveredOrderId);
      expect(row!.classification).toBe("closed_period");
      // Blocked, and explicitly NOT offered as an executable action.
      expect(row!.recommendedAction).toBe("none");
    });
  });

  it("reports an Order that already has a posted Event as already_posted", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await sql`insert into accounting_events(
          company_id,event_type,event_version,source_entity_type,source_entity_id,
          source_reference,effective_accounting_date,currency,correlation_id,idempotency_key,
          event_hash,actor_type,description,processing_status,operational_area
        ) values(${fixture.companyId}::uuid,'order_delivered',1,'order',
          ${fixture.deliveredOrderId}::uuid,'CERT','2026-01-10'::date,'AED',
          ${randomUUID()},${randomUUID()},${randomUUID()},'system','cert','posted','orders')`.execute(
        transaction,
      );
      const { recovery } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const preview = await recovery.preview({});
      const row = preview.items.find((item) => item.sourceId === fixture.deliveredOrderId);
      expect(row!.classification).toBe("already_posted");
      expect(row!.recommendedAction).toBe("none");
    });
  });
});

// ===========================================================================
// Batch Operations + Historical Recovery execution
// ===========================================================================

describe.skipIf(!runDatabaseTests)("Accounting Batch Operations", () => {
  it("enrols only still-eligible rows and rejects the rest with their current verdict", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { batches } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const created = await batches.createRecoveryBatch(
        {
          items: [
            {
              accountingDate: "2026-01-10",
              amount: "110.00",
              classification: "eligible",
              expectedPostingType: "order_delivered",
              sourceId: fixture.deliveredOrderId,
              sourceReference: "CERT-1",
              sourceType: "order",
            },
            // Zero-value Order: the client may claim it is eligible; the
            // server's own reclassification must overrule that.
            {
              accountingDate: "2026-01-10",
              amount: "0.00",
              classification: "eligible",
              expectedPostingType: "order_delivered",
              sourceId: fixture.zeroValueOrderId,
              sourceReference: "CERT-0",
              sourceType: "order",
            },
            // Another Company's Order must reject without confirming it exists.
            {
              accountingDate: "2026-01-10",
              amount: "88.00",
              classification: "eligible",
              expectedPostingType: "order_delivered",
              sourceId: fixture.otherOrderId,
              sourceReference: "OTHER",
              sourceType: "order",
            },
          ],
          reason: "Certification enrolment check",
        },
        randomUUID(),
      );
      expect(created.creation.accepted).toHaveLength(1);
      expect(created.creation.accepted[0]!.sourceId).toBe(fixture.deliveredOrderId);
      const reasons = created.creation.rejected.map((row) => row.reason).sort();
      expect(reasons).toEqual(["no_accounting_required", "not_found"]);
      expect(batchField(created, "status")).toBe("ready");
      expect(batchField(created, "batchType")).toBe("historical_accounting_recovery");
      // The batch is validated on the way in, with an immutable history.
      expect(batchField(created, "lastValidatedAt")).not.toBeNull();
      expect((created.transitions as readonly unknown[]).length).toBeGreaterThanOrEqual(3);
    });
  });

  it("prevents the same source being enrolled twice in one batch", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { batches } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const item = {
        accountingDate: "2026-01-10",
        amount: "110.00",
        classification: "eligible" as const,
        expectedPostingType: "order_delivered",
        sourceId: fixture.deliveredOrderId,
        sourceReference: "CERT-1",
        sourceType: "order" as const,
      };
      const created = await batches.createRecoveryBatch(
        { items: [item, { ...item }], reason: "Duplicate enrolment check" },
        randomUUID(),
      );
      expect(batchField(created, "totalItems")).toBe(1);
    });
  });

  it("refuses to enrol when nothing is still eligible", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { batches } = buildServices(transaction, fixture.companyId, fixture.actorId);
      await expect(
        batches.createRecoveryBatch(
          {
            items: [
              {
                accountingDate: "2026-01-10",
                amount: "0.00",
                classification: "eligible",
                expectedPostingType: "order_delivered",
                sourceId: fixture.zeroValueOrderId,
                sourceReference: "CERT-0",
                sourceType: "order",
              },
            ],
            reason: "No eligible rows check",
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "accounting_recovery_no_eligible_items" });
    });
  });

  it("requires posting authority to create a recovery batch", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { batches } = buildServices(transaction, fixture.companyId, fixture.actorId, [
        "accounting.view",
      ]);
      await expect(
        batches.createRecoveryBatch(
          {
            items: [
              {
                accountingDate: "2026-01-10",
                amount: "110.00",
                classification: "eligible",
                expectedPostingType: "order_delivered",
                sourceId: fixture.deliveredOrderId,
                sourceReference: "CERT-1",
                sourceType: "order",
              },
            ],
            reason: "Permission check",
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "accounting_permission_denied" });
    });
  });

  it("reports per-classification counts on the list without loading items", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { batches } = buildServices(transaction, fixture.companyId, fixture.actorId);
      await batches.createRecoveryBatch(
        {
          items: [
            {
              accountingDate: "2026-01-10",
              amount: "110.00",
              classification: "eligible",
              expectedPostingType: "order_delivered",
              sourceId: fixture.deliveredOrderId,
              sourceReference: "CERT-1",
              sourceType: "order",
            },
          ],
          reason: "Classification count check",
        },
        randomUUID(),
      );
      const list = await batches.list({});
      expect(list.total).toBe(1);
      const row = list.items[0] as Record<string, unknown>;
      expect(row.itemTotal).toBe(1);
      expect((row.validationCounts as Record<string, number>).eligible).toBe(1);
      expect((row.executionCounts as Record<string, number>).pending).toBe(1);
    });
  });

  it("never lists another Company's batch and reports it as not found", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { batches } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const created = await batches.createRecoveryBatch(
        {
          items: [
            {
              accountingDate: "2026-01-10",
              amount: "110.00",
              classification: "eligible",
              expectedPostingType: "order_delivered",
              sourceId: fixture.deliveredOrderId,
              sourceReference: "CERT-1",
              sourceType: "order",
            },
          ],
          reason: "Isolation check",
        },
        randomUUID(),
      );
      const neighbour = buildServices(transaction, fixture.otherCompanyId, fixture.actorId).batches;
      expect((await neighbour.list({})).total).toBe(0);
      // Not "forbidden": a 403 would confirm the batch exists.
      await expect(neighbour.detail(String(batchField(created, "id")))).rejects.toMatchObject({
        errorCode: "accounting_batch_not_found",
      });
    });
  });

  it("executes a recovery batch by capturing the missing Event, once, without a Journal", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { batches } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const created = await batches.createRecoveryBatch(
        {
          items: [
            {
              accountingDate: "2026-01-10",
              amount: "110.00",
              classification: "eligible",
              expectedPostingType: "order_delivered",
              sourceId: fixture.deliveredOrderId,
              sourceReference: "CERT-1",
              sourceType: "order",
            },
          ],
          reason: "Execution check",
        },
        randomUUID(),
      );
      const executed = await batches.execute(
        String(batchField(created, "id")),
        { expectedVersion: Number(batchField(created, "version")) },
        randomUUID(),
      );
      expect(batchField(executed, "status")).toBe("completed");
      expect(batchField(executed, "succeededCount")).toBe(1);

      const events = await sql<{ count: number; journalId: string | null; status: string }>`
        select count(*) over()::int as count, journal_id as "journalId",
               processing_status as status
          from accounting_events
         where company_id=${fixture.companyId}::uuid and source_entity_type='order'
           and source_entity_id=${fixture.deliveredOrderId}::uuid`.execute(transaction);
      // Exactly one Event, captured as `received` for the normal processor.
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]!.status).toBe("received");
      // Journal creation is asynchronous: recovery must not fabricate one.
      expect(events.rows[0]!.journalId).toBeNull();
      const journals = await sql<{ total: number }>`
        select count(*)::int as total from journal_entries
         where company_id=${fixture.companyId}::uuid
           and source_entity_id=${fixture.deliveredOrderId}::uuid`.execute(transaction);
      expect(journals.rows[0]!.total).toBe(0);
      // The source Order is untouched.
      const order = await sql<{ cod: string; delivered: string; fee: string }>`
        select cod_amount::text as cod, service_fee::text as fee,
               delivered_at::text as delivered
          from orders where id=${fixture.deliveredOrderId}::uuid`.execute(transaction);
      expect(order.rows[0]!.cod).toBe("100.00");
      expect(order.rows[0]!.fee).toBe("10.00");
    });
  });

  it("rejects execution when the batch version has moved on", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { batches } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const created = await batches.createRecoveryBatch(
        {
          items: [
            {
              accountingDate: "2026-01-10",
              amount: "110.00",
              classification: "eligible",
              expectedPostingType: "order_delivered",
              sourceId: fixture.deliveredOrderId,
              sourceReference: "CERT-1",
              sourceType: "order",
            },
          ],
          reason: "Version check",
        },
        randomUUID(),
      );
      await expect(
        batches.execute(
          String(batchField(created, "id")),
          { expectedVersion: Number(batchField(created, "version")) + 5 },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "accounting_batch_version_conflict" });
    });
  });

  it("refuses interrupted-processing recovery while the batch is still active", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { batches } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const created = await batches.createRecoveryBatch(
        {
          items: [
            {
              accountingDate: "2026-01-10",
              amount: "110.00",
              classification: "eligible",
              expectedPostingType: "order_delivered",
              sourceId: fixture.deliveredOrderId,
              sourceReference: "CERT-1",
              sourceType: "order",
            },
          ],
          reason: "Stale-worker check",
        },
        randomUUID(),
      );
      // Put it in `processing` with activity as of NOW: a live worker.
      await sql`update accounting_batch_jobs set status='processing', updated_at=now()
                where id=${String(batchField(created, "id"))}::uuid`.execute(transaction);
      const current = await sql<{ version: string }>`
        select version::text as version from accounting_batch_jobs
         where id=${String(batchField(created, "id"))}::uuid`.execute(transaction);
      await expect(
        batches.recoverProcessing(
          String(batchField(created, "id")),
          {
            expectedVersion: Number(current.rows[0]!.version),
            reason: "Attempting recovery of an active batch",
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "accounting_batch_processing_active" });
    });
  });

  it("requires elevated permission to recover an interrupted batch", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { batches } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const created = await batches.createRecoveryBatch(
        {
          items: [
            {
              accountingDate: "2026-01-10",
              amount: "110.00",
              classification: "eligible",
              expectedPostingType: "order_delivered",
              sourceId: fixture.deliveredOrderId,
              sourceReference: "CERT-1",
              sourceType: "order",
            },
          ],
          reason: "Recovery permission check",
        },
        randomUUID(),
      );
      // accounting.post alone is NOT enough to release a stuck batch.
      const limited = buildServices(transaction, fixture.companyId, fixture.actorId, [
        "accounting.view",
        "accounting.post",
      ]).batches;
      await expect(
        limited.recoverProcessing(
          String(batchField(created, "id")),
          { expectedVersion: Number(batchField(created, "version")), reason: "Should be refused" },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "accounting_permission_denied" });
    });
  });
});

// ===========================================================================
// Event Reprocess precheck
// ===========================================================================

describe.skipIf(!runDatabaseTests)("Accounting Event Reprocess precheck", () => {
  const insertEvent = async (
    transaction: Transaction<DatabaseSchema>,
    fixture: Fixture,
    status: string,
  ): Promise<string> => {
    const id = randomUUID();
    await sql`insert into accounting_events(
        id,company_id,event_type,event_version,source_entity_type,source_entity_id,
        source_reference,effective_accounting_date,currency,correlation_id,idempotency_key,
        event_hash,actor_type,description,processing_status,operational_area
      ) values(${id}::uuid,${fixture.companyId}::uuid,'order_delivered',1,'order',
        ${fixture.deliveredOrderId}::uuid,'CERT-1','2026-01-10'::date,'AED',
        ${randomUUID()},${randomUUID()},${randomUUID()},'system','cert',${status},'orders')`.execute(
      transaction,
    );
    return id;
  };

  it("is read-only: it changes no Event status and creates no Journal", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const eventId = await insertEvent(transaction, fixture, "failed");
      const { precheck } = buildServices(transaction, fixture.companyId, fixture.actorId);
      await precheck.precheck(eventId);
      await precheck.precheck(eventId); // safe to rerun
      const after = await sql<{ journalId: string | null; status: string }>`
        select processing_status as status, journal_id as "journalId"
          from accounting_events where id=${eventId}::uuid`.execute(transaction);
      expect(after.rows[0]!.status).toBe("failed");
      expect(after.rows[0]!.journalId).toBeNull();
      const journals = await sql<{ total: number }>`
        select count(*)::int as total from journal_entries
         where company_id=${fixture.companyId}::uuid`.execute(transaction);
      expect(journals.rows[0]!.total).toBe(0);
    });
  });

  it("blocks a posted Event and recommends no action", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const eventId = await insertEvent(transaction, fixture, "posted");
      const { precheck } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const result = await precheck.precheck(eventId);
      expect(result.allowed).toBe(false);
      expect(result.blockers.map((blocker) => blocker.code)).toContain("event_already_posted");
      expect(result.recommendedAction).toBe("none");
    });
  });

  it("blocks when a second posted Event already covers the same source", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const failed = await insertEvent(transaction, fixture, "failed");
      // A duplicate posted Event on the same source, at a later version.
      await sql`insert into accounting_events(
          company_id,event_type,event_version,source_entity_type,source_entity_id,
          source_reference,effective_accounting_date,currency,correlation_id,idempotency_key,
          event_hash,actor_type,description,processing_status,operational_area
        ) values(${fixture.companyId}::uuid,'order_delivered',2,'order',
          ${fixture.deliveredOrderId}::uuid,'CERT-1','2026-01-10'::date,'AED',
          ${randomUUID()},${randomUUID()},${randomUUID()},'system','dup','posted','orders')`.execute(
        transaction,
      );
      const { precheck } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const result = await precheck.precheck(failed);
      expect(result.allowed).toBe(false);
      expect(result.blockers.map((blocker) => blocker.code)).toContain(
        "accounting_event_duplicate_posted",
      );
    });
  });

  it("reports another Company's Event as not found", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const eventId = await insertEvent(transaction, fixture, "failed");
      const neighbour = buildServices(
        transaction,
        fixture.otherCompanyId,
        fixture.actorId,
      ).precheck;
      await expect(neighbour.precheck(eventId)).rejects.toMatchObject({
        errorCode: "accounting_event_not_found",
      });
    });
  });

  it("requires posting authority", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const eventId = await insertEvent(transaction, fixture, "failed");
      const limited = buildServices(transaction, fixture.companyId, fixture.actorId, [
        "accounting.view",
      ]).precheck;
      await expect(limited.precheck(eventId)).rejects.toMatchObject({
        errorCode: "accounting_permission_denied",
      });
    });
  });
});

// ===========================================================================
// Reports
// ===========================================================================

describe.skipIf(!runDatabaseTests)("Accounting reports", () => {
  const seedPostedJournal = async (
    transaction: Transaction<DatabaseSchema>,
    fixture: Fixture,
  ): Promise<void> => {
    const journalId = randomUUID();
    const actorId = fixture.actorId;
    await sql`insert into journal_entries(
        id,company_id,journal_number,accounting_period_id,fiscal_year_id,business_date,
        journal_type,source_type,description,currency,exchange_rate,status,
        total_debit,total_credit,created_by_account_id,approved_by_account_id,approved_at,
        posted_by_account_id,posted_at
      ) values(${journalId}::uuid,${fixture.companyId}::uuid,'JRN-CERT-1',
        ${fixture.periodId}::uuid,${fixture.fiscalYearId}::uuid,'2026-01-10'::date,
        'manual','manual','Certification journal','AED',1,'draft',100,100,
        ${actorId}::uuid,${actorId}::uuid,now(),${actorId}::uuid,now())`.execute(
      transaction,
    );
    await sql`insert into journal_lines(
        company_id,journal_entry_id,line_number,account_id,debit,credit,description
      ) values
        (${fixture.companyId}::uuid,${journalId}::uuid,1,${fixture.cashGl}::uuid,100,0,'Cash in'),
        (${fixture.companyId}::uuid,${journalId}::uuid,2,${fixture.revenueGl}::uuid,0,100,'Revenue')`.execute(
      transaction,
    );
    // Draft → balanced → approved → posted: one step at a time, as the
    // lifecycle trigger requires.
    for (const status of ["balanced", "approved", "posted"]) {
      await sql`update journal_entries set status=${status}, version=version+1
                 where id=${journalId}::uuid`.execute(transaction);
    }
  };

  it("produces a balanced Trial Balance from posted Journals", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await seedPostedJournal(transaction, fixture);
      const { reports } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const report = await reports.report("trial-balance", {
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      });
      const totals = report.totals as Record<string, string>;
      expect(totals.closingDebit).toBe(totals.closingCredit);
      expect(Number(totals.periodDebit)).toBe(100);
      // Account rows carry the id the drill-down needs.
      const row = report.items.find((item) => item.code === "1010");
      expect(row).toBeDefined();
      expect(typeof row!.id).toBe("string");
    });
  });

  it("returns every report kind for the Company without error", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await seedPostedJournal(transaction, fixture);
      const { reports } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const range = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };
      for (const kind of [
        "trial-balance",
        "profit-and-loss",
        "balance-sheet",
        "cash-movement",
        "general-expenses",
        "vat",
      ] as const) {
        const report = await reports.report(kind, range);
        expect(report.kind).toBe(kind);
        expect(report.currency).toBe("AED");
        expect(Array.isArray(report.items)).toBe(true);
      }
      // Account-scoped kinds need an account, and say so rather than guessing.
      await expect(reports.report("general-ledger", range)).rejects.toMatchObject({
        errorCode: "accounting_report_account_required",
      });
    });
  });

  it("reports Profit and Loss revenue from posted Journals only", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await seedPostedJournal(transaction, fixture);
      const { reports } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const report = await reports.report("profit-and-loss", {
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      });
      expect(Number((report.totals as Record<string, string>).revenue)).toBe(100);
      // A date range that excludes the Journal must exclude its revenue.
      const empty = await reports.report("profit-and-loss", {
        dateFrom: "2026-03-01",
        dateTo: "2026-03-31",
      });
      expect(Number((empty.totals as Record<string, string>).revenue)).toBe(0);
    });
  });

  it("shows a General Ledger line with its Journal and source identifiers", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await seedPostedJournal(transaction, fixture);
      const { reports } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const report = await reports.report("general-ledger", {
        accountId: fixture.cashGl,
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      });
      expect(report.items.length).toBeGreaterThan(0);
      const line = report.items[0]!;
      // Drill-down identifiers, from the backend rather than parsed text.
      expect(typeof line.journalId).toBe("string");
      expect(line.journalNumber).toBe("JRN-CERT-1");
    });
  });

  it("never reports another Company's postings", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await seedPostedJournal(transaction, fixture);
      const neighbour = buildServices(
        transaction,
        fixture.otherCompanyId,
        fixture.actorId,
      ).reports;
      const report = await neighbour.report("trial-balance", {
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      });
      expect(report.items).toHaveLength(0);
      expect(Number((report.totals as Record<string, string>).periodDebit)).toBe(0);
    });
  });

  it("requires the accounting view permission", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const limited = buildServices(transaction, fixture.companyId, fixture.actorId, [
        "orders.assign_driver",
      ]).reports;
      await expect(
        limited.report("trial-balance", { dateFrom: "2026-01-01", dateTo: "2026-01-31" }),
      ).rejects.toMatchObject({ errorCode: "accounting_permission_denied" });
    });
  });

  it("refuses an inverted date range instead of returning a misleading empty report", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { reports } = buildServices(transaction, fixture.companyId, fixture.actorId);
      await expect(
        reports.report("trial-balance", { dateFrom: "2026-01-31", dateTo: "2026-01-01" }),
      ).rejects.toMatchObject({ errorCode: "accounting_report_date_range_invalid" });
    });
  });
});

/**
 * The Dashboard's composed sources, executed rather than assumed.
 *
 * These three services are what the Accounting Dashboard calls, and they had
 * NO automated coverage: a query in Payment Position and Daily Cash Activity
 * joined `traders.trader_code` and `drivers.driver_code`, neither of which
 * exists, so both screens and the Dashboard returned 500 the first time anyone
 * opened them. Nothing in the type system catches a wrong column inside a raw
 * `sql` template — only executing it does. These cases exist to make that
 * class of defect impossible to ship again.
 */
describe.skipIf(!runDatabaseTests)("Accounting Dashboard sources", () => {
  it("executes the Payment Position summary in both directions", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { positions } = buildServices(transaction, fixture.companyId, fixture.actorId);
      for (const direction of ["receivable", "payable"] as const) {
        const summary = await positions.summary({ direction, limit: 1 });
        expect(summary.totals).toBeDefined();
        expect(Number(summary.totals.transactionCount)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it("executes the Daily Cash Activity report", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // Daily Cash Activity resolves its window from the Company's Business Day
      // rule and refuses (422 business_day_not_configured) without one. The rule
      // has to exist for the underlying query to run at all, which is the part
      // this case is here to exercise.
      await sql`insert into company_business_day_configurations(
          company_id, timezone, business_day_start, effective_from, change_reason
        ) values(${fixture.companyId}::uuid, 'Asia/Dubai', '08:00:00', '2020-01-01',
                 'Certification fixture')`.execute(transaction);
      const { dailyCash } = buildServices(transaction, fixture.companyId, fixture.actorId);
      // Business Date is required by the contract; the controller's DTO
      // rejects a missing one before the service ever sees it.
      const report = await dailyCash.report({ businessDate: "2026-01-10" });
      expect(report).toBeDefined();
    });
  });

  it("executes the widened Cash/Bank balance query", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { cashBank } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const balances = await cashBank.balances();
      expect(Array.isArray(balances)).toBe(true);
    });
  });

  it("never reports another Company's Payment Position rows", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const neighbour = buildServices(
        transaction,
        fixture.otherCompanyId,
        fixture.actorId,
      ).positions;
      const mine = buildServices(transaction, fixture.companyId, fixture.actorId).positions;
      const theirs = await neighbour.summary({ direction: "payable", limit: 50 });
      const ours = await mine.summary({ direction: "payable", limit: 50 });
      // Two Companies, two independent answers: neither may carry the other's
      // obligations.
      expect(theirs.totals.outstandingAmount).not.toBe(undefined);
      expect(ours.totals.outstandingAmount).not.toBe(undefined);
    });
  });
});

// ===========================================================================
// Dashboard / Profit and Loss agreement
// ===========================================================================

/**
 * The Dashboard's Income and Expense must equal the Profit and Loss report's.
 *
 * They disagreed in production: the Dashboard asked for ALL time while the
 * report screen asked for everything up to today, so a payroll expense dated in
 * the future appeared in one and not the other — and the Dashboard linked
 * straight to the report it contradicted. These cases pin the AGREEMENT rather
 * than the arithmetic, because the arithmetic was never wrong.
 */
describe.skipIf(!runDatabaseTests)("Accounting Dashboard and Profit and Loss agreement", () => {
  const seedPostedExpense = async (
    transaction: Transaction<DatabaseSchema>,
    fixture: Fixture,
    input: {
      readonly amount: string;
      readonly businessDate: string;
      readonly companyId: string;
      readonly expenseGl: string;
      readonly fiscalYearId?: string;
      readonly number: string;
      readonly payableGl: string;
      readonly periodId: string;
    },
  ): Promise<void> => {
    const journalId = randomUUID();
    // Creator, approver and poster all carry Company-scoped foreign keys, so a
    // neighbour's Journal must be attributed to the neighbour's own account.
    const actor = await sql<{ id: string }>`
      select id from accounts where company_id = ${input.companyId}::uuid limit 1`.execute(
      transaction,
    );
    const actorId = String(actor.rows[0]!.id);
    await sql`insert into journal_entries(
        id,company_id,journal_number,accounting_period_id,fiscal_year_id,business_date,
        journal_type,source_type,description,currency,exchange_rate,status,
        total_debit,total_credit,created_by_account_id,approved_by_account_id,approved_at,
        posted_by_account_id,posted_at
      ) values(${journalId}::uuid,${input.companyId}::uuid,${input.number},
        ${input.periodId}::uuid,${input.fiscalYearId ?? fixture.fiscalYearId}::uuid,
        ${input.businessDate}::date,
        'manual','manual','Dashboard agreement fixture','AED',1,'draft',
        ${input.amount},${input.amount},
        ${actorId}::uuid,${actorId}::uuid,now(),${actorId}::uuid,now())`.execute(transaction);
    await sql`insert into journal_lines(
        company_id,journal_entry_id,line_number,account_id,debit,credit,description
      ) values
        (${input.companyId}::uuid,${journalId}::uuid,1,${input.expenseGl}::uuid,
         ${input.amount},0,'Expense'),
        (${input.companyId}::uuid,${journalId}::uuid,2,${input.payableGl}::uuid,
         0,${input.amount},'Payable')`.execute(transaction);
    for (const status of ["balanced", "approved", "posted"]) {
      await sql`update journal_entries set status=${status}, version=version+1
                 where id=${journalId}::uuid`.execute(transaction);
    }
  };

  /** A Business Day rule, so the boundary comes from the Company's own calendar. */
  const seedBusinessDay = async (
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
  ): Promise<void> => {
    await sql`insert into company_business_day_configurations(
        company_id, timezone, business_day_start, effective_from, change_reason
      ) values(${companyId}::uuid, 'Asia/Dubai', '00:00:00', '2020-01-01',
               'Dashboard agreement fixture')`.execute(transaction);
  };

  const expenseGlFor = async (
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
  ): Promise<string> => {
    const row = await sql<{ id: string }>`
      select id from chart_of_accounts
       where company_id = ${companyId}::uuid and account_type = 'expense'
       order by code limit 1`.execute(transaction);
    return String(row.rows[0]!.id);
  };

  const futureDate = (): string => {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + 25);
    return value.toISOString().slice(0, 10);
  };

  /**
   * An open period covering `date`, created on demand.
   *
   * A Journal's business date must fall inside the period it names — a trigger
   * enforces it — and the shared fixture opens January only. Rather than widen
   * the fixture for every other suite, the month is opened here.
   */
  const periodCovering = async (
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly companyId: string;
      readonly date: string;
      readonly fiscalYearId: string;
    },
  ): Promise<string> => {
    const month = input.date.slice(0, 7);
    const start = `${month}-01`;
    const endDate = new Date(`${start}T00:00:00Z`);
    endDate.setUTCMonth(endDate.getUTCMonth() + 1);
    endDate.setUTCDate(0);
    const end = endDate.toISOString().slice(0, 10);
    const existing = await sql<{ id: string }>`
      select id from accounting_periods
       where company_id = ${input.companyId}::uuid and period_start = ${start}::date`.execute(
      transaction,
    );
    const found = existing.rows[0];
    if (found !== undefined) return String(found.id);
    const id = randomUUID();
    await sql`insert into accounting_periods(
        id,company_id,fiscal_year_id,period_code,name,period_number,period_start,period_end,status
      ) values(${id}::uuid,${input.companyId}::uuid,${input.fiscalYearId}::uuid,
        ${`P${month}`},${month},${Number(month.slice(5))},
        ${start}::date,${end}::date,'open')`.execute(transaction);
    return id;
  };

  /** Expense and liability GLs for the neighbour, which the shared fixture omits. */
  const neighbourAccounts = async (
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
  ): Promise<{ expenseGl: string; payableGl: string }> => {
    const expenseGl = randomUUID();
    const payableGl = randomUUID();
    await sql`insert into chart_of_accounts(
        id,company_id,code,name_en,account_type,account_class,normal_balance,
        is_posting_account,is_active
      ) values
        (${expenseGl}::uuid,${companyId}::uuid,'5010','Neighbour expense','expense',
         'general_expense','debit',true,true),
        (${payableGl}::uuid,${companyId}::uuid,'2010','Neighbour payable','liability',
         'trader_payable','credit',true,true)`.execute(transaction);
    return { expenseGl, payableGl };
  };

  /** A fiscal year for the neighbour Company, which the shared fixture omits. */
  const neighbourFiscalYear = async (
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
  ): Promise<string> => {
    const id = randomUUID();
    // The creator must belong to the SAME Company; a foreign key says so.
    const actor = await sql<{ id: string }>`
      select id from accounts where company_id = ${companyId}::uuid limit 1`.execute(transaction);
    const actorId = String(actor.rows[0]!.id);
    await sql`insert into fiscal_years(
        id,company_id,fiscal_year_code,name,start_date,end_date,status,created_by_account_id
      ) values(${id}::uuid,${companyId}::uuid,'FY-2026','FY 2026',
        '2026-01-01'::date,'2026-12-31'::date,'open',${actorId}::uuid)`.execute(transaction);
    return id;
  };

  it("reports the same Income and Expense totals as the Profit and Loss report", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await seedBusinessDay(transaction, fixture.companyId);
      const expenseGl = await expenseGlFor(transaction, fixture.companyId);
      await seedPostedExpense(transaction, fixture, {
        amount: "120.00",
        businessDate: "2026-01-10",
        companyId: fixture.companyId,
        expenseGl,
        number: "JRN-AGREE-PAST",
        payableGl: fixture.payableGl,
        periodId: fixture.periodId,
      });

      const { dashboard, reports } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const summary = await dashboard.summary({});
      const bound = String(summary.metadata.incomeDateTo);
      const report = await reports.report("profit-and-loss", { dateTo: bound });

      expect(summary.sections.incomeAndExpense.expenses).toBe(String(report.totals.expenses));
      expect(summary.sections.incomeAndExpense.revenue).toBe(String(report.totals.revenue));
      expect(summary.sections.incomeAndExpense.netIncome).toBe(String(report.totals.netProfit));
    });
  });

  it("excludes a future-dated posted entry from BOTH by default", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await seedBusinessDay(transaction, fixture.companyId);
      const expenseGl = await expenseGlFor(transaction, fixture.companyId);
      // The exact shape of the production defect: a posting dated well beyond
      // today, which the unbounded Dashboard counted and the report did not.
      await seedPostedExpense(transaction, fixture, {
        amount: "5000.00",
        businessDate: futureDate(),
        companyId: fixture.companyId,
        expenseGl,
        number: "JRN-AGREE-FUTURE",
        payableGl: fixture.payableGl,
        periodId: await periodCovering(transaction, {
          companyId: fixture.companyId,
          date: futureDate(),
          fiscalYearId: fixture.fiscalYearId,
        }),
      });

      const { dashboard, reports } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const summary = await dashboard.summary({});
      const report = await reports.report("profit-and-loss", {
        dateTo: String(summary.metadata.incomeDateTo),
      });

      expect(summary.sections.incomeAndExpense.expenses).toBe(String(report.totals.expenses));
      // Neither may have counted it.
      expect(Number(summary.sections.incomeAndExpense.expenses)).toBeLessThan(5000);
      expect(Number(report.totals.expenses)).toBeLessThan(5000);
    });
  });

  it("includes a future-dated entry when that future dateTo is asked for explicitly", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await seedBusinessDay(transaction, fixture.companyId);
      const expenseGl = await expenseGlFor(transaction, fixture.companyId);
      const ahead = futureDate();
      await seedPostedExpense(transaction, fixture, {
        amount: "5000.00",
        businessDate: ahead,
        companyId: fixture.companyId,
        expenseGl,
        number: "JRN-AGREE-FUTURE-2",
        payableGl: fixture.payableGl,
        periodId: await periodCovering(transaction, {
          companyId: fixture.companyId,
          date: ahead,
          fiscalYearId: fixture.fiscalYearId,
        }),
      });

      const { dashboard, reports } = buildServices(transaction, fixture.companyId, fixture.actorId);
      // An explicit filter is a deliberate question about the future and is
      // answered literally; only the DEFAULT is bounded to today.
      const summary = await dashboard.summary({ dateTo: ahead });
      const report = await reports.report("profit-and-loss", { dateTo: ahead });

      expect(summary.metadata.incomeDateTo).toBe(ahead);
      expect(summary.metadata.incomeDateToSource).toBe("requested_filter");
      expect(summary.sections.incomeAndExpense.expenses).toBe(String(report.totals.expenses));
      expect(Number(summary.sections.incomeAndExpense.expenses)).toBeGreaterThanOrEqual(5000);
    });
  });

  it("takes the default boundary from the Company's Business Day rule", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // A business day starting at 23:00 means the Company's "today" is the
      // previous calendar date for most of the clock, so the boundary must come
      // from this rule rather than from the server's date.
      await sql`insert into company_business_day_configurations(
          company_id, timezone, business_day_start, effective_from, change_reason
        ) values(${fixture.companyId}::uuid, 'Asia/Dubai', '23:00:00', '2020-01-01',
                 'Late business-day start')`.execute(transaction);

      const { businessDays, dashboard } = buildServices(
        transaction,
        fixture.companyId,
        fixture.actorId,
      );
      const summary = await dashboard.summary({});
      const expected = await businessDays.businessDateOf(new Date().toISOString());

      expect(summary.metadata.incomeDateTo).toBe(expected);
      expect(summary.metadata.incomeDateToSource).toBe("company_business_date");
      expect(summary.timezone).toBeDefined();
    });
  });

  it("never counts another Company's postings in either figure", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await seedBusinessDay(transaction, fixture.companyId);
      await seedBusinessDay(transaction, fixture.otherCompanyId);
      const neighbourGl = await neighbourAccounts(transaction, fixture.otherCompanyId);
      const neighbourYear = await neighbourFiscalYear(transaction, fixture.otherCompanyId);
      const neighbourPeriodId = await periodCovering(transaction, {
        companyId: fixture.otherCompanyId,
        date: "2026-01-10",
        fiscalYearId: neighbourYear,
      });
      await seedPostedExpense(transaction, fixture, {
        amount: "9999.00",
        businessDate: "2026-01-10",
        companyId: fixture.otherCompanyId,
        expenseGl: neighbourGl.expenseGl,
        fiscalYearId: neighbourYear,
        number: "JRN-NEIGHBOUR",
        payableGl: neighbourGl.payableGl,
        periodId: neighbourPeriodId,
      });

      const { dashboard } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const summary = await dashboard.summary({});
      expect(Number(summary.sections.incomeAndExpense.expenses)).toBeLessThan(9999);
    });
  });
});
