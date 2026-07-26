import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { reconciliationPageSizes } from "./operations.dto.js";
import {
  driverCashStatusLabel,
  legacyUnknown,
  paymentMethodLabel,
  reconciliationStatusLabel,
} from "./reconciliation-status.js";
import type {
  CreateDriverReconciliationDto,
  DriverSearchQueryDto,
  EligibleOrdersQueryDto,
  FinancialPaymentDto,
  OrderSelectionDto,
  ReconciliationExpenseDto,
  ReconciliationListQueryDto,
  ReconciliationPaymentDto,
} from "./operations.dto.js";

/**
 * Driver Payable Deduction is always AED 0.00 during Driver Cash Reconciliation.
 *
 * Driver compensation — `orders.driver_cost`, Employee Driver commission,
 * Outsourced Driver commission and payroll accrual — is paid through the
 * separate commission, payroll and outsourced-payment workflows. Reconciliation
 * represents cash received from the Driver only, so deducting here would pay the
 * Driver twice for the same delivery.
 */
const driverPayableDeduction = new Decimal(0);

const defaultPageSize = 25;

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const idempotencyOperation = "driver_reconciliations.create";

interface EligibleOrder {
  readonly amountCollected: string;
  readonly assignedDriverId: string | null;
  readonly deliveryStatus: string;
  readonly driverReconciliationStatus: string;
  readonly id: string;
  readonly orderNumber: string;
}

