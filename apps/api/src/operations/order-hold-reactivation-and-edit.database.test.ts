import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { OperationsService } from "./operations.service.js";
import { OrdersWorkflowService } from "./orders-workflow.service.js";

/**
 * 2026-10-05 -- Render Error Handler, Lahthza and AL Fahd Al Maliky.
 *
 * 1. Hold Reactivation was refused with "Order serial number and financial
 *    model are immutable": migration 20260920000000 rewrote
 *    `protect_order_manual_identifiers` and dropped the audited Hold
 *    Reactivation exception of 20260902012000. 20260992000000 restores it.
 *
 * 2. PATCH /operations/orders/:id was refused by
 *    orders_prospective_financial_model_check for the production Orders
 *    ORD-000007 (744082f8), ORD-000093 (45b130a1), ORD-000094 (67ccf401) and
 *    ORD-000110 (1f7b0812). The build live then (f1d5271) wrote
 *    trader_paid_service_fee = fee and trader_deductions = additional fees
 *    for every Order, so any edit of a ZERO-COD "customer pays COD and fee"
 *    Order broke the rule (it requires both to be 0). The current code writes
 *    the payment-condition-aware values; these tests pin that, using the four
 *    production Orders' shapes. No production data needed repair: a
 *    read-only check on 5 Oct showed all four rows satisfy every clause.
 *
 * Disposable database only.
 */

const url = process.env.DATABASE_URL ?? "";
const disposable = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const run = process.env.RUN_INTEGRITY_DATABASE === "true" && disposable !== "" && url.endsWith(`/${disposable}`);
const PERMISSIONS = [
  "orders.create",
  "orders.view",
  "orders.update",
  "orders.update_delivery_status",
  "orders.override_service_fee",
  "users_roles.manage",
];
const FINANCIAL_COLUMNS = sql`cod_amount::text as cod, payment_condition as pc, service_fee::text as fee,
  customer_amount_due::text as due, total_deductions::text as deductions,
  trader_gross_payable::text as gross, trader_paid_service_fee::text as "paidFee",
  trader_deductions::text as "traderDeductions", trader_net_payable::text as net,
  serial_number as serial, order_date::text as "orderDate", delivery_status as status,
  financial_model_version as model`;

