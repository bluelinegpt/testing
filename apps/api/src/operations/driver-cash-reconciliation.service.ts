import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import {
  buildDriverCollectionReportHtml,
  type ReportLanguage,
} from "./driver-collection-report-html.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { BusinessDayService } from "../company-configuration/business-day.service.js";
import {
  type AppliedReportDateMode,
  ReportDateModeService,
} from "../company-configuration/report-date-mode.js";
import { EmployeeCollectionEarningService } from "../payroll/employee-collection-earning.service.js";
import { OutsourcedDriverFeeService } from "../payroll/outsourced-driver-fee.service.js";

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
  DriverCollectionsFilterDto,
  DriverCollectionsSummaryQueryDto,
  DriverSearchQueryDto,
  EligibleOrdersQueryDto,
  FinancialPaymentDto,
  OrderSelectionDto,
  ReconciliationExpenseDto,
  ReconciliationListQueryDto,
  ReconciliationPaymentDto,
} from "./operations.dto.js";

/**
 * Driver Payable Deduction remains zero unless the operator explicitly applies
 * an Outsourced Driver fee offset. The offset is backed by locked accrual
 * allocations and never changes Order COD, Trader payable, or payment method.
 */
const defaultPageSize = 25;

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const idempotencyOperation = "driver_reconciliations.create";
const reversalIdempotencyOperation = "driver_reconciliations.reverse";

interface EligibleOrder {
  readonly amountCollected: string;
  readonly assignedDriverId: string | null;
  readonly customerAmountDue: string;
  readonly deliveryStatus: string;
  readonly driverReconciliationStatus: string;
  readonly id: string;
  readonly orderNumber: string;
  readonly traderId: string;
  readonly traderNetPayable: string;
}