export interface DriverReconciliationResult {
  readonly driverId: string;
  readonly driverPayableDeduction: string;
  readonly expenseTotal: string;
  readonly grossCollections: string;
  readonly netAmountExpected: string;
  readonly orderCount: number;
  readonly paymentTotal: string;
  readonly reconciliationId: string;
  readonly reconciliationNumber: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface SelectionTotals {
  readonly collectionTotal: string;
  readonly orderCount: number;
}

export interface ReconciliationDriver {
  readonly accountStatus: string;
  readonly code: string;
  readonly driverType: string;
  readonly id: string;
  readonly mobileNumber: string;
  readonly name: string;
  readonly pendingCollectionTotal: string;
  readonly pendingOrderCount: number;
}

export interface EligibleOrderRow {
  readonly amountCollected: string;
  readonly areaName: string;
  readonly cashStatus: string;
  readonly cashStatusLabel: string;
  readonly customerName: string;
  readonly deliveredAt: string | null;
  readonly id: string;
  readonly orderNumber: string;
  readonly traderName: string;
}

export interface DriverReconciliationPreview {
  readonly difference: string;
  readonly driverId: string;
  readonly driverPayableDeduction: string;
  readonly expenseTotal: string;
  readonly grossCollections: string;
  readonly netAmountExpected: string;
  readonly netBeforeExpenses: string;
  readonly orderCount: number;
  readonly orders: readonly {
    readonly amountCollected: string;
    readonly cashStatus: string;
    readonly cashStatusLabel: string;
    readonly id: string;
    readonly orderNumber: string;
  }[];
  readonly paymentTotal: string;
  readonly warnings: readonly string[];
}

export interface ReconciliationListRow {
  readonly businessDate: string;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string;
  readonly driverName: string;
  readonly driverType: string;
  readonly expenseTotal: string;
  readonly grossCollections: string;
  readonly id: string;
  readonly netAmountReceived: string;
  readonly orderCount: number;
  readonly paymentTotal: string;
  readonly reconciliationNumber: string;
  readonly status: string;
  readonly statusLabel: string;
}

export interface ExpenseTypeOption {
  readonly code: string;
  readonly id: string;
  readonly name: string;
  readonly requiresDescription: boolean;
}

/**
 * The authoritative Driver Cash Reconciliation service.
 *
 * This is the only code path that confirms a Driver Cash Reconciliation. It owns
 * eligibility validation, locking, the Net Expected formula, idempotency,
 * payment and expense validation, status changes, history and audit.
 */
@Injectable()
export class DriverCashReconciliationService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  public async expenseTypes(): Promise<readonly ExpenseTypeOption[]> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const result = await sql<{ code: string; id: string; name: string }>`
      select id, code, display_name as name
      from expense_types
      where company_id = ${companyId}::uuid and is_active
      order by lower(display_name), code
    `.execute(this.database);
    return result.rows.map((row) => ({
      ...row,
      requiresDescription: row.code.toUpperCase() === "OTHER",
    }));
  }

  /**
   * Server-side Driver search for the reconciliation workspace.
   *
   * Active Drivers are listed by default. A Disabled Driver appears only when it
   * still holds eligible pending Orders, so stranded cash stays reachable
   * without reopening Disabled Drivers generally.
   */
  public async searchDrivers(query: DriverSearchQueryDto): Promise<Page<ReconciliationDriver>> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const { limit, offset, page, pageSize } = this.pagination(query);
    const search = query.search?.trim() || null;
    const includeAll = query.status === "all";
    const direction = query.sortDirection === "desc" ? "desc" : "asc";
    const result = await sql<ReconciliationDriver & { total: number }>`
      with eligible as (
        select assigned_driver_id as driver_id,
               count(*)::int as "pendingOrderCount",
               coalesce(sum(amount_collected), 0)::text as "pendingCollectionTotal"
          from orders
         where company_id = ${companyId}::uuid
           and delivery_status = 'delivered'
           and driver_reconciliation_status = 'pending'
         group by assigned_driver_id
      )
      select d.id, d.code, d.name_en as name, d.mobile_number as "mobileNumber",
             d.driver_type as "driverType", d.account_status as "accountStatus",
             coalesce(e."pendingOrderCount", 0) as "pendingOrderCount",
             coalesce(e."pendingCollectionTotal", '0')::text as "pendingCollectionTotal",
             count(*) over()::int as total
        from drivers d
        left join eligible e on e.driver_id = d.id
       where d.company_id = ${companyId}::uuid
         and (${includeAll} or d.account_status = 'active'
              or coalesce(e."pendingOrderCount", 0) > 0)
         and (${search}::text is null
              or d.name_en ilike '%' || ${search} || '%'
              or d.code ilike '%' || ${search} || '%'
              or d.mobile_number ilike '%' || ${search} || '%')
       order by d.name_en ${sql.raw(direction)}, d.code ${sql.raw(direction)}
       limit ${limit} offset ${offset}
    `.execute(this.database);
    return this.page(result.rows, page, pageSize);
  }

  /**
   * Eligible Orders for one Driver.
   *
   * Eligibility is enforced in SQL — Company, Driver, Delivered, Pending
   * Collection and not already linked to a reconciliation — so an ineligible
   * Order is never returned for the UI to hide.
   */
  public async eligibleOrders(
    query: EligibleOrdersQueryDto,
  ): Promise<Page<EligibleOrderRow> & { readonly filteredTotals: SelectionTotals }> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const { limit, offset, page, pageSize } = this.pagination(query);
    const search = query.search?.trim() || null;
    const direction = query.sortDirection === "asc" ? "asc" : "desc";
    const sortColumn =
      query.sortBy === "amountCollected"
        ? "o.amount_collected"
        : query.sortBy === "orderNumber"
          ? "o.order_number"
          : "o.delivered_at";
    const filters = sql`
      o.company_id = ${companyId}::uuid
        and o.assigned_driver_id = ${query.driverId}::uuid
        and o.delivery_status = 'delivered'
        and o.driver_reconciliation_status = 'pending'
        and not exists (
          select 1 from driver_reconciliation_orders link
           where link.order_id = o.id and link.company_id = o.company_id
        )
        and (${search}::text is null or o.order_number ilike '%' || ${search} || '%')
        and (${query.traderId ?? null}::uuid is null
             or o.trader_id = ${query.traderId ?? null}::uuid)
        and (${query.areaId ?? null}::uuid is null
             or o.area_id = ${query.areaId ?? null}::uuid)
        and (${query.deliveredFrom ?? null}::date is null
             or o.delivered_at::date >= ${query.deliveredFrom ?? null}::date)
        and (${query.deliveredTo ?? null}::date is null
             or o.delivered_at::date <= ${query.deliveredTo ?? null}::date)
    `;
    const result = await sql<Omit<EligibleOrderRow, "cashStatusLabel"> & { total: number }>`
      select o.id, o.order_number as "orderNumber", o.delivered_at::text as "deliveredAt",
             o.customer_name as "customerName", t.name_en as "traderName",
             a.name_en as "areaName", o.amount_collected::text as "amountCollected",
             o.driver_reconciliation_status as "cashStatus",
             count(*) over()::int as total
        from orders o
        join traders t on t.id = o.trader_id and t.company_id = o.company_id
        join areas a on a.id = o.area_id and a.company_id = o.company_id
       where ${filters}
       order by ${sql.raw(sortColumn)} ${sql.raw(direction)}, o.id ${sql.raw(direction)}
       limit ${limit} offset ${offset}
    `.execute(this.database);
    const totals = await sql<SelectionTotals>`
      select count(*)::int as "orderCount",
             coalesce(sum(o.amount_collected), 0)::text as "collectionTotal"
        from orders o
       where ${filters}
    `.execute(this.database);
    const rows = result.rows.map((row) => ({
      ...row,
      cashStatusLabel: driverCashStatusLabel(row.cashStatus),
    }));
    return {
      ...this.page(rows, page, pageSize),
      filteredTotals: totals.rows[0] ?? { collectionTotal: "0.00", orderCount: 0 },
    };
  }

  /**
   * Authoritative preview. Read-only: it writes nothing, changes no status,
   * reserves no Bank Reference and creates no idempotency record.
   */
  public async preview(input: CreateDriverReconciliationDto): Promise<DriverReconciliationPreview> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const orders = await this.resolveOrders(this.database, companyId, input, false);
    const warnings: string[] = [];
    if (orders.length === 0) {
      throw new ApplicationException(
        "reconciliation_empty",
        "Select at least one Order",
        HttpStatus.BAD_REQUEST,
      );
    }
    const driverIds = new Set(orders.map((order) => order.assignedDriverId));
    if (driverIds.size !== 1 || driverIds.has(null)) {
      throw new ApplicationException(
        "reconciliation_driver_mismatch",
        "All selected Orders must belong to the same Driver",
        HttpStatus.CONFLICT,
      );
    }
    const ineligible = orders.filter(
      (order) =>
        order.deliveryStatus !== "delivered" || order.driverReconciliationStatus !== "pending",
    );
    for (const order of ineligible) {
      warnings.push(`${order.orderNumber} is no longer Delivered with Pending Collection`);
    }
    const gross = this.sumCollections(orders);
    const expenseTotal = this.sumExpenses(input.expenses ?? []);
    const net = gross.minus(driverPayableDeduction).minus(expenseTotal);
    const paymentTotal = this.sumPayments(input.payments ?? []);
    return {
      difference: paymentTotal.minus(net).toFixed(2),
      driverId: orders[0]?.assignedDriverId ?? "",
      driverPayableDeduction: driverPayableDeduction.toFixed(2),
      expenseTotal: expenseTotal.toFixed(2),
      grossCollections: gross.toFixed(2),
      netAmountExpected: net.toFixed(2),
      netBeforeExpenses: gross.toFixed(2),
      orderCount: orders.length,
      orders: orders.map((order) => ({
        amountCollected: order.amountCollected,
        cashStatus: order.driverReconciliationStatus,
        cashStatusLabel: driverCashStatusLabel(order.driverReconciliationStatus),
        id: order.id,
        orderNumber: order.orderNumber,
      })),
      paymentTotal: paymentTotal.toFixed(2),
      warnings,
    };
  }

  public async confirm(
    input: CreateDriverReconciliationDto,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<DriverReconciliationResult> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const key = idempotencyKey?.trim() ?? "";
    if (!idempotencyKeyPattern.test(key)) {
      throw new ApplicationException(
        "idempotency_key_invalid",
        "A valid idempotency key is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const requestHash = this.materialFingerprint(input);

    return this.transactions.execute(async (transaction) => {
      // 1. Reserve the idempotency key. A replay of a completed submission returns
      //    the stored result before any write, so re-inserting payments cannot
      //    collide with the Bank Reference uniqueness index.
      const reserved = await sql<{ id: string }>`
        insert into idempotency_records (
          company_id, operation, idempotency_key, request_hash, expires_at
        ) values (
          ${companyId}::uuid, ${idempotencyOperation}, ${key}, ${requestHash},
          now() + interval '24 hours'
        )
        on conflict (company_id, operation, idempotency_key) do nothing
        returning id
      `.execute(transaction);
      if (reserved.rows[0] === undefined) {
        const existing = await sql<{ requestHash: string; resourceId: string | null }>`
          select request_hash as "requestHash", resource_id as "resourceId"
          from idempotency_records
          where company_id = ${companyId}::uuid
            and operation = ${idempotencyOperation}
            and idempotency_key = ${key}
          for update
        `.execute(transaction);
        const record = existing.rows[0];
        if (record === undefined || record.requestHash !== requestHash) {
          throw new ApplicationException(
            "idempotency_key_reused",
            "This submission key was already used for different reconciliation details",
            HttpStatus.CONFLICT,
          );
        }
        if (record.resourceId !== null) {
          return this.reconciliationResult(transaction, companyId, record.resourceId);
        }
        throw new ApplicationException(
          "reconciliation_submission_in_progress",
          "This reconciliation submission is already being processed",
          HttpStatus.CONFLICT,
        );
      }

      // 2. Resolve and lock the selected Orders in a deterministic order.
      const orders = await this.resolveOrders(transaction, companyId, input, true);
      // 3. Lock any existing reconciliation links for those Orders so a concurrent
      //    confirmation cannot claim the same Order between validation and write.
      await this.lockExistingLinks(transaction, companyId, orders);
      // 4. Revalidate Company, Driver and statuses under the locks.
      const driverId = this.assertSingleEligibleDriver(orders);
      await this.assertDriverReconcilable(transaction, companyId, driverId, orders);

      // 5. Recalculate totals from the locked rows, never from client input.
      const gross = this.sumCollections(orders);
      const expenseTotal = this.sumExpenses(input.expenses);
      const net = gross.minus(driverPayableDeduction).minus(expenseTotal);
      if (net.isNegative()) {
        throw new ApplicationException(
          "reconciliation_negative_net",
          "The reconciliation net amount cannot be negative",
          HttpStatus.CONFLICT,
        );
      }

      // 6. Validate expenses and payments against the recalculated total.
      await this.validateExpenses(transaction, companyId, input.expenses);
      await this.validatePayments(transaction, companyId, input.payments);
      const paymentTotal = this.sumPayments(input.payments);
      if (net.isZero() && input.payments.length > 0) {
        throw new ApplicationException(
          "reconciliation_payment_difference",
          "A zero Net Amount Expected must not carry payments",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!paymentTotal.equals(net)) {
        throw new ApplicationException(
          "reconciliation_payment_difference",
          "Payment total must equal the Net Amount Expected",
          HttpStatus.BAD_REQUEST,
        );
      }

      // 7. Write everything atomically.
      const reconciliationNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        "reconciliation",
        "REC",
      );
      const header = await sql<{ id: string }>`
        insert into driver_reconciliations (
          company_id, reconciliation_number, driver_id, business_date,
          gross_collections, driver_payable_deduction, reconciliation_expenses,
          net_amount_received, status, created_by_account_id
        ) values (
          ${companyId}::uuid, ${reconciliationNumber}, ${driverId}::uuid, current_date,
          ${gross.toFixed(2)}, ${driverPayableDeduction.toFixed(2)}, ${expenseTotal.toFixed(2)},
          ${net.toFixed(2)}, 'draft', ${identity.identityId}::uuid
        ) returning id
      `.execute(transaction);
      const reconciliationId = header.rows[0]?.id;
      if (reconciliationId === undefined) throw new Error("Reconciliation ID was not returned");

      for (const order of orders) {
        await sql`
          insert into driver_reconciliation_orders (
            company_id, reconciliation_id, order_id, customer_collection_amount,
            driver_payable_deduction
          ) values (
            ${companyId}::uuid, ${reconciliationId}::uuid, ${order.id}::uuid,
            ${order.amountCollected}, ${driverPayableDeduction.toFixed(2)}
          )
        `.execute(transaction);
      }
      for (const expense of input.expenses) {
        await sql`
          insert into driver_reconciliation_expenses (
            company_id, reconciliation_id, expense_type_id, amount, description,
            expense_reference, attachment_file_id, created_by_account_id
          ) values (
            ${companyId}::uuid, ${reconciliationId}::uuid, ${expense.expenseTypeId}::uuid,
            ${new Decimal(expense.amount).toFixed(2)}, ${expense.notes?.trim() || null},
            ${expense.reference?.trim() || null}, ${expense.attachmentFileId ?? null}::uuid,
            ${identity.identityId}::uuid
          )
        `.execute(transaction);
      }
      const paymentIds: string[] = [];
      for (const payment of input.payments) {
        const inserted = await sql<{ id: string }>`
          insert into driver_reconciliation_payments (
            company_id, reconciliation_id, payment_method, amount,
            company_bank_account_id, bank_reference, created_by_account_id, payment_at
          ) values (
            ${companyId}::uuid, ${reconciliationId}::uuid, ${payment.paymentMethod},
            ${new Decimal(payment.amount).toFixed(2)}, ${payment.bankAccountId ?? null}::uuid,
            ${payment.bankReference?.trim() || null}, ${identity.identityId}::uuid,
            coalesce(${payment.paymentDate ?? null}::date::timestamptz, now())
          ) returning id
        `.execute(transaction);
        const paymentId = inserted.rows[0]?.id;
        if (paymentId !== undefined) paymentIds.push(paymentId);
      }
      await sql`
        update driver_reconciliations
           set status = 'confirmed', confirmed_by_account_id = ${identity.identityId}::uuid,
               confirmed_at = now(), updated_at = now()
         where id = ${reconciliationId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      // Only the Driver Cash Status changes. Delivery Status, Return Status,
      // Trader Settlement Status, pricing and customer snapshots are untouched.
      await sql`
        update orders set driver_reconciliation_status = 'reconciled',
                          updated_at = now(), version = version + 1
        where company_id = ${companyId}::uuid
          and id in (${sql.join(orders.map((order) => sql`${order.id}::uuid`))})
      `.execute(transaction);

      const actorRole = await this.history.actorRole(transaction, companyId, identity.identityId);
      for (const order of orders) {
        await this.history.statusHistory(transaction, {
          actorId: identity.identityId,
          companyId,
          from: "pending",
          orderId: order.id,
          statusDimension: "driver_reconciliation",
          to: "reconciled",
        });
        await this.history.orderEvent(transaction, {
          actorId: identity.identityId,
          actorRole,
          category: "financial_change",
          companyId,
          correlationId,
          eventType: "driver_cash.money_received",
          fieldName: "driver_reconciliation_status",
          newValue: { reconciliationNumber, status: "reconciled" },
          orderId: order.id,
          previousValue: "pending",
          relatedDriverId: driverId,
          relatedPaymentId: paymentIds[0] ?? null,
          relatedReconciliationId: reconciliationId,
          source: "web_portal",
        });
      }
      await this.history.audit(transaction, {
        action: "driver_reconciliation.confirm",
        actorId: identity.identityId,
        after: {
          driverPayableDeduction: driverPayableDeduction.toFixed(2),
          expenseTotal: expenseTotal.toFixed(2),
          grossCollections: gross.toFixed(2),
          netAmountExpected: net.toFixed(2),
          orderCount: orders.length,
          paymentTotal: paymentTotal.toFixed(2),
          reconciliationNumber,
        },
        companyId,
        correlationId,
        subjectId: reconciliationId,
        subjectType: "driver_reconciliation",
      });
      await sql`
        update idempotency_records
           set response_status = 201, resource_type = 'driver_reconciliation',
               resource_id = ${reconciliationId}::uuid, completed_at = now()
         where company_id = ${companyId}::uuid
           and operation = ${idempotencyOperation}
           and idempotency_key = ${key}
      `.execute(transaction);

      return {
        driverId,
        driverPayableDeduction: driverPayableDeduction.toFixed(2),
        expenseTotal: expenseTotal.toFixed(2),
        grossCollections: gross.toFixed(2),
        netAmountExpected: net.toFixed(2),
        orderCount: orders.length,
        paymentTotal: paymentTotal.toFixed(2),
        reconciliationId,
        reconciliationNumber,
      };
    });
  }

  /**
   * Compatibility wrapper for the retired single-Order endpoint.
   *
   * It holds no financial logic of its own: it resolves the Order's collected
   * amount, then delegates to {@link confirm}, so eligibility, locking, the
   * formula, idempotency, payment validation, history and audit are identical to
   * the selected-Orders path.
   *
   * Callers should supply their own idempotency key and reuse it across retries.
   * A request-specific key is generated only for legacy callers that omit one:
   * a permanently Order-derived key would make a corrected retry after a
   * rejected submission indistinguishable from a replay. Duplicate confirmation
   * remains impossible regardless, because the Order-link uniqueness index and
   * the Pending Collection revalidation both run under row locks.
   */
  public async confirmSingleOrder(
    orderId: string,
    payment: FinancialPaymentDto,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<DriverReconciliationResult> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const result = await sql<{ amountCollected: string }>`
      select amount_collected::text as "amountCollected" from orders
      where id = ${orderId}::uuid and company_id = ${companyId}::uuid
    `.execute(this.database);
    const order = result.rows[0];
    if (order === undefined) {
      throw new ApplicationException(
        "order_not_found",
        "The Order does not belong to this Company",
        HttpStatus.NOT_FOUND,
      );
    }
    const amount = new Decimal(order.amountCollected);
    const paymentMethod = payment.paymentMethod ?? "cash";
    // Bank fields are omitted entirely for Cash, which the payment validation requires.
    const line: ReconciliationPaymentDto = {
      amount: amount.toNumber(),
      paymentMethod,
      ...(paymentMethod === "bank_transfer" && payment.bankAccountId !== undefined
        ? { bankAccountId: payment.bankAccountId }
        : {}),
      ...(paymentMethod === "bank_transfer" && payment.bankReference !== undefined
        ? { bankReference: payment.bankReference }
        : {}),
    };
    const input: CreateDriverReconciliationDto = {
      excludedOrderIds: [],
      expenses: [],
      orderIds: [orderId],
      payments: amount.isZero() ? [] : [line],
      selectionMode: "ids",
    };
    const key = idempotencyKey?.trim() || `legacy-${randomUUID()}`;
    return this.confirm(input, correlationId, key);
  }

  /**
   * The material payload fingerprint.
   *
   * Only fields that change the financial outcome participate: the resolved
   * selection, and the expense and payment lines. Lines are normalised (amounts
   * to two decimals, text trimmed) and sorted, so that reordering rows or
   * re-serialising the request produces the same fingerprint and therefore
   * replays rather than being rejected. Presentation-only fields are excluded.
   */
  private materialFingerprint(input: CreateDriverReconciliationDto): string {
    const material = {
      excludedOrderIds: [...(input.excludedOrderIds ?? [])].sort(),
      expenses: input.expenses
        .map((expense) =>
          [
            expense.expenseTypeId,
            new Decimal(expense.amount).toFixed(2),
            expense.notes?.trim() ?? "",
            expense.reference?.trim() ?? "",
          ].join("|"),
        )
        .sort(),
      filters: {
        areaId: input.areaId ?? null,
        cashStatus: input.cashStatus ?? null,
        dateFrom: input.dateFrom ?? null,
        dateTo: input.dateTo ?? null,
        deliveryStatus: input.deliveryStatus ?? null,
        driverId: input.driverId ?? null,
        quickView: input.quickView ?? null,
        search: input.search?.trim() ?? null,
        settlementStatus: input.settlementStatus ?? null,
        traderId: input.traderId ?? null,
      },
      orderIds: [...(input.orderIds ?? [])].sort(),
      payments: input.payments
        .map((payment) =>
          [
            payment.paymentMethod,
            new Decimal(payment.amount).toFixed(2),
            payment.bankAccountId ?? "",
            payment.bankReference?.trim() ?? "",
            payment.paymentDate ?? "",
          ].join("|"),
        )
        .sort(),
      selectionMode: input.selectionMode,
    };
    return createHash("sha256").update(JSON.stringify(material)).digest("hex");
  }

  public async list(query: ReconciliationListQueryDto): Promise<Page<ReconciliationListRow>> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const { limit, offset, page, pageSize } = this.pagination(query);
    const search = query.search?.trim() || null;
    const direction = query.sortDirection === "asc" ? "asc" : "desc";
    const sortColumn =
      query.sortBy === "reconciliationNumber"
        ? "r.reconciliation_number"
        : query.sortBy === "netAmountReceived"
          ? "r.net_amount_received"
          : "r.business_date";
    const result = await sql<ReconciliationListRow & { total: number }>`
      select r.id, r.reconciliation_number as "reconciliationNumber",
             r.business_date::text as "businessDate",
             d.name_en as "driverName", d.driver_type as "driverType",
             r.gross_collections::text as "grossCollections",
             r.driver_payable_deduction::text as "driverPayableDeduction",
             r.reconciliation_expenses::text as "expenseTotal",
             r.net_amount_received::text as "netAmountReceived",
             r.status, r.confirmed_at::text as "confirmedAt",
             coalesce(actor.username, ${legacyUnknown}) as "confirmedBy",
             coalesce(links.total, 0)::int as "orderCount",
             coalesce(payments.total, 0)::text as "paymentTotal",
             count(*) over()::int as total
        from driver_reconciliations r
        join drivers d on d.id = r.driver_id and d.company_id = r.company_id
        left join accounts actor
          on actor.id = r.confirmed_by_account_id and actor.company_id = r.company_id
        left join lateral (
          select count(*)::int as total from driver_reconciliation_orders link
           where link.reconciliation_id = r.id and link.company_id = r.company_id
        ) links on true
        left join lateral (
          select coalesce(sum(p.amount), 0) as total from driver_reconciliation_payments p
           where p.reconciliation_id = r.id and p.company_id = r.company_id
        ) payments on true
       where r.company_id = ${companyId}::uuid
         and (${search}::text is null
              or r.reconciliation_number ilike '%' || ${search} || '%')
         and (${query.driverId ?? null}::uuid is null
              or r.driver_id = ${query.driverId ?? null}::uuid)
         and (${query.dateFrom ?? null}::date is null
              or r.business_date >= ${query.dateFrom ?? null}::date)
         and (${query.dateTo ?? null}::date is null
              or r.business_date <= ${query.dateTo ?? null}::date)
         and (${query.status ?? null}::text is null or r.status = ${query.status ?? null})
         and (${query.paymentMethod ?? null}::text is null or exists (
              select 1 from driver_reconciliation_payments p
               where p.reconciliation_id = r.id and p.company_id = r.company_id
                 and p.payment_method = ${query.paymentMethod ?? null}
         ))
       order by ${sql.raw(sortColumn)} ${sql.raw(direction)}, r.created_at desc
       limit ${limit} offset ${offset}
    `.execute(this.database);
    const items = result.rows.map((row) => ({
      ...row,
      statusLabel: reconciliationStatusLabel(row.status),
    }));
    return this.page(items, page, pageSize);
  }

  public async details(reconciliationId: string): Promise<unknown> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const header = await sql<ReconciliationListRow>`
      select r.id, r.reconciliation_number as "reconciliationNumber",
             r.business_date::text as "businessDate",
             d.name_en as "driverName", d.driver_type as "driverType",
             r.gross_collections::text as "grossCollections",
             r.driver_payable_deduction::text as "driverPayableDeduction",
             r.reconciliation_expenses::text as "expenseTotal",
             r.net_amount_received::text as "netAmountReceived",
             r.status, r.confirmed_at::text as "confirmedAt",
             coalesce(actor.username, ${legacyUnknown}) as "confirmedBy",
             coalesce(links.total, 0)::int as "orderCount",
             coalesce(payments.total, 0)::text as "paymentTotal"
        from driver_reconciliations r
        join drivers d on d.id = r.driver_id and d.company_id = r.company_id
        left join accounts actor
          on actor.id = r.confirmed_by_account_id and actor.company_id = r.company_id
        left join lateral (
          select count(*)::int as total from driver_reconciliation_orders link
           where link.reconciliation_id = r.id and link.company_id = r.company_id
        ) links on true
        left join lateral (
          select coalesce(sum(p.amount), 0) as total from driver_reconciliation_payments p
           where p.reconciliation_id = r.id and p.company_id = r.company_id
        ) payments on true
       where r.id = ${reconciliationId}::uuid and r.company_id = ${companyId}::uuid
    `.execute(this.database);
    const found = header.rows[0];
    const resolved =
      found === undefined
        ? undefined
        : { ...found, statusLabel: reconciliationStatusLabel(found.status) };
    if (resolved === undefined) {
      throw new ApplicationException(
        "reconciliation_not_found",
        "Driver cash reconciliation not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const orders = await sql`
      select o.id, o.order_number as "orderNumber", o.customer_name as "customerName",
             link.customer_collection_amount::text as "amountCollected",
             link.driver_payable_deduction::text as "driverPayableDeduction",
             o.driver_reconciliation_status as "cashStatus"
        from driver_reconciliation_orders link
        join orders o on o.id = link.order_id and o.company_id = link.company_id
       where link.reconciliation_id = ${reconciliationId}::uuid
         and link.company_id = ${companyId}::uuid
       order by o.order_number
    `.execute(this.database);
    // Bank Account exposure is limited to the display fields approved for
    // reconciliation review; account numbers and IBANs are never returned.
    const payments = await sql`
      select p.id, p.payment_method as "paymentMethod", p.amount::text as amount,
             p.bank_reference as "bankReference", p.payment_at::text as "paymentAt",
             bank.bank_name as "bankName", bank.account_name as "bankAccountName",
             coalesce(actor.username, ${legacyUnknown}) as "recordedBy"
        from driver_reconciliation_payments p
        left join company_bank_accounts bank
          on bank.id = p.company_bank_account_id and bank.company_id = p.company_id
        left join accounts actor
          on actor.id = p.created_by_account_id and actor.company_id = p.company_id
       where p.reconciliation_id = ${reconciliationId}::uuid
         and p.company_id = ${companyId}::uuid
       order by p.payment_at
    `.execute(this.database);
    const expenses = await sql`
      select e.id, e.amount::text as amount, e.description, e.expense_reference as reference,
             e.recorded_at::text as "recordedAt",
             coalesce(type.display_name, ${legacyUnknown}) as "expenseType",
             coalesce(actor.username, ${legacyUnknown}) as "recordedBy"
        from driver_reconciliation_expenses e
        left join expense_types type
          on type.id = e.expense_type_id and type.company_id = e.company_id
        left join accounts actor
          on actor.id = e.created_by_account_id and actor.company_id = e.company_id
       where e.reconciliation_id = ${reconciliationId}::uuid
         and e.company_id = ${companyId}::uuid
       order by e.recorded_at
    `.execute(this.database);
    const audit = await sql`
      select a.action, a.occurred_at::text as "occurredAt",
             coalesce(actor.username, ${legacyUnknown}) as actor
        from audit_events a
        left join accounts actor
          on actor.id = a.actor_account_id and actor.company_id = a.company_id
       where a.company_id = ${companyId}::uuid
         and a.subject_type = 'driver_reconciliation'
         and a.subject_id = ${reconciliationId}::text
       order by a.occurred_at
    `.execute(this.database);
    return {
      audit: audit.rows,
      expenses: expenses.rows,
      orders: orders.rows.map((row) => {
        const order = row as Record<string, unknown> & { cashStatus: string };
        return { ...order, cashStatusLabel: driverCashStatusLabel(order.cashStatus) };
      }),
      overview: resolved,
      payments: payments.rows.map((row) => {
        const payment = row as Record<string, unknown> & { paymentMethod: string };
        return { ...payment, paymentMethodLabel: paymentMethodLabel(payment.paymentMethod) };
      }),
    };
  }

  /**
   * Approved page sizes are 25, 50 and 100. Anything else normalises to 25,
   * matching the project-wide pagination policy; the DTO allowlist rejects
   * unsupported values at the HTTP boundary before reaching here.
   */
  private pagination(query: { page?: number; pageSize?: number }): {
    limit: number;
    offset: number;
    page: number;
    pageSize: number;
  } {
    const page =
      Number.isInteger(query.page) && (query.page ?? 0) > 0 ? (query.page ?? 1) : 1;
    const requested = query.pageSize ?? defaultPageSize;
    const pageSize = reconciliationPageSizes.includes(
      requested as (typeof reconciliationPageSizes)[number],
    )
      ? requested
      : defaultPageSize;
    return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
  }

  private page<T extends { total?: number }>(
    rows: readonly T[],
    page: number,
    pageSize: number,
  ): Page<T> {
    return { items: rows, page, pageSize, total: rows[0]?.total ?? 0 };
  }

  private sumCollections(orders: readonly EligibleOrder[]): Decimal {
    return orders.reduce((total, order) => total.plus(order.amountCollected), new Decimal(0));
  }

  private sumExpenses(expenses: readonly ReconciliationExpenseDto[]): Decimal {
    return expenses.reduce((total, expense) => total.plus(expense.amount), new Decimal(0));
  }

  private sumPayments(payments: readonly ReconciliationPaymentDto[]): Decimal {
    return payments.reduce((total, payment) => total.plus(payment.amount), new Decimal(0));
  }

  private assertSingleEligibleDriver(orders: readonly EligibleOrder[]): string {
    if (orders.length === 0) {
      throw new ApplicationException(
        "reconciliation_empty",
        "Select at least one Order",
        HttpStatus.BAD_REQUEST,
      );
    }
    const driverIds = new Set(orders.map((order) => order.assignedDriverId));
    if (driverIds.size !== 1 || driverIds.has(null)) {
      throw new ApplicationException(
        "reconciliation_driver_mismatch",
        "All selected Orders must belong to the same Driver",
        HttpStatus.CONFLICT,
      );
    }
    const invalid = orders.filter(
      (order) =>
        order.deliveryStatus !== "delivered" || order.driverReconciliationStatus !== "pending",
    );
    if (invalid.length > 0) {
      throw new ApplicationException(
        "reconciliation_order_ineligible",
        "Every selected Order must be Delivered with Pending Collection",
        HttpStatus.CONFLICT,
        invalid.map((order) => order.orderNumber),
      );
    }
    const driverId = orders[0]?.assignedDriverId;
    if (driverId === null || driverId === undefined) {
      throw new ApplicationException(
        "reconciliation_driver_mismatch",
        "All selected Orders must belong to the same Driver",
        HttpStatus.CONFLICT,
      );
    }
    return driverId;
  }

  /**
   * A Disabled Driver may still hand over cash for Orders that were already
   * assigned and delivered before disablement, so that money in hand is never
   * stranded. New assignments to a Disabled Driver remain blocked elsewhere.
   */
  private async assertDriverReconcilable(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    driverId: string,
    orders: readonly EligibleOrder[],
  ): Promise<void> {
    const result = await sql<{ accountStatus: string }>`
      select account_status as "accountStatus" from drivers
      where id = ${driverId}::uuid and company_id = ${companyId}::uuid
    `.execute(database);
    const driver = result.rows[0];
    if (driver === undefined) {
      throw new ApplicationException(
        "driver_not_found",
        "The selected Driver does not belong to this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (driver.accountStatus === "active") return;
    const assignments = await sql<{ orderId: string }>`
      select distinct order_id as "orderId" from order_assignments
      where company_id = ${companyId}::uuid and driver_id = ${driverId}::uuid
        and order_id in (${sql.join(orders.map((order) => sql`${order.id}::uuid`))})
    `.execute(database);
    const proven = new Set(assignments.rows.map((row) => row.orderId));
    const unproven = orders.filter((order) => !proven.has(order.id));
    if (unproven.length > 0) {
      throw new ApplicationException(
        "reconciliation_driver_disabled",
        "A Disabled Driver can only be reconciled for Orders with a proven historical assignment",
        HttpStatus.CONFLICT,
        unproven.map((order) => order.orderNumber),
      );
    }
  }

  private async lockExistingLinks(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    orders: readonly EligibleOrder[],
  ): Promise<void> {
    if (orders.length === 0) return;
    await sql`
      select id from driver_reconciliation_orders
      where company_id = ${companyId}::uuid
        and order_id in (${sql.join(orders.map((order) => sql`${order.id}::uuid`))})
      order by id
      for update
    `.execute(database);
  }

  private async resolveOrders(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    input: OrderSelectionDto,
    lock: boolean,
  ): Promise<readonly EligibleOrder[]> {
    const excluded = new Set(input.excludedOrderIds ?? []);
    if (input.selectionMode === "ids") {
      const ids = (input.orderIds ?? []).filter((id) => !excluded.has(id));
      if (ids.length === 0) return [];
      const result = await sql<EligibleOrder>`
        select id, order_number as "orderNumber", assigned_driver_id as "assignedDriverId",
               delivery_status as "deliveryStatus",
               driver_reconciliation_status as "driverReconciliationStatus",
               amount_collected::text as "amountCollected"
        from orders
        where company_id = ${companyId}::uuid
          and id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
        order by id
        ${sql.raw(lock ? "for update" : "")}
      `.execute(database);
      return result.rows;
    }
    // Filter selection is constrained to reconciliation-eligible Orders in SQL so
    // that the locked set matches what the operator was shown.
    const result = await sql<EligibleOrder>`
      select o.id, o.order_number as "orderNumber", o.assigned_driver_id as "assignedDriverId",
             o.delivery_status as "deliveryStatus",
             o.driver_reconciliation_status as "driverReconciliationStatus",
             o.amount_collected::text as "amountCollected"
      from orders o
      where o.company_id = ${companyId}::uuid
        and o.delivery_status = 'delivered'
        and o.driver_reconciliation_status = 'pending'
        and (${input.driverId ?? null}::uuid is null
          or o.assigned_driver_id = ${input.driverId ?? null}::uuid)
        and (${input.areaId ?? null}::uuid is null or o.area_id = ${input.areaId ?? null}::uuid)
        and (${input.traderId ?? null}::uuid is null
          or o.trader_id = ${input.traderId ?? null}::uuid)
        and (${input.dateFrom ?? null}::date is null
          or o.order_date >= ${input.dateFrom ?? null}::date)
        and (${input.dateTo ?? null}::date is null or o.order_date <= ${input.dateTo ?? null}::date)
        and (${input.excludedOrderIds?.length ?? 0} = 0 or o.id not in (
          ${sql.join(
            (input.excludedOrderIds?.length ?? 0) > 0
              ? (input.excludedOrderIds ?? []).map((id) => sql`${id}::uuid`)
              : [sql`null::uuid`],
          )}
        ))
      order by o.id
      ${sql.raw(lock ? "for update of o" : "")}
    `.execute(database);
    return result.rows;
  }

  private async validateExpenses(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    expenses: readonly ReconciliationExpenseDto[],
  ): Promise<void> {
    for (const expense of expenses) {
      if (new Decimal(expense.amount).lessThanOrEqualTo(0)) {
        throw new ApplicationException(
          "expense_amount_invalid",
          "Every expense amount must be greater than zero",
          HttpStatus.BAD_REQUEST,
        );
      }
      const type = await sql<{ code: string }>`
        select code from expense_types where id = ${expense.expenseTypeId}::uuid
          and company_id = ${companyId}::uuid and is_active
      `.execute(database);
      const expenseType = type.rows[0];
      if (expenseType === undefined) {
        throw new ApplicationException(
          "expense_type_not_found",
          "An expense type is not active in this Company",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (expenseType.code.toUpperCase() === "OTHER" && !expense.notes?.trim()) {
        throw new ApplicationException(
          "expense_description_required",
          "A description is required for Other expenses",
          HttpStatus.BAD_REQUEST,
        );
      }
      // Real uploads are deferred in this phase; only an existing Company file
      // reference is accepted.
      if (expense.attachmentFileId !== undefined) {
        const file = await sql<{ id: string }>`
          select id from file_objects where id = ${expense.attachmentFileId}::uuid
            and company_id = ${companyId}::uuid
        `.execute(database);
        if (file.rows[0] === undefined) {
          throw new ApplicationException(
            "expense_attachment_not_found",
            "An expense attachment is not available in this Company",
            HttpStatus.BAD_REQUEST,
          );
        }
      }
    }
  }

  private async validatePayments(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    payments: readonly ReconciliationPaymentDto[],
  ): Promise<void> {
    for (const payment of payments) {
      if (payment.paymentMethod === "cash") {
        if (payment.bankAccountId !== undefined || payment.bankReference !== undefined) {
          throw new ApplicationException(
            "cash_payment_bank_details",
            "Cash payments cannot include bank details",
            HttpStatus.BAD_REQUEST,
          );
        }
        continue;
      }
      if (payment.bankAccountId === undefined || !payment.bankReference?.trim()) {
        throw new ApplicationException(
          "bank_payment_details_required",
          "Bank Account and Bank Reference are required for Bank Transfer",
          HttpStatus.BAD_REQUEST,
        );
      }
      const bank = await sql<{ id: string }>`
        select id from company_bank_accounts
        where id = ${payment.bankAccountId}::uuid and company_id = ${companyId}::uuid and is_active
      `.execute(database);
      if (bank.rows[0] === undefined) {
        throw new ApplicationException(
          "bank_account_not_found",
          "The selected Bank Account is not active in this Company",
          HttpStatus.BAD_REQUEST,
        );
      }
    }
  }

  private async reconciliationResult(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    reconciliationId: string,
  ): Promise<DriverReconciliationResult> {
    const result = await sql<DriverReconciliationResult>`
      select r.id as "reconciliationId", r.reconciliation_number as "reconciliationNumber",
             r.driver_id as "driverId", r.gross_collections::text as "grossCollections",
             r.driver_payable_deduction::text as "driverPayableDeduction",
             r.reconciliation_expenses::text as "expenseTotal",
             r.net_amount_received::text as "netAmountExpected",
             coalesce(payments.total, 0)::text as "paymentTotal",
             coalesce(reconciled_orders.total, 0)::int as "orderCount"
      from driver_reconciliations r
      left join lateral (
        select count(*)::int as total
        from driver_reconciliation_orders ro
        where ro.reconciliation_id = r.id and ro.company_id = r.company_id
      ) reconciled_orders on true
      left join lateral (
        select sum(p.amount) as total
        from driver_reconciliation_payments p
        where p.reconciliation_id = r.id and p.company_id = r.company_id
      ) payments on true
      where r.id = ${reconciliationId}::uuid and r.company_id = ${companyId}::uuid
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "reconciliation_not_found",
        "Reconciliation not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private assertAnyPermission(permission: string): void {
    const permissions = this.identities.current().permissions;
    if (!permissions.has("users_roles.manage") && !permissions.has(permission)) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