describe.skipIf(!run)("Order edit and Hold Reactivation (Render errors of 24 Sep / 4-5 Oct 2026)", () => {
  let db: Kysely<DatabaseSchema>;
  let ops: OperationsService;
  let workflow: OrdersWorkflowService;
  let store: RequestSecurityContextStore;
  const f = {
    actorId: randomUUID(),
    areaId: randomUUID(),
    companyId: randomUUID(),
    driverId: randomUUID(),
    traderId: randomUUID(),
  };

  beforeAll(async () => {
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 4 }) }) });
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DATABASE).useValue(db).compile();
    ops = module.get(OperationsService, { strict: false });
    workflow = module.get(OrdersWorkflowService, { strict: false });
    store = module.get(RequestSecurityContextStore, { strict: false });
    const tag = f.companyId.slice(0, 8);
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${f.companyId}::uuid,${`HR-${tag}`},${`hr-${tag}`},'Hold Reactivation','active',now())`.execute(db);
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${f.actorId}::uuid,${f.companyId}::uuid,'company_user',${`hr.${f.actorId}`},'x','disabled')`.execute(db);
    const emirate = (await sql<{ id: string }>`select id from emirates order by code limit 1`.execute(db)).rows[0]!.id;
    await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
      values (${f.areaId}::uuid,${f.companyId}::uuid,${`A-${tag}`},'Area','منطقة',${emirate}::uuid)`.execute(db);
    await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id)
      values (${f.traderId}::uuid,${f.companyId}::uuid,${`T-${tag}`},'Trader','971500000003',${f.areaId}::uuid,${f.actorId}::uuid)`.execute(db);
    await sql`insert into trader_service_prices(company_id,trader_id,emirate_id,area_id,service_fee,created_by_account_id)
      values (${f.companyId}::uuid,${f.traderId}::uuid,${emirate}::uuid,${f.areaId}::uuid,25,${f.actorId}::uuid)`.execute(db);
    const employee = randomUUID();
    await sql`insert into employees(id,company_id,employee_number,name_en,employee_type,hired_on,payroll_eligible,is_active)
      values (${employee}::uuid,${f.companyId}::uuid,${`E-${tag}`},'Driver','employee','2026-01-01'::date,true,true)`.execute(db);
    await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,employee_id)
      values (${f.driverId}::uuid,${f.companyId}::uuid,${`D-${tag}`},'Driver','971500000005','employee',${employee}::uuid)`.execute(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  const as = <T,>(work: () => Promise<T>) =>
    store.run(
      {
        identity: {
          companyId: f.companyId,
          forcePasswordChange: false,
          identityId: f.actorId,
          kind: "company_user",
          permissions: new Set(PERMISSIONS),
          sessionId: randomUUID(),
        },
        tenant: { companyId: f.companyId, identityId: f.actorId },
      } as never,
      work,
    );
  let counter = 0;
  const create = async (codAmount: number, paymentCondition: string, serviceFee?: number, withDriver = true) => {
    counter += 1;
    return (
      (await as(() =>
        ops.createOrder(
          {
            areaId: f.areaId,
            codAmount,
            customerAddress: "Address",
            customerMobileNumber: "0501234567",
            customerName: "Customer",
            ...(withDriver ? { driverId: f.driverId } : {}),
            packageCount: 1,
            paymentCondition,
            referenceNumber: `HR-REF-${counter}-${randomUUID().slice(0, 6)}`,
            serialNumber: `HR-${counter}`,
            traderId: f.traderId,
            ...(serviceFee === undefined ? {} : { serviceFee, serviceFeeOverrideReason: "Agreed price" }),
          } as never,
          randomUUID(),
          `hr.${randomUUID()}`,
        ),
      )) as { id: string }
    ).id;
  };
  const row = async (id: string) =>
    (await sql<Record<string, string>>`select ${FINANCIAL_COLUMNS} from orders where id = ${id}::uuid`.execute(db)).rows[0]!;
  const toHold = (id: string) =>
    as(() => ops.changeOrderStatus(id, { reason: "Customer asked to hold", status: "hold" } as never, randomUUID()));
  const serialHistory = async (id: string) =>
    (await sql<{ n: number }>`select count(*)::int n from order_serial_history where order_id = ${id}::uuid`.execute(db)).rows[0]!.n;

  // -------------------------------------------------------------------------
  // Hold Reactivation
  // -------------------------------------------------------------------------

  it("reactivates a Hold Order with a new Serial Number and date, audited, financial model unchanged", async () => {
    const id = await create(0, "customer_pays_cod_trader_pays_fee");
    await toHold(id);
    const before = await row(id);
    expect(before.status).toBe("hold");
    const nextDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await as(() =>
      workflow.reactivateHoldOrders(
        { orders: [{ newSerialDate: nextDate, newSerialNumber: "HR-REACTIVATED-1", newStatus: "assigned_to_driver", orderId: id }] },
        randomUUID(),
      ),
    );
    const after = await row(id);
    expect(after).toMatchObject({ model: before.model, orderDate: nextDate, serial: "HR-REACTIVATED-1", status: "assigned_to_driver" });
    // Money is untouched by a reactivation.
    for (const column of ["cod", "fee", "due", "deductions", "gross", "paidFee", "traderDeductions", "net"])
      expect(after[column], column).toBe(before[column]);
    expect(await serialHistory(id)).toBe(1);
  });

  it("a failing batch rolls back completely: no Order, serial or history changes", async () => {
    const first = await create(0, "customer_pays_cod_trader_pays_fee");
    await toHold(first);
    // No Driver: reactivating it to out_for_delivery is refused after the first
    // Order of the batch has already been updated inside the transaction.
    const second = await create(274, "customer_pays_cod_and_fee", 20, false);
    await toHold(second);
    const before = [await row(first), await row(second)];
    await expect(
      as(() =>
        workflow.reactivateHoldOrders(
          {
            orders: [
              { newSerialDate: before[0]!.orderDate!, newSerialNumber: "HR-BATCH-1", newStatus: "in_branch", orderId: first },
              { newSerialDate: before[1]!.orderDate!, newSerialNumber: "HR-BATCH-2", newStatus: "out_for_delivery", orderId: second },
            ],
          },
          randomUUID(),
        ),
      ),
    ).rejects.toMatchObject({ errorCode: "hold_reactivation_driver_required" });
    expect([await row(first), await row(second)]).toEqual(before);
    expect((await serialHistory(first)) + (await serialHistory(second))).toBe(0);
  });

  it("the exception stays narrow: serial and financial model remain immutable everywhere else", async () => {
    const id = await create(0, "customer_pays_cod_trader_pays_fee");
    // Ordinary update, no reactivation flag.
    await expect(sql`update orders set serial_number = 'X-1', serial_number_normalized = 'x-1' where id = ${id}::uuid`.execute(db)).rejects.toThrow(
      /serial number and financial model are immutable/u,
    );
    await toHold(id);
    await db.transaction().execute(async (transaction) => {
      await sql`select set_config('blueline.hold_reactivation','on',true)`.execute(transaction);
      // Flag set, but the Order does not leave Hold.
      await expect(
        sql`update orders set serial_number = 'X-2', serial_number_normalized = 'x-2' where id = ${id}::uuid`.execute(transaction),
      ).rejects.toThrow(/immutable/u);
    });
    await db.transaction().execute(async (transaction) => {
      await sql`select set_config('blueline.hold_reactivation','on',true)`.execute(transaction);
      // Leaving Hold, but trying to switch the financial model.
      await expect(
        sql`update orders set delivery_status = 'in_branch', financial_model_version = null where id = ${id}::uuid`.execute(transaction),
      ).rejects.toThrow(/immutable/u);
    });
    // The flag is transaction-local: it does not leak into the next statement.
    await expect(sql`update orders set serial_number = 'X-3', serial_number_normalized = 'x-3' where id = ${id}::uuid`.execute(db)).rejects.toThrow(
      /immutable/u,
    );
    expect((await row(id)).status).toBe("hold");
  });

  it("Reference Number stays editable (20260920 behaviour kept)", async () => {
    const id = await create(0, "customer_pays_cod_trader_pays_fee");
    await as(() => ops.updateOrder(id, { referenceNumber: `HR-NEW-REF-${randomUUID().slice(0, 6)}` } as never, randomUUID()));
  });

  // -------------------------------------------------------------------------
  // Order edit (PATCH) -- the four production Order shapes
  // -------------------------------------------------------------------------

  const productionShapes = [
    { cod: 0, fee: undefined, label: "ORD-000007 / ORD-000093 / ORD-000094 (zero COD, Trader pays fee 25)", pc: "customer_pays_cod_trader_pays_fee" },
    { cod: 274, fee: 20, label: "ORD-000110 (COD 274, customer pays COD and fee 20)", pc: "customer_pays_cod_and_fee" },
    { cod: 0, fee: undefined, label: "zero COD, customer pays fee (the shape the old build broke)", pc: "customer_pays_cod_and_fee" },
  ] as const;
  const edits: Array<[string, Record<string, unknown>]> = [
    ["notes", { notes: "Call before delivery" }],
    ["COD to 0", { codAmount: 0 }],
    ["COD to 150", { codAmount: 150 }],
    ["who pays flipped", { paymentCondition: "FLIP" }],
    ["fee to 30", { serviceFee: 30, serviceFeeReason: "Agreed price" }],
    ["additional fee 5", { additionalFees: 5 }],
  ];

  for (const shape of productionShapes) {
    it(`${shape.label}: every pre-delivery edit saves amounts that satisfy the financial model`, async () => {
      for (const [name, edit] of edits) {
        const id = await create(shape.cod, shape.pc, shape.fee);
        const payload = { ...edit };
        if (payload.paymentCondition === "FLIP")
          payload.paymentCondition =
            shape.pc === "customer_pays_cod_and_fee" ? "customer_pays_cod_trader_pays_fee" : "customer_pays_cod_and_fee";
        await expect(as(() => ops.updateOrder(id, payload as never, randomUUID())), name).resolves.not.toThrow();
        const saved = await row(id);
        const cod = Number(saved.cod);
        const zeroCodCustomerPays = saved.pc === "customer_pays_cod_and_fee" && cod === 0;
        // The rule the old build broke: with zero COD under "customer pays
        // COD and fee" nothing is deducted from the Trader.
        if (zeroCodCustomerPays) {
          expect(saved.paidFee, name).toBe("0.00");
          expect(saved.traderDeductions, name).toBe("0.00");
          expect(saved.deductions, name).toBe("0.00");
        }
        expect(Number(saved.net), name).toBe(Math.max(cod - Number(saved.deductions), 0));
      }
    }, 120_000);
  }

  it("an invalid financial write is rejected by the unchanged constraint and nothing partial is committed", async () => {
    const id = await create(0, "customer_pays_cod_and_fee");
    const before = await row(id);
    // Exactly what the old build wrote for this Order: the fee deducted from the Trader.
    await expect(
      db.transaction().execute(async (transaction) => {
        await sql`update orders set notes = 'partial' where id = ${id}::uuid`.execute(transaction);
        await sql`update orders set trader_paid_service_fee = service_fee, total_deductions = service_fee where id = ${id}::uuid`.execute(transaction);
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "orders_prospective_financial_model_check" });
    expect(await row(id)).toEqual(before);
    expect((await sql<{ notes: string | null }>`select notes from orders where id = ${id}::uuid`.execute(db)).rows[0]!.notes).toBeNull();
  });
});