export interface DriverReconciliationResult {
  readonly driverFeeAllocations: readonly {
    readonly accrualId: string;
    readonly amount: string;
  }[];
  readonly driverFeePaymentId: string | null;
  readonly driverFeePaymentNumber: string | null;
  readonly remainingDriverFeeOutstanding: string;
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

/** The authoritative operational timestamp for this screen. */
const BUSINESS_DATE_COLUMN = "r.confirmed_at";

export interface Page<T> {
  /**
   * The Date Mode actually applied, resolved by the backend.
   *
   * Optional so existing callers are unaffected; present whenever the screen
   * asked for a mode. Carries the window, the timezone, the authoritative
   * timestamp and the two warning flags, so the caption above a total always
   * describes the predicate that produced it.
   */
  readonly appliedDateMode?: AppliedReportDateMode;
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

export interface DriverCollectionPrintData {
  readonly actualReceived: string;
  readonly businessDate: string;
  readonly companyName: string;
  readonly difference: string;
  readonly driverExpenses: string;
  readonly driverName: string;
  readonly gross: string;
  readonly netExpected: string;
  readonly paymentMethod: "cash" | "visa";
  readonly reconciliationNumber: string;
  readonly totalOrders: number;
  readonly totalTraders: number;
  readonly traders: readonly {
    readonly companyFees: string;
    readonly gross: string;
    readonly orderCount: number;
    readonly orders: readonly {
      readonly address: string;
      readonly amountToCollect: string;
      readonly areaNameAr: string;
      readonly companyFees: string;
      readonly customerMobile: string;
      readonly customerName: string;
      readonly notes: string | null;
      readonly referenceNumber: string | null;
      readonly serialNumber: string;
      readonly status: string;
      readonly traderPayable: string;
    }[];
    readonly traderName: string;
    readonly traderPayable: string;
  }[];
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
  readonly companyFees: string;
  readonly difference: string;
  readonly driverId: string;
  readonly driverPayableDeduction: string;
  readonly driverFeeAllocations: readonly unknown[];
  readonly eligibleDriverFeeAccrualCount: number;
  readonly expenseTotal: string;
  readonly grossCollections: string;
  readonly netAmountExpected: string;
  readonly netBeforeExpenses: string;
  readonly orderCount: number;
  readonly traderCount: number;
  readonly traderPayable: string;
  readonly orders: readonly {
    readonly amountCollected: string;
    readonly cashStatus: string;
    readonly cashStatusLabel: string;
    readonly id: string;
    readonly orderNumber: string;
  }[];
  readonly paymentTotal: string;
  readonly remainingDriverFeeOutstanding: string;
  readonly requestedDriverFeeOffset: string;
  readonly safeMaximumDriverFeeOffset: string;
  readonly totalOutstandingDriverFees: string;
  readonly oldestFirstDriverFeeProposal: readonly unknown[];
  readonly warnings: readonly string[];
}

export interface ReconciliationListRow {
  /** The reconciliation's own date-only field. NOT the Company Business Date. */
  readonly businessDate: string;
  /** Company Business Date derived from confirmedAt. Null when unconfirmed. */
  readonly confirmationBusinessDate?: string | null;
  readonly collectionPaymentMethod: "cash" | "visa" | null;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string;
  readonly driverName: string;
  readonly driverType: string;
  readonly expenseTotal: string;
  readonly grossCollections: string;
  readonly id: string;
  readonly isReversed: boolean;
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

/** Server-calculated Driver Collections workspace summary cards (§3). */
export interface DriverCollectionsSummary {
  readonly actualAmountReceived: string;
  readonly cashTotal: string;
  readonly collectionsWithDifferenceCount: number;
  readonly driverExpenses: string;
  readonly netExpectedFromDrivers: string;
  readonly outstandingFromDrivers: string;
  readonly pendingAmountToCollect: string;
  readonly pendingOrderCount: number;
  readonly reconciledCollectionsCount: number;
  readonly visaTotal: string;
}

/**
 * Comprehensive, server-authoritative, PDF-ready data for the Driver Collection
 * Report (§10/§19). Built entirely from stored snapshots on the reconciliation,
 * its linked Orders and its expenses — never from the current live catalog
 * state, so a report regenerated later is byte-identical. No internal database
 * IDs appear anywhere in this shape.
 */
export interface DriverCollectionReportData {
  readonly expenses: readonly {
    readonly amount: string;
    readonly description: string | null;
    readonly enteredBy: string;
    readonly expenseType: string;
    readonly reason: string | null;
    readonly recordedAt: string;
    readonly reference: string | null;
  }[];
  readonly header: {
    readonly businessDate: string;
    readonly collectionPaymentMethod: "cash" | "visa" | null;
    readonly company: {
      readonly hasLogo: boolean;
      readonly nameAr: string | null;
      readonly nameEn: string;
      readonly subtitleAr: string | null;
      readonly subtitleEn: string | null;
      readonly telephone: string | null;
    };
    readonly confirmedAt: string | null;
    readonly confirmedBy: string;
    readonly createdAt: string;
    readonly createdBy: string;
    /**
     * Driver business Code (`d.code`), distinct from the id and the name.
     *
     * Nullable because the row type feeding it declares `string | null`
     * (line 1945): the Driver join can leave it absent. Reported as absent
     * rather than substituted with an empty Code.
     */
    readonly driverCode: string | null;
    readonly driverName: string;
    /** Arabic Driver name. Nullable: `d.name_ar` is optional on the Driver. */
    readonly driverNameAr: string | null;
    readonly driverType: "employee" | "outsourced";
    readonly linkedDriverFeePaymentId?: string | null;
    readonly linkedDriverFeePaymentNumber?: string | null;
    readonly linkedDriverFeePaymentStatus?: "confirmed" | "reversed" | null;
    readonly isReversal: boolean;
    readonly notes: string | null;
    readonly reconciliationNumber: string;
    /** The reconciliation number this entry reverses, when `isReversal` is true. */
    readonly reversesReconciliationNumber: string | null;
    readonly reversedByReconciliationNumber: string | null;
    readonly status: "confirmed" | "draft";
    readonly statusLabel: string;
  };
  readonly orders: readonly {
    readonly additionalFees: string;
    readonly areaName: string;
    readonly codAmount: string;
    readonly customerAmountToCollect: string;
    readonly customerName: string;
    readonly deliveryDate: string | null;
    readonly driverReconciliationStatus: string;
    readonly driverReconciliationStatusLabel: string;
    readonly emirateName: string | null;
    readonly paymentMethod: "cash" | "visa" | null;
    readonly referenceNumber: string | null;
    readonly serialNumber: string;
    readonly serviceFee: string;
    readonly totalDeductions: string;
    readonly traderName: string;
    readonly traderPayable: string;
    readonly vatAmount: string;
  }[];
  readonly summary: {
    readonly actualReceived: string;
    readonly cashTotal: string;
    readonly difference: string;
    readonly driverFeeOffset?: string;
    readonly driverExpenses: string;
    readonly grossCollections: string;
    readonly netExpected: string;
    readonly orderCount: number;
    readonly visaTotal: string;
  };
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
    @Inject(ReportDateModeService) private readonly reportDateModes: ReportDateModeService,
    @Inject(BusinessDayService) private readonly businessDays: BusinessDayService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(CompanyProfileService) private readonly companyProfile: CompanyProfileService,
    @Inject(DriverCollectionPdfService) private readonly pdf: DriverCollectionPdfService,
    @Inject(OutsourcedDriverFeeService)
    private readonly outsourcedDriverFees: OutsourcedDriverFeeService,
    // Fact capture only. This service prices nothing and touches no
    // reconciliation figure; see the call site in `confirm`.
    @Inject(EmployeeCollectionEarningService)
    private readonly collectionEarnings: EmployeeCollectionEarningService,
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
    // The live `driver_reconciliation_status = 'pending'` column is the sole
    // eligibility gate (matching `confirm()`'s own trust model in
    // `resolveOrders`): once a Driver collection is reversed, `reverse()` moves
    // the Order back to 'pending', and it must reappear here immediately. An
    // extra "not already linked" check was removed because the historical link
    // row to the (now reversed) original collection is permanent — checking it
    // would incorrectly hide every restored Order forever.
    const filters = sql`
      o.company_id = ${companyId}::uuid
        and o.assigned_driver_id = ${query.driverId}::uuid
        and o.delivery_status = 'delivered'
        and o.driver_reconciliation_status = 'pending'
        and (${search}::text is null
             or o.order_number ilike '%' || ${search} || '%'
             or o.serial_number ilike '%' || ${search} || '%'
             or o.reference_number ilike '%' || ${search} || '%'
             or o.customer_name ilike '%' || ${search} || '%'
             or o.customer_mobile_number ilike '%' || ${search} || '%'
             or exists (
               select 1 from traders t
                where t.id = o.trader_id and t.company_id = o.company_id
                  and (t.name_en ilike '%' || ${search} || '%'
                       or t.name_ar ilike '%' || ${search} || '%')
             ))
        and (${query.traderId ?? null}::uuid is null
             or o.trader_id = ${query.traderId ?? null}::uuid)
        and (${query.areaId ?? null}::uuid is null
             or o.area_id = ${query.areaId ?? null}::uuid)
        and (${query.emirateId ?? null}::uuid is null or exists (
             select 1 from areas a
              where a.id = o.area_id and a.company_id = o.company_id
                and a.emirate_id = ${query.emirateId ?? null}::uuid
        ))
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
    if (ineligible.length > 0) {
      // A stale eligible-Orders selection is most often "already reconciled by
      // someone else in the meantime" — name the conflicting reconciliation
      // where one exists, rather than a generic "no longer eligible" warning.
      const reconciliationByOrder = await this.findActiveReconciliationLinks(
        this.database,
        companyId,
        ineligible,
      );
      for (const order of ineligible) {
        const reconciliationNumber = reconciliationByOrder.get(order.orderNumber);
        warnings.push(
          reconciliationNumber === undefined
            ? `${order.orderNumber} is no longer Delivered with Pending Collection`
            : `${order.orderNumber}: This Order has already been included in Driver Collection ${reconciliationNumber}.`,
        );
      }
    }
    const gross = this.sumCollections(orders);
    const expenseTotal = this.sumExpenses(input.expenses ?? []);
    const requestedOffset = new Decimal(input.driverFeeOffsetAmount ?? 0);
    const feeOffset = await this.outsourcedDriverFees.collectionOffsetProposal(
      this.database,
      companyId,
      orders[0]?.assignedDriverId ?? "",
      gross.minus(expenseTotal),
      requestedOffset,
      input.driverFeeAllocations,
    );
    const selectedDriverFeeOffset = new Decimal(feeOffset.requestedOffset);
    const net = gross.minus(selectedDriverFeeOffset).minus(expenseTotal);
    const paymentTotal = this.sumPayments(input.payments ?? []);
    // Company Fees and Trader Payable are shown separately and never reduce the amount the Driver
    // hands over (§8). Company Fees = Gross - Trader Payable.
    const traderPayable = orders.reduce(
      (total, order) => total.plus(order.traderNetPayable),
      new Decimal(0),
    );
    const companyFees = gross.minus(traderPayable);
    return {
      companyFees: companyFees.toFixed(2),
      difference: paymentTotal.minus(net).toFixed(2),
      driverId: orders[0]?.assignedDriverId ?? "",
      driverPayableDeduction: selectedDriverFeeOffset.toFixed(2),
      driverFeeAllocations: feeOffset.allocations,
      eligibleDriverFeeAccrualCount: feeOffset.eligibleAccrualCount,
      expenseTotal: expenseTotal.toFixed(2),
      grossCollections: gross.toFixed(2),
      netAmountExpected: net.toFixed(2),
      netBeforeExpenses: gross.toFixed(2),
      orderCount: orders.length,
      traderCount: new Set(orders.map((order) => order.traderId)).size,
      traderPayable: traderPayable.toFixed(2),
      orders: orders.map((order) => ({
        amountCollected: order.amountCollected,
        cashStatus: order.driverReconciliationStatus,
        cashStatusLabel: driverCashStatusLabel(order.driverReconciliationStatus),
        id: order.id,
        orderNumber: order.orderNumber,
      })),
      paymentTotal: paymentTotal.toFixed(2),
      remainingDriverFeeOutstanding: feeOffset.remainingDriverOutstanding,
      requestedDriverFeeOffset: feeOffset.requestedOffset,
      safeMaximumDriverFeeOffset: feeOffset.safeMaximumOffset,
      totalOutstandingDriverFees: feeOffset.totalOutstanding,
      oldestFirstDriverFeeProposal: feeOffset.oldestFirstProposal,
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
      // 4. Revalidate Company, Driver and statuses under the locks. The
      //    already-reconciled check runs first so a stale or direct-API
      //    duplicate attempt names the conflicting reconciliation, rather
      //    than falling into the generic ineligibility message below.
      await this.assertOrdersNotAlreadyReconciled(transaction, companyId, orders);
      const driverId = this.assertSingleEligibleDriver(orders);
      await this.assertDriverReconcilable(transaction, companyId, driverId, orders);

      // §5: every Driver collection is either Cash or Visa — the collection method
      // is mandatory and is carried onto the header and each linked Order so Cash
      // and Visa can never be mixed within one reconciliation.
      const collectionPaymentMethod = input.collectionPaymentMethod;
      if (collectionPaymentMethod === undefined) {
        throw new ApplicationException(
          "reconciliation_payment_method_required",
          "Select Cash or Visa for the Driver collection",
          HttpStatus.BAD_REQUEST,
        );
      }

      // 5. Recalculate totals from the locked rows, never from client input.
      const gross = this.sumCollections(orders);
      const expenseTotal = this.sumExpenses(input.expenses);
      const requestedOffset = new Decimal(input.driverFeeOffsetAmount ?? 0);
      const feeOffset = await this.outsourcedDriverFees.collectionOffsetProposal(
        transaction,
        companyId,
        driverId,
        gross.minus(expenseTotal),
        requestedOffset,
        input.driverFeeAllocations,
        true,
      );
      const selectedDriverFeeOffset = new Decimal(feeOffset.requestedOffset);
      const net = gross.minus(selectedDriverFeeOffset).minus(expenseTotal);
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
      const header = await sql<{ businessDate: string; id: string }>`
        insert into driver_reconciliations (
          company_id, reconciliation_number, driver_id, business_date,
          gross_collections, driver_payable_deduction, reconciliation_expenses,
          net_amount_received, status, created_by_account_id, collection_payment_method, notes
        ) values (
          ${companyId}::uuid, ${reconciliationNumber}, ${driverId}::uuid,
          (now() at time zone 'Asia/Dubai')::date,
          ${gross.toFixed(2)}, ${selectedDriverFeeOffset.toFixed(2)}, ${expenseTotal.toFixed(2)},
          ${net.toFixed(2)}, 'draft', ${identity.identityId}::uuid,
          ${collectionPaymentMethod}, ${input.notes?.trim() || null}
        ) returning id,business_date::text as "businessDate"
      `.execute(transaction);
      const reconciliationId = header.rows[0]?.id;
      if (reconciliationId === undefined) throw new Error("Reconciliation ID was not returned");

      for (const [orderIndex, order] of orders.entries()) {
        await sql`
          insert into driver_reconciliation_orders (
            company_id, reconciliation_id, order_id, customer_collection_amount,
            driver_payable_deduction, collection_payment_method
          ) values (
            ${companyId}::uuid, ${reconciliationId}::uuid, ${order.id}::uuid,
            ${order.amountCollected}, ${orderIndex === 0 ? selectedDriverFeeOffset.toFixed(2) : "0.00"},
            ${collectionPaymentMethod}
          )
        `.execute(transaction);
      }
      for (const expense of input.expenses) {
        await sql`
          insert into driver_reconciliation_expenses (
            company_id, reconciliation_id, expense_type_id, amount, description,
            expense_reference, reason, attachment_file_id, created_by_account_id
          ) values (
            ${companyId}::uuid, ${reconciliationId}::uuid, ${expense.expenseTypeId}::uuid,
            ${new Decimal(expense.amount).toFixed(2)}, ${expense.notes?.trim() || null},
            ${expense.reference?.trim() || null}, ${expense.reason?.trim() || null},
            ${expense.attachmentFileId ?? null}::uuid, ${identity.identityId}::uuid
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
      const feePayment = await this.outsourcedDriverFees.confirmCollectionOffset(transaction, {
        actorId: identity.identityId,
        ...(input.driverFeeAllocations === undefined
          ? {}
          : { allocations: input.driverFeeAllocations }),
        amount: selectedDriverFeeOffset,
        companyId,
        correlationId,
        driverId,
        idempotencyKey: key,
        paymentDate: header.rows[0]!.businessDate,
        reconciliationId,
        safeCollectionAmount: gross.minus(expenseTotal),
      });
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

      // Create one Trader payable grouping per Trader in this collection (§13). The relevant
      // Orders are the collection's Orders for that Trader; the order-level payable/outstanding
      // ledger already lives on the Orders. Trader payments/allocations are Phase 4.
      const traderGroups = new Map<string, { count: number; total: Decimal }>();
      for (const order of orders) {
        const group = traderGroups.get(order.traderId) ?? { count: 0, total: new Decimal(0) };
        group.count += 1;
        group.total = group.total.plus(order.traderNetPayable);
        traderGroups.set(order.traderId, group);
      }
      for (const [traderId, group] of traderGroups) {
        await sql`
          insert into driver_collection_trader_payables (
            company_id, reconciliation_id, trader_id, order_count, total_payable
          ) values (
            ${companyId}::uuid, ${reconciliationId}::uuid, ${traderId}::uuid,
            ${group.count}, ${group.total.toFixed(2)}
          )
        `.execute(transaction);
      }

      /* Employee Driver collection earnings: capture the FACT, price nothing.
         Runs only once the reconciliation is confirmed and every financial
         decision above is already made, so it cannot influence COD, expenses,
         totals, payments or the confirmation rules -- it only reads what those
         produced. No rate is looked up here and no amount is written anywhere;
         Payroll derives the money later from the effective rule. Outsourced
         Drivers return null and are untouched, keeping the two compensation
         models separate. */
      await this.collectionEarnings.captureForConfirmedCollection(
        transaction,
        {
          businessDate: header.rows[0]!.businessDate,
          confirmedAt: new Date().toISOString(),
          countsForCollectionEarning: input.countsForCollectionEarning === true,
          driverId,
          // The reconciliation's own Orders are authoritative whenever it has
          // them; the manual count is only consulted when it has none.
          manualOrderCount: input.manualCollectedOrderCount,
          orderIds: orders.map((order) => ({ id: order.id, orderNumber: order.orderNumber })),
          reconciliationId,
        },
        identity.identityId,
      );

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
          driverPayableDeduction: selectedDriverFeeOffset.toFixed(2),
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
        driverFeeAllocations:
          feePayment?.allocations.map((line) => ({
            accrualId: line.accrualId,
            amount: line.amount,
          })) ?? [],
        driverFeePaymentId: feePayment?.paymentId ?? null,
        driverFeePaymentNumber: feePayment?.paymentNumber ?? null,
        remainingDriverFeeOutstanding:
          feePayment?.remainingDriverOutstanding ?? feeOffset.remainingDriverOutstanding,
        driverId,
        driverPayableDeduction: selectedDriverFeeOffset.toFixed(2),
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
   * Reverse a confirmed Driver collection (§8). The original record is immutable
   * and preserved; a compensating reversal reconciliation is created (linked via
   * `reversal_of_id`), the linked Orders move `reconciled → reversed`, and the
   * action is audited with a mandatory reason. Reversal is blocked when any Order
   * has already progressed to Trader settlement, so it can never undo money that
   * was paid onward. Concurrent reversals serialise on the `for update` lock of
   * the original row, and a prior reversal makes a second attempt a no-op error.
   */
  public async reverse(
    reconciliationId: string,
    reason: string,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<{
    linkedDriverFeePaymentReversed: boolean;
    orderCount: number;
    restoredDriverFeeAccrualIds: readonly string[];
    reconciliationId: string;
    reversalReconciliationId: string;
    reversalReconciliationNumber: string;
  }> {
    this.assertAnyPermission("reconciliations.reverse");
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const key = idempotencyKey?.trim() || `reverse:${reconciliationId}`;
    if (!idempotencyKeyPattern.test(key)) {
      throw new ApplicationException(
        "idempotency_key_invalid",
        "A valid idempotency key is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      throw new ApplicationException(
        "reconciliation_reversal_reason_required",
        "A reason is required to reverse a Driver collection",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.transactions.execute(async (transaction) => {
      const requestHash = createHash("sha256")
        .update(JSON.stringify({ reason: trimmedReason, reconciliationId }))
        .digest("hex");
      const reserved = await sql<{ id: string }>`
        insert into idempotency_records(
          company_id,operation,idempotency_key,request_hash,expires_at
        ) values(
          ${companyId}::uuid,${reversalIdempotencyOperation},${key},${requestHash},
          now()+interval '24 hours'
        ) on conflict(company_id,operation,idempotency_key) do nothing returning id
      `.execute(transaction);
      if (reserved.rows[0] === undefined) {
        const replay = await sql<{
          requestHash: string;
          responseBody: {
            linkedDriverFeePaymentReversed: boolean;
            orderCount: number;
            reconciliationId: string;
            restoredDriverFeeAccrualIds: readonly string[];
            reversalReconciliationId: string;
            reversalReconciliationNumber: string;
          } | null;
        }>`
          select request_hash as "requestHash",response_body as "responseBody"
          from idempotency_records where company_id=${companyId}::uuid
            and operation=${reversalIdempotencyOperation} and idempotency_key=${key}
          for update
        `.execute(transaction);
        if (replay.rows[0]?.requestHash !== requestHash) {
          throw new ApplicationException(
            "idempotency_key_reused",
            "This submission key was already used for a different reversal",
            HttpStatus.CONFLICT,
          );
        }
        if (replay.rows[0]?.responseBody !== null && replay.rows[0]?.responseBody !== undefined) {
          return replay.rows[0].responseBody;
        }
        throw new ApplicationException(
          "reconciliation_submission_in_progress",
          "This reversal is already being processed",
          HttpStatus.CONFLICT,
        );
      }
      const original = (
        await sql<{
          driverId: string;
          reconciliationNumber: string;
          reversalOfId: string | null;
          status: string;
        }>`
          select driver_id as "driverId", reconciliation_number as "reconciliationNumber",
                 reversal_of_id as "reversalOfId", status
            from driver_reconciliations
           where id = ${reconciliationId}::uuid and company_id = ${companyId}::uuid
           for update
        `.execute(transaction)
      ).rows[0];
      if (original === undefined) {
        throw new ApplicationException(
          "reconciliation_not_found",
          "Driver cash reconciliation not found",
          HttpStatus.NOT_FOUND,
        );
      }
      if (original.reversalOfId !== null) {
        throw new ApplicationException(
          "reconciliation_reversal_invalid",
          "A reversal entry cannot itself be reversed",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (original.status !== "confirmed") {
        throw new ApplicationException(
          "reconciliation_not_confirmed",
          "Only a confirmed reconciliation can be reversed",
          HttpStatus.BAD_REQUEST,
        );
      }
      const existingReversal = (
        await sql<{ id: string }>`
          select id from driver_reconciliations
           where company_id = ${companyId}::uuid and reversal_of_id = ${reconciliationId}::uuid
           limit 1
        `.execute(transaction)
      ).rows[0];
      if (existingReversal !== undefined) {
        throw new ApplicationException(
          "reconciliation_already_reversed",
          "This reconciliation has already been reversed",
          HttpStatus.CONFLICT,
        );
      }
      const links = (
        await sql<{
          driverReconciliationStatus: string;
          orderId: string;
          traderSettlementStatus: string;
        }>`
          select o.id as "orderId",
                 o.driver_reconciliation_status as "driverReconciliationStatus",
                 o.trader_settlement_status as "traderSettlementStatus"
            from driver_reconciliation_orders link
            join orders o on o.id = link.order_id and o.company_id = link.company_id
           where link.reconciliation_id = ${reconciliationId}::uuid
             and link.company_id = ${companyId}::uuid
           order by o.id
           for update of o
        `.execute(transaction)
      ).rows;
      const advancedSettlement = [
        "partially_settled",
        "settled",
        "money_sent_to_trader",
        "money_received_by_trader",
      ];
      if (links.some((link) => advancedSettlement.includes(link.traderSettlementStatus))) {
        throw new ApplicationException(
          "reconciliation_reversal_blocked_by_settlement",
          "Cannot reverse: one or more Orders have already progressed to Trader settlement",
          HttpStatus.CONFLICT,
        );
      }
      const reversedFeePayment = await this.outsourcedDriverFees.reverseCollectionOffset(
        transaction,
        companyId,
        identity.identityId,
        reconciliationId,
        trimmedReason,
        correlationId,
      );

      const reversalNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        "reconciliation",
        "REC",
      );
      const reversalHeader = (
        await sql<{ id: string }>`
          insert into driver_reconciliations (
            company_id, reconciliation_number, driver_id, business_date,
            gross_collections, driver_payable_deduction, reconciliation_expenses,
            net_amount_received, status, created_by_account_id,
            confirmed_by_account_id, confirmed_at, reversal_of_id
          ) values (
            ${companyId}::uuid, ${reversalNumber}, ${original.driverId}::uuid, current_date,
            0, 0, 0, 0, 'confirmed', ${identity.identityId}::uuid,
            ${identity.identityId}::uuid, now(), ${reconciliationId}::uuid
          ) returning id
        `.execute(transaction)
      ).rows[0];
      const reversalId = reversalHeader?.id;
      if (reversalId === undefined) throw new Error("Reversal reconciliation ID was not returned");

      const actorRole = await this.history.actorRole(transaction, companyId, identity.identityId);
      for (const link of links) {
        // Defensive: only flip Orders still marked reconciled by this collection.
        if (link.driverReconciliationStatus !== "reconciled") continue;
        // Two-step transition, both recorded in the append-only status history:
        // reconciled -> reversed (the reversal itself) -> pending (eligibility
        // restored, safe because the settlement-progress guard above already
        // rejected any Order that must not be re-collected). The Order's LIVE
        // status ends at 'pending' so it reappears in `eligibleOrders()`
        // immediately; the transient 'reversed' step is preserved in history and
        // the order event below, never discarded.
        await sql`
          update orders set driver_reconciliation_status = 'pending',
                            updated_at = now(), version = version + 1
           where id = ${link.orderId}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
        await this.history.statusHistory(transaction, {
          actorId: identity.identityId,
          companyId,
          from: "reconciled",
          orderId: link.orderId,
          reason: trimmedReason,
          statusDimension: "driver_reconciliation",
          to: "reversed",
        });
        await this.history.statusHistory(transaction, {
          actorId: identity.identityId,
          companyId,
          from: "reversed",
          orderId: link.orderId,
          reason: trimmedReason,
          statusDimension: "driver_reconciliation",
          to: "pending",
        });
        await this.history.orderEvent(transaction, {
          actorId: identity.identityId,
          actorRole,
          category: "financial_change",
          companyId,
          correlationId,
          eventType: "driver_cash.reversed",
          fieldName: "driver_reconciliation_status",
          newValue: {
            reversalReconciliationNumber: reversalNumber,
            reversedReconciliationNumber: original.reconciliationNumber,
            restoredEligibility: true,
            status: "reversed",
          },
          orderId: link.orderId,
          previousValue: "reconciled",
          reason: trimmedReason,
          relatedDriverId: original.driverId,
          relatedPaymentId: null,
          relatedReconciliationId: reversalId,
          source: "web_portal",
        });
      }
      await this.history.audit(transaction, {
        action: "driver_reconciliation.reverse",
        actorId: identity.identityId,
        after: {
          orderCount: links.length,
          reason: trimmedReason,
          reversalReconciliationNumber: reversalNumber,
          reversedReconciliationNumber: original.reconciliationNumber,
        },
        companyId,
        correlationId,
        subjectId: reconciliationId,
        subjectType: "driver_reconciliation",
      });

      const response = {
        linkedDriverFeePaymentReversed: reversedFeePayment !== null,
        orderCount: links.length,
        restoredDriverFeeAccrualIds: reversedFeePayment?.restoredAccrualIds ?? [],
        reconciliationId,
        reversalReconciliationId: reversalId,
        reversalReconciliationNumber: reversalNumber,
      };
      await sql`
        update idempotency_records set response_status=200,
          resource_type='driver_reconciliation_reversal',
          resource_id=${reversalId}::uuid,response_body=${JSON.stringify(response)}::jsonb,
          completed_at=now()
        where company_id=${companyId}::uuid and operation=${reversalIdempotencyOperation}
          and idempotency_key=${key}
      `.execute(transaction);
      return response;
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
      // This retired path predates Cash/Visa (§5); it always represented a
      // physical cash handover, so it defaults to Cash rather than leaving the
      // now-mandatory field unset.
      collectionPaymentMethod: "cash",
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

  /**
   * Shared filter predicate for the Driver Collections list and summary
   * endpoints (§2/§3), so the summary cards always describe the same slice the
   * list shows. Assumes the caller aliases `driver_reconciliations` as `r` and
   * joins `drivers d on d.id = r.driver_id and d.company_id = r.company_id`.
   * Always excludes synthetic reversal-marker rows (`r.reversal_of_id is not
   * null`) — a reversal is exposed as a flag on the ORIGINAL reconciliation,
   * never as a row of its own.
   */

  /**
   * The Business Date predicate, or a no-op.
   *
   * Built by `ReportDateModeService` so this screen cannot develop its own idea
   * of where a business day begins. Returns a match-everything predicate in
   * Calendar Date mode, which is why the calendar filters alongside it need no
   * conditional of their own.
   */
  private businessDatePredicate(
    applied: AppliedReportDateMode | undefined,
  ): ReturnType<typeof sql> {
    if (applied === undefined || applied.dateMode !== "business_date") return sql`true`;
    return this.reportDateModes.predicate(BUSINESS_DATE_COLUMN, applied);
  }

  private reconciliationFilters(
    companyId: string,
    query: DriverCollectionsFilterDto,
    applied?: AppliedReportDateMode,
  ): ReturnType<typeof sql> {
    const search = query.search?.trim() || null;
    return sql`
      r.company_id = ${companyId}::uuid
        and r.reversal_of_id is null
        -- Business Date mode. Matches everything in every other mode, so the
        -- existing calendar filters below are completely unaffected.
        and ${this.businessDatePredicate(applied)}
        and (${query.driverId ?? null}::uuid is null
             or r.driver_id = ${query.driverId ?? null}::uuid)
        and (${query.driverType ?? null}::text is null
             or d.driver_type = ${query.driverType ?? null})
        and (${query.dateFrom ?? null}::date is null
             or r.business_date >= ${query.dateFrom ?? null}::date)
        and (${query.dateTo ?? null}::date is null
             or r.business_date <= ${query.dateTo ?? null}::date)
        and (${query.collectionPaymentMethod ?? null}::text is null or (
          case ${query.collectionPaymentMethod ?? null}::text
            when 'not_assigned' then r.collection_payment_method is null
            else r.collection_payment_method = ${query.collectionPaymentMethod ?? null}::text
          end
        ))
        and (${query.reconciliationStatus ?? null}::text is null
             or ${query.reconciliationStatus ?? null}::text = 'all'
             or (${query.reconciliationStatus ?? null}::text = 'pending' and r.status = 'draft')
             or (
               ${query.reconciliationStatus ?? null}::text = 'reconciled' and r.status = 'confirmed'
               and not exists (
                 select 1 from driver_reconciliations rv
                  where rv.company_id = r.company_id and rv.reversal_of_id = r.id
               )
             )
             or (
               ${query.reconciliationStatus ?? null}::text = 'reversed' and r.status = 'confirmed'
               and exists (
                 select 1 from driver_reconciliations rv
                  where rv.company_id = r.company_id and rv.reversal_of_id = r.id
               )
             )
        )
        -- Driver Fee paid / unpaid.
        --
        -- "Paid" means a CONFIRMED Outsourced Driver Fee Payment is linked to
        -- this Collection. A reversed fee payment is deliberately treated as
        -- unpaid: the money came back, so the fee is outstanding again.
        --
        -- Only outsourced drivers accrue fees, so employee-driver Collections
        -- match neither value and are excluded whenever this filter is set.
        and (${query.driverFeeStatus ?? null}::text is null
             or ${query.driverFeeStatus ?? null}::text = 'all'
             or (
               ${query.driverFeeStatus ?? null}::text = 'paid'
               and d.driver_type = 'outsourced'
               and exists (
                 select 1 from outsourced_driver_fee_payments fp
                  where fp.company_id = r.company_id
                    and fp.linked_driver_reconciliation_id = r.id
                    and fp.status = 'confirmed'
               )
             )
             or (
               ${query.driverFeeStatus ?? null}::text = 'unpaid'
               and d.driver_type = 'outsourced'
               and not exists (
                 select 1 from outsourced_driver_fee_payments fp
                  where fp.company_id = r.company_id
                    and fp.linked_driver_reconciliation_id = r.id
                    and fp.status = 'confirmed'
               )
             )
        )
        and (${search}::text is null
             or r.reconciliation_number ilike '%' || ${search} || '%'
             or d.name_en ilike '%' || ${search} || '%'
             or coalesce(d.name_ar, '') ilike '%' || ${search} || '%')
        and (
          (${query.traderId ?? null}::uuid is null
           and ${query.emirateId ?? null}::uuid is null
           and ${query.areaId ?? null}::uuid is null
           and ${query.orderSerialNumber ?? null}::text is null
           and ${query.referenceNumber ?? null}::text is null
           and ${query.customerName ?? null}::text is null
           and ${query.deliveredFrom ?? null}::date is null
           and ${query.deliveredTo ?? null}::date is null
           and ${query.orderStatus ?? null}::text is null)
          or exists (
            select 1
              from driver_reconciliation_orders link
              join orders o on o.id = link.order_id and o.company_id = link.company_id
              left join areas a on a.id = o.area_id and a.company_id = o.company_id
             where link.reconciliation_id = r.id and link.company_id = r.company_id
               and (${query.traderId ?? null}::uuid is null
                    or o.trader_id = ${query.traderId ?? null}::uuid)
               and (${query.emirateId ?? null}::uuid is null
                    or a.emirate_id = ${query.emirateId ?? null}::uuid)
               and (${query.areaId ?? null}::uuid is null
                    or o.area_id = ${query.areaId ?? null}::uuid)
               and (${query.orderSerialNumber ?? null}::text is null
                    or coalesce(o.serial_number, o.order_number)
                       ilike '%' || ${query.orderSerialNumber ?? null} || '%')
               and (${query.referenceNumber ?? null}::text is null
                    or o.reference_number ilike '%' || ${query.referenceNumber ?? null} || '%')
               and (${query.customerName ?? null}::text is null
                    or o.customer_name ilike '%' || ${query.customerName ?? null} || '%')
               and (${query.deliveredFrom ?? null}::date is null
                    or o.delivered_at::date >= ${query.deliveredFrom ?? null}::date)
               and (${query.deliveredTo ?? null}::date is null
                    or o.delivered_at::date <= ${query.deliveredTo ?? null}::date)
               and (${query.orderStatus ?? null}::text is null
                    or o.delivery_status = ${query.orderStatus ?? null}::text)
          )
        )
    `;
  }

  public async list(query: ReconciliationListQueryDto): Promise<Page<ReconciliationListRow>> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const { limit, offset, page, pageSize } = this.pagination(query);
    const direction = query.sortDirection === "asc" ? "asc" : "desc";
    const sortColumn =
      query.sortBy === "reconciliationNumber"
        ? "r.reconciliation_number"
        : query.sortBy === "netAmountReceived"
          ? "r.net_amount_received"
          : "r.business_date";
    // Resolved once per request: one configuration query, boundaries computed
    // once, and the same object feeds the row query, the count that rides the
    // same statement, and the caption returned to the caller.
    const applied = await this.reportDateModes.resolve("driver-collection-activity", query);
    const filters = this.reconciliationFilters(companyId, query, applied);
    const result = await sql<ReconciliationListRow & { total: number }>`
      select r.id, r.reconciliation_number as "reconciliationNumber",
             r.business_date::text as "businessDate",
             r.collection_payment_method as "collectionPaymentMethod",
             d.name_en as "driverName", d.driver_type as "driverType",
             r.gross_collections::text as "grossCollections",
             r.driver_payable_deduction::text as "driverPayableDeduction",
             r.reconciliation_expenses::text as "expenseTotal",
             r.net_amount_received::text as "netAmountReceived",
             r.status, r.confirmed_at::text as "confirmedAt",
             coalesce(actor.username, ${legacyUnknown}) as "confirmedBy",
             coalesce(links.total, 0)::int as "orderCount",
             coalesce(payments.total, 0)::text as "paymentTotal",
             exists (
               select 1 from driver_reconciliations rv
                where rv.company_id = r.company_id and rv.reversal_of_id = r.id
             ) as "isReversed",
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
       where ${filters}
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
    // ONE configuration query for the whole page, then pure in-memory
    // resolution. Calling businessDateOf per row would be an N+1; deriving
    // the date in SQL would restate the rule in a second language.
    const businessDates = await this.businessDays.businessDatesFor(
      items.map((row) => row.confirmedAt),
    );
    const enriched = items.map((row) => ({
      ...row,
      // Null when no authoritative timestamp exists. Never guessed.
      confirmationBusinessDate:
        row.confirmedAt === null ? null : (businessDates.get(row.confirmedAt) ?? null),
    }));
    return { ...this.page(enriched, page, pageSize), appliedDateMode: applied };
  }

  /**
   * Server-calculated Driver Collections summary cards (§3), honoring the same
   * filters as `list()`. Pending/Outstanding figures come from Orders that have
   * not yet been claimed by any (non-reversed) reconciliation; the remaining
   * cards aggregate confirmed, non-reversed reconciliations.
   */
  public async summary(query: DriverCollectionsSummaryQueryDto): Promise<DriverCollectionsSummary> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const search = query.search?.trim() || null;
    // "Pending" / "Outstanding" apply to Orders not yet part of any active
    // collection. Reconciliation-only concepts (collection method, business
    // date range, reconciliation status) do not constrain this pool; Order-level
    // filters (driver, trader, customer, Emirate, Area, dates, identifiers) do.
    const pending = await sql<{ pendingAmount: string; pendingOrderCount: number }>`
      select count(*)::int as "pendingOrderCount",
             coalesce(sum(o.customer_amount_due), 0)::text as "pendingAmount"
        from orders o
        left join drivers drv on drv.id = o.assigned_driver_id and drv.company_id = o.company_id
        left join areas a on a.id = o.area_id and a.company_id = o.company_id
       where o.company_id = ${companyId}::uuid
         and o.delivery_status = 'delivered'
         and o.driver_reconciliation_status = 'pending'
         and (${query.driverId ?? null}::uuid is null
              or o.assigned_driver_id = ${query.driverId ?? null}::uuid)
         and (${query.driverType ?? null}::text is null
              or drv.driver_type = ${query.driverType ?? null}::text)
         and (${query.traderId ?? null}::uuid is null or o.trader_id = ${query.traderId ?? null}::uuid)
         and (${query.emirateId ?? null}::uuid is null
              or a.emirate_id = ${query.emirateId ?? null}::uuid)
         and (${query.areaId ?? null}::uuid is null or o.area_id = ${query.areaId ?? null}::uuid)
         and (${query.orderSerialNumber ?? null}::text is null
              or coalesce(o.serial_number, o.order_number)
                 ilike '%' || ${query.orderSerialNumber ?? null} || '%')
         and (${query.referenceNumber ?? null}::text is null
              or o.reference_number ilike '%' || ${query.referenceNumber ?? null} || '%')
         and (${query.customerName ?? null}::text is null
              or o.customer_name ilike '%' || ${query.customerName ?? null} || '%')
         and (${query.deliveredFrom ?? null}::date is null
              or o.delivered_at::date >= ${query.deliveredFrom ?? null}::date)
         and (${query.deliveredTo ?? null}::date is null
              or o.delivered_at::date <= ${query.deliveredTo ?? null}::date)
         and (${search}::text is null
              or o.order_number ilike '%' || ${search} || '%'
              or o.serial_number ilike '%' || ${search} || '%'
              or o.reference_number ilike '%' || ${search} || '%'
              or o.customer_name ilike '%' || ${search} || '%'
              or coalesce(drv.name_en, '') ilike '%' || ${search} || '%')
    `.execute(this.database);

    const filters = this.reconciliationFilters(companyId, query);
    const confirmed = await sql<{
      actualAmountReceived: string;
      cashTotal: string;
      collectionsWithDifferenceCount: number;
      driverExpenses: string;
      netExpectedFromDrivers: string;
      reconciledCollectionsCount: number;
      visaTotal: string;
    }>`
      select
        coalesce(sum(r.gross_collections) filter (
          where r.status = 'confirmed' and r.collection_payment_method = 'cash'
        ), 0)::text as "cashTotal",
        coalesce(sum(r.gross_collections) filter (
          where r.status = 'confirmed' and r.collection_payment_method = 'visa'
        ), 0)::text as "visaTotal",
        coalesce(sum(r.reconciliation_expenses) filter (where r.status = 'confirmed'), 0)::text
          as "driverExpenses",
        coalesce(sum(r.net_amount_received) filter (where r.status = 'confirmed'), 0)::text
          as "netExpectedFromDrivers",
        coalesce(sum(coalesce(payments.total, 0)) filter (where r.status = 'confirmed'), 0)::text
          as "actualAmountReceived",
        count(*) filter (
          where r.status = 'confirmed' and not exists (
            select 1 from driver_reconciliations rv
             where rv.company_id = r.company_id and rv.reversal_of_id = r.id
          )
        )::int as "reconciledCollectionsCount",
        count(*) filter (
          where r.status = 'confirmed'
            and abs(r.net_amount_received - coalesce(payments.total, 0)) <> 0
        )::int as "collectionsWithDifferenceCount"
        from driver_reconciliations r
        join drivers d on d.id = r.driver_id and d.company_id = r.company_id
        left join lateral (
          select coalesce(sum(p.amount), 0) as total from driver_reconciliation_payments p
           where p.reconciliation_id = r.id and p.company_id = r.company_id
        ) payments on true
       where ${filters}
    `.execute(this.database);

    const pendingRow = pending.rows[0] ?? { pendingAmount: "0.00", pendingOrderCount: 0 };
    const confirmedRow = confirmed.rows[0] ?? {
      actualAmountReceived: "0.00",
      cashTotal: "0.00",
      collectionsWithDifferenceCount: 0,
      driverExpenses: "0.00",
      netExpectedFromDrivers: "0.00",
      reconciledCollectionsCount: 0,
      visaTotal: "0.00",
    };
    return {
      actualAmountReceived: new Decimal(confirmedRow.actualAmountReceived).toFixed(2),
      cashTotal: new Decimal(confirmedRow.cashTotal).toFixed(2),
      collectionsWithDifferenceCount: confirmedRow.collectionsWithDifferenceCount,
      driverExpenses: new Decimal(confirmedRow.driverExpenses).toFixed(2),
      netExpectedFromDrivers: new Decimal(confirmedRow.netExpectedFromDrivers).toFixed(2),
      // Outstanding from Drivers and Pending Amount to Collect describe the same
      // pool in this system (money for delivered Orders not yet reconciled) —
      // there is no separate "confirmed but not yet handed over" state, since
      // `confirm()` requires the payment total to already equal Net Expected.
      outstandingFromDrivers: new Decimal(pendingRow.pendingAmount).toFixed(2),
      pendingAmountToCollect: new Decimal(pendingRow.pendingAmount).toFixed(2),
      pendingOrderCount: pendingRow.pendingOrderCount,
      reconciledCollectionsCount: confirmedRow.reconciledCollectionsCount,
      visaTotal: new Decimal(confirmedRow.visaTotal).toFixed(2),
    };
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

  // Read-only data for the Driver-collection print document (§12), grouped by Trader. No status,
  // financial row or snapshot is modified. Internal UUIDs are never returned — only the business
  // identifiers (serial/reference/collection numbers) that preserve leading zeros.
  public async printData(reconciliationId: string): Promise<DriverCollectionPrintData> {
    this.assertAnyPermission("reconciliations.create");
    const { companyId } = this.tenants.current();
    const header = (
      await sql<{
        actualReceived: string;
        businessDate: string;
        companyName: string;
        driverExpenses: string;
        driverName: string;
        netExpected: string;
        paymentMethod: string | null;
        reconciliationNumber: string;
      }>`
        select r.reconciliation_number as "reconciliationNumber",
               r.business_date::text as "businessDate",
               r.collection_payment_method as "paymentMethod",
               r.reconciliation_expenses::text as "driverExpenses",
               r.net_amount_received::text as "netExpected",
               d.name_en as "driverName",
               coalesce(company.name_ar, company.name_en) as "companyName",
               coalesce(pay.total, 0)::text as "actualReceived"
          from driver_reconciliations r
          join drivers d on d.id = r.driver_id and d.company_id = r.company_id
          join companies company on company.id = r.company_id
          left join lateral (
            select coalesce(sum(p.amount), 0) as total from driver_reconciliation_payments p
             where p.reconciliation_id = r.id and p.company_id = r.company_id
          ) pay on true
         where r.id = ${reconciliationId}::uuid and r.company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (header === undefined) {
      throw new ApplicationException(
        "reconciliation_not_found",
        "Driver cash reconciliation not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const rows = (
      await sql<{
        address: string;
        amountToCollect: string;
        areaNameAr: string;
        companyFees: string;
        customerMobile: string;
        customerName: string;
        notes: string | null;
        referenceNumber: string | null;
        serialNumber: string;
        status: string;
        traderName: string;
        traderPayable: string;
      }>`
        select coalesce(t.name_ar, t.name_en) as "traderName",
               coalesce(o.serial_number, o.order_number) as "serialNumber",
               o.reference_number as "referenceNumber",
               o.customer_name as "customerName",
               o.customer_mobile_number as "customerMobile",
               coalesce(o.customer_area_name_snapshot, a.name_ar, a.name_en, '') as "areaNameAr",
               o.customer_address as "address",
               o.customer_amount_due::text as "amountToCollect",
               (o.customer_amount_due - o.trader_net_payable)::text as "companyFees",
               o.trader_net_payable::text as "traderPayable",
               o.delivery_status as "status",
               o.notes
          from driver_reconciliation_orders link
          join orders o on o.id = link.order_id and o.company_id = link.company_id
          join traders t on t.id = o.trader_id and t.company_id = o.company_id
          left join areas a on a.id = o.area_id and a.company_id = o.company_id
         where link.reconciliation_id = ${reconciliationId}::uuid
           and link.company_id = ${companyId}::uuid
         order by t.name_en, coalesce(o.serial_number, o.order_number)
      `.execute(this.database)
    ).rows;

    const traderOrder: string[] = [];
    const grouped = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
      if (!grouped.has(row.traderName)) {
        grouped.set(row.traderName, []);
        traderOrder.push(row.traderName);
      }
      grouped.get(row.traderName)!.push(row);
    }
    const traders = traderOrder.map((traderName) => {
      const traderRows = grouped.get(traderName)!;
      const gross = traderRows.reduce((sum, r) => sum.plus(r.amountToCollect), new Decimal(0));
      const companyFees = traderRows.reduce((sum, r) => sum.plus(r.companyFees), new Decimal(0));
      const traderPayable = traderRows.reduce(
        (sum, r) => sum.plus(r.traderPayable),
        new Decimal(0),
      );
      return {
        companyFees: companyFees.toFixed(2),
        gross: gross.toFixed(2),
        orderCount: traderRows.length,
        orders: traderRows.map((r) => ({
          address: r.address,
          amountToCollect: new Decimal(r.amountToCollect).toFixed(2),
          areaNameAr: r.areaNameAr,
          companyFees: new Decimal(r.companyFees).toFixed(2),
          customerMobile: r.customerMobile,
          customerName: r.customerName,
          notes: r.notes,
          referenceNumber: r.referenceNumber,
          serialNumber: r.serialNumber,
          status: r.status,
          traderPayable: new Decimal(r.traderPayable).toFixed(2),
        })),
        traderName,
        traderPayable: traderPayable.toFixed(2),
      };
    });
    const gross = rows.reduce((sum, r) => sum.plus(r.amountToCollect), new Decimal(0));
    const actualReceived = new Decimal(header.actualReceived);
    const netExpected = new Decimal(header.netExpected);
    return {
      actualReceived: actualReceived.toFixed(2),
      businessDate: header.businessDate,
      companyName: header.companyName,
      difference: actualReceived.minus(netExpected).toFixed(2),
      driverExpenses: new Decimal(header.driverExpenses).toFixed(2),
      driverName: header.driverName,
      gross: gross.toFixed(2),
      netExpected: netExpected.toFixed(2),
      paymentMethod: header.paymentMethod === "visa" ? "visa" : "cash",
      reconciliationNumber: header.reconciliationNumber,
      totalOrders: rows.length,
      totalTraders: traders.length,
      traders,
    };
  }

  /**
   * Resolves the active (non-reversed, confirmed) Driver Collection linked to
   * one Order, so the Orders screen can open the exact same server-authoritative
   * report/PDF the Driver Collections screen uses — never a second, Order-scoped
   * report record. Returns null when the Order has no reconciliation yet.
   */
  public async reconciliationForOrder(
    orderId: string,
  ): Promise<{ reconciliationId: string; reconciliationNumber: string } | null> {
    this.assertAnyPermission(["reconciliations.create", "reports.export"]);
    const { companyId } = this.tenants.current();
    const result = await sql<{ id: string; reconciliationNumber: string }>`
      select r.id, r.reconciliation_number as "reconciliationNumber"
        from driver_reconciliation_orders link
        join driver_reconciliations r on r.id = link.reconciliation_id and r.company_id = link.company_id
       where link.company_id = ${companyId}::uuid
         and link.order_id = ${orderId}::uuid
         and r.status = 'confirmed'
         and not exists (
           select 1 from driver_reconciliations rv
            where rv.company_id = r.company_id and rv.reversal_of_id = r.id
         )
       limit 1
    `.execute(this.database);
    const row = result.rows[0];
    return row === undefined
      ? null
      : { reconciliationId: row.id, reconciliationNumber: row.reconciliationNumber };
  }

  /**
   * Comprehensive, server-authoritative report data for the Driver Collection
   * Report (§10/§19/CP2 §1). Every value is read from the reconciliation's own
   * stored snapshots and its linked Orders' financial snapshot columns — never
   * from the current catalog — so a report regenerated later from the same
   * reconciliation is identical. No internal database IDs are returned. Three
   * queries total (header+company, orders, expenses): no N+1.
   */
  public async reportData(reconciliationId: string): Promise<DriverCollectionReportData> {
    this.assertAnyPermission(["reconciliations.create", "reports.export"]);
    const { companyId } = this.tenants.current();
    const header = (
      await sql<{
        businessDate: string;
        collectionPaymentMethod: "cash" | "visa" | null;
        confirmedAt: string | null;
        confirmedBy: string;
        createdAt: string;
        createdBy: string;
        driverCode: string | null;
        driverName: string;
        driverNameAr: string | null;
        driverType: "employee" | "outsourced";
        driverPayableDeduction: string;
        isReversal: boolean;
        linkedDriverFeePaymentId: string | null;
        linkedDriverFeePaymentNumber: string | null;
        linkedDriverFeePaymentStatus: "confirmed" | "reversed" | null;
        notes: string | null;
        reconciliationNumber: string;
        reversedByReconciliationNumber: string | null;
        reversesReconciliationNumber: string | null;
        status: "confirmed" | "draft";
      }>`
        select r.reconciliation_number as "reconciliationNumber",
               r.status,
               r.collection_payment_method as "collectionPaymentMethod",
               r.business_date::text as "businessDate",
               r.created_at::text as "createdAt",
               r.confirmed_at::text as "confirmedAt",
               r.driver_payable_deduction::text as "driverPayableDeduction",
               r.notes,
               (r.reversal_of_id is not null) as "isReversal",
               d.name_en as "driverName", d.driver_type as "driverType",
               d.code as "driverCode", d.name_ar as "driverNameAr",
               coalesce(creator.username, ${legacyUnknown}) as "createdBy",
               coalesce(confirmer.username, ${legacyUnknown}) as "confirmedBy",
               fee_payment.id as "linkedDriverFeePaymentId",
               fee_payment.payment_number as "linkedDriverFeePaymentNumber",
               fee_payment.status as "linkedDriverFeePaymentStatus",
               original.reconciliation_number as "reversesReconciliationNumber",
               reversal.reconciliation_number as "reversedByReconciliationNumber"
          from driver_reconciliations r
          join drivers d on d.id = r.driver_id and d.company_id = r.company_id
          left join accounts creator
            on creator.id = r.created_by_account_id and creator.company_id = r.company_id
          left join accounts confirmer
            on confirmer.id = r.confirmed_by_account_id and confirmer.company_id = r.company_id
          left join driver_reconciliations original
            on original.id = r.reversal_of_id and original.company_id = r.company_id
          left join driver_reconciliations reversal
            on reversal.reversal_of_id = r.id and reversal.company_id = r.company_id
          left join lateral (
            select payment.id, payment.payment_number, payment.status
              from outsourced_driver_fee_payments payment
             where payment.company_id = r.company_id
               and payment.linked_driver_reconciliation_id = r.id
             order by payment.created_at
             limit 1
          ) fee_payment on true
         where r.id = ${reconciliationId}::uuid and r.company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (header === undefined) {
      throw new ApplicationException(
        "reconciliation_not_found",
        "Driver cash reconciliation not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const branding = await this.companyProfile.branding();

    const orderRows = (
      await sql<{
        additionalFees: string;
        areaName: string;
        codAmount: string;
        customerAmountToCollect: string;
        customerName: string;
        deliveryDate: string | null;
        driverReconciliationStatus: string;
        emirateName: string | null;
        paymentMethod: "cash" | "visa" | null;
        orderNumber: string;
        referenceNumber: string | null;
        serialNumber: string;
        serviceFee: string;
        totalDeductions: string;
        traderCode: string | null;
        traderName: string;
        traderPayable: string;
        vatAmount: string;
      }>`
        -- Order NUMBER and Trader CODE are the values the detail routes
        -- consume; the Serial Number and Trader Name stay as the values the
        -- User reads. Additive: no existing field changes.
        select o.order_number as "orderNumber", t.code as "traderCode",
               coalesce(o.serial_number, o.order_number) as "serialNumber",
               o.reference_number as "referenceNumber",
               o.delivered_at::text as "deliveryDate",
               coalesce(t.name_ar, t.name_en) as "traderName",
               o.customer_name as "customerName",
               coalesce(e.name_ar, e.name_en) as "emirateName",
               coalesce(o.customer_area_name_ar_snapshot, a.name_ar,
                        o.customer_area_name_snapshot, a.name_en, '') as "areaName",
               o.cod_amount::text as "codAmount",
               o.customer_amount_due::text as "customerAmountToCollect",
               o.service_fee::text as "serviceFee",
               coalesce(o.additional_fees, 0)::text as "additionalFees",
               coalesce(o.vat_amount, 0)::text as "vatAmount",
               coalesce(o.total_deductions, o.customer_amount_due - o.trader_net_payable)::text
                 as "totalDeductions",
               o.trader_net_payable::text as "traderPayable",
               link.collection_payment_method as "paymentMethod",
               o.driver_reconciliation_status as "driverReconciliationStatus"
          from driver_reconciliation_orders link
          join orders o on o.id = link.order_id and o.company_id = link.company_id
          join traders t on t.id = o.trader_id and t.company_id = o.company_id
          left join areas a on a.id = o.area_id and a.company_id = o.company_id
          left join emirates e on e.id = a.emirate_id
         where link.reconciliation_id = ${reconciliationId}::uuid
           and link.company_id = ${companyId}::uuid
         order by coalesce(o.serial_number, o.order_number)
      `.execute(this.database)
    ).rows;

    const expenseRows = (
      await sql<{
        amount: string;
        description: string | null;
        enteredBy: string;
        expenseType: string;
        reason: string | null;
        recordedAt: string;
        reference: string | null;
      }>`
        select coalesce(type.display_name, ${legacyUnknown}) as "expenseType",
               ex.amount::text as amount, ex.description, ex.reason,
               ex.expense_reference as reference, ex.recorded_at::text as "recordedAt",
               coalesce(actor.username, ${legacyUnknown}) as "enteredBy"
          from driver_reconciliation_expenses ex
          left join expense_types type
            on type.id = ex.expense_type_id and type.company_id = ex.company_id
          left join accounts actor
            on actor.id = ex.created_by_account_id and actor.company_id = ex.company_id
         where ex.reconciliation_id = ${reconciliationId}::uuid
           and ex.company_id = ${companyId}::uuid
         order by ex.recorded_at
      `.execute(this.database)
    ).rows;

    const paymentTotal = (
      await sql<{ total: string }>`
        select coalesce(sum(p.amount), 0)::text as total from driver_reconciliation_payments p
         where p.reconciliation_id = ${reconciliationId}::uuid and p.company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0]?.total;
    const actualReceived = new Decimal(paymentTotal ?? "0");

    const grossCollections = orderRows.reduce(
      (sum, order) => sum.plus(order.customerAmountToCollect),
      new Decimal(0),
    );
    const cashTotal = orderRows
      .filter((order) => order.paymentMethod === "cash")
      .reduce((sum, order) => sum.plus(order.customerAmountToCollect), new Decimal(0));
    const visaTotal = orderRows
      .filter((order) => order.paymentMethod === "visa")
      .reduce((sum, order) => sum.plus(order.customerAmountToCollect), new Decimal(0));
    const driverExpenses = expenseRows.reduce(
      (sum, expense) => sum.plus(expense.amount),
      new Decimal(0),
    );
    const driverFeeOffset = new Decimal(header.driverPayableDeduction);
    const netExpected = grossCollections.minus(driverExpenses).minus(driverFeeOffset);

    return {
      expenses: expenseRows.map((row) => ({
        amount: new Decimal(row.amount).toFixed(2),
        description: row.description,
        enteredBy: row.enteredBy,
        expenseType: row.expenseType,
        reason: row.reason,
        recordedAt: row.recordedAt,
        reference: row.reference,
      })),
      header: {
        businessDate: header.businessDate,
        collectionPaymentMethod: header.collectionPaymentMethod,
        company: {
          hasLogo: branding.hasLogo,
          nameAr: branding.nameAr,
          nameEn: branding.nameEn,
          subtitleAr: branding.subtitleAr,
          subtitleEn: branding.subtitleEn,
          telephone: branding.telephone,
        },
        confirmedAt: header.confirmedAt,
        confirmedBy: header.confirmedBy,
        createdAt: header.createdAt,
        createdBy: header.createdBy,
        driverCode: header.driverCode,
        driverName: header.driverName,
        driverNameAr: header.driverNameAr,
        driverType: header.driverType,
        linkedDriverFeePaymentId: header.linkedDriverFeePaymentId,
        linkedDriverFeePaymentNumber: header.linkedDriverFeePaymentNumber,
        linkedDriverFeePaymentStatus: header.linkedDriverFeePaymentStatus,
        isReversal: header.isReversal,
        notes: header.notes,
        reconciliationNumber: header.reconciliationNumber,
        reversedByReconciliationNumber: header.reversedByReconciliationNumber,
        reversesReconciliationNumber: header.reversesReconciliationNumber,
        status: header.status,
        statusLabel: reconciliationStatusLabel(header.status),
      },
      orders: orderRows.map((row) => ({
        additionalFees: new Decimal(row.additionalFees).toFixed(2),
        areaName: row.areaName,
        codAmount: new Decimal(row.codAmount).toFixed(2),
        customerAmountToCollect: new Decimal(row.customerAmountToCollect).toFixed(2),
        customerName: row.customerName,
        deliveryDate: row.deliveryDate,
        driverReconciliationStatus: row.driverReconciliationStatus,
        driverReconciliationStatusLabel: driverCashStatusLabel(row.driverReconciliationStatus),
        emirateName: row.emirateName,
        paymentMethod: row.paymentMethod,
        orderNumber: row.orderNumber,
        referenceNumber: row.referenceNumber,
        serialNumber: row.serialNumber,
        serviceFee: new Decimal(row.serviceFee).toFixed(2),
        totalDeductions: new Decimal(row.totalDeductions).toFixed(2),
        traderCode: row.traderCode,
        traderName: row.traderName,
        traderPayable: new Decimal(row.traderPayable).toFixed(2),
        vatAmount: new Decimal(row.vatAmount).toFixed(2),
      })),
      summary: {
        actualReceived: actualReceived.toFixed(2),
        cashTotal: cashTotal.toFixed(2),
        difference: actualReceived.minus(netExpected).toFixed(2),
        driverFeeOffset: driverFeeOffset.toFixed(2),
        driverExpenses: driverExpenses.toFixed(2),
        grossCollections: grossCollections.toFixed(2),
        netExpected: netExpected.toFixed(2),
        orderCount: orderRows.length,
        visaTotal: visaTotal.toFixed(2),
      },
    };
  }

  /**
   * True, downloadable PDF file for the Driver Collection Report (§12/§19),
   * server-authoritative end to end: the same `reportData()` snapshot backs
   * both the JSON view and this PDF, rendered from server-built HTML via a
   * headless browser — never from a User's DOM. A render failure only ever
   * throws; the reconciliation itself is a separately-committed, already
   * confirmed record and is never touched by this read-only path.
   */
  public async reportPdf(
    reconciliationId: string,
    language: ReportLanguage,
    correlationId: string,
  ): Promise<{ bytes: Buffer; filename: string }> {
    this.assertAnyPermission(["reconciliations.create", "reports.export"]);
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const data = await this.reportData(reconciliationId);
    const generatedAt = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Dubai",
      year: "numeric",
    }).format(new Date());
    const html = buildDriverCollectionReportHtml(data, language, `${generatedAt} (UAE)`);
    const footerTemplate =
      language === "ar"
        ? `<div style="font-size:9px;width:100%;text-align:center;color:#666;direction:rtl;">الصفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div>`
        : `<div style="font-size:9px;width:100%;text-align:center;color:#666;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
    const bytes = await this.pdf.renderPdf(html, footerTemplate);
    // Safe filename (§19): built only from the reconciliation number, which is
    // always the `REC-XXXXXX` shape generated by `nextReferenceNumber` — the
    // allowlist strips anything else defensively rather than trusting that.
    const safeNumber = data.header.reconciliationNumber.replaceAll(/[^A-Za-z0-9-]/g, "");
    const filename = `Driver-Collection-${safeNumber}.pdf`;
    await this.history.audit(this.database, {
      action: "driver_reconciliation.report_pdf_generated",
      actorId: identity.identityId,
      after: { language, reconciliationNumber: data.header.reconciliationNumber },
      companyId,
      correlationId,
      subjectId: reconciliationId,
      subjectType: "driver_reconciliation",
    });
    return { bytes, filename };
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
    const page = Number.isInteger(query.page) && (query.page ?? 0) > 0 ? (query.page ?? 1) : 1;
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

  /**
   * Last-mile duplicate-collection guard, run under the locks taken by
   * `lockExistingLinks` so a concurrent confirmation cannot slip through: a
   * stale client (or a direct API attempt) selecting an Order already claimed
   * by a non-reversed confirmed reconciliation gets a specific error naming
   * that reconciliation, not just a generic "ineligible" one.
   */
  private async assertOrdersNotAlreadyReconciled(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    orders: readonly EligibleOrder[],
  ): Promise<void> {
    if (orders.length === 0) return;
    const reconciliationByOrder = await this.findActiveReconciliationLinks(
      database,
      companyId,
      orders,
    );
    if (reconciliationByOrder.size === 0) return;
    throw new ApplicationException(
      "order_already_reconciled",
      "One or more selected Orders have already been included in a Driver Collection",
      HttpStatus.CONFLICT,
      [...reconciliationByOrder].map(
        ([orderNumber, reconciliationNumber]) =>
          `${orderNumber}: This Order has already been included in Driver Collection ${reconciliationNumber}.`,
      ),
    );
  }

  /**
   * Orders (from the given set) currently claimed by a non-reversed confirmed
   * reconciliation, keyed by Order number. Shared by the `preview()` warning
   * and the `confirm()` duplicate-collection guard so both name the same
   * conflicting reconciliation the same way.
   */
  private async findActiveReconciliationLinks(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    orders: readonly EligibleOrder[],
  ): Promise<Map<string, string>> {
    if (orders.length === 0) return new Map();
    const linked = await sql<{ orderNumber: string; reconciliationNumber: string }>`
      select o.order_number as "orderNumber", r.reconciliation_number as "reconciliationNumber"
        from driver_reconciliation_orders link
        join driver_reconciliations r on r.id = link.reconciliation_id and r.company_id = link.company_id
        join orders o on o.id = link.order_id and o.company_id = link.company_id
       where link.company_id = ${companyId}::uuid
         and link.order_id in (${sql.join(orders.map((order) => sql`${order.id}::uuid`))})
         and r.status = 'confirmed'
         and not exists (
           select 1 from driver_reconciliations rv
            where rv.company_id = r.company_id and rv.reversal_of_id = r.id
         )
    `.execute(database);
    return new Map(linked.rows.map((row) => [row.orderNumber, row.reconciliationNumber]));
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
               amount_collected::text as "amountCollected",
               customer_amount_due::text as "customerAmountDue",
               trader_id as "traderId",
               trader_net_payable::text as "traderNetPayable"
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
             o.amount_collected::text as "amountCollected",
             o.customer_amount_due::text as "customerAmountDue",
             o.trader_id as "traderId",
             o.trader_net_payable::text as "traderNetPayable"
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
             coalesce(reconciled_orders.total, 0)::int as "orderCount",
             fee_payment.id as "driverFeePaymentId",
             fee_payment.payment_number as "driverFeePaymentNumber",
             coalesce(fee_outstanding.total,0)::text as "remainingDriverFeeOutstanding",
             coalesce(fee_allocations.items,'[]'::jsonb) as "driverFeeAllocations"
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
      left join outsourced_driver_fee_payments fee_payment
        on fee_payment.company_id=r.company_id and fee_payment.linked_driver_reconciliation_id=r.id
      left join lateral (
        select jsonb_agg(jsonb_build_object('accrualId',a.accrual_id,'amount',a.allocated_amount)
          order by a.allocation_order) as items
        from outsourced_driver_fee_payment_allocations a
        where a.company_id=r.company_id and a.payment_id=fee_payment.id
      ) fee_allocations on true
      left join lateral (
        select sum(a.outstanding_amount) as total
        from outsourced_driver_fee_accruals a
        where a.company_id=r.company_id and a.driver_id=r.driver_id
          and a.status in ('accrued','partially_paid')
      ) fee_outstanding on true
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

  private assertAnyPermission(permission: string | readonly string[]): void {
    const permissions = this.identities.current().permissions;
    const required = Array.isArray(permission) ? permission : [permission];
    if (
      !permissions.has("users_roles.manage") &&
      !required.some((candidate) => permissions.has(candidate))
    ) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
