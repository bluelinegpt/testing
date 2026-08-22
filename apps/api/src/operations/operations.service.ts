import { createHash, randomBytes, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { PasswordHasher } from "../authentication/password-hasher.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { BusinessDayService } from "../company-configuration/business-day.service.js";
import {
  type AppliedReportDateMode,
  ReportDateModeService,
} from "../company-configuration/report-date-mode.js";
import {
  type OrderFeeSource,
  orderAccountingColumns,
  orderFeeSource,
} from "./order-accounting-classification.js";
import { deriveOrderWorkflowGuidance } from "./order-workflow-guidance.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { normalizeReferenceTerm, unifiedOrderSearchPredicate } from "./order-search.js";
import { traderCommerceOrderScopePairs } from "./trader-commerce-order-scope.js";
import { mobileComparisonKey, normalizeUaeMobile } from "../shared/uae-mobile.js";
import { PushOutboxWriter } from "../push/push-outbox-writer.service.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { EmployeeDeliveryEarningService } from "../payroll/employee-delivery-earning.service.js";
import { OutsourcedDriverFeeService } from "../payroll/outsourced-driver-fee.service.js";
import type {
  BulkSettleTraderDto,
  ChangeOrderStatusDto,
  CreateDriverDto,
  CreateOrderDto,
  CreateTraderPortalOrderDto,
  CreateTraderDto,
  FinancialPaymentDto,
  ImportOrdersCsvDto,
  ImportTraderPortalOrdersCsvDto,
  OrderIdentifierAvailabilityQueryDto,
  OrderQuoteDto,
  RegisterInternationalShipmentDto,
  RegisterOrderAttachmentDto,
  UpdateOrderDto,
} from "./operations.dto.js";

export interface OperationsOverview {
  readonly counts: {
    readonly activeDrivers: number;
    readonly activeTraders: number;
    readonly orders: number;
    readonly pendingCashOrders: number;
    readonly unsettledTraderOrders: number;
  };
  readonly financials: {
    readonly codAmount: string;
    readonly companyRevenue: string;
    readonly customerAmountDue: string;
    readonly orderProfit: string;
    readonly traderNetPayable: string;
    readonly vatAmount: string;
  };
  readonly deliveryStatuses: readonly OperationsStatusCount[];
}

export interface OperationsOverviewFilters {
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
}

export interface OperationsStatusCount {
  readonly count: number;
  readonly status: string;
}

/**
 * Operational counts only — deliberately no COD/revenue/profit totals, so an
 * Operator holding only dispatch permissions (`orders.assign_driver`,
 * `orders.update_delivery_status`) can call this without ever being granted
 * `reports.financial.view`. `byStatus` always includes every known delivery
 * status key (zero-filled), so a mobile client never has to special-case a
 * status that simply has no Orders right now.
 */
export interface OperationsOperatorDashboardSummary {
  readonly activeTotal: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly deliveredToday: number;
  readonly returnPending: number;
}

/** Driver-scoped dashboard counts — never Company-wide, never another
 *  Driver's. See {@link OperationsService.driverDashboardSummary}. */
export interface OperationsDriverDashboardSummary {
  readonly activeTotal: number;
  readonly assignedToMe: number;
  readonly deliveredToday: number;
  readonly outForDelivery: number;
  readonly returnPending: number;
}

/**
 * Recorded as the Service Fee reason when a Trader/Area is CONFIGURED at
 * zero and no fee was requested.
 *
 * This is deliberately a system-generated explanation, not a user's words:
 * nobody made an exceptional decision here, the price simply is zero. It
 * satisfies `orders_zero_service_fee_reason_check` while keeping a
 * configured zero clearly distinguishable from a manual override in both
 * the Order record and the audit trail.
 */
export const configuredZeroPriceReason = "Configured Trader/Area price is zero";

export interface OperationsOrderFilters {
  readonly areaId?: string | undefined;
  /** Every Order in an Emirate, without having to pick each Area inside it. */
  readonly emirateId?: string | undefined;
  readonly cashStatus?: string | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  readonly deliveryStatus?: string | undefined;
  readonly driverId?: string | undefined;
  readonly orderType?: "collect_order" | "delivery" | undefined;
  /** External Reference Number, partial match. Distinct from `search`. */
  readonly referenceNumber?: string | undefined;
  /** Serial Number, partial match. Distinct from `search`. */
  readonly serialNumber?: string | undefined;
  readonly search?: string | undefined;
  readonly settlementStatus?: string | undefined;
  readonly quickView?:
    "active" | "all" | "cancelled" | "closed" | "hold" | "accountant" | undefined;
  /**
   * Delivery Activity: only Orders that actually reached a customer.
   *
   * Gated on `delivered_at is not null`, never on delivery_status. An Order
   * later returned or cancelled still WAS delivered, and the view exists to
   * report that the delivery happened; its current status stays visible in its
   * own column.
   */
  readonly deliveredOnly?: boolean | undefined;
  /** Calendar Date mode, against the Company-local date of `delivered_at`. */
  readonly deliveryDateFrom?: string | undefined;
  readonly deliveryDateTo?: string | undefined;
  /** Delivery Activity only. `dateFrom`/`dateTo` keep meaning Order Date. */
  readonly dateMode?: string | undefined;
  readonly businessDateFrom?: string | undefined;
  readonly businessDateTo?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: 25 | 50 | 100 | undefined;
  readonly sortBy?: "amountToCollect" | "createdAt" | "orderDate" | "orderNumber" | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
  readonly traderId?: string | undefined;
}

export interface OperationsOrderPage {
  /** Present when Delivery Activity resolved a Date Mode; absent otherwise. */
  readonly appliedDateMode?: AppliedReportDateMode;
  readonly filteredCount: number;
  /** Rows matching the selected tab and the optional filters. */
  readonly matchingCount: number;
  readonly items: readonly OperationsOrder[];
  readonly page: number;
  readonly pageSize: 25 | 50 | 100;
  readonly totalCount: number;
  /** Rows in the selected tab before optional filters are applied. */
  readonly tabTotalCount: number;
}

export interface OperationsOrderQuote {
  readonly additionalFees: string;
  readonly additionalFeeVatAmount: string;
  readonly codAmount: string;
  readonly companyRevenue: string;
  readonly configuredServiceFee: string;
  readonly customerAmountDue: string;
  readonly orderProfit: string;
  readonly overrideApplied: boolean;
  readonly pricingProvenance: "manual" | "resolved";
  readonly pricingRuleId: string | null;
  readonly serviceFee: string;
  readonly serviceFeeVatAmount: string;
  readonly totalDeductions: string;
  readonly traderNetPayable: string;
  readonly vatAmount: string;
  readonly vatEnabled: boolean;
  readonly vatPriceMode: "exclusive" | "inclusive" | null;
  readonly vatRate: string;
}

export interface SearchPage<T> {
  readonly hasMore: boolean;
  readonly items: readonly T[];
  readonly total: number;
}

export interface OperationsTraderOption {
  readonly code: string;
  readonly id: string;
  readonly mobileNumber: string;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly pickupAreaId: string | null;
  readonly pickupAreaNameAr: string | null;
  readonly pickupAreaNameEn: string | null;
  readonly pickupEmirateId: string | null;
  readonly pickupEmirateNameAr: string | null;
  readonly pickupEmirateNameEn: string | null;
  readonly secondMobileNumber: string | null;
}

export interface OperationsExportFile {
  readonly content: string;
  readonly contentType: "text/csv";
  readonly filename: string;
}

export interface OperationsBillingSummary {
  readonly billableOrders: number;
  readonly commercialStatus: string;
  readonly currentPeriodStart: string;
  readonly lastUsageAt: string | null;
  readonly planName: string;
}

export interface OperationsOrder {
  /** Mirrors the capture trigger: |COD|+|Fee|+|Additional|+|VAT| is not zero. */
  readonly accountingRequired: boolean;
  /** The delivery instant. Null until the Order is delivered. */
  readonly deliveredAt?: string | null;
  /**
   * Business Date of the delivery, backend-derived from `deliveredAt`.
   *
   * Present only on Delivery Activity responses. Deliberately NOT named
   * `confirmationBusinessDate`: this one comes from a delivery, not a
   * confirmation.
   */
  readonly deliveryBusinessDate?: string | null;
  readonly additionalFees: string | null;
  readonly additionalFeeVatAmount: string | null;
  readonly amountCollected: string;
  readonly areaName: string;
  readonly areaId?: string;
  readonly areaNameEn?: string | null;
  readonly areaNameAr?: string | null;
  readonly emirateId?: string | null;
  /** Present only on the single-order detail fetch (`orderById`) — the list
      and export queries do not join `emirates`, so this is undefined there. */
  readonly emirateNameEn?: string;
  readonly emirateNameAr?: string;
  readonly assignedDriverId: string | null;
  /** Identifier only; used to prefilter the Trader Settlement screen.
      Optional because two other constructors of this shape (Fast Entry and the
      export path) do not select it and do not derive workflow guidance. */
  readonly traderId?: string;
  /** Settlements this Order could lawfully have its receipt confirmed on. */
  readonly confirmableSettlementCount?: number;
  /** Present only when exactly one confirmable settlement exists. */
  readonly confirmableSettlementId?: string | null;
  /** Ledger-derived Accounting state; see the lateral in the list query. */
  readonly accountingState?: string;
  readonly accountingEventId?: string | null;
  readonly accountingJournalId?: string | null;
  readonly assignedDriverMobile: string | null;
  readonly assignedDriverName: string | null;
  readonly codAmount: string;
  readonly companyRevenue: string;
  readonly customerAmountDue: string;
  readonly customerAddress: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly deliveryStatus: string;
  readonly driverReconciliationStatus: string;
  readonly id: string;
  readonly isFreeOrder?: boolean;
  readonly orderDate: string;
  readonly orderNumber: string;
  readonly orderType?: "collect_order" | "delivery";
  readonly orderProfit: string;
  readonly outsourcedDriverFeeAmount: string | null;
  readonly outsourcedDriverFeeOutstanding: string | null;
  readonly outsourcedDriverFeePaid: string | null;
  readonly outsourcedDriverFeePaymentNumbers: string | null;
  readonly outsourcedDriverFeeStatus: string;
  readonly returnStatus: string;
  readonly referenceNumber: string | null;
  readonly serialNumber: string | null;
  readonly serviceFee: string;
  /** Why the fee is zero or differs from the configured price. */
  readonly serviceFeeOverrideReason: string | null;
  readonly serviceFeeVatAmount: string | null;
  readonly totalDeductions: string | null;
  readonly traderNetPayable: string;
  readonly traderName: string;
  readonly traderSettlementStatus: string;
  readonly vatAmount: string;
}

export interface OperationsOrderDetail extends OperationsOrder {
  readonly attachments: readonly OperationsOrderAttachment[];
  readonly history: readonly {
    readonly changedBy: string;
    readonly fromStatus: string | null;
    readonly occurredAt: string;
    readonly reason: string | null;
    readonly statusDimension: string;
    readonly toStatus: string;
  }[];
  readonly internationalShipment: OperationsInternationalShipment | null;
  readonly metadata: {
    readonly closedAt: string | null;
    readonly createdAt: string;
    readonly createdBy: string;
    readonly customerSecondMobileNumber: string | null;
    readonly driverCost: string;
    readonly notes: string | null;
    readonly operationalCompletedAt: string | null;
    readonly orderExpensesTotal: string;
    readonly packageCount: number;
    readonly paymentCondition: string;
    readonly returnDriverFee: string;
    readonly traderNetPayable: string;
  };
  readonly events: readonly {
    readonly actor: string;
    readonly actorRole: string;
    readonly category: string;
    readonly correlationId: string;
    readonly eventType: string;
    readonly fieldName: string | null;
    readonly id: string;
    readonly newValue: unknown;
    readonly occurredAt: string;
    readonly previousValue: unknown;
    readonly reason: string | null;
    readonly source: string;
  }[];
}

export interface OperationsOrderAttachment {
  readonly attachmentType: string;
  readonly createdAt: string;
  readonly fileId: string;
  readonly fileName: string;
  readonly id: string;
  readonly mediaType: string;
  readonly scanStatus: string;
  readonly sizeBytes: string;
  readonly uploadedBy: string;
}

export interface OperationsInternationalShipment {
  readonly currentStatus: string;
  readonly customerCharge: string;
  readonly destinationCountryCode: string;
  readonly expectedDeliveryDate: string | null;
  readonly id: string;
  readonly internationalDeliveryCost: string;
  readonly notes: string | null;
  readonly providerName: string;
  readonly providerReferenceNumber: string | null;
  readonly shipmentDate: string | null;
}

export interface OperationsTrackingLink {
  readonly expiresAt: string;
  readonly token: string;
  readonly url: string;
}

export interface PublicOrderTracking {
  readonly areaName: string;
  readonly assignedDriverName: string | null;
  readonly companyName: string;
  readonly customerName: string;
  readonly deliveredAt: string | null;
  readonly deliveryStatus: string;
  readonly lastUpdatedAt: string;
  readonly orderNumber: string;
}

export interface PortalOrder {
  readonly amountCollected: string;
  readonly areaId: string;
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerAmountDue: string;
  readonly customerAddress: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly deliveryStatus: string;
  readonly id: string;
  readonly notes: string | null;
  readonly orderDate: string;
  readonly orderNumber: string;
  readonly packageCount: number;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
  readonly serviceFee: string;
  readonly traderName: string;
  readonly traderSettlementStatus: string;
  readonly emirateNameEn: string | null;
  readonly emirateNameAr: string | null;
}

/**
 * One Order row, safe for a Trader session.
 *
 * An explicit allow-list, not `OperationsOrder` narrowed down: a field added
 * to `OperationsOrder` later must be deliberately added here too, rather than
 * reaching a Trader's browser by default.
 */
export interface TraderPortalOrderSummary {
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerAddress: string;
  readonly customerAmountDue: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  /**
   * The Delivery Company that processed this Order. Present only from
   * `traderPortalOrdersPageAllCompanies` -- the single-Company `orders()`
   * delegate has nothing else to put here, since every row already belongs
   * to the caller's one session Company, so it stays absent there rather
   * than repeating a value the caller already knows.
   */
  readonly deliveryCompanyId?: string;
  readonly deliveryCompanyName?: string;
  readonly deliveryStatus: string;
  readonly id: string;
  readonly orderDate: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly serviceFee: string;
}

export interface TraderPortalOrderPage {
  readonly filteredCount: number;
  readonly items: readonly TraderPortalOrderSummary[];
  readonly page: number;
  readonly pageSize: 25 | 50 | 100;
  readonly totalCount: number;
}

export interface TraderPortalProfile {
  readonly code: string;
  readonly commercialNumber: string | null;
  /**
   * The Company's six-digit Mobile Code, for the Trader portal's "Mobile App
   * — Scan QR" panel. Authenticated Traders only — never on a public route.
   */
  readonly companyMobileCode: string;
  readonly contactPerson: string | null;
  readonly email: string | null;
  readonly id: string;
  readonly mobileNumber: string;
  readonly name: string;
  readonly nameAr: string | null;
  /** The account's own display preference, not a Trader business field. */
  readonly preferredLanguage: string;
  readonly telephone: string | null;
}

export interface TraderPortalDashboard {
  readonly commerce: {
    readonly activeProducts: number;
    readonly deliveryCompanyCount: number;
    readonly draftProducts: number;
    readonly hasStore: boolean;
    readonly storeName: string | null;
    readonly storeStatus: string | null;
    readonly storeUrl: string | null;
    readonly totalProducts: number;
  };
  readonly orders: {
    readonly active: number;
    readonly cancelled: number;
    readonly delivered: number;
    readonly newOrders: number;
    readonly returned: number;
    readonly total: number;
  };
  /** Current-month figures only; see the Dashboard's own period label. */
  readonly period: {
    readonly monthCodTotal: string;
    readonly monthLabel: string;
  };
  readonly recentOrders: readonly {
    readonly amountDue: string;
    readonly customerName: string;
    readonly deliveryCompanyName: string | null;
    readonly orderDate: string;
    readonly orderNumber: string;
    readonly status: string;
  }[];
}

export interface TraderPortalArea {
  readonly emirateId: string;
  readonly emirateNameAr: string | null;
  readonly emirateNameEn: string;
  readonly id: string;
  readonly nameAr: string | null;
  readonly nameEn: string;
}

/**
 * One row's outcome, in the importer's terms rather than the database's.
 *
 * Added alongside the existing flat `errors` list, never in place of it, so an
 * older client that only reads `errors` keeps working unchanged.
 */
export interface OperationsOrderImportRow {
  /** True once the Order exists; false for every validation failure. */
  readonly accountingRequired: boolean | null;
  readonly errorField: string | null;
  /** Friendly, already-explained. Never SQL, a stack, or a constraint name. */
  readonly errorMessage: string | null;
  readonly feeSource: OrderFeeSource | null;
  readonly orderNumber: string | null;
  /** Preserved exactly as written, leading zeros and all. */
  readonly referenceNumber: string | null;
  readonly resolvedServiceFee: string | null;
  /** Line number in the uploaded file, counting the header as row 1. */
  readonly rowNumber: number;
  readonly status: "imported" | "invalid";
  readonly zeroFeeReason: string | null;
}

export interface OperationsOrderImportResult {
  readonly errors: readonly string[];
  readonly importNumber: string;
  readonly importedRows: number;
  readonly invalidRows: number;
  /** Per-row detail. Additive; `errors` remains the summary view. */
  readonly rows: readonly OperationsOrderImportRow[];
  readonly totalRows: number;
}

export interface OperationsTrader {
  readonly code: string;
  readonly id: string;
  readonly mobileNumber: string;
  readonly name: string;
  readonly openOrders: number;
  readonly status: string;
  readonly totalOrders: number;
  readonly unsettledNetPayable: string;
}

export interface OperationsDriver {
  readonly activeOrders: number;
  readonly code: string;
  readonly deliveredOrders: number;
  readonly id: string;
  readonly mobileNumber: string;
  readonly name: string;
  readonly pendingCashOrders: number;
  readonly status: string;
  readonly type: string;
}

export interface OperationsPendingCashOrder {
  readonly amountCollected: string;
  readonly assignedDriverName: string;
  readonly codAmount: string;
  readonly customerAmountDue: string;
  readonly customerName: string;
  readonly driverId: string;
  readonly id: string;
  readonly orderNumber: string;
  readonly serviceFee: string;
  readonly vatAmount: string;
}

export interface OperationsDriverReconciliation {
  readonly businessDate: string;
  readonly confirmedAt: string | null;
  readonly driverName: string;
  readonly grossCollections: string;
  readonly id: string;
  readonly netAmountReceived: string;
  readonly orderCount: number;
  readonly reconciliationNumber: string;
  readonly status: string;
}

export interface OperationsDriverReconciliationDetail extends OperationsDriverReconciliation {
  readonly orders: readonly {
    readonly amountCollected: string;
    readonly codAmount: string;
    readonly customerAmountDue: string;
    readonly customerName: string;
    readonly orderId: string;
    readonly orderNumber: string;
    readonly serviceFee: string;
    readonly vatAmount: string;
  }[];
  readonly payments: readonly {
    readonly amount: string;
    readonly bankAccountName: string | null;
    readonly bankReference: string | null;
    readonly method: string;
  }[];
}

export interface OperationsPendingSettlementOrder {
  readonly customerName: string;
  readonly grossPayable: string;
  readonly id: string;
  readonly netPayable: string;
  readonly orderNumber: string;
  readonly serviceFee: string;
  readonly traderId: string;
  readonly traderName: string;
}

export interface OperationsTraderSettlement {
  readonly businessDate: string;
  readonly confirmedAt: string | null;
  readonly grossPayable: string;
  readonly id: string;
  readonly netPayable: string;
  readonly orderCount: number;
  readonly serviceFeeDeductions: string;
  readonly settlementNumber: string;
  readonly status: string;
  readonly traderName: string;
}

export interface OperationsTraderSettlementDetail extends OperationsTraderSettlement {
  readonly orders: readonly {
    readonly customerName: string;
    readonly grossPayable: string;
    readonly netPayable: string;
    readonly orderId: string;
    readonly orderNumber: string;
    readonly serviceFee: string;
  }[];
  readonly payments: readonly {
    readonly amount: string;
    readonly bankAccountName: string | null;
    readonly bankReference: string | null;
    readonly method: string;
  }[];
}

interface ResolvedFinancialPayment {
  readonly bankAccountId: string | null;
  readonly bankReference: string | null;
  readonly method: "bank_transfer" | "cash";
}

interface VatPolicy {
  readonly enabled: boolean;
  readonly priceMode: "exclusive" | "inclusive" | null;
  readonly rate: Decimal;
}

interface OrderFinancials {
  readonly additionalFees: Decimal;
  readonly additionalFeeVatAmount: Decimal;
  readonly codAmount: Decimal;
  readonly companyRevenue: Decimal;
  readonly customerAmountDue: Decimal;
  readonly orderProfit: Decimal;
  readonly serviceFee: Decimal;
  readonly serviceFeeNetAmount: Decimal;
  readonly serviceFeeVatAmount: Decimal;
  readonly totalDeductions: Decimal;
  readonly traderReceivableDue: Decimal;
  readonly traderNetPayable: Decimal;
  readonly vatAmount: Decimal;
}

interface ResolvedServiceFee {
  /** The matched configured fee, or the manual fee when none was configured. */
  readonly configuredFee: Decimal;
  readonly finalFee: Decimal;
  readonly overrideApplied: boolean;
  readonly overrideReason: string | null;
  readonly provenance: "manual" | "resolved";
  /** The matched price rule, or null when the fee was entered manually. */
  readonly servicePriceId: string | null;
}

interface InsertOrderInput
  extends Omit<CreateOrderDto, "customerMobileNumber" | "customerName"> {
  readonly correlationId: string;
  readonly createdByAccountId: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly importBatchId?: string;
}

@Injectable()
export class OperationsService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(ReportDateModeService) private readonly reportDateModes: ReportDateModeService,
    @Inject(BusinessDayService) private readonly businessDays: BusinessDayService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(PasswordHasher) private readonly passwords: PasswordHasher,
    @Inject(OutsourcedDriverFeeService)
    private readonly outsourcedDriverFees: OutsourcedDriverFeeService,
    @Inject(EmployeeDeliveryEarningService)
    private readonly employeeDeliveryEarnings: EmployeeDeliveryEarningService,
    @Inject(PushOutboxWriter) private readonly pushOutbox: PushOutboxWriter,
  ) {}

  public async overview(filters: OperationsOverviewFilters = {}): Promise<OperationsOverview> {
    const { companyId } = this.tenants.current();
    const dateFrom = this.optionalDate(filters.dateFrom);
    const dateTo = this.optionalDate(filters.dateTo);
    const [counts, financials, deliveryStatuses] = await Promise.all([
      sql<OperationsOverview["counts"]>`
        select
          (select count(*)::int from orders where company_id = ${companyId}::uuid
            and (${dateFrom}::date is null or order_date >= ${dateFrom}::date)
            and (${dateTo}::date is null or order_date <= ${dateTo}::date)) as "orders",
          (select count(*)::int from traders where company_id = ${companyId}::uuid and account_status = 'active') as "activeTraders",
          (select count(*)::int from drivers where company_id = ${companyId}::uuid and account_status = 'active') as "activeDrivers",
          (select count(*)::int from orders where company_id = ${companyId}::uuid and driver_reconciliation_status = 'pending') as "pendingCashOrders",
          (select count(*)::int from orders where company_id = ${companyId}::uuid and trader_settlement_status = 'unsettled') as "unsettledTraderOrders"
      `.execute(this.database),
      sql<OperationsOverview["financials"]>`
        select
          coalesce(sum(cod_amount), 0)::text as "codAmount",
          coalesce(sum(customer_amount_due), 0)::text as "customerAmountDue",
          coalesce(sum(trader_net_payable), 0)::text as "traderNetPayable",
          coalesce(sum(vat_amount), 0)::text as "vatAmount",
          coalesce(sum(company_revenue), 0)::text as "companyRevenue",
          coalesce(sum(order_profit), 0)::text as "orderProfit"
        from orders
        where company_id = ${companyId}::uuid
          and (${dateFrom}::date is null or order_date >= ${dateFrom}::date)
          and (${dateTo}::date is null or order_date <= ${dateTo}::date)
      `.execute(this.database),
      sql<OperationsStatusCount>`
        select delivery_status as status, count(*)::int as count
        from orders
        where company_id = ${companyId}::uuid
          and (${dateFrom}::date is null or order_date >= ${dateFrom}::date)
          and (${dateTo}::date is null or order_date <= ${dateTo}::date)
        group by delivery_status
        order by delivery_status
      `.execute(this.database),
    ]);
    return {
      counts: counts.rows[0] ?? {
        activeDrivers: 0,
        activeTraders: 0,
        orders: 0,
        pendingCashOrders: 0,
        unsettledTraderOrders: 0,
      },
      deliveryStatuses: deliveryStatuses.rows,
      financials: financials.rows[0] ?? {
        codAmount: "0",
        companyRevenue: "0",
        customerAmountDue: "0",
        orderProfit: "0",
        traderNetPayable: "0",
        vatAmount: "0",
      },
    };
  }

  /**
   * Every value here comes from a server-side `count(*) ... group by`, never
   * a client-downloaded page of Orders — a mobile dashboard must not fake
   * counts by paging through full history. `activeTotal` uses the exact
   * `quickView = 'active'` boundary the Orders list already applies
   * (`delivery_status not in ('hold', 'closed', 'cancelled')`), so a Driver
   * out for delivery or an Order Returned to Trader still counts as Active
   * here exactly as it does when quick-viewing "Active" in the list.
   */
  public async operatorDashboardSummary(): Promise<OperationsOperatorDashboardSummary> {
    const { companyId } = this.tenants.current();
    const knownStatuses = [
      "new",
      "in_branch",
      "assigned_to_driver",
      "out_for_delivery",
      "hold",
      "delivered",
      "returned_to_branch",
      "returned_to_trader",
      "cancelled",
      "closed",
    ] as const;
    // A "Driver User" (a `company_user` account whose linked Employee backs a
    // `drivers.employee_id` record — see `currentEmployeeDriverId`) must see
    // ONLY their own Driver's counts here, exactly like `orders()` and
    // `orderDetail()` already narrow for them. Without this, a Driver User's
    // mobile dashboard leaked full Company-wide totals even though the very
    // same identity's Orders list was already correctly scoped to just their
    // own assignments — the two views disagreed about what this account is.
    // An ordinary Operator (no linked Driver) is completely unaffected:
    // `ownDriverId` is `undefined` and every predicate below is a no-op.
    const ownDriverId = await this.currentEmployeeDriverId();
    const driverScope = sql`(${ownDriverId ?? null}::uuid is null or assigned_driver_id = ${ownDriverId ?? null}::uuid)`;
    const [statusCounts, activeTotal, deliveredToday, returnPending] = await Promise.all([
      sql<OperationsStatusCount>`
        select delivery_status as status, count(*)::int as count
          from orders
         where company_id = ${companyId}::uuid
           and ${driverScope}
         group by delivery_status
      `.execute(this.database),
      sql<{ count: number }>`
        select count(*)::int as count from orders
         where company_id = ${companyId}::uuid
           and delivery_status not in ('hold', 'closed', 'cancelled')
           and ${driverScope}
      `.execute(this.database),
      sql<{ count: number }>`
        select count(*)::int as count from orders
         where company_id = ${companyId}::uuid
           and delivery_status = 'delivered' and delivered_at::date = current_date
           and ${driverScope}
      `.execute(this.database),
      sql<{ count: number }>`
        select count(*)::int as count from orders
         where company_id = ${companyId}::uuid and delivery_status = 'returned_to_branch'
           and ${driverScope}
      `.execute(this.database),
    ]);
    const byStatus: Record<string, number> = Object.fromEntries(
      knownStatuses.map((status) => [status, 0]),
    );
    for (const row of statusCounts.rows) byStatus[row.status] = row.count;
    return {
      activeTotal: activeTotal.rows[0]?.count ?? 0,
      byStatus,
      deliveredToday: deliveredToday.rows[0]?.count ?? 0,
      returnPending: returnPending.rows[0]?.count ?? 0,
    };
  }

  /**
   * Dashboard summary for the authenticated Driver ONLY — every count is
   * scoped to `assigned_driver_id = driver.id`, where `driver` is resolved
   * from the authenticated identity via `driverForAccount` exactly like
   * `driverPortalOrders`/`changeDriverPortalOrderStatus` already do. There is
   * no `driverId` input anywhere in this method's signature — a client can
   * only ever see its own counts, never another Driver's or the Company's.
   *
   * Unlike the Operator summary, "New" (unassigned) Orders are intentionally
   * excluded: an Order not yet assigned to this Driver is not their concern.
   */
  public async driverDashboardSummary(): Promise<OperationsDriverDashboardSummary> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const driver = await this.driverForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    const [statusCounts, deliveredToday] = await Promise.all([
      sql<{ status: string; count: number }>`
        select delivery_status as status, count(*)::int as count
          from orders
         where company_id = ${identity.companyId}::uuid
           and assigned_driver_id = ${driver.id}::uuid
           and delivery_status in ('assigned_to_driver', 'out_for_delivery', 'returned_to_branch')
         group by delivery_status
      `.execute(this.database),
      sql<{ count: number }>`
        select count(*)::int as count from orders
         where company_id = ${identity.companyId}::uuid
           and assigned_driver_id = ${driver.id}::uuid
           and delivery_status = 'delivered' and delivered_at::date = current_date
      `.execute(this.database),
    ]);
    const byStatus: Record<string, number> = {
      assigned_to_driver: 0,
      out_for_delivery: 0,
      returned_to_branch: 0,
    };
    for (const row of statusCounts.rows) byStatus[row.status] = row.count;
    const assignedToMe = byStatus.assigned_to_driver ?? 0;
    const outForDelivery = byStatus.out_for_delivery ?? 0;
    const returnPending = byStatus.returned_to_branch ?? 0;
    return {
      activeTotal: assignedToMe + outForDelivery,
      assignedToMe,
      deliveredToday: deliveredToday.rows[0]?.count ?? 0,
      outForDelivery,
      returnPending,
    };
  }

  /**
   * The Driver this authenticated identity operates as, if any -- resolved
   * ONLY from the explicit `employees.company_user_id` / `drivers.employee_id`
   * chain (never from name, mobile, or email matching). `IdentityContext`
   * already carries `profileType`/`profileId` for a `company_user` session
   * (set at login from `user_business_links`, defaulting to the "employee"
   * profile type -- see `authentication.repository.ts`'s `activeProfile`), so
   * this is a single deterministic lookup, not an inference.
   *
   * Returns `undefined` for every other identity (an ordinary office User
   * with no Driver behind their linked Employee, an Employee that IS a
   * Driver but wasn't yet resolved this way, a Platform Administrator, ...),
   * in which case Orders visibility is completely unchanged -- this never
   * narrows what an Operator/Admin can already see.
   */
  private async currentEmployeeDriverId(): Promise<string | undefined> {
    const identity = this.identities.current();
    if (identity.kind !== "company_user" || identity.profileType !== "employee") {
      return undefined;
    }
    const { companyId } = this.tenants.current();
    const result = await sql<{ id: string }>`
      select id from drivers
       where employee_id = ${identity.profileId ?? null}::uuid and company_id = ${companyId}::uuid
       limit 1
    `.execute(this.database);
    return result.rows[0]?.id;
  }

  public async orders(filters: OperationsOrderFilters = {}): Promise<OperationsOrderPage> {
    const { companyId } = this.tenants.current();
    const search = this.optionalFilter(filters.search);
    const referenceNumber = this.optionalFilter(filters.referenceNumber);
    // Normalised to match how reference_number_normalized is stored, so the
    // deprecated filter reaches the same index the unified search uses.
    const referenceTerm = referenceNumber === null ? null : normalizeReferenceTerm(referenceNumber);
    const serialNumber = this.optionalFilter(filters.serialNumber);
    const serialTerm = serialNumber === null ? null : this.normalizeOrderIdentifier(serialNumber);
    const deliveryStatus = this.optionalFilter(filters.deliveryStatus);
    const orderType = this.optionalFilter(filters.orderType);
    const cashStatus = this.optionalFilter(filters.cashStatus);
    const settlementStatus = this.optionalFilter(filters.settlementStatus);
    const traderId = this.optionalUuidFilter(filters.traderId);
    // A Driver User must see only Orders assigned to them, regardless of
    // which Orders permission their Role happens to grant, and regardless of
    // any `driverId` the client sends -- never let the caller pick someone
    // else's Driver identity to view. Everyone else's behaviour, including
    // the client-supplied `driverId` filter, is completely unchanged.
    const ownDriverId = await this.currentEmployeeDriverId();
    const driverId = ownDriverId ?? this.optionalUuidFilter(filters.driverId);
    const areaId = this.optionalUuidFilter(filters.areaId);
    const emirateId = this.optionalUuidFilter(filters.emirateId);
    const dateFrom = this.optionalDate(filters.dateFrom);
    const dateTo = this.optionalDate(filters.dateTo);
    const quickView = filters.quickView ?? "active";
    const delivery = await this.deliveryActivity(filters);
    const { applied, deliveredOnly } = delivery;
    const page =
      Number.isInteger(filters.page) && (filters.page ?? 0) > 0 ? (filters.page ?? 1) : 1;
    const pageSize = ([25, 50, 100] as const).includes(filters.pageSize ?? 25)
      ? (filters.pageSize ?? 25)
      : 25;
    const offset = (page - 1) * pageSize;
    const sortColumns = {
      amountToCollect: "o.customer_amount_due",
      createdAt: "o.created_at",
      orderDate: "o.order_date",
      orderNumber: "o.order_number",
    } as const;
    const sortColumn = sortColumns[filters.sortBy ?? "orderDate"];
    const sortDirection = filters.sortDirection === "asc" ? "asc" : "desc";
    /* Serial Number is the secondary key, so Orders sharing a date read in
       Serial order instead of by `id` -- which is a random UUID and therefore
       an arbitrary shuffle within each day. `order_date` is a DATE, so on a busy
       day that shuffle was the entire visible ordering.
       Compared NUMERICALLY: the digits are extracted and cast, because
       lexically '10' sorts before '9'. Delivery Activity already does this to
       its Order Number for the same reason.

       ALWAYS ascending, deliberately, even when the date sorts descending: the
       newest day belongs at the top, but within that day the Orders should read
       in the sequence they were raised -- 1, 2, 3 -- which is how an operator
       works through them. `id` stays as the final key: without a unique
       tie-break, offset pagination can repeat one row and skip another. */
    const serialSortKey = "nullif(regexp_replace(o.serial_number,'[^0-9]','','g'),'')::bigint";
    const quickViewPredicate = sql`
      (${quickView} = 'all'
        or (${quickView} = 'active' and o.delivery_status in ('new','in_branch','assigned_to_driver','out_for_delivery','hold','delivered','returned_to_branch','returned_to_trader','collect_order'))
        or (${quickView} = 'closed' and o.delivery_status = 'closed')
        or (${quickView} = 'hold' and o.delivery_status = 'hold')
        or (${quickView} = 'cancelled' and o.delivery_status = 'cancelled')
        or (${quickView} = 'accountant'
          and o.delivery_status = 'delivered'
          and (
            o.driver_reconciliation_status = 'pending'
            or (
              o.driver_reconciliation_status in ('reconciled', 'not_applicable')
              and o.trader_net_payable > 0
              and o.trader_settlement_status in ('unsettled', 'partially_settled')
            )
            or (
              o.driver_reconciliation_status in ('reconciled', 'not_applicable')
              and o.trader_settlement_status = 'money_sent_to_trader'
              and 1 = (
                select count(*)
                from trader_settlement_orders accountant_tso
                join trader_settlements accountant_s
                  on accountant_s.id = accountant_tso.settlement_id
                 and accountant_s.company_id = accountant_tso.company_id
                where accountant_tso.company_id = o.company_id
                  and accountant_tso.order_id = o.id
                  and accountant_s.reversal_of_id is null
                  and accountant_s.status = 'confirmed'
                  and not exists (
                    select 1
                    from trader_settlements accountant_reversal
                    where accountant_reversal.company_id = accountant_s.company_id
                      and accountant_reversal.reversal_of_id = accountant_s.id
                  )
              )
            )
          )
        ))
    `;
    const tabPredicate = sql`
      ${quickViewPredicate}
      and (${ownDriverId}::uuid is null or o.assigned_driver_id = ${ownDriverId}::uuid)
      and (${deliveredOnly} = false or o.delivered_at is not null)
    `;
    const filterPredicate = sql`
      ${tabPredicate}
      -- Deprecated dedicated Reference filter, kept for callers that still send
      -- it; the web no longer renders a field for it. Now matched against the
      -- normalised column so it uses the trigram index instead of scanning, and
      -- leading zeros in values like '000123' still survive because the
      -- normalisation lower-cases and trims but never casts to a number.
      and (${referenceTerm}::text is null
           or o.reference_number_normalized like '%' || ${referenceTerm}::text || '%')
      and (${serialTerm}::text is null
           or o.serial_number_normalized = ${serialTerm}::text)
      and ${unifiedOrderSearchPredicate(search)}
      and (${deliveryStatus}::text is null or o.delivery_status = ${deliveryStatus})
      and (${orderType}::text is null or o.order_type = ${orderType})
      and (${cashStatus}::text is null or o.driver_reconciliation_status = ${cashStatus})
      and (${settlementStatus}::text is null or o.trader_settlement_status = ${settlementStatus})
      and (${traderId}::uuid is null or o.trader_id = ${traderId}::uuid)
      and (${driverId}::uuid is null or o.assigned_driver_id = ${driverId}::uuid)
      and (${areaId}::uuid is null or o.area_id = ${areaId}::uuid)
      -- Through the Area the Order already joins, so no extra join is needed and
      -- the existing access path is unchanged. Selecting an Emirate used to
      -- narrow only the Area picker and filtered nothing.
      and (${emirateId}::uuid is null or a.emirate_id = ${emirateId}::uuid)
      and (${dateFrom}::date is null or o.order_date >= ${dateFrom}::date)
      and (${dateTo}::date is null or o.order_date <= ${dateTo}::date)
      -- Delivery Activity. One shared fragment, so the list, the count and the
      -- export cannot drift apart. Matches everything when it is off.
      and ${delivery.predicate}
    `;
    const result = await sql<OperationsOrder>`
      select o.id,
             o.order_number as "orderNumber",
             o.serial_number as "serialNumber",
             o.reference_number as "referenceNumber",
             o.order_date::text as "orderDate",
             t.name_en as "traderName",
             a.name_en as "areaNameEn",
             a.name_ar as "areaNameAr",
             coalesce(o.customer_area_name_ar_snapshot,a.name_ar,
                      o.customer_area_name_snapshot,a.name_en) as "areaName",
             o.assigned_driver_id as "assignedDriverId",
             /* Identifier only, so the workflow guidance can prefilter the
                Trader Settlement screen. No financial column is added. */
             o.trader_id as "traderId",
             d.name_en as "assignedDriverName",
             d.mobile_number as "assignedDriverMobile",
             o.customer_name as "customerName",
             o.customer_address as "customerAddress",
             o.customer_mobile_number as "customerMobileNumber",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.service_fee_vat_amount::text as "serviceFeeVatAmount",
             o.additional_fees::text as "additionalFees",
             o.additional_fee_vat_amount::text as "additionalFeeVatAmount",
             o.total_deductions::text as "totalDeductions",
             o.trader_net_payable::text as "traderNetPayable",
             o.customer_amount_due::text as "customerAmountDue",
             o.amount_collected::text as "amountCollected",
             o.is_free_order as "isFreeOrder",
             o.order_type as "orderType",
             o.vat_amount::text as "vatAmount",
             o.company_revenue::text as "companyRevenue",
             o.order_profit::text as "orderProfit",
             o.delivery_status as "deliveryStatus",
             o.driver_reconciliation_status as "driverReconciliationStatus",
             o.trader_settlement_status as "traderSettlementStatus",
             case
               when d.id is null or d.driver_type <> 'outsourced' then 'not_required'
               when o.delivery_status <> 'delivered' then 'pending_delivery'
               when fee.id is null then 'missing_accrual'
               when fee.status = 'accrued' then 'unpaid'
               else fee.status
             end as "outsourcedDriverFeeStatus",
             fee.earned_amount::text as "outsourcedDriverFeeAmount",
             fee.paid_amount::text as "outsourcedDriverFeePaid",
             fee.outstanding_amount::text as "outsourcedDriverFeeOutstanding",
             fee_payments.payment_numbers as "outsourcedDriverFeePaymentNumbers",
             o.return_status as "returnStatus",
             o.delivered_at::text as "deliveredAt",
             /* Authoritative Accounting state for this Order.

                Derived from the Accounting Event and its Journal rather than
                predicted from the Order's own money fields: an Order that is
                "Accounting Required" tells you an Event SHOULD exist, never
                that one did post. The lateral below is the ledger's answer. */
             /* Receipt-confirmation target for this Order.

                Settlement-level, because that is what the confirmation action
                takes: confirmMoneyReceived(settlementId). There is deliberately
                NO paymentId here -- one settlement carries many payment rows and
                none of them is a confirmation target. */
             coalesce(receipt.confirmable_count, 0) as "confirmableSettlementCount",
             case
               when receipt.confirmable_count = 1 then receipt.settlement_id
             end as "confirmableSettlementId",
             coalesce(acct.state, 'accounting_event_missing') as "accountingState",
             acct.event_id as "accountingEventId",
             acct.journal_id as "accountingJournalId"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      left join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
      left join outsourced_driver_fee_accruals fee
        on fee.order_id = o.id and fee.company_id = o.company_id
      /* ONE set-based lateral for the whole page, not a lookup per row: the
         planner runs it as part of this single query, so adding it cannot
         introduce an N+1 no matter how many Orders are returned.

         The ordering below takes the CURRENT Event. An Order
         can accumulate several (a reversal raises another), and the newest is
         the one whose state the operator has to act on.

         The classification order matters. A duplicate is reported as a
         duplicate even though it also lands in the failed status, and a
         mapping block is named as such rather than as a generic failure --
         each one sends the operator to a different screen. */
      /* ONE set-based lateral, evaluated as part of this single page query.

         The eligibility test mirrors the service's own guard in
         confirmMoneyReceived (trader-settlement.service.ts): a settlement can
         receive a Money Received confirmation only when it is NOT itself a
         reversal record, its status is 'confirmed' (money sent), and no
         reversal of it exists. Those three conditions are restated here rather
         than reinvented, so the count can never disagree with what the action
         would accept.

         The minimum id is read ONLY when the count is exactly one, so it never
         picks a winner among several -- ambiguity is reported, not resolved. */
      left join lateral (
        select
          count(*)::int as confirmable_count,
          min(s.id::text) as settlement_id
        from trader_settlement_orders tso
        join trader_settlements s
          on s.id = tso.settlement_id and s.company_id = tso.company_id
        where tso.company_id = o.company_id
          and tso.order_id = o.id
          -- Only an Order actually awaiting receipt has a confirmable target.
          and o.trader_settlement_status = 'money_sent_to_trader'
          and s.status = 'confirmed'
          and s.reversal_of_id is null
          and not exists (
            select 1
            from trader_settlements r
            where r.company_id = s.company_id and r.reversal_of_id = s.id
          )
      ) receipt on true
      left join lateral (
        select
          e.id as event_id,
          j.id as journal_id,
          case
            when e.error_code is not null and e.error_code like '%duplicate%'
              then 'accounting_blocked_duplicate'
            when e.processing_status = 'blocked_period' or e.failure_category = 'period'
              then 'accounting_blocked_closed_period'
            when e.processing_status = 'blocked_configuration'
              or e.failure_category = 'configuration'
              then 'accounting_blocked_missing_mapping'
            when e.processing_status = 'failed' then 'accounting_event_failed'
            when e.processing_status in ('received', 'validated', 'processing', 'retry_pending')
              then 'accounting_event_waiting'
            when e.processing_status = 'posted' and j.status = 'posted' then 'journal_posted'
            when e.processing_status = 'posted' and j.id is not null then 'journal_pending'
            when e.processing_status = 'posted' then 'accounting_event_posted'
            else 'accounting_event_waiting'
          end as state
        from accounting_events e
        left join journal_entries j on j.id = e.journal_id and j.company_id = e.company_id
        where e.company_id = o.company_id
          and e.source_entity_type = 'order'
          and e.source_entity_id = o.id
        order by e.created_at desc
        limit 1
      ) acct on true
      left join lateral (
        select string_agg(payments.payment_number, ', ' order by payments.payment_number) as payment_numbers
        from (
          select distinct p.payment_number
          from outsourced_driver_fee_payment_allocations pa
          join outsourced_driver_fee_payments p
            on p.id = pa.payment_id and p.company_id = pa.company_id
          where pa.company_id = o.company_id
            and pa.accrual_id = fee.id
            and pa.reversed_at is null
            and p.status = 'confirmed'
        ) payments
      ) fee_payments on true
      where o.company_id = ${companyId}::uuid
        and ${filterPredicate}
      order by ${
        delivery.order ??
        sql`${sql.raw(sortColumn)} ${sql.raw(sortDirection)},
            ${sql.raw(serialSortKey)} asc nulls last,
            o.id ${sql.raw(sortDirection)}`
      }
      limit ${pageSize} offset ${offset}
    `.execute(this.database);
    const counts = await sql<{ matchingCount: number; tabTotalCount: number }>`
      select
        count(*) filter (where ${filterPredicate})::int as "matchingCount",
        count(*) filter (where ${tabPredicate})::int as "tabTotalCount"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      -- The shared filter predicate reaches the Emirate through the Area, so
      -- the count must join it too. Both queries use the same predicate; only
      -- one of them joining is how the Emirate filter broke the whole list.
      left join areas a on a.id = o.area_id and a.company_id = o.company_id
      where o.company_id = ${companyId}::uuid
    `.execute(this.database);
    // ONE Business Day configuration query for the whole page. Calling the
    // resolver per Order would be an N+1; deriving the date in SQL would
    // restate the business-day rule in a second language.
    const deliveryBusinessDates = deliveredOnly
      ? await this.businessDays.businessDatesFor(result.rows.map((row) => row.deliveredAt))
      : undefined;
    /* Workflow guidance is derived per row from columns this select ALREADY
       returns -- no extra query, no join, no per-row lookup. See
       `order-workflow-guidance.ts`; the four persisted statuses stay
       authoritative and nothing here is written back. */
    const items = result.rows.map((row) => ({
      ...row,
      ...(deliveryBusinessDates === undefined
        ? {}
        : {
            // Only from delivered_at. Never created_at, never order_date.
            deliveryBusinessDate:
              row.deliveredAt == null ? null : (deliveryBusinessDates.get(row.deliveredAt) ?? null),
          }),
      workflowGuidance: deriveOrderWorkflowGuidance({
        accountingRequired: row.accountingRequired === true,
        accountingEventId: row.accountingEventId ?? null,
        accountingJournalId: row.accountingJournalId ?? null,
        accountingState: row.accountingState ?? null,
        confirmableSettlementCount: row.confirmableSettlementCount ?? 0,
        confirmableSettlementId: row.confirmableSettlementId ?? null,
        assignedDriverId: row.assignedDriverId ?? null,
        customerAmountDue: row.customerAmountDue,
        deliveryStatus: row.deliveryStatus,
        driverReconciliationStatus: row.driverReconciliationStatus,
        isFreeOrder: row.isFreeOrder === true,
        orderId: row.id,
        orderNumber: row.orderNumber,
        returnStatus: row.returnStatus ?? null,
        traderId: row.traderId ?? "",
        traderNetPayable: row.traderNetPayable,
        traderSettlementStatus: row.traderSettlementStatus,
      }),
    }));
    return {
      ...(applied === undefined ? {} : { appliedDateMode: applied }),
      filteredCount: counts.rows[0]?.matchingCount ?? 0,
      matchingCount: counts.rows[0]?.matchingCount ?? 0,
      items,
      page,
      pageSize,
      totalCount: counts.rows[0]?.tabTotalCount ?? 0,
      tabTotalCount: counts.rows[0]?.tabTotalCount ?? 0,
    };
  }

  /**
   * The Delivery Activity predicate and ordering, built once and shared by the
   * list, the count and the export.
   *
   * Three copies of this would eventually disagree, and the disagreement would
   * be an export that does not match the screen it came from - the exact defect
   * the temporary 501 refusal existed to prevent.
   *
   * Everything it returns is inert when Delivery Activity is off, so the
   * Active/All/Hold/Cancelled/Closed views and every ordinary export keep their
   * existing behaviour untouched.
   */
  private async deliveryActivity(filters: OperationsOrderFilters): Promise<{
    readonly applied: AppliedReportDateMode | undefined;
    readonly deliveredOnly: boolean;
    readonly order: ReturnType<typeof sql> | null;
    readonly predicate: ReturnType<typeof sql>;
  }> {
    const deliveredOnly = filters.deliveredOnly === true;
    // Business Date is refused outside Delivery Activity rather than ignored:
    // an Orders list has no authoritative operational instant, so answering
    // would be answering a different question.
    if (!deliveredOnly && filters.dateMode === "business_date") {
      throw new ApplicationException(
        "report_date_mode_not_supported",
        "Business Date mode applies to Delivery Activity only",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (!deliveredOnly) {
      return { applied: undefined, deliveredOnly, order: null, predicate: sql`true` };
    }
    // One resolution per request: one configuration query, boundaries computed
    // once, and the same object feeds rows, count and export.
    const applied = await this.reportDateModes.resolve("order-delivery-activity", {
      businessDateFrom: filters.businessDateFrom,
      businessDateTo: filters.businessDateTo,
      dateMode: filters.dateMode,
    });
    const timezone = applied.timezone ?? (await this.companyTimezone());
    const from = this.optionalDate(filters.deliveryDateFrom);
    const to = this.optionalDate(filters.deliveryDateTo);
    // Business Date compares the raw timestamp against UTC bounds, so no
    // function wraps the indexed column there.
    const businessDate =
      applied.dateMode === "business_date"
        ? this.reportDateModes.predicate("o.delivered_at", applied)
        : sql`true`;
    return {
      applied,
      deliveredOnly,
      // Two Orders delivered in the same second must land in a fixed order, or
      // offset pagination can repeat one row and skip another. Order Number is
      // compared NUMERICALLY - lexically ORD-9 sorts after ORD-10 - with the id
      // as the guaranteed-unique final key.
      order:
        filters.sortBy === undefined
          ? sql`o.delivered_at desc nulls last,
              nullif(regexp_replace(o.order_number,'[^0-9]','','g'),'')::bigint desc nulls last,
              o.id desc`
          : null,
      // Calendar Date reads the COMPANY-LOCAL date of the delivery instant. A
      // UTC date would put deliveries before 04:00 Dubai on the previous day.
      predicate: sql`(
        o.delivered_at is not null
        and (${from}::date is null
             or (o.delivered_at at time zone ${timezone})::date >= ${from}::date)
        and (${to}::date is null
             or (o.delivered_at at time zone ${timezone})::date <= ${to}::date)
        and ${businessDate}
      )`,
    };
  }

  /** Company timezone for Calendar Date mode. One row, cached by Postgres. */
  private async companyTimezone(): Promise<string> {
    const { companyId } = this.tenants.current();
    const result = await sql<{ timezone: string }>`
      select timezone from company_settings where company_id = ${companyId}::uuid
    `.execute(this.database);
    return result.rows[0]?.timezone ?? "Asia/Dubai";
  }

  public async exportOrders(filters: OperationsOrderFilters = {}): Promise<OperationsExportFile> {
    const { companyId } = this.tenants.current();
    // Same shared fragment the list and count use, so the exported rows are
    // exactly the rows the operator saw.
    const delivery = await this.deliveryActivity(filters);
    const search = this.optionalFilter(filters.search);
    const referenceNumber = this.optionalFilter(filters.referenceNumber);
    // Normalised to match how reference_number_normalized is stored, so the
    // deprecated filter reaches the same index the unified search uses.
    const referenceTerm = referenceNumber === null ? null : normalizeReferenceTerm(referenceNumber);
    const serialNumber = this.optionalFilter(filters.serialNumber);
    const serialTerm = serialNumber === null ? null : this.normalizeOrderIdentifier(serialNumber);
    const deliveryStatus = this.optionalFilter(filters.deliveryStatus);
    const cashStatus = this.optionalFilter(filters.cashStatus);
    const settlementStatus = this.optionalFilter(filters.settlementStatus);
    const traderId = this.optionalUuidFilter(filters.traderId);
    const driverId = this.optionalUuidFilter(filters.driverId);
    const areaId = this.optionalUuidFilter(filters.areaId);
    const emirateId = this.optionalUuidFilter(filters.emirateId);
    const dateFrom = this.optionalDate(filters.dateFrom);
    const dateTo = this.optionalDate(filters.dateTo);
    const result = await sql<
      OperationsOrder & {
        readonly exportedAt: string;
      }
    >`
      select o.id,
             o.order_number as "orderNumber",
             o.serial_number as "serialNumber",
             o.reference_number as "referenceNumber",
             o.order_date::text as "orderDate",
             t.name_en as "traderName",
             a.name_en as "areaNameEn",
             a.name_ar as "areaNameAr",
             coalesce(o.customer_area_name_ar_snapshot,a.name_ar,
                      o.customer_area_name_snapshot,a.name_en) as "areaName",
             o.assigned_driver_id as "assignedDriverId",
             d.name_en as "assignedDriverName",
             d.mobile_number as "assignedDriverMobile",
             o.customer_name as "customerName",
             o.customer_address as "customerAddress",
             o.customer_mobile_number as "customerMobileNumber",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.service_fee_vat_amount::text as "serviceFeeVatAmount",
             o.additional_fees::text as "additionalFees",
             o.additional_fee_vat_amount::text as "additionalFeeVatAmount",
             o.total_deductions::text as "totalDeductions",
             o.trader_net_payable::text as "traderNetPayable",
             o.customer_amount_due::text as "customerAmountDue",
             o.amount_collected::text as "amountCollected",
             o.vat_amount::text as "vatAmount",
             o.company_revenue::text as "companyRevenue",
             o.order_profit::text as "orderProfit",
             o.delivery_status as "deliveryStatus",
             o.driver_reconciliation_status as "driverReconciliationStatus",
             o.trader_settlement_status as "traderSettlementStatus",
             now()::text as "exportedAt"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      left join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
      where o.company_id = ${companyId}::uuid
        -- The same two fragments as the list, so an export reproduces exactly
        -- what the operator saw on screen.
      and (${referenceTerm}::text is null
             or o.reference_number_normalized like '%' || ${referenceTerm}::text || '%')
        and (${serialTerm}::text is null
             or o.serial_number_normalized = ${serialTerm}::text)
        and ${unifiedOrderSearchPredicate(search)}
        and (${deliveryStatus}::text is null or o.delivery_status = ${deliveryStatus})
        and (${cashStatus}::text is null or o.driver_reconciliation_status = ${cashStatus})
        and (${settlementStatus}::text is null or o.trader_settlement_status = ${settlementStatus})
        and (${traderId}::uuid is null or o.trader_id = ${traderId}::uuid)
        and (${driverId}::uuid is null or o.assigned_driver_id = ${driverId}::uuid)
        and (${areaId}::uuid is null or o.area_id = ${areaId}::uuid)
        and (${emirateId}::uuid is null or a.emirate_id = ${emirateId}::uuid)
        and (${dateFrom}::date is null or o.order_date >= ${dateFrom}::date)
        and (${dateTo}::date is null or o.order_date <= ${dateTo}::date)
        and ${delivery.predicate}
      order by ${delivery.order ?? sql`o.order_date desc, o.created_at desc, o.order_number`}
      limit 5000
    `.execute(this.database);
    const content = this.toCsv([
      [
        "serial_number",
        "reference_number",
        "order_number",
        "order_date",
        "trader",
        "area",
        "driver",
        "customer",
        "customer_mobile",
        "customer_address",
        "cod_amount",
        "service_fee",
        "service_fee_vat",
        "additional_fees",
        "additional_fee_vat",
        "total_deductions",
        "vat_amount",
        "customer_due",
        "company_revenue",
        "profit",
        "delivery_status",
        "cash_status",
        "settlement_status",
      ],
      ...result.rows.map((order) => [
        order.serialNumber ?? "",
        order.referenceNumber ?? "",
        order.orderNumber,
        order.orderDate,
        order.traderName,
        order.areaName,
        order.assignedDriverName ?? "",
        order.customerName,
        order.customerMobileNumber,
        order.customerAddress,
        order.codAmount,
        order.serviceFee,
        order.serviceFeeVatAmount ?? "",
        order.additionalFees ?? "",
        order.additionalFeeVatAmount ?? "",
        order.totalDeductions ?? "",
        order.vatAmount,
        order.customerAmountDue,
        order.companyRevenue,
        order.orderProfit,
        order.deliveryStatus,
        order.driverReconciliationStatus,
        order.traderSettlementStatus,
      ]),
    ]);
    return {
      content,
      contentType: "text/csv",
      filename: `blueline-orders-${new Date().toISOString().slice(0, 10)}.csv`,
    };
  }

  public async billingSummary(): Promise<OperationsBillingSummary> {
    const { companyId } = this.tenants.current();
    const result = await sql<OperationsBillingSummary>`
      with current_period as (
        select date_trunc('month', current_date)::date as period_start
      )
      select
        cp.period_start::text as "currentPeriodStart",
        count(e.id)::int as "billableOrders",
        max(e.occurred_at)::text as "lastUsageAt",
        'Commercial setup pending'::text as "commercialStatus",
        'Manual agreement'::text as "planName"
      from current_period cp
      left join saas_usage_events e
        on e.company_id = ${companyId}::uuid
       and e.billing_period_start = cp.period_start
      group by cp.period_start
    `.execute(this.database);
    return (
      result.rows[0] ?? {
        billableOrders: 0,
        commercialStatus: "Commercial setup pending",
        currentPeriodStart: new Date().toISOString().slice(0, 8) + "01",
        lastUsageAt: null,
        planName: "Manual agreement",
      }
    );
  }

  public async orderDetail(orderId: string): Promise<OperationsOrderDetail> {
    const { companyId } = this.tenants.current();
    // `orders()` (the list) already scopes to the caller's own Driver id when
    // one is resolved -- but this single-Order lookup is reachable by the
    // SAME `orders.*` permissions and takes an arbitrary id, so without this
    // check a Driver could read any other Order in the Company by guessing/
    // iterating ids, bypassing the list scoping entirely. Same fate as a
    // truly nonexistent Order (`order_not_found`), not a distinct 403 --
    // this never confirms to the caller that a Order they cannot see exists.
    const ownDriverId = await this.currentEmployeeDriverId();
    const order = await this.orderById(companyId, orderId);
    if (ownDriverId !== undefined && order.assignedDriverId !== ownDriverId) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    const [history, attachments, internationalShipment, metadata, events] = await Promise.all([
      sql<OperationsOrderDetail["history"][number]>`
        select h.status_dimension as "statusDimension",
               h.from_status as "fromStatus",
               h.to_status as "toStatus",
               h.reason,
               h.occurred_at::text as "occurredAt",
               a.username as "changedBy"
        from order_status_history h
        join accounts a on a.id = h.changed_by_account_id and a.company_id = h.company_id
        where h.company_id = ${companyId}::uuid and h.order_id = ${orderId}::uuid
        order by h.occurred_at, h.id
      `.execute(this.database),
      this.orderAttachments(companyId, orderId),
      this.internationalShipment(companyId, orderId),
      sql<OperationsOrderDetail["metadata"]>`
        select o.created_at::text as "createdAt", creator.username as "createdBy",
               o.customer_second_mobile_number as "customerSecondMobileNumber",
               o.package_count as "packageCount", o.notes, o.payment_condition as "paymentCondition",
               o.trader_net_payable::text as "traderNetPayable",
               o.driver_cost::text as "driverCost", o.return_driver_fee::text as "returnDriverFee",
               o.order_expenses_total::text as "orderExpensesTotal",
               o.operational_completed_at::text as "operationalCompletedAt",
               o.closed_at::text as "closedAt"
        from orders o
        join accounts creator on creator.id = o.created_by_account_id
          and creator.company_id = o.company_id
        where o.company_id = ${companyId}::uuid and o.id = ${orderId}::uuid
      `.execute(this.database),
      sql<OperationsOrderDetail["events"][number]>`
        select e.id, e.event_type as "eventType", e.event_category as category,
               e.field_name as "fieldName", e.previous_value as "previousValue",
               e.new_value as "newValue", coalesce(a.username, 'System') as actor,
               e.actor_role as "actorRole", e.source, e.reason,
               e.correlation_id as "correlationId", e.occurred_at::text as "occurredAt"
        from order_events e
        left join accounts a on a.id = e.actor_account_id and a.company_id = e.company_id
        where e.company_id = ${companyId}::uuid and e.order_id = ${orderId}::uuid
        order by e.occurred_at desc, e.id desc
      `.execute(this.database),
    ]);
    const detailMetadata = metadata.rows[0];
    if (detailMetadata === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    return {
      ...order,
      attachments,
      events: events.rows,
      history: history.rows,
      internationalShipment,
      metadata: detailMetadata,
    };
  }

  public async orderDetailByNumber(orderNumber: string): Promise<OperationsOrderDetail> {
    const { companyId } = this.tenants.current();
    const normalized = orderNumber.trim();
    const result = await sql<{ id: string }>`
      select id from orders
      where company_id = ${companyId}::uuid and order_number = ${normalized}
      limit 1
    `.execute(this.database);
    const orderId = result.rows[0]?.id;
    if (orderId === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    return this.orderDetail(orderId);
  }

  public async registerInternationalShipment(
    orderId: string,
    input: RegisterInternationalShipmentDto,
    correlationId: string,
  ): Promise<OperationsInternationalShipment> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const providerName = input.providerName.trim();
    const currentStatus = input.currentStatus.trim();
    if (providerName.length === 0 || currentStatus.length === 0) {
      throw new ApplicationException(
        "international_shipment_invalid",
        "Provider and current status are required",
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.transactions.execute(async (transaction) => {
      const order = await sql<{ assignedDriverId: string | null; orderNumber: string }>`
        select assigned_driver_id as "assignedDriverId", order_number as "orderNumber"
        from orders
        where id = ${orderId}::uuid and company_id = ${companyId}::uuid
        for update
      `.execute(transaction);
      const orderRow = order.rows[0];
      if (orderRow === undefined) {
        throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
      }
      if (orderRow.assignedDriverId !== null) {
        throw new ApplicationException(
          "international_order_has_driver",
          "Remove the internal driver before registering an international shipment",
          HttpStatus.CONFLICT,
        );
      }
      const provider = await this.upsertThirdPartyDeliveryCompany(
        transaction,
        companyId,
        providerName,
      );
      await sql`
        update orders
           set delivery_mode = 'international',
               updated_at = now(),
               version = version + 1
         where id = ${orderId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await sql`
        insert into international_shipments (
          company_id, order_id, third_party_delivery_company_id, provider_reference_number,
          destination_country_code, international_delivery_cost, customer_charge,
          shipment_date, current_status, notes
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, ${provider.id}::uuid,
          ${input.providerReferenceNumber?.trim() ?? null}, ${input.destinationCountryCode},
          ${input.internationalDeliveryCost}, ${input.customerCharge}, current_date,
          ${currentStatus}, ${input.notes?.trim() ?? null}
        )
        on conflict (order_id)
        do update set third_party_delivery_company_id = excluded.third_party_delivery_company_id,
                      provider_reference_number = excluded.provider_reference_number,
                      destination_country_code = excluded.destination_country_code,
                      international_delivery_cost = excluded.international_delivery_cost,
                      customer_charge = excluded.customer_charge,
                      current_status = excluded.current_status,
                      notes = excluded.notes,
                      updated_at = now(),
                      version = international_shipments.version + 1
      `.execute(transaction);
      await this.audit(transaction, {
        action: "international_shipment.register",
        actorId: identity.identityId,
        after: {
          currentStatus,
          destinationCountryCode: input.destinationCountryCode,
          orderNumber: orderRow.orderNumber,
          providerName,
        },
        companyId,
        correlationId,
        subjectId: orderId,
        subjectType: "order",
      });
    });
    const shipment = await this.internationalShipment(companyId, orderId);
    if (shipment === null) {
      throw new Error("Registered international shipment could not be loaded");
    }
    return shipment;
  }

  public async registerOrderAttachment(
    orderId: string,
    input: RegisterOrderAttachmentDto,
    correlationId: string,
  ): Promise<OperationsOrderAttachment> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const fileName = input.fileName.trim();
    const mediaType = input.mediaType.trim().toLowerCase();
    if (fileName.length === 0 || mediaType.length === 0) {
      throw new ApplicationException(
        "attachment_invalid",
        "The attachment file name and media type are required",
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.orderById(companyId, orderId);
    const attachmentId = await this.transactions.execute(async (transaction) => {
      const file = await sql<{ id: string }>`
        insert into file_objects (
          company_id, storage_provider, storage_key, original_filename, media_type,
          size_bytes, classification, scan_status, uploaded_by_account_id
        ) values (
          ${companyId}::uuid, 'registered', ${`orders/${companyId}/${orderId}/${randomUUID()}/${fileName}`},
          ${fileName}, ${mediaType}, ${input.sizeBytes}, 'private', 'pending',
          ${identity.identityId}::uuid
        )
        returning id
      `.execute(transaction);
      const fileId = file.rows[0]?.id;
      if (fileId === undefined) {
        throw new Error("Attachment file metadata did not return an identifier");
      }
      const attachment = await sql<{ id: string }>`
        insert into order_attachments (
          company_id, order_id, file_object_id, attachment_type, uploaded_by_account_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, ${fileId}::uuid,
          ${input.attachmentType}, ${identity.identityId}::uuid
        )
        returning id
      `.execute(transaction);
      const createdId = attachment.rows[0]?.id;
      if (createdId === undefined) {
        throw new Error("Order attachment creation did not return an identifier");
      }
      await this.audit(transaction, {
        action: "order_attachment.register",
        actorId: identity.identityId,
        after: {
          attachmentType: input.attachmentType,
          fileName,
          mediaType,
          sizeBytes: input.sizeBytes,
        },
        companyId,
        correlationId,
        subjectId: orderId,
        subjectType: "order",
      });
      return createdId;
    });
    const attachment = (await this.orderAttachments(companyId, orderId)).find(
      (item) => item.id === attachmentId,
    );
    if (attachment === undefined) {
      throw new Error("Created order attachment could not be loaded");
    }
    return attachment;
  }

  public async createTrackingLink(
    orderId: string,
    correlationId: string,
  ): Promise<OperationsTrackingLink> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const order = await this.orderById(companyId, orderId);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await this.transactions.execute(async (transaction) => {
      await sql`
        insert into tracking_tokens (company_id, order_id, token_hash, expires_at)
        values (${companyId}::uuid, ${orderId}::uuid, ${tokenHash}, ${expiresAt})
      `.execute(transaction);
      await this.audit(transaction, {
        action: "tracking_link.create",
        actorId: identity.identityId,
        after: { expiresAt: expiresAt.toISOString(), orderNumber: order.orderNumber },
        companyId,
        correlationId,
        subjectId: orderId,
        subjectType: "order",
      });
    });
    return { expiresAt: expiresAt.toISOString(), token, url: `/track/${token}` };
  }

  public async publicTracking(token: string): Promise<PublicOrderTracking> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new ApplicationException(
        "tracking_not_found",
        "Tracking information was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const result = await sql<PublicOrderTracking & { readonly trackingTokenId: string }>`
      select tt.id as "trackingTokenId",
             c.name_en as "companyName",
             o.order_number as "orderNumber",
             o.customer_name as "customerName",
             coalesce(o.customer_area_name_ar_snapshot,a.name_ar,
                      o.customer_area_name_snapshot,a.name_en) as "areaName",
             d.name_en as "assignedDriverName",
             o.delivery_status as "deliveryStatus",
             o.delivered_at::text as "deliveredAt",
             greatest(o.updated_at, coalesce(max(h.occurred_at), o.updated_at))::text as "lastUpdatedAt"
      from tracking_tokens tt
      join orders o on o.id = tt.order_id and o.company_id = tt.company_id
      join companies c on c.id = tt.company_id and c.status = 'active'
      left join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
      left join order_status_history h on h.order_id = o.id and h.company_id = o.company_id
      where tt.token_hash = ${tokenHash}
        and tt.revoked_at is null
        and (tt.expires_at is null or tt.expires_at > now())
      group by tt.id, c.name_en, o.id, a.name_en, a.name_ar, d.name_en
      limit 1
    `.execute(this.database);
    const tracking = result.rows[0];
    if (tracking === undefined) {
      throw new ApplicationException(
        "tracking_not_found",
        "Tracking information was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    await sql`
      insert into tracking_access_events (company_id, tracking_token_id, response_status)
      values (
        (select company_id from tracking_tokens where id = ${tracking.trackingTokenId}::uuid),
        ${tracking.trackingTokenId}::uuid,
        200
      )
    `.execute(this.database);
    await sql`
      update tracking_tokens
         set last_accessed_at = now()
       where id = ${tracking.trackingTokenId}::uuid
    `.execute(this.database);
    const { trackingTokenId: _trackingTokenId, ...publicTracking } = tracking;
    void _trackingTokenId;
    return publicTracking;
  }

  public async traderPortalProfile(): Promise<TraderPortalProfile> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const trader = await this.traderForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    const result = await sql<TraderPortalProfile>`
      select t.id, t.code, t.name_en as name, t.name_ar as "nameAr",
             t.mobile_number as "mobileNumber", t.telephone, t.email,
             t.contact_person as "contactPerson", t.commercial_number as "commercialNumber",
             coalesce(a.preferred_language, 'en') as "preferredLanguage",
             c.mobile_code as "companyMobileCode"
        from traders t
        join companies c on c.id = t.company_id
        left join accounts a on a.id = ${identity.identityId}::uuid
       where t.id=${trader.id}::uuid and t.company_id=${identity.companyId}::uuid
       limit 1
    `.execute(this.database);
    return result.rows[0]!;
  }

  /**
   * Fields a Trader may edit about itself from the portal.
   *
   * The primary login mobile and Trader name are deliberately absent: §42 of
   * the workspace prompt treats them as identity-sensitive and defers a
   * verification flow to a later prompt, rather than letting a Trader quietly
   * change the number Delivery Orders and settlements already reference.
   */
  public async updateTraderPortalProfile(input: {
    readonly commercialNumber?: string | null;
    readonly contactPerson?: string | null;
    readonly email?: string | null;
    readonly preferredLanguage?: string;
    readonly telephone?: string | null;
  }): Promise<TraderPortalProfile> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const trader = await this.traderForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    await this.transactions.execute(async (transaction) => {
      await sql`
        update traders set
          contact_person = ${input.contactPerson === undefined ? sql`contact_person` : input.contactPerson},
          telephone = ${input.telephone === undefined ? sql`telephone` : input.telephone},
          email = ${input.email === undefined ? sql`email` : input.email},
          commercial_number =
            ${input.commercialNumber === undefined ? sql`commercial_number` : input.commercialNumber},
          updated_at = now(), version = version + 1
        where id = ${trader.id}::uuid and company_id = ${identity.companyId}::uuid
      `.execute(transaction);
      if (input.preferredLanguage !== undefined) {
        await sql`
          update accounts set preferred_language = ${input.preferredLanguage}, updated_at = now()
           where id = ${identity.identityId}::uuid
        `.execute(transaction);
      }
    });
    return this.traderPortalProfile();
  }

  /**
   * The Trader's own Dashboard.
   *
   * Reports the Trader's EXISTING Delivery Orders (this Company context's
   * `orders` rows) alongside a read-only Commerce summary. It does not invent
   * a Store Order concept — that domain does not exist yet, and this Dashboard
   * is explicit that "Orders" here means Delivery Orders. When the Store Order
   * domain lands, its KPIs are added beside these, not blended into them.
   */
  public async traderPortalDashboard(): Promise<TraderPortalDashboard> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const trader = await this.traderForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );

    const orderCounts = await sql<{
      active: string;
      cancelled: string;
      delivered: string;
      newOrders: string;
      returned: string;
      total: string;
    }>`
      select
        count(*) filter (where delivery_status = 'new') as "newOrders",
        count(*) filter (
          where delivery_status in ('in_branch', 'assigned_to_driver', 'out_for_delivery', 'hold')
        ) as active,
        count(*) filter (where delivery_status = 'delivered') as delivered,
        count(*) filter (where delivery_status = 'cancelled') as cancelled,
        count(*) filter (
          where delivery_status in ('returned_to_branch', 'returned_to_trader')
        ) as returned,
        count(*) as total
        from orders
       where company_id = ${identity.companyId}::uuid and trader_id = ${trader.id}::uuid
    `.execute(this.database);

    const monthCod = await sql<{ total: string }>`
      select coalesce(sum(cod_amount), 0)::text as total
        from orders
       where company_id = ${identity.companyId}::uuid and trader_id = ${trader.id}::uuid
         and order_date >= date_trunc('month', now())
    `.execute(this.database);

    const recent = await sql<{
      amountDue: string;
      customerName: string;
      companyName: string;
      orderDate: string;
      orderNumber: string;
      status: string;
    }>`
      select o.order_number as "orderNumber", o.order_date::text as "orderDate",
             o.customer_name as "customerName", o.delivery_status as status,
             o.customer_amount_due::text as "amountDue", c.name_en as "companyName"
        from orders o
        join companies c on c.id = o.company_id
       where o.company_id = ${identity.companyId}::uuid and o.trader_id = ${trader.id}::uuid
       order by o.order_date desc, o.created_at desc
       limit 5
    `.execute(this.database);

    // Trader Commerce is optional: a Trader who has never touched My Store
    // gets zeros here rather than an error, because a Dashboard that fails to
    // load over a Store that does not exist yet is a worse first screen than
    // an honest empty summary.
    const commerce = await sql<{
      activeProducts: string;
      deliveryCompanyCount: string;
      draftProducts: string;
      slug: string | null;
      status: string | null;
      storeName: string | null;
      storefrontId: string | null;
      totalProducts: string;
    }>`
      with commerce_identity as (
        select trader_commerce_id from trader_commerce_company_links
         where trader_id = ${trader.id}::uuid
      ),
      store as (
        select s.id, s.display_name, s.slug, s.status, s.trader_commerce_id
          from trader_storefronts s
          join commerce_identity ci on ci.trader_commerce_id = s.trader_commerce_id
      )
      select
        store.id as "storefrontId", store.display_name as "storeName", store.slug, store.status,
        coalesce(
          (select count(*) from trader_storefront_products p
            where p.storefront_id = store.id and p.lifecycle_status = 'active'), 0) as "activeProducts",
        coalesce(
          (select count(*) from trader_storefront_products p
            where p.storefront_id = store.id and p.lifecycle_status = 'draft'), 0) as "draftProducts",
        coalesce(
          (select count(*) from trader_storefront_products p
            where p.storefront_id = store.id), 0) as "totalProducts",
        coalesce(
          (select count(*) from trader_delivery_company_relationships r
            where r.trader_commerce_id = store.trader_commerce_id and r.status = 'active'), 0)
          as "deliveryCompanyCount"
        from commerce_identity
        left join store on store.trader_commerce_id = commerce_identity.trader_commerce_id
    `.execute(this.database);

    const commerceRow = commerce.rows[0];
    const counts = orderCounts.rows[0]!;
    return {
      commerce: {
        activeProducts: Number(commerceRow?.activeProducts ?? 0),
        deliveryCompanyCount: Number(commerceRow?.deliveryCompanyCount ?? 0),
        draftProducts: Number(commerceRow?.draftProducts ?? 0),
        hasStore: commerceRow?.storefrontId !== undefined && commerceRow.storefrontId !== null,
        storeName: commerceRow?.storeName ?? null,
        storeStatus: commerceRow?.status ?? null,
        storeUrl:
          commerceRow?.slug !== null && commerceRow?.slug !== undefined
            ? `/store/${commerceRow.slug}`
            : null,
        totalProducts: Number(commerceRow?.totalProducts ?? 0),
      },
      orders: {
        active: Number(counts.active),
        cancelled: Number(counts.cancelled),
        delivered: Number(counts.delivered),
        newOrders: Number(counts.newOrders),
        returned: Number(counts.returned),
        total: Number(counts.total),
      },
      period: {
        monthCodTotal: monthCod.rows[0]?.total ?? "0",
        monthLabel: new Date().toISOString().slice(0, 7),
      },
      recentOrders: recent.rows.map((row) => ({
        amountDue: row.amountDue,
        customerName: row.customerName,
        deliveryCompanyName: row.companyName,
        orderDate: row.orderDate,
        orderNumber: row.orderNumber,
        status: row.status,
      })),
    };
  }

  public async traderPortalAreas(): Promise<readonly TraderPortalArea[]> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    await this.traderForAccount(identity.companyId, identity.identityId, identity.profileId);
    const result = await sql<TraderPortalArea>`
      select a.id,a.name_en as "nameEn",a.name_ar as "nameAr",
             e.id as "emirateId",e.name_en as "emirateNameEn",
             e.name_ar as "emirateNameAr"
        from areas a
        join emirates e on e.id=a.emirate_id
       where a.company_id=${identity.companyId}::uuid and a.is_active
       order by e.display_order,lower(a.name_en),a.id
    `.execute(this.database);
    return result.rows;
  }

  /**
   * Which Delivery Company (and that Company's own Trader record) a Trader
   * Portal write should land under — the write-side counterpart of
   * `traderPortalOrdersPageAllCompanies`'s read-side aggregation (Trader
   * Portal Prompt 3T-C, Part D).
   *
   * The set of companies eligible for `target` is the exact same UNION
   * `traderPortalOrdersPageAllCompanies` reads from — the caller's own
   * session Company, always, plus every Company its Trader Commerce identity
   * is actively linked to. Reusing that set (rather than inventing a second
   * one) means "which Companies can I see Orders for" and "which Companies
   * can I create an Order under" can never drift apart.
   *
   * Resolution alone is always safe and always cross-Company: it never
   * writes anything, and correctly rejects an unrelated or inactive Company
   * regardless of what the actual write does with the result.
   *
   * ---------------------------------------------------------------------------
   * WHY `accountId` IS PART OF THE RESULT
   * ---------------------------------------------------------------------------
   *
   * `orders`, `order_status_history`, `order_events`, `order_assignments`,
   * `customers`, `customer_addresses`, `file_objects` and `import_batches`
   * all carry a COMPOSITE actor foreign key —
   * `(*_account_id, company_id) references accounts(id, company_id)` — so
   * writing under a Company other than the caller's own session Company
   * requires an account that actually belongs to THAT Company. The caller's
   * own login account never does. `target.accountId` is the resolved
   * Company Trader record's OWN account (`traders.account_id`) for
   * `target.companyId` — genuinely valid there — and is passed as
   * `createOrder`'s/`importOrdersCsv`'s `actingAccountIdOverride` by the two
   * callers below whenever `target.companyId !== identity.companyId`. This
   * satisfies every one of those constraints without touching
   * `IdentityContextAccessor`, `TenantContextAccessor`, `identities.current()`,
   * or the login/session model itself.
   */
  private async resolveTraderPortalDeliveryCompany(
    ownCompanyId: string,
    callerTraderId: string,
    requestedCompanyId: string | undefined,
  ): Promise<{
    readonly accountId: string;
    readonly companyId: string;
    readonly traderId: string;
  }> {
    const scopePairs = traderCommerceOrderScopePairs(callerTraderId);
    const result = await sql<{ accountId: string; companyId: string; traderId: string }>`
      select scope."companyId", scope."traderId", t.account_id as "accountId"
        from (
          select "companyId", "traderId" from (${scopePairs}) scope
          union
          select ${ownCompanyId}::uuid as "companyId", ${callerTraderId}::uuid as "traderId"
        ) scope
        join traders t on t.id = scope."traderId" and t.company_id = scope."companyId"
    `.execute(this.database);
    const options = result.rows;
    // Unreachable in practice — the UNION above always contributes the
    // caller's own Company — but kept as an explicit, honest guard rather
    // than trusting that invariant silently (§ Part A: "zero Companies
    // blocks manual Order creation").
    if (options.length === 0) {
      throw new ApplicationException(
        "no_delivery_company_available",
        "No Delivery Company is available for this Trader",
        HttpStatus.FORBIDDEN,
      );
    }
    if (requestedCompanyId === undefined) {
      return options.find((option) => option.companyId === ownCompanyId) ?? options[0]!;
    }
    const match = options.find((option) => option.companyId === requestedCompanyId);
    if (match === undefined) {
      throw new ApplicationException(
        "delivery_company_not_linked",
        "The selected Delivery Company is not an active relationship for this Trader",
        HttpStatus.FORBIDDEN,
      );
    }
    return match;
  }

  public async createTraderPortalOrder(
    input: CreateTraderPortalOrderDto,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<OperationsOrder> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const callerTrader = await this.traderForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    // Pricing is the Company's decision, not the Trader's. The portal contract
    // inherits `serviceFee` and `serviceFeeOverrideReason` from the Operator
    // DTO, so both are stripped here rather than trusted — the same reason
    // `traderId` is resolved from the session instead of the request body.
    //
    // Stripped, not rejected, so an existing mobile build that still sends the
    // fields keeps working: the Order is simply priced from the authoritative
    // Trader/Area table, which is what it should always have been. A configured
    // zero price therefore succeeds with no reason demanded of the Trader.
    const {
      deliveryCompanyId,
      serviceFee: _clientServiceFee,
      serviceFeeOverrideReason: _clientReason,
      ...pricedByCompany
    } = input;
    void _clientServiceFee;
    void _clientReason;
    const target = await this.resolveTraderPortalDeliveryCompany(
      identity.companyId,
      callerTrader.id,
      deliveryCompanyId,
    );
    // Trader Portal serial numbers are Company-owned operational identifiers.
    // The Trader should not type or control them; generate the next serial in
    // the target Company tenant scope immediately before creating the Order.
    // Own Company: no override needed, identical to today's behaviour except
    // for server-generated serial numbers.
    if (target.companyId === identity.companyId) {
      const nextSerial = await this.nextSerialNumber();
      return this.createOrder(
        { ...pricedByCompany, serialNumber: nextSerial.serialNumber, traderId: target.traderId },
        correlationId,
        idempotencyKey,
      );
    }
    // A different, actively-linked Company: `tenants.run()` redirects
    // `resolveServiceFee`'s (and everything else's) `companyId` to the
    // target Company for the duration of this one call -- so pricing
    // resolves from THAT Company's own Trader/Area table, not the caller's
    // session Company -- and `target.accountId` (that Company's own linked
    // Trader account) satisfies every composite actor FK `createOrder`
    // writes through. See `resolveTraderPortalDeliveryCompany`'s doc
    // comment for the full reasoning.
    return this.tenants.run({ companyId: target.companyId, identityId: identity.identityId }, async () => {
      const nextSerial = await this.nextSerialNumber();
      return this.createOrder(
        { ...pricedByCompany, serialNumber: nextSerial.serialNumber, traderId: target.traderId },
        correlationId,
        idempotencyKey,
        target.accountId,
      );
    });
  }

  public async updateTraderPortalOrder(
    orderId: string,
    input: UpdateOrderDto,
    correlationId: string,
  ): Promise<OperationsOrder> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const trader = await this.traderForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    // Same rule as creation: the Trader owns the Order's business fields, never
    // its price. Editing must not become the way around the creation guard.
    const {
      serviceFee: _ignoredServiceFee,
      serviceFeeReason: _ignoredReason,
      traderId: _ignoredTraderId,
      ...safeInput
    } = input;
    void _ignoredServiceFee;
    void _ignoredReason;
    void _ignoredTraderId;
    return this.updateOrder(orderId, safeInput, correlationId, trader.id);
  }

  public async traderPortalOrders(): Promise<readonly PortalOrder[]> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const trader = await this.traderForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    const result = await sql<PortalOrder>`
      select o.id,
             o.order_number as "orderNumber",
             o.order_date::text as "orderDate",
             o.serial_number as "serialNumber",
             o.reference_number as "referenceNumber",
             o.area_id as "areaId",
             o.package_count as "packageCount",
             o.notes,
             t.name_en as "traderName",
             a.name_en as "areaNameEn",
             a.name_ar as "areaNameAr",
             coalesce(o.customer_area_name_ar_snapshot,a.name_ar,
                      o.customer_area_name_snapshot,a.name_en) as "areaName",
             o.customer_name as "customerName",
             o.customer_address as "customerAddress",
             o.customer_mobile_number as "customerMobileNumber",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.customer_amount_due::text as "customerAmountDue",
             o.amount_collected::text as "amountCollected",
             o.delivery_status as "deliveryStatus",
             o.trader_settlement_status as "traderSettlementStatus",
             e.id as "emirateId",
             e.name_en as "emirateNameEn",
             e.name_ar as "emirateNameAr"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      left join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join emirates e on e.id = a.emirate_id
      where o.company_id = ${identity.companyId}::uuid
        and o.trader_id = ${trader.id}::uuid
      order by o.order_date desc, o.created_at desc, o.order_number
      limit 100
    `.execute(this.database);
    return result.rows;
  }

  /**
   * The Trader's own Orders, searchable and paginated.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS DELEGATES RATHER THAN QUERYING AGAIN
   * ---------------------------------------------------------------------------
   *
   * `traderPortalOrders()` above is an unbounded `limit 100` list with no
   * search, filter or paging — adequate for the Dashboard's "recent Orders",
   * inadequate as a Trader's actual Order list (Trader Workspace Prompt 3T-B,
   * §4/§45: "no unbounded list"). Rather than write a second search/filter/sort
   * implementation, this forces `traderId` to the authenticated Trader and
   * hands the SAME filters to `orders()` — the identical engine the Company
   * portal's Orders page already uses, including unified search, quickView
   * status grouping and the reference-number index.
   *
   * `filters.traderId` from the caller is never read: only the server-derived
   * `trader.id` is ever passed through, so a manipulated `traderId` in a
   * request body cannot reach another Trader's Orders (§11/§42).
   *
   * ---------------------------------------------------------------------------
   * WHY THE RESULT IS REDACTED BEFORE IT LEAVES THIS METHOD
   * ---------------------------------------------------------------------------
   *
   * `orders()` was built for a Company Operator and its row shape reflects
   * that: `companyRevenue`, `orderProfit`, `traderNetPayable`,
   * `outsourcedDriverFee*`, `assignedDriverId/Name/Mobile`,
   * `accountingEventId/JournalId` and confirmable-settlement identifiers are
   * all present on every row, unconditionally — the query has no notion of
   * caller kind. Returning that unchanged to a Trader session would leak
   * Company financial internals and Driver identity over the wire even if the
   * Trader UI never renders them (§7/§34/§70 of the Customer/Trader prompts
   * both name this exact category of leak).
   *
   * Redacted into `TraderPortalOrderSummary` — a purpose-built, explicit
   * allow-list — rather than reusing `OperationsOrder` as-is or padding
   * `PortalOrder`'s shape with placeholder values it has no data for.
   */
  public async traderPortalOrdersPage(
    filters: Omit<OperationsOrderFilters, "traderId">,
  ): Promise<TraderPortalOrderPage> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const trader = await this.traderForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    const result = await this.orders({ ...filters, traderId: trader.id });
    return {
      filteredCount: result.filteredCount,
      items: result.items.map((order): TraderPortalOrderSummary => ({
        areaName: order.areaName,
        codAmount: order.codAmount,
        customerAddress: order.customerAddress,
        customerAmountDue: order.customerAmountDue,
        customerMobileNumber: order.customerMobileNumber,
        customerName: order.customerName,
        deliveryStatus: order.deliveryStatus,
        id: order.id,
        orderDate: order.orderDate,
        orderNumber: order.orderNumber,
        referenceNumber: order.referenceNumber ?? null,
        serviceFee: order.serviceFee,
      })),
      page: result.page,
      pageSize: result.pageSize,
      totalCount: result.totalCount,
    };
  }

  /**
   * The Trader's Orders across every Delivery Company its Trader Commerce
   * identity is linked to -- "one common Trader Order history" (Trader
   * Portal Prompt 3T-C, Part C).
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS A SEPARATE METHOD, NOT A WIDER `traderPortalOrdersPage`
   * ---------------------------------------------------------------------------
   *
   * `traderPortalOrdersPage` delegates to `orders()`, the shared engine the
   * Company Operator also uses, which is scoped by `tenants.current().companyId`
   * -- one Company, always. That scoping is exactly what Driver Cash
   * Reconciliation and Trader Settlements are built on, so `orders()` and
   * `traderPortalOrdersPage` are left completely untouched here.
   *
   * This method instead resolves every `(company_id, trader_id)` pair the
   * caller's Trader Commerce identity is actively linked to
   * (`traderCommerceOrderScopePairs`, read-only, see that module's comment)
   * and runs its own bounded, redacted query against that set. It deliberately
   * re-implements only the filters the Trader Portal's toolbar actually
   * offers -- search, status quick-view, Order Date range, paging -- rather
   * than the full sort/driver/Delivery-Activity/financial-column surface
   * `orders()` carries for the Operator, which this Trader-facing view has no
   * business exposing or needing.
   */
  public async traderPortalOrdersPageAllCompanies(
    filters: Pick<
      OperationsOrderFilters,
      "dateFrom" | "dateTo" | "page" | "pageSize" | "quickView" | "search"
    > & { readonly deliveryCompanyId?: string | undefined },
  ): Promise<TraderPortalOrderPage> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const trader = await this.traderForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );

    const search = this.optionalFilter(filters.search);
    const dateFrom = this.optionalDate(filters.dateFrom);
    const dateTo = this.optionalDate(filters.dateTo);
    const deliveryCompanyId = this.optionalUuidFilter(filters.deliveryCompanyId);
    const quickView = filters.quickView ?? "active";
    const page =
      Number.isInteger(filters.page) && (filters.page ?? 0) > 0 ? (filters.page ?? 1) : 1;
    const pageSize = ([25, 50, 100] as const).includes(filters.pageSize ?? 25)
      ? (filters.pageSize ?? 25)
      : 25;
    const offset = (page - 1) * pageSize;

    const quickViewPredicate = sql`
      (${quickView} = 'all'
        or (${quickView} = 'active' and o.delivery_status in ('new','in_branch','assigned_to_driver','out_for_delivery','hold','delivered','returned_to_branch','returned_to_trader','collect_order'))
        or (${quickView} = 'closed' and o.delivery_status = 'closed')
        or (${quickView} = 'hold' and o.delivery_status = 'hold')
        or (${quickView} = 'cancelled' and o.delivery_status = 'cancelled'))
    `;
    const scopePairs = traderCommerceOrderScopePairs(trader.id);
    // `scopePairs` is empty for a Trader with no Trader Commerce identity yet
    // (no `trader_commerce_company_links` row at all -- most Traders, until
    // they touch My Store). Without this UNION such a Trader would see zero
    // Orders instead of their own, which is a regression, not a narrowing:
    // the caller's own `(company_id, trader_id)` pair is always in scope for
    // its own session regardless of whether a Commerce identity exists.
    const filterPredicate = sql`
      (o.company_id, o.trader_id) in (
        select "companyId", "traderId" from (${scopePairs}) scope
        union
        select ${identity.companyId}::uuid, ${trader.id}::uuid
      )
      and (${deliveryCompanyId}::uuid is null or o.company_id = ${deliveryCompanyId}::uuid)
      and ${quickViewPredicate}
      and ${unifiedOrderSearchPredicate(search)}
      and (${dateFrom}::date is null or o.order_date >= ${dateFrom}::date)
      and (${dateTo}::date is null or o.order_date <= ${dateTo}::date)
    `;

    const countResult = await sql<{ total: string }>`
      select count(*)::text as total
        from orders o
       where ${filterPredicate}
    `.execute(this.database);

    const result = await sql<{
      areaName: string;
      codAmount: string;
      companyId: string;
      companyName: string;
      customerAddress: string;
      customerAmountDue: string;
      customerMobileNumber: string;
      customerName: string;
      deliveryStatus: string;
      id: string;
      orderDate: string;
      orderNumber: string;
      referenceNumber: string | null;
      serviceFee: string;
    }>`
      select o.id, o.order_number as "orderNumber", o.order_date::text as "orderDate",
             o.reference_number as "referenceNumber",
             coalesce(o.customer_area_name_ar_snapshot,a.name_ar,
                      o.customer_area_name_snapshot,a.name_en) as "areaName",
             o.customer_name as "customerName",
             o.customer_address as "customerAddress",
             o.customer_mobile_number as "customerMobileNumber",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.customer_amount_due::text as "customerAmountDue",
             o.delivery_status as "deliveryStatus",
             o.company_id as "companyId",
             c.name_en as "companyName"
        from orders o
        left join areas a on a.id = o.area_id and a.company_id = o.company_id
        join companies c on c.id = o.company_id
       where ${filterPredicate}
       order by o.order_date desc, o.created_at desc, o.order_number
       limit ${pageSize} offset ${offset}
    `.execute(this.database);

    const totalCount = Number(countResult.rows[0]?.total ?? 0);
    return {
      filteredCount: totalCount,
      items: result.rows.map((order): TraderPortalOrderSummary => ({
        areaName: order.areaName,
        codAmount: order.codAmount,
        customerAddress: order.customerAddress,
        customerAmountDue: order.customerAmountDue,
        customerMobileNumber: order.customerMobileNumber,
        customerName: order.customerName,
        deliveryCompanyId: order.companyId,
        deliveryCompanyName: order.companyName,
        deliveryStatus: order.deliveryStatus,
        id: order.id,
        orderDate: order.orderDate,
        orderNumber: order.orderNumber,
        referenceNumber: order.referenceNumber ?? null,
        serviceFee: order.serviceFee,
      })),
      page,
      pageSize,
      totalCount,
    };
  }

  /**
   * The Delivery Companies the caller's Trader Commerce identity is actively
   * linked to -- populates the Trader Orders "Delivery Company" filter
   * without requiring a Store to already exist (unlike
   * `operations/trader-storefronts/:id/delivery-companies`, which is
   * Store-scoped). Read-only, same `trader_commerce_company_links` fan-out as
   * `traderPortalOrdersPageAllCompanies`.
   */
  public async traderPortalLinkedDeliveryCompanies(): Promise<
    readonly { readonly id: string; readonly isOwn: boolean; readonly name: string }[]
  > {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const trader = await this.traderForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    const scopePairs = traderCommerceOrderScopePairs(trader.id);
    // `isOwn` marks the ONE Company the caller is actually logged into —
    // the only Company Order creation and bulk import can currently write
    // under (`assertTraderPortalWriteStaysInOwnCompany`). The UI uses this
    // to disable the other, merely-visible-not-yet-writable options rather
    // than let a Trader submit a form that is certain to be rejected.
    const result = await sql<{ id: string; isOwn: boolean; name: string }>`
      select distinct c.id, c.name_en as name, c.id = ${identity.companyId}::uuid as "isOwn"
        from (
          select scope."companyId", scope."traderId" from (${scopePairs}) scope
          union
          select ${identity.companyId}::uuid as "companyId", ${trader.id}::uuid as "traderId"
        ) scope
        join companies c on c.id = scope."companyId"
       order by "isOwn" desc, c.name_en
    `.execute(this.database);
    return result.rows;
  }

  /**
   * Bulk Order creation for a Trader, reusing the Company import engine.
   *
   * ---------------------------------------------------------------------------
   * WHY THE CSV IS RE-WRITTEN RATHER THAN A SECOND IMPORTER BUILT
   * ---------------------------------------------------------------------------
   *
   * `importOrdersCsv` already owns every rule this needs — column validation,
   * per-row pricing from the Trader/Area table, the zero-fee-needs-a-reason
   * check, atomic all-or-nothing failure, and the row-level result the UI
   * shows as a preview of what happened. Building a parallel Trader importer
   * would be exactly the second Order engine §3/§69 forbid.
   *
   * So the only new work is enforcing Trader scope BEFORE that engine ever
   * runs: any `traderId` or `driverId` column the Trader's file supplies is
   * dropped — a Trader manually assigning a Driver or naming a different
   * Trader is not a typo to correct, it is exactly the input this method
   * exists to refuse — and a `traderId` column is added back with the
   * server-resolved Trader on every row. `importOrdersCsv` then sees a file
   * that looks exactly like one the Trader's own portal produced honestly.
   */
  public async createTraderPortalOrdersImport(
    input: ImportTraderPortalOrdersCsvDto,
    correlationId: string,
  ): Promise<OperationsOrderImportResult> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const callerTrader = await this.traderForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    // One Delivery Company for the whole batch (Part D): resolved once,
    // before any row is read, exactly like the single-Order path above —
    // never per-row, and never from a column inside the CSV itself.
    const target = await this.resolveTraderPortalDeliveryCompany(
      identity.companyId,
      callerTrader.id,
      input.deliveryCompanyId,
    );
    const scoped = this.scopeCsvToTrader(
      String((input as { csv?: unknown }).csv ?? ""),
      target.traderId,
    );
    if (target.companyId === identity.companyId) {
      return this.importOrdersCsv({ csv: scoped }, correlationId);
    }
    // Same cross-Company write bridge as `createTraderPortalOrder`: redirect
    // `companyId` for this one call, and use the target Company's own
    // linked Trader account for every composite-FK'd actor column
    // `importOrdersCsv` writes through (`file_objects`, `import_batches`,
    // and — via `insertOrder`/`resolveImportedCustomer` — `orders`,
    // `order_status_history`, `order_events`, `order_assignments`,
    // `customers`, `customer_addresses`).
    return this.tenants.run({ companyId: target.companyId, identityId: identity.identityId }, () =>
      this.importOrdersCsv({ csv: scoped }, correlationId, target.accountId),
    );
  }

  /** Strips any `traderId`/`driverId` column and forces the given Trader. */
  private scopeCsvToTrader(csv: string, traderId: string): string {
    const rows = this.parseCsv(csv).filter((row) => row.some((cell) => cell.trim().length > 0));
    if (rows.length === 0) return csv;
    const header = rows[0]!.map((cell) => cell.trim());
    const dropped = new Set(["traderid", "driverid"]);
    const keepIndexes = header
      .map((name, position) => [name, position] as const)
      .filter(([name]) => !dropped.has(name.toLowerCase()));
    const writeRow = (cells: readonly string[]): string =>
      cells
        .map((cell) => (/[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
        .join(",");
    const rebuilt = [
      writeRow([...keepIndexes.map(([name]) => name), "traderId"]),
      ...rows
        .slice(1)
        .map((row) => writeRow([...keepIndexes.map(([, index]) => row[index] ?? ""), traderId])),
    ];
    return rebuilt.join("\n");
  }

  public async driverPortalOrders(): Promise<readonly PortalOrder[]> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const driver = await this.driverForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    const result = await sql<PortalOrder>`
      select o.id,
             o.order_number as "orderNumber",
             o.order_date::text as "orderDate",
             o.serial_number as "serialNumber",
             o.reference_number as "referenceNumber",
             o.area_id as "areaId",
             o.package_count as "packageCount",
             o.notes,
             t.name_en as "traderName",
             a.name_en as "areaNameEn",
             a.name_ar as "areaNameAr",
             coalesce(o.customer_area_name_ar_snapshot,a.name_ar,
                      o.customer_area_name_snapshot,a.name_en) as "areaName",
             o.customer_name as "customerName",
             o.customer_address as "customerAddress",
             o.customer_mobile_number as "customerMobileNumber",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.customer_amount_due::text as "customerAmountDue",
             o.amount_collected::text as "amountCollected",
             o.delivery_status as "deliveryStatus",
             o.trader_settlement_status as "traderSettlementStatus",
             e.id as "emirateId",
             e.name_en as "emirateNameEn",
             e.name_ar as "emirateNameAr"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      left join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join emirates e on e.id = a.emirate_id
      where o.company_id = ${identity.companyId}::uuid
        and o.assigned_driver_id = ${driver.id}::uuid
        and o.delivery_status in (
          'assigned_to_driver', 'out_for_delivery', 'delivered', 'returned_to_branch'
        )
      order by o.order_date desc, o.created_at desc, o.order_number
      limit 100
    `.execute(this.database);
    return result.rows;
  }

  /**
   * A single Order, scoped to one Driver's own assignment, with NO status
   * filter — unlike `driverPortalOrders()` (the Orders list), which
   * deliberately only surfaces the statuses a Driver actively works: Hold is
   * excluded there by design (it drops off the Driver's list once put on
   * Hold, matching "Driver: limited operational next actions" — resuming it
   * is Operations-only). `changeDriverPortalOrderStatus` still needs to
   * return the Order it just changed regardless of which status that left it
   * in, which is exactly what caused a real bug this method fixes: reusing
   * `driverPortalOrders()` for that re-fetch meant a successful Hold (a valid
   * status this Driver Physical Correction newly allows) could never be
   * found again by `.find()`, throwing "Updated driver portal order could
   * not be loaded" as a 500 on every Hold attempt.
   */
  private async driverPortalOrderById(
    companyId: string,
    driverId: string,
    orderId: string,
  ): Promise<PortalOrder | undefined> {
    const result = await sql<PortalOrder>`
      select o.id,
             o.order_number as "orderNumber",
             o.order_date::text as "orderDate",
             o.serial_number as "serialNumber",
             o.reference_number as "referenceNumber",
             o.area_id as "areaId",
             o.package_count as "packageCount",
             o.notes,
             t.name_en as "traderName",
             a.name_en as "areaNameEn",
             a.name_ar as "areaNameAr",
             coalesce(o.customer_area_name_ar_snapshot,a.name_ar,
                      o.customer_area_name_snapshot,a.name_en) as "areaName",
             o.customer_name as "customerName",
             o.customer_address as "customerAddress",
             o.customer_mobile_number as "customerMobileNumber",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.customer_amount_due::text as "customerAmountDue",
             o.amount_collected::text as "amountCollected",
             o.delivery_status as "deliveryStatus",
             o.trader_settlement_status as "traderSettlementStatus",
             e.id as "emirateId",
             e.name_en as "emirateNameEn",
             e.name_ar as "emirateNameAr"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      left join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join emirates e on e.id = a.emirate_id
      where o.company_id = ${companyId}::uuid
        and o.id = ${orderId}::uuid
        and o.assigned_driver_id = ${driverId}::uuid
      limit 1
    `.execute(this.database);
    return result.rows[0];
  }

  /**
   * Read-only status timeline for one Order this Driver is (or was, for a
   * just-completed delivery) assigned to. Ownership is re-checked here
   * independently of whatever the caller was ever shown via
   * `driverPortalOrders()` — the same defense-in-depth pattern
   * `changeDriverPortalOrderStatus` already uses. Loaded on demand only
   * (the mobile client fetches this when the Driver expands History, not on
   * every Order Detail open), so no cost is paid for a Driver who never asks.
   */
  public async driverPortalOrderHistory(
    orderId: string,
  ): Promise<readonly { fromStatus: string | null; toStatus: string; occurredAt: string }[]> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const driver = await this.driverForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    const owned = await sql<{ id: string }>`
      select id from orders
       where id = ${orderId}::uuid and company_id = ${identity.companyId}::uuid
         and assigned_driver_id = ${driver.id}::uuid
       limit 1
    `.execute(this.database);
    if (owned.rows[0] === undefined) {
      throw new ApplicationException(
        "driver_order_access_denied",
        "The order was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const history = await sql<{
      fromStatus: string | null;
      toStatus: string;
      occurredAt: string;
    }>`
      select h.from_status as "fromStatus", h.to_status as "toStatus",
             h.occurred_at::text as "occurredAt"
        from order_status_history h
       where h.company_id = ${identity.companyId}::uuid and h.order_id = ${orderId}::uuid
       order by h.occurred_at, h.id
    `.execute(this.database);
    return history.rows;
  }

  public async changeDriverPortalOrderStatus(
    orderId: string,
    input: ChangeOrderStatusDto,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<PortalOrder> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const driver = await this.driverForAccount(
      identity.companyId,
      identity.identityId,
      identity.profileId,
    );
    const current = await sql<{ driverId: string | null }>`
      select assigned_driver_id as "driverId"
      from orders
      where id = ${orderId}::uuid
        and company_id = ${identity.companyId}::uuid
        and assigned_driver_id = ${driver.id}::uuid
      limit 1
    `.execute(this.database);
    if (current.rows[0] === undefined) {
      await sql`
        insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,
          after_data,correlation_id,actor_role,source)
        values(${identity.companyId}::uuid,${identity.identityId}::uuid,'driver.order_access_blocked',
          'order',${orderId},'{"reason":"profile_scope"}'::jsonb,${correlationId},'driver','portal')
      `.execute(this.database);
      throw new ApplicationException(
        "driver_order_access_denied",
        "The order was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    await this.changeOrderStatus(orderId, input, correlationId, idempotencyKey);
    const updated = await this.driverPortalOrderById(identity.companyId, driver.id, orderId);
    if (updated === undefined) {
      throw new Error("Updated driver portal order could not be loaded");
    }
    return updated;
  }

  public async traders(): Promise<readonly OperationsTrader[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<OperationsTrader>`
      select t.id,
             t.code,
             t.name_en as name,
             t.mobile_number as "mobileNumber",
             t.account_status as status,
             count(o.id)::int as "totalOrders",
             count(o.id) filter (where o.delivery_status in ('new', 'assigned_to_driver', 'out_for_delivery'))::int as "openOrders",
             coalesce(sum(o.trader_outstanding_balance) filter (
               where o.delivery_status = 'delivered'
                 and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
                 and o.trader_settlement_status not in ('not_eligible', 'reversed')
             ), 0)::text as "unsettledNetPayable"
      from traders t
      left join orders o on o.trader_id = t.id and o.company_id = t.company_id
      where t.company_id = ${companyId}::uuid
      group by t.id
      order by lower(t.name_en), t.code
      limit 100
    `.execute(this.database);
    return result.rows;
  }

  public async searchTraders(
    search = "",
    requestedLimit = 20,
    requestedOffset = 0,
  ): Promise<SearchPage<OperationsTraderOption>> {
    const { companyId } = this.tenants.current();
    const term = search.trim().toLowerCase();
    const mobileTerm = normalizeUaeMobile(search);
    const limit = Math.min(Math.max(Math.trunc(requestedLimit) || 20, 1), 50);
    const offset = Math.max(Math.trunc(requestedOffset) || 0, 0);
    const match = this.searchMatch(
      mobileTerm ?? term,
      sql`lower(t.name_en || ' ' || coalesce(t.name_ar, '') || ' ' || t.mobile_number
                || ' ' || coalesce(t.second_mobile_number, ''))`,
    );
    const result = await sql<OperationsTraderOption & { total: number }>`
      select t.id,t.code,
             t.name_en as "nameEn",
             t.name_ar as "nameAr",
             t.mobile_number as "mobileNumber",
             t.second_mobile_number as "secondMobileNumber",
             a.id as "pickupAreaId",
             a.name_en as "pickupAreaNameEn",
             a.name_ar as "pickupAreaNameAr",
             e.id as "pickupEmirateId",
             e.name_en as "pickupEmirateNameEn",
             e.name_ar as "pickupEmirateNameAr",
             count(*) over ()::int as total
      from traders t
      left join areas a on a.id=t.pickup_area_id and a.company_id=t.company_id
      left join emirates e on e.id=a.emirate_id
      where t.company_id = ${companyId}::uuid
        and t.account_status = 'active'
        and (${match})
      order by lower(t.name_en), t.id
      limit ${limit} offset ${offset}
    `.execute(this.database);
    const total = result.rows[0]?.total ?? 0;
    return {
      hasMore: offset + result.rows.length < total,
      items: result.rows.map((trader) => ({
        code: trader.code,
        id: trader.id,
        mobileNumber: trader.mobileNumber,
        nameAr: trader.nameAr,
        nameEn: trader.nameEn,
        pickupAreaId: trader.pickupAreaId,
        pickupAreaNameAr: trader.pickupAreaNameAr,
        pickupAreaNameEn: trader.pickupAreaNameEn,
        pickupEmirateId: trader.pickupEmirateId,
        pickupEmirateNameAr: trader.pickupEmirateNameAr,
        pickupEmirateNameEn: trader.pickupEmirateNameEn,
        secondMobileNumber: trader.secondMobileNumber,
      })),
      total,
    };
  }

  public async drivers(): Promise<readonly OperationsDriver[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<OperationsDriver>`
      select d.id,
             d.code,
             d.name_en as name,
             d.mobile_number as "mobileNumber",
             d.driver_type as type,
             d.account_status as status,
             count(o.id) filter (where o.delivery_status in ('assigned_to_driver', 'out_for_delivery'))::int as "activeOrders",
             count(o.id) filter (where o.delivery_status = 'delivered')::int as "deliveredOrders",
             count(o.id) filter (where o.driver_reconciliation_status = 'pending')::int as "pendingCashOrders"
      from drivers d
      left join orders o on o.assigned_driver_id = d.id and o.company_id = d.company_id
      where d.company_id = ${companyId}::uuid
        and d.account_status = 'active'
      group by d.id
      order by lower(d.name_en), d.code
      limit 100
    `.execute(this.database);
    return result.rows;
  }

  public async pendingCashOrders(): Promise<readonly OperationsPendingCashOrder[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<OperationsPendingCashOrder>`
      select o.id,
             o.order_number as "orderNumber",
             o.customer_name as "customerName",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.vat_amount::text as "vatAmount",
             o.customer_amount_due::text as "customerAmountDue",
             o.amount_collected::text as "amountCollected",
             d.id as "driverId",
             d.name_en as "assignedDriverName"
      from orders o
      join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
      where o.company_id = ${companyId}::uuid
        and o.driver_reconciliation_status = 'pending'
      order by d.name_en, o.delivered_at nulls last, o.order_number
      limit 100
    `.execute(this.database);
    return result.rows;
  }

  public async pendingSettlementOrders(): Promise<readonly OperationsPendingSettlementOrder[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<OperationsPendingSettlementOrder>`
      select o.id,
             o.order_number as "orderNumber",
             o.customer_name as "customerName",
             t.id as "traderId",
             t.name_en as "traderName",
             o.trader_gross_payable::text as "grossPayable",
             o.trader_paid_service_fee::text as "serviceFee",
             o.trader_net_payable::text as "netPayable"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      where o.company_id = ${companyId}::uuid
        and o.delivery_status = 'delivered'
        and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
        and o.trader_settlement_status = 'unsettled'
      order by t.name_en, o.delivered_at nulls last, o.order_number
      limit 100
    `.execute(this.database);
    return result.rows;
  }

  public async traderSettlements(): Promise<readonly OperationsTraderSettlement[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<OperationsTraderSettlement>`
      select s.id,
             s.settlement_number as "settlementNumber",
             s.business_date::text as "businessDate",
             t.name_en as "traderName",
             s.gross_payable::text as "grossPayable",
             s.service_fee_deductions::text as "serviceFeeDeductions",
             s.net_payable::text as "netPayable",
             s.status,
             s.confirmed_at::text as "confirmedAt",
             count(so.id)::int as "orderCount"
      from trader_settlements s
      join traders t on t.id = s.trader_id and t.company_id = s.company_id
      left join trader_settlement_orders so
        on so.settlement_id = s.id and so.company_id = s.company_id
      where s.company_id = ${companyId}::uuid
      group by s.id, t.name_en
      order by s.business_date desc, s.created_at desc, s.settlement_number desc
      limit 50
    `.execute(this.database);
    return result.rows;
  }

  public async traderSettlementDetail(
    settlementId: string,
  ): Promise<OperationsTraderSettlementDetail> {
    const { companyId } = this.tenants.current();
    const header = await sql<OperationsTraderSettlement>`
      select s.id,
             s.settlement_number as "settlementNumber",
             s.business_date::text as "businessDate",
             t.name_en as "traderName",
             s.gross_payable::text as "grossPayable",
             s.service_fee_deductions::text as "serviceFeeDeductions",
             s.net_payable::text as "netPayable",
             s.status,
             s.confirmed_at::text as "confirmedAt",
             count(so.id)::int as "orderCount"
      from trader_settlements s
      join traders t on t.id = s.trader_id and t.company_id = s.company_id
      left join trader_settlement_orders so
        on so.settlement_id = s.id and so.company_id = s.company_id
      where s.company_id = ${companyId}::uuid and s.id = ${settlementId}::uuid
      group by s.id, t.name_en
    `.execute(this.database);
    const settlement = header.rows[0];
    if (settlement === undefined) {
      throw new ApplicationException(
        "settlement_not_found",
        "Trader settlement not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const [orders, payments] = await Promise.all([
      sql<OperationsTraderSettlementDetail["orders"][number]>`
        select o.id as "orderId",
               o.order_number as "orderNumber",
               o.customer_name as "customerName",
               so.gross_payable::text as "grossPayable",
               so.deductions_and_charges::text as "serviceFee",
               so.net_payable::text as "netPayable"
        from trader_settlement_orders so
        join orders o on o.id = so.order_id and o.company_id = so.company_id
        where so.company_id = ${companyId}::uuid
          and so.settlement_id = ${settlementId}::uuid
        order by o.order_number
      `.execute(this.database),
      sql<OperationsTraderSettlementDetail["payments"][number]>`
        select payment_method as method,
               amount::text as amount,
               case
                 when b.id is null then null
                 else concat(b.bank_name, ' - ', b.account_name)
               end as "bankAccountName",
               bank_reference as "bankReference"
        from trader_settlement_payments p
        left join company_bank_accounts b
          on b.id = p.company_bank_account_id
         and b.company_id = p.company_id
        where p.company_id = ${companyId}::uuid
          and p.settlement_id = ${settlementId}::uuid
        order by p.created_at, p.id
      `.execute(this.database),
    ]);
    return { ...settlement, orders: orders.rows, payments: payments.rows };
  }

  public async createTrader(
    input: CreateTraderDto,
    correlationId: string,
  ): Promise<OperationsTrader> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const name = input.nameEn.trim();
    const mobileNumber = input.mobileNumber?.trim() || null;
    const passwordHash = await this.passwords.hash(randomUUID());
    try {
      const createdTrader = await this.transactions.execute(async (transaction) => {
        const code = await this.nextReferenceNumber(transaction, companyId, "trader", "TRD");
        const accountId = randomUUID();
        const inserted = await sql<{ id: string }>`
          insert into accounts (
            id, company_id, account_kind, username, password_hash, status, password_changed_at
          ) values (
            ${accountId}::uuid, ${companyId}::uuid, 'trader', ${`trader.${code.toLowerCase()}`},
            ${passwordHash}, 'active', now()
          )
        `.execute(transaction);
        void inserted;
        const trader = await sql<{ id: string }>`
          insert into traders (
            company_id, account_id, code, name_en, contact_person, mobile_number,
            email, pickup_address, account_status
          ) values (
            ${companyId}::uuid, ${accountId}::uuid, ${code}, ${name},
            ${input.contactPerson?.trim() || null}, ${mobileNumber},
            ${input.email?.trim() || null}, ${input.pickupAddress?.trim() || null}, 'active'
          )
          returning id
        `.execute(transaction);
        const traderId = trader.rows[0]?.id;
        if (traderId === undefined) {
          throw new Error("Trader creation did not return an identifier");
        }
        await this.audit(transaction, {
          action: "trader.create",
          actorId: identity.identityId,
          after: { code, nameEn: name },
          companyId,
          correlationId,
          subjectId: traderId,
          subjectType: "trader",
        });
        return { code, traderId };
      });
      return {
        code: createdTrader.code,
        id: createdTrader.traderId,
        mobileNumber: mobileNumber ?? "",
        name,
        openOrders: 0,
        status: "active",
        totalOrders: 0,
        unsettledNetPayable: "0",
      };
    } catch (error) {
      this.rethrowDuplicate(error, "trader_exists", "A trader with this code already exists");
      throw error;
    }
  }

  public async createDriver(
    input: CreateDriverDto,
    correlationId: string,
  ): Promise<OperationsDriver> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const code = input.code.trim().toUpperCase();
    const name = input.nameEn.trim();
    const mobileNumber = input.mobileNumber.trim();
    const outsourcedFee = input.outsourcedFeePerDeliveredOrder ?? 0;
    const passwordHash = await this.passwords.hash(randomUUID());
    try {
      const driverId = await this.transactions.execute(async (transaction) => {
        const accountId = randomUUID();
        await sql`
          insert into accounts (
            id, company_id, account_kind, username, password_hash, status, password_changed_at
          ) values (
            ${accountId}::uuid, ${companyId}::uuid, 'driver', ${`driver.${code.toLowerCase()}`},
            ${passwordHash}, 'active', now()
          )
        `.execute(transaction);
        const driver = await sql<{ id: string }>`
          insert into drivers (
            company_id, account_id, code, name_en, mobile_number, driver_type,
            account_status, outsourced_fee_per_delivered_order
          ) values (
            ${companyId}::uuid, ${accountId}::uuid, ${code}, ${name}, ${mobileNumber},
            'outsourced', 'active', ${outsourcedFee}
          )
          returning id
        `.execute(transaction);
        const driverId = driver.rows[0]?.id;
        if (driverId === undefined) {
          throw new Error("Driver creation did not return an identifier");
        }
        await this.audit(transaction, {
          action: "driver.create",
          actorId: identity.identityId,
          after: { code, nameEn: name, outsourcedFeePerDeliveredOrder: outsourcedFee },
          companyId,
          correlationId,
          subjectId: driverId,
          subjectType: "driver",
        });
        return driverId;
      });
      return {
        activeOrders: 0,
        code,
        deliveredOrders: 0,
        id: driverId,
        mobileNumber,
        name,
        pendingCashOrders: 0,
        status: "active",
        type: "outsourced",
      };
    } catch (error) {
      this.rethrowDuplicate(error, "driver_exists", "A driver with this code already exists");
      throw error;
    }
  }

  public async createOrder(
    input: CreateOrderDto,
    correlationId: string,
    idempotencyKey?: string,
    /**
     * Overrides which account this Order (and its Customer, if inline) is
     * recorded as created by. Every existing caller omits this and gets
     * today's exact behaviour: `identity.identityId`, the session's own
     * account.
     *
     * Exists ONLY for the Trader Portal's cross-Company write bridge
     * (`createTraderPortalOrder`, Trader Portal Prompt 3T-C, Part A/B):
     * `orders`, `order_status_history`, `order_events`, `order_assignments`,
     * `customers` and `customer_addresses` all carry a COMPOSITE foreign key
     * — `(*_account_id, company_id) references accounts(id, company_id)` —
     * so writing under a Company other than the caller's own session Company
     * requires an account that actually belongs to THAT Company. The
     * caller's own login account never does. Passing the target Company's
     * own linked Trader account here (resolved server-side, never from the
     * client) satisfies every one of those constraints without touching
     * `IdentityContextAccessor`/`TenantContextAccessor`, `identities.current()`,
     * or the login/session model itself — `identity.kind`/`identity.permissions`
     * (role label, override-fee permission) still come from the real caller.
     */
    actingAccountIdOverride?: string,
  ): Promise<OperationsOrder> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const actingAccountId = actingAccountIdOverride ?? identity.identityId;
    const actorRole =
      identity.kind === "trader"
        ? "Trader"
        : identity.kind === "driver"
          ? "Driver"
          : "Company User";
    const key = idempotencyKey?.trim() ?? "";
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
      throw new ApplicationException(
        "idempotency_key_invalid",
        "A valid idempotency key is required to create an order",
        HttpStatus.BAD_REQUEST,
      );
    }
    const serialNumber = input.serialNumber.trim();
    const referenceNumber = input.referenceNumber?.trim() || null;
    const serialNumberNormalized = this.normalizeOrderIdentifier(serialNumber);
    const referenceNumberNormalized =
      referenceNumber === null ? null : this.normalizeOrderIdentifier(referenceNumber);
    const collectOrder = input.orderType === "collect_order";
    const requestedDriverId = collectOrder ? undefined : input.driverId;
    const inlineCustomer = input.inlineCustomer;
    const customerOmitted =
      input.customerId === undefined &&
      input.customerAddressId === undefined &&
      inlineCustomer === undefined;
    const orderAreaId = input.areaId ?? inlineCustomer?.areaId;
    if (!customerOmitted && orderAreaId === undefined) {
      throw new ApplicationException(
        "area_required",
        "Select an Area when Customer details are entered",
        HttpStatus.BAD_REQUEST,
      );
    }
    const hasExistingCustomer =
      input.customerId !== undefined && input.customerAddressId !== undefined;
    if (!customerOmitted && hasExistingCustomer === (inlineCustomer !== undefined)) {
      throw new ApplicationException(
        "order_customer_selection_invalid",
        "Select an existing Customer or enter one new Customer",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      inlineCustomer !== undefined &&
      input.areaId !== undefined &&
      inlineCustomer.areaId !== input.areaId
    ) {
      throw new ApplicationException(
        "customer_area_mismatch",
        "The new Customer Area must match the Order Area",
        HttpStatus.BAD_REQUEST,
      );
    }
    const customerName = (inlineCustomer?.name ?? input.customerName ?? "").trim();
    const customerMobileNumber = (
      inlineCustomer?.mobileNumber ??
      input.customerMobileNumber ??
      ""
    ).trim();
    const customerSecondMobileNumber =
      (inlineCustomer?.secondMobileNumber ?? input.customerSecondMobileNumber)?.trim() || null;
    /* Address is optional. Stored as '' rather than NULL when absent: the column
       is NOT NULL with no non-empty check, so an empty string satisfies the
       schema and no migration is needed to relax it. */
    const customerAddress = (inlineCustomer?.address ?? input.customerAddress ?? "").trim();
    const notes = input.notes?.trim() || null;
    const packageCount = input.packageCount ?? 1;
    const additionalFees = input.additionalFees ?? 0;
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          areaId: input.areaId,
          additionalFees,
          codAmount: input.codAmount,
          customerAddressId: input.customerAddressId ?? null,
          customerAddress,
          customerDeliveryNotes: input.customerDeliveryNotes?.trim() || null,
          customerId: input.customerId ?? null,
          inlineCustomer: inlineCustomer ?? null,
          customerLatitude: input.customerLatitude ?? null,
          customerLocationLink: input.customerLocationLink?.trim() || null,
          customerLongitude: input.customerLongitude ?? null,
          customerMobileNumber,
          customerName,
          customerSecondMobileNumber,
          driverId: requestedDriverId ?? null,
          notes,
          packageCount,
          referenceNumber,
          serialNumber,
          serviceFee: input.serviceFee ?? null,
          serviceFeeOverrideReason: input.serviceFeeOverrideReason?.trim() || null,
          traderId: input.traderId,
        }),
      )
      .digest("hex");

    return this.transactions.execute(async (transaction) => {
      const reservation = await sql<{ id: string }>`
        insert into idempotency_records (
          company_id, operation, idempotency_key, request_hash, expires_at
        ) values (
          ${companyId}::uuid, 'orders.create', ${key}, ${requestHash}, now() + interval '24 hours'
        )
        on conflict (company_id, operation, idempotency_key) do nothing
        returning id
      `.execute(transaction);
      if (reservation.rows[0] === undefined) {
        const existing = await sql<{ requestHash: string; resourceId: string | null }>`
          select request_hash as "requestHash", resource_id as "resourceId"
          from idempotency_records
          where company_id = ${companyId}::uuid
            and operation = 'orders.create'
            and idempotency_key = ${key}
          for update
        `.execute(transaction);
        const record = existing.rows[0];
        if (record === undefined || record.requestHash !== requestHash) {
          throw new ApplicationException(
            "idempotency_key_reused",
            "This submission key was already used for different order details",
            HttpStatus.CONFLICT,
          );
        }
        if (record.resourceId !== null) {
          return this.loadOrder(transaction, companyId, record.resourceId);
        }
        throw new ApplicationException(
          "order_creation_in_progress",
          "This order submission is still being processed",
          HttpStatus.CONFLICT,
        );
      }

      await this.assertOrderIdentifiersAvailable(transaction, companyId, {
        referenceNumber,
        referenceNumberNormalized,
        serialNumber,
        serialNumberNormalized,
      });

      const trader = await sql<{ id: string; name: string }>`
        select id, name_en as name
        from traders
        where id = ${input.traderId}::uuid
          and company_id = ${companyId}::uuid
          and account_status = 'active'
      `.execute(transaction);
      const traderRow = trader.rows[0];
      if (traderRow === undefined) {
        throw new ApplicationException(
          "trader_not_found",
          "The selected trader is not active in this Company",
          HttpStatus.BAD_REQUEST,
        );
      }

      const resolvedCustomer = customerOmitted
        ? undefined
        : await this.resolveCreateOrderCustomer(transaction, {
            companyId,
            correlationId,
            createdByAccountId: actingAccountId,
            ...(input.customerAddressId === undefined
              ? {}
              : { customerAddressId: input.customerAddressId }),
            ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
            ...(inlineCustomer === undefined ? {} : { inlineCustomer }),
            orderAreaId: orderAreaId!,
          });
      const customerAddressRow = resolvedCustomer?.address;
      const customerRow = resolvedCustomer?.customer;
      const latitude = input.customerLatitude ?? customerAddressRow?.latitude ?? null;
      const longitude = input.customerLongitude ?? customerAddressRow?.longitude ?? null;
      if (
        (latitude === null || latitude === undefined) !==
        (longitude === null || longitude === undefined)
      ) {
        throw new ApplicationException(
          "customer_coordinates_incomplete",
          "Latitude and longitude must be entered together",
          HttpStatus.BAD_REQUEST,
        );
      }
      const customerLocationLink =
        input.customerLocationLink?.trim() || customerAddressRow?.locationLink || null;
      const customerDeliveryNotes =
        input.customerDeliveryNotes?.trim() ||
        customerAddressRow?.deliveryInstructions ||
        customerRow?.deliveryNotes ||
        null;

      const driverRow =
        requestedDriverId === undefined
          ? undefined
          : (
              await sql<{ id: string; name: string; outsourcedFee: string | null }>`
                select id,
                       name_en as name,
                       outsourced_fee_per_delivered_order::text as "outsourcedFee"
                from drivers
                where id = ${requestedDriverId}::uuid
                  and company_id = ${companyId}::uuid
                  and account_status = 'active'
              `.execute(transaction)
            ).rows[0];
      if (requestedDriverId !== undefined && driverRow === undefined) {
        throw new ApplicationException(
          "driver_not_found",
          "The selected driver is not active in this Company",
          HttpStatus.BAD_REQUEST,
        );
      }

      const area =
        input.areaId === undefined
          ? undefined
          : await this.activeArea(transaction, companyId, input.areaId);
      /*
       * A Free Order is a decision, so it does not ask the pricing engine a
       * question it has already answered. Skipping `resolveServiceFee` is the
       * point: an Area with no configured price raises `pricing_not_configured`,
       * which would block an Order the operator has explicitly declared free.
       *
       * The Trader's own pricing is not read, written or affected -- this is one
       * Order, and the next one prices normally.
       *
       * `manual` provenance with a zero configured fee is the honest record: no
       * `trader_service_price_id` was applied, and the zero came from a person.
       * The operator's reason is copied into `service_fee_override_reason` so
       * `orders_zero_service_fee_reason_check` is satisfied by the same stated
       * words that justify the free delivery; `is_free_order` remains what
       * distinguishes this from a configured-zero price.
       */
      const freeOrder = !collectOrder && input.isFreeOrder === true;
      const freeOrderReason = freeOrder ? (input.freeOrderReason ?? "").trim() : null;
      if (freeOrder && freeOrderReason === "") {
        throw new ApplicationException(
          "free_order_reason_required",
          "Enter a reason for the Free Order",
          HttpStatus.BAD_REQUEST,
        );
      }
      const pricing =
        freeOrder || collectOrder
          ? {
              configuredFee: this.money(new Decimal(0)),
              finalFee: this.money(new Decimal(0)),
              overrideApplied: false,
              overrideReason:
                freeOrderReason ?? (collectOrder ? "Collect Order — operational only" : null),
              provenance: "manual" as const,
              servicePriceId: null,
            }
          : await this.resolveServiceFee(transaction, {
              areaId: area!.id,
              companyId,
              permissions: identity.permissions,
              ...(input.serviceFee === undefined ? {} : { requestedFee: input.serviceFee }),
              ...(input.serviceFeeOverrideReason === undefined
                ? {}
                : { requestedReason: input.serviceFeeOverrideReason }),
              traderId: traderRow.id,
            });
      const vatPolicy = await this.vatPolicy(transaction, companyId);
      const orderNumber = await this.nextOrderNumber(transaction, companyId);
      const driverCost = new Decimal(driverRow?.outsourcedFee ?? 0);
      const financials = this.calculateOrderFinancials({
        // Both forced, never trusted from the client: a free Order with a COD is
        // not a state this system recognises.
        additionalFees: freeOrder || collectOrder ? new Decimal(0) : new Decimal(additionalFees),
        codAmount: freeOrder || collectOrder ? new Decimal(0) : new Decimal(input.codAmount),
        driverCost: collectOrder ? new Decimal(0) : driverCost,
        prospective: true,
        serviceFee: pricing.finalFee,
        vatPolicy,
      });
      // A Collect Order is not complete when it is created. Without a Driver
      // it starts New so the normal assignment action is available. Once a
      // Driver is already supplied it can enter the collect task directly.
      const deliveryStatus = collectOrder
        ? "collect_order"
        : driverRow === undefined
          ? "new"
          : "assigned_to_driver";
      const traderSettlementStatus =
        freeOrder || collectOrder || financials.traderNetPayable.isZero()
          ? "not_eligible"
          : "unsettled";

      const inserted = await sql<{ id: string }>`
        insert into orders (
          company_id, order_number, serial_number, serial_number_normalized,
          reference_number, reference_number_normalized, financial_model_version,
          order_date, trader_id, area_id, created_by_account_id,
          assigned_driver_id, customer_id, customer_address_id,customer_name, customer_mobile_number,
          customer_second_mobile_number, customer_address,customer_latitude,customer_longitude,notes,
          customer_code_snapshot,customer_reference_snapshot,customer_area_code_snapshot,
          customer_area_name_snapshot,customer_area_name_ar_snapshot,area_name_fallback_used,
          customer_location_link_snapshot,customer_delivery_notes_snapshot,
          customer_provenance_status,
          package_count, payment_condition, cod_amount, service_fee, service_fee_net_amount,
          service_fee_vat_amount,additional_fees,additional_fee_vat_amount,total_deductions,
          customer_amount_due,trader_gross_payable,trader_paid_service_fee,trader_deductions,
          trader_net_payable,driver_cost,vat_amount,vat_enabled_snapshot,vat_rate_snapshot,
          vat_price_mode_snapshot,company_revenue,order_profit,delivery_status,trader_settlement_status,
          pricing_provenance_status, trader_service_price_id,
          configured_service_fee_snapshot, final_service_fee_snapshot,
          service_fee_override_reason, is_free_order, free_order_reason, order_type
        ) values (
          ${companyId}::uuid, ${orderNumber}, ${serialNumber}, ${serialNumberNormalized},
          ${referenceNumber}, ${referenceNumberNormalized}, 'trader_deduction_v1',
          current_date, ${traderRow.id}::uuid,
          ${area?.id ?? null}::uuid, ${actingAccountId}::uuid,
          ${driverRow?.id ?? null}::uuid,${customerRow?.id ?? null}::uuid,${customerAddressRow?.id ?? null}::uuid,
          ${customerName}, ${customerMobileNumber},${customerSecondMobileNumber}, ${customerAddress},
          ${latitude ?? null},${longitude ?? null},${notes},${customerRow?.code ?? null},
          ${customerRow?.customerReference ?? null},${customerAddressRow?.areaCode ?? null},${customerAddressRow?.areaNameEn ?? null},
          ${customerAddressRow?.areaNameAr ?? null},${customerAddressRow === undefined ? null : customerAddressRow.areaNameAr === null},
          ${customerLocationLink},${customerDeliveryNotes},${customerOmitted ? "not_applicable" : "resolved"},
          ${packageCount}, 'customer_pays_cod_trader_pays_fee',
          ${financials.codAmount.toFixed(2)}, ${financials.serviceFee.toFixed(2)},
          ${financials.serviceFeeNetAmount.toFixed(2)},${financials.serviceFeeVatAmount.toFixed(2)},
          ${financials.additionalFees.toFixed(2)},${financials.additionalFeeVatAmount.toFixed(2)},
          ${financials.totalDeductions.toFixed(2)},${financials.customerAmountDue.toFixed(2)},
          ${financials.codAmount.toFixed(2)},${financials.serviceFeeNetAmount.plus(financials.serviceFeeVatAmount).toFixed(2)},
          ${financials.additionalFees.plus(financials.additionalFeeVatAmount).toFixed(2)},
          ${financials.traderNetPayable.toFixed(2)},${collectOrder ? "0.00" : driverCost.toFixed(2)},
          ${financials.vatAmount.toFixed(2)},${vatPolicy.enabled},${vatPolicy.rate.toFixed(4)},
          ${vatPolicy.enabled ? vatPolicy.priceMode : null},
          ${financials.companyRevenue.toFixed(2)}, ${financials.orderProfit.toFixed(2)},
          ${deliveryStatus}, ${traderSettlementStatus},
          ${pricing.provenance}, ${pricing.servicePriceId}::uuid,
          ${pricing.configuredFee.toFixed(2)}, ${pricing.finalFee.toFixed(2)},
          ${pricing.overrideReason}, ${freeOrder}, ${freeOrderReason}, ${collectOrder ? "collect_order" : "delivery"}
        )
        returning id
      `.execute(transaction);
      const orderId = inserted.rows[0]?.id;
      if (orderId === undefined) {
        throw new Error("Order creation did not return an identifier");
      }
      await this.createOrderTraderReceivableIfNeeded(transaction, {
        actorAccountId: actingAccountId,
        amountDue: financials.traderReceivableDue,
        companyId,
        correlationId,
        orderId,
        orderNumber,
        traderId: traderRow.id,
      });

      if (driverRow !== undefined) {
        await sql`
          insert into order_assignments (
            company_id, order_id, driver_id, assigned_by_account_id
          ) values (
            ${companyId}::uuid, ${orderId}::uuid, ${driverRow.id}::uuid,
            ${actingAccountId}::uuid
          )
        `.execute(transaction);
      }

      await sql`
        insert into order_status_history (
          company_id, order_id, status_dimension, to_status, changed_by_account_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, 'delivery', ${deliveryStatus},
          ${actingAccountId}::uuid
        )
      `.execute(transaction);
      await sql`
        insert into order_events (
          company_id, order_id, event_type, event_category, field_name,
          new_value, actor_account_id, actor_role, source, correlation_id,
          related_driver_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, 'order.created', 'user_action',
          'delivery_status', to_jsonb(${deliveryStatus}::text), ${actingAccountId}::uuid,
          ${actorRole}, 'web_portal', ${correlationId}, ${driverRow?.id ?? null}::uuid
        )
      `.execute(transaction);
      if (driverRow !== undefined) {
        await sql`
          insert into order_events (
            company_id, order_id, event_type, event_category, field_name,
            new_value, actor_account_id, actor_role, source, correlation_id,
            related_driver_id
          ) values (
            ${companyId}::uuid, ${orderId}::uuid, 'order.driver_assigned',
            'driver_assignment', 'assigned_driver_id', to_jsonb(${driverRow.id}::text),
            ${actingAccountId}::uuid, ${actorRole}, 'web_portal', ${correlationId},
            ${driverRow.id}::uuid
          )
        `.execute(transaction);
      }
      await this.recordOrderUsageEvent(transaction, companyId, orderId);
      await this.audit(transaction, {
        action: "order.create",
        actorId: actingAccountId,
        after: { orderNumber, traderId: traderRow.id, driverId: driverRow?.id ?? null },
        companyId,
        correlationId,
        subjectId: orderId,
        subjectType: "order",
      });
      if (customerRow !== undefined && customerAddressRow !== undefined) {
        await this.audit(transaction, {
          action: "customer.selected_for_order",
          actorId: actingAccountId,
          after: {
            customerAddressId: customerAddressRow.id,
            customerId: customerRow.id,
            orderId,
            orderNumber,
          },
          companyId,
          correlationId,
          subjectId: customerRow.id,
          subjectType: "customer",
        });
      }

      if (pricing.overrideApplied) {
        await this.audit(transaction, {
          action: "order.service_fee_override",
          actorId: actingAccountId,
          after: {
            configuredFee: pricing.configuredFee.toFixed(2),
            overriddenFee: pricing.finalFee.toFixed(2),
            reason: pricing.overrideReason,
          },
          companyId,
          correlationId,
          subjectId: orderId,
          subjectType: "order",
        });
        await sql`
          insert into order_events (
            company_id, order_id, event_type, event_category, field_name,
            previous_value, new_value, actor_account_id, actor_role, source,
            reason, correlation_id
          ) values (
            ${companyId}::uuid, ${orderId}::uuid, 'order.service_fee_override',
            'financial_change', 'service_fee',
            to_jsonb(${pricing.configuredFee.toFixed(2)}::text),
            to_jsonb(${pricing.finalFee.toFixed(2)}::text), ${actingAccountId}::uuid,
              ${actorRole}, 'web_portal', ${pricing.overrideReason}, ${correlationId}
          )
        `.execute(transaction);
      }

      // A zero Service Fee that is NOT an override still deserves a line in the
      // Order history. It is the case the zero-fee policy exists to make
      // visible, and without this the history would simply show a zero fee with
      // no explanation of where it came from.
      //
      // Recorded as its own event type, never as an override: nobody overrode
      // anything here, and filing it under `order.service_fee_override` would
      // misattribute an ordinary configured price to a person's decision.
      if (!pricing.overrideApplied && pricing.finalFee.isZero()) {
        await sql`
          insert into order_events (
            company_id, order_id, event_type, event_category, field_name,
            previous_value, new_value, actor_account_id, actor_role, source,
            reason, correlation_id
          ) values (
            ${companyId}::uuid, ${orderId}::uuid, 'order.zero_service_fee',
            'financial_change', 'service_fee',
            to_jsonb(${pricing.configuredFee.toFixed(2)}::text),
            to_jsonb(${pricing.finalFee.toFixed(2)}::text), ${actingAccountId}::uuid,
              ${actorRole}, 'web_portal', ${pricing.overrideReason}, ${correlationId}
          )
        `.execute(transaction);
      }

      await sql`
        update idempotency_records
           set response_status = 201,
               resource_type = 'order',
               resource_id = ${orderId}::uuid,
               completed_at = now()
         where company_id = ${companyId}::uuid
           and operation = 'orders.create'
           and idempotency_key = ${key}
      `.execute(transaction);

      return {
        // The four components the capture trigger tests, computed here so a caller
        // acting on the freshly created Order sees the same classification the
        // list and detail queries will later report.
        accountingRequired: !(
          financials.codAmount.isZero() &&
          financials.serviceFee.isZero() &&
          financials.additionalFees.isZero() &&
          financials.vatAmount.isZero()
        ),
        additionalFees: financials.additionalFees.toFixed(2),
        additionalFeeVatAmount: financials.additionalFeeVatAmount.toFixed(2),
        amountCollected: "0.00",
        areaName: area?.nameAr ?? area?.nameEn ?? "",
        assignedDriverId: driverRow?.id ?? null,
        assignedDriverMobile: null,
        assignedDriverName: driverRow?.name ?? null,
        codAmount: financials.codAmount.toFixed(2),
        companyRevenue: financials.companyRevenue.toFixed(2),
        customerAmountDue: financials.customerAmountDue.toFixed(2),
        customerAddress,
        customerMobileNumber,
        customerName,
        deliveryStatus,
        driverReconciliationStatus: "not_applicable",
        id: orderId,
        orderDate: new Date().toISOString().slice(0, 10),
        orderNumber,
        orderProfit: financials.orderProfit.toFixed(2),
        outsourcedDriverFeeAmount: null,
        outsourcedDriverFeeOutstanding: null,
        outsourcedDriverFeePaid: null,
        outsourcedDriverFeePaymentNumbers: null,
        outsourcedDriverFeeStatus:
          driverRow?.outsourcedFee == null ? "not_required" : "pending_delivery",
        referenceNumber,
        returnStatus: "not_applicable",
        serialNumber,
        serviceFee: financials.serviceFee.toFixed(2),
        serviceFeeOverrideReason: pricing.overrideReason,
        serviceFeeVatAmount: financials.serviceFeeVatAmount.toFixed(2),
        totalDeductions: financials.totalDeductions.toFixed(2),
        traderNetPayable: financials.traderNetPayable.toFixed(2),
        traderName: traderRow.name,
        traderSettlementStatus: "unsettled",
        vatAmount: financials.vatAmount.toFixed(2),
      };
    });
  }

  public async quoteOrder(input: OrderQuoteDto): Promise<OperationsOrderQuote> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const area = await sql<{ id: string }>`
      select id from areas
      where id = ${input.areaId}::uuid
        and company_id = ${companyId}::uuid
        and is_active
    `.execute(this.database);
    if (area.rows[0] === undefined) {
      throw new ApplicationException(
        "area_not_found",
        "The selected area is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    const trader = await sql<{ id: string }>`
      select id from traders
      where id = ${input.traderId}::uuid
        and company_id = ${companyId}::uuid
        and account_status = 'active'
    `.execute(this.database);
    if (trader.rows[0] === undefined) {
      throw new ApplicationException(
        "trader_not_found",
        "The selected trader is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    const pricing = await this.resolveServiceFee(this.database, {
      areaId: input.areaId,
      companyId,
      permissions: identity.permissions,
      ...(input.serviceFee === undefined ? {} : { requestedFee: input.serviceFee }),
      ...(input.serviceFeeOverrideReason === undefined
        ? {}
        : { requestedReason: input.serviceFeeOverrideReason }),
      traderId: input.traderId,
    });
    const driverCost =
      input.driverId === undefined
        ? new Decimal(0)
        : await this.activeDriverCost(companyId, input.driverId);
    const vatPolicy = await this.vatPolicy(this.database, companyId);
    const financials = this.calculateOrderFinancials({
      additionalFees: new Decimal(input.additionalFees ?? 0),
      codAmount: new Decimal(input.codAmount),
      driverCost,
      prospective: true,
      serviceFee: pricing.finalFee,
      vatPolicy,
    });
    return {
      additionalFees: financials.additionalFees.toFixed(2),
      additionalFeeVatAmount: financials.additionalFeeVatAmount.toFixed(2),
      codAmount: financials.codAmount.toFixed(2),
      companyRevenue: financials.companyRevenue.toFixed(2),
      configuredServiceFee: pricing.configuredFee.toFixed(2),
      customerAmountDue: financials.customerAmountDue.toFixed(2),
      orderProfit: financials.orderProfit.toFixed(2),
      overrideApplied: pricing.overrideApplied,
      pricingProvenance: pricing.provenance,
      pricingRuleId: pricing.servicePriceId,
      serviceFee: financials.serviceFee.toFixed(2),
      serviceFeeVatAmount: financials.serviceFeeVatAmount.toFixed(2),
      totalDeductions: financials.totalDeductions.toFixed(2),
      traderNetPayable: financials.traderNetPayable.toFixed(2),
      vatAmount: financials.vatAmount.toFixed(2),
      vatEnabled: vatPolicy.enabled,
      vatPriceMode: vatPolicy.priceMode,
      vatRate: vatPolicy.rate.toFixed(4),
    };
  }

  public async identifierAvailability(
    input: OrderIdentifierAvailabilityQueryDto,
  ): Promise<{ referenceNumberAvailable: boolean; serialNumberAvailable: boolean }> {
    const { companyId } = this.tenants.current();
    const serial =
      input.serialNumber === undefined ? null : this.normalizeOrderIdentifier(input.serialNumber);
    const reference =
      input.referenceNumber === undefined || input.referenceNumber.trim() === ""
        ? null
        : this.normalizeOrderIdentifier(input.referenceNumber);
    // Serial Number availability is scoped to today's Business Date
    // (`order_date`, always `current_date` at creation), matching
    // `assertOrderIdentifiersAvailable`'s authoritative check; External
    // Reference Number availability is intentionally left company-wide
    // forever, unchanged.
    const result = await sql<{ referenceExists: boolean; serialExists: boolean }>`
      select
        (${serial}::text is not null and exists(
          select 1 from orders
          where company_id=${companyId}::uuid and order_date = current_date
            and serial_number_normalized=${serial}
        )) as "serialExists",
        (${reference}::text is not null and exists(
          select 1 from orders
          where company_id=${companyId}::uuid and reference_number_normalized=${reference}
        )) as "referenceExists"
    `.execute(this.database);
    return {
      referenceNumberAvailable: !(result.rows[0]?.referenceExists ?? false),
      serialNumberAvailable: !(result.rows[0]?.serialExists ?? false),
    };
  }

  public async nextSerialNumber(): Promise<{ serialNumber: string }> {
    const { companyId } = this.tenants.current();
    const result = await sql<{ serialNumber: string }>`
      select (coalesce(max(serial_number::bigint), 0) + 1)::text as "serialNumber"
        from orders
       where company_id=${companyId}::uuid
         and order_date=current_date
         and serial_number ~ '^[0-9]+$'
    `.execute(this.database);

    return { serialNumber: result.rows[0]?.serialNumber ?? "1" };
  }

  public async importOrdersCsv(
    input: ImportOrdersCsvDto,
    correlationId: string,
    /** Same override, same reason, as `createOrder`'s -- see that parameter's
     * doc comment. Every existing caller omits this and gets today's exact
     * behaviour: `identity.identityId`. */
    actingAccountIdOverride?: string,
  ): Promise<OperationsOrderImportResult> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const actingAccountId = actingAccountIdOverride ?? identity.identityId;
    const csv = String((input as { readonly csv?: unknown }).csv ?? "");
    const parsed = this.parseOrdersCsv(csv);
    const errors = parsed.errors.slice();
    // Validation is all-or-nothing and runs BEFORE the transaction opens, which
    // is what makes this import atomic in the way it already promised: if any
    // row is bad, nothing is written and every bad row is reported at once. The
    // importer fixes the whole file and resubmits, rather than discovering
    // problems one failed upload at a time.
    if (errors.length > 0) {
      return {
        errors,
        importNumber: "",
        importedRows: 0,
        invalidRows: errors.length,
        rows: parsed.invalid,
        totalRows: parsed.totalRows,
      };
    }
    if (parsed.rows.length === 0) {
      throw new ApplicationException(
        "orders_import_empty",
        "The import file does not contain any order rows",
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.transactions.execute(async (transaction) => {
      const importNumber = await this.nextReferenceNumber(transaction, companyId, "import", "IMP");
      const file = await sql<{ id: string }>`
        insert into file_objects (
          company_id, storage_provider, storage_key, original_filename, media_type,
          size_bytes, sha256, classification, scan_status, uploaded_by_account_id
        ) values (
          ${companyId}::uuid, 'database', ${`imports/${companyId}/${importNumber}.csv`},
          ${`${importNumber}.csv`}, 'text/csv', ${Buffer.byteLength(csv, "utf8")},
          ${createHash("sha256").update(csv).digest("hex")}, 'private', 'clean',
          ${actingAccountId}::uuid
        )
        returning id
      `.execute(transaction);
      const fileId = file.rows[0]?.id;
      if (fileId === undefined) {
        throw new Error("Import file metadata creation did not return an identifier");
      }
      const batch = await sql<{ id: string }>`
        insert into import_batches (
          company_id, import_number, import_type, source_file_id, template_version,
          status, total_rows, valid_rows, invalid_rows, imported_rows,
          requested_by_account_id, completed_at
        ) values (
          ${companyId}::uuid, ${importNumber}, 'orders', ${fileId}::uuid, 'csv-v1',
          'importing', ${parsed.totalRows}, ${parsed.rows.length}, 0, 0,
          ${actingAccountId}::uuid, null
        )
        returning id
      `.execute(transaction);
      const importBatchId = batch.rows[0]?.id;
      if (importBatchId === undefined) {
        throw new Error("Import batch creation did not return an identifier");
      }

      let importedRows = 0;
      const rowResults: OperationsOrderImportRow[] = [];
      for (const { row, rowNumber } of parsed.rows) {
        // Pricing, permissions and the zero-fee policy are all decided inside
        // `insertOrder` -> `resolveServiceFee`, so an authorization or reason
        // failure surfaces here as an ApplicationException. Left unhandled it
        // would abort the import with a message that never says WHICH line
        // caused it, so it is re-thrown with the row and reference attached.
        //
        // Re-thrown, not swallowed: this import is atomic and must stay atomic.
        // Continuing past a failed row would leave a partial import behind.
        const created = await this.insertOrder(transaction, {
          ...row,
          correlationId,
          createdByAccountId: actingAccountId,
          customerMobileNumber: row.customerMobileNumber ?? "",
          customerName: row.customerName ?? "",
          importBatchId,
        }).catch((cause: unknown) => {
          throw this.importRowFailure(cause, rowNumber, row.referenceNumber ?? null);
        });
        await this.audit(transaction, {
          action: "order.import_create",
          actorId: actingAccountId,
          after: { importNumber, orderNumber: created.orderNumber },
          companyId,
          correlationId,
          subjectId: created.id,
          subjectType: "order",
        });
        rowResults.push({
          accountingRequired: created.accountingRequired,
          errorField: null,
          errorMessage: null,
          feeSource: orderFeeSource(created.serviceFee, created.serviceFeeOverrideReason),
          orderNumber: created.orderNumber,
          referenceNumber: created.referenceNumber,
          resolvedServiceFee: created.serviceFee,
          rowNumber,
          status: "imported",
          zeroFeeReason: created.serviceFeeOverrideReason,
        });
        importedRows += 1;
      }

      await sql`
        update import_batches
           set status = 'completed',
               imported_rows = ${importedRows},
               completed_at = now()
         where id = ${importBatchId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);

      return {
        errors: [],
        importNumber,
        importedRows,
        invalidRows: 0,
        rows: rowResults,
        totalRows: parsed.totalRows,
      };
    });
  }

  /**
   * Turn a mid-import failure into something the importer can act on.
   *
   * Only the message from an ApplicationException is reused — those are written
   * for people. Anything else (a driver error, a constraint violation, a bug)
   * is replaced with a generic sentence, because its text may name a table, a
   * constraint or a query and none of that belongs in front of a user.
   *
   * The original is kept as `cause` so the log still has the whole story.
   */
  private importRowFailure(
    cause: unknown,
    rowNumber: number,
    referenceNumber: string | null,
  ): ApplicationException {
    const where =
      referenceNumber === null ? `Row ${rowNumber}` : `Row ${rowNumber} (${referenceNumber})`;
    const explanation =
      cause instanceof ApplicationException
        ? cause.message
        : "This row could not be imported. Check the Trader, Area and amounts, then try again.";
    const failure = new ApplicationException(
      cause instanceof ApplicationException ? cause.errorCode : "orders_import_row_failed",
      `${where}: ${explanation}`,
      cause instanceof ApplicationException ? cause.getStatus() : HttpStatus.UNPROCESSABLE_ENTITY,
    );
    (failure as { cause?: unknown }).cause = cause;
    return failure;
  }

  // Edits an order's business fields before delivery. Changing the Trader, or the Customer +
  // address (which sets the Area), re-prices the order. Recomputes VAT and the customer/trader
  // money whenever COD, the fee, the Trader, or the Area changes, and records one order_events
  // row per changed field (old -> new) so the audit shows exactly what the user changed.
  public async updateOrder(
    orderId: string,
    input: UpdateOrderDto,
    correlationId: string,
    requiredTraderId?: string,
  ): Promise<OperationsOrder> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    await this.transactions.execute(async (transaction) => {
      const current = (
        await sql<{
          areaId: string;
          areaNameSnapshot: string | null;
          codAmount: string;
          companyRevenue: string;
          configuredFee: string | null;
          customerAddress: string;
          customerAddressId: string;
          customerAmountDue: string;
          customerCodeSnapshot: string | null;
          customerId: string;
          customerMobileNumber: string;
          customerName: string;
          customerSecondMobileNumber: string | null;
          deliveryStatus: string;
          driverCost: string;
          financialModelVersion: string | null;
          additionalFees: string | null;
          vatEnabledSnapshot: boolean | null;
          vatPriceModeSnapshot: "exclusive" | "inclusive" | null;
          vatRateSnapshot: string | null;
          notes: string | null;
          orderDate: string;
          orderProfit: string;
          packageCount: number;
          pricingProvenance: string;
          referenceNumber: string | null;
          serialNumber: string;
          serviceFee: string;
          traderId: string;
          traderName: string;
          traderNetPayable: string;
          traderServicePriceId: string | null;
          vatAmount: string;
        }>`
          select o.area_id as "areaId",
                 o.customer_area_name_snapshot as "areaNameSnapshot",
                 o.cod_amount::text as "codAmount",
                 o.company_revenue::text as "companyRevenue",
                 o.configured_service_fee_snapshot::text as "configuredFee",
                 o.customer_address as "customerAddress",
                 o.customer_address_id as "customerAddressId",
                 o.customer_amount_due::text as "customerAmountDue",
                 o.customer_code_snapshot as "customerCodeSnapshot",
                 o.customer_id as "customerId",
                 o.customer_mobile_number as "customerMobileNumber",
                 o.customer_name as "customerName",
                 o.customer_second_mobile_number as "customerSecondMobileNumber",
                 o.delivery_status as "deliveryStatus",
                 o.driver_cost::text as "driverCost",
                 o.financial_model_version as "financialModelVersion",
                 o.additional_fees::text as "additionalFees",
                 o.vat_enabled_snapshot as "vatEnabledSnapshot",
                 o.vat_price_mode_snapshot as "vatPriceModeSnapshot",
                 o.vat_rate_snapshot::text as "vatRateSnapshot",
                 o.notes,
                 o.order_date::text as "orderDate",
                 o.order_profit::text as "orderProfit",
                 o.package_count as "packageCount",
                 o.pricing_provenance_status as "pricingProvenance",
                 o.reference_number as "referenceNumber",
                 o.serial_number as "serialNumber",
                 o.service_fee::text as "serviceFee",
                 o.trader_id as "traderId",
                 t.name_en as "traderName",
                 o.trader_net_payable::text as "traderNetPayable",
                 o.trader_service_price_id as "traderServicePriceId",
                 o.vat_amount::text as "vatAmount"
          from orders o
          join traders t on t.id = o.trader_id and t.company_id = o.company_id
          where o.id = ${orderId}::uuid and o.company_id = ${companyId}::uuid
            and (${requiredTraderId ?? null}::uuid is null
              or o.trader_id=${requiredTraderId ?? null}::uuid)
          for update of o
        `.execute(transaction)
      ).rows[0];
      if (current === undefined) {
        throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
      }
      if (
        !["new", "in_branch", "assigned_to_driver", "out_for_delivery"].includes(
          current.deliveryStatus,
        )
      ) {
        throw new ApplicationException(
          "order_edit_not_allowed",
          "An order can only be edited before it is delivered",
          HttpStatus.CONFLICT,
        );
      }

      const changes: {
        category: string;
        field: string;
        next: string | null;
        previous: string | null;
        reason: string | null;
      }[] = [];
      const track = (
        field: string,
        category: string,
        before: string | null,
        after: string | null,
      ) => {
        if ((before ?? null) !== (after ?? null)) {
          changes.push({ category, field, next: after, previous: before, reason: null });
        }
      };

      const serialNumber = input.serialNumber ?? current.serialNumber;
      const serialNumberNormalized = this.normalizeOrderIdentifier(serialNumber);
      const referenceNumber =
        input.referenceNumber === undefined ? current.referenceNumber : input.referenceNumber;
      const referenceNumberNormalized =
        referenceNumber === null ? null : this.normalizeOrderIdentifier(referenceNumber);
      if (serialNumber !== current.serialNumber || referenceNumber !== current.referenceNumber) {
        const duplicate = await sql<{ referenceExists: boolean; serialExists: boolean }>`
          select exists(select 1 from orders where company_id=${companyId}::uuid
            and id<>${orderId}::uuid and order_date=${current.orderDate}::date
            and serial_number_normalized=${serialNumberNormalized}) as "serialExists",
            exists(select 1 from orders where company_id=${companyId}::uuid
            and id<>${orderId}::uuid and ${referenceNumberNormalized}::text is not null
            and reference_number_normalized=${referenceNumberNormalized}) as "referenceExists"
        `.execute(transaction);
        if (duplicate.rows[0]?.serialExists) {
          throw new ApplicationException(
            "order_serial_already_exists_for_date",
            `Serial Number "${serialNumber}" is already used on this date`,
            HttpStatus.CONFLICT,
          );
        }
        if (duplicate.rows[0]?.referenceExists) {
          throw new ApplicationException(
            "reference_number_exists",
            `Reference Number "${referenceNumber}" is already used`,
            HttpStatus.CONFLICT,
          );
        }
        track("serial_number", "user_action", current.serialNumber, serialNumber);
        track("reference_number", "user_action", current.referenceNumber, referenceNumber);
      }

      // --- Trader change ------------------------------------------------------
      const traderChanged = input.traderId !== undefined && input.traderId !== current.traderId;
      let traderId = current.traderId;
      if (traderChanged) {
        const row = (
          await sql<{ id: string; name: string }>`
            select id, name_en as name from traders
            where id = ${input.traderId}::uuid and company_id = ${companyId}::uuid
              and account_status = 'active'
          `.execute(transaction)
        ).rows[0];
        if (row === undefined) {
          throw new ApplicationException(
            "trader_not_found",
            "The selected Trader is not active in this Company",
            HttpStatus.BAD_REQUEST,
          );
        }
        traderId = row.id;
        track("trader", "user_action", current.traderName, row.name);
      }

      // --- Customer + address change (sets the Area) --------------------------
      const customerChanged =
        (input.customerId !== undefined && input.customerId !== current.customerId) ||
        (input.customerAddressId !== undefined &&
          input.customerAddressId !== current.customerAddressId);
      let areaId = current.areaId;
      let customerColumns:
        | {
            addressId: string;
            areaCode: string;
            areaName: string;
            areaNameAr: string | null;
            code: string;
            customerId: string;
            deliveryNotes: string | null;
            locationLink: string | null;
            reference: string | null;
          }
        | undefined;
      if (customerChanged) {
        if (input.customerId === undefined || input.customerAddressId === undefined) {
          throw new ApplicationException(
            "customer_change_incomplete",
            "Select the Customer and one of their addresses together",
            HttpStatus.BAD_REQUEST,
          );
        }
        const cust = (
          await sql<{
            code: string;
            customerReference: string | null;
            deliveryNotes: string | null;
            id: string;
          }>`
            select id, code, customer_reference as "customerReference",
                   delivery_notes as "deliveryNotes"
            from customers
            where id = ${input.customerId}::uuid and company_id = ${companyId}::uuid
              and status = 'active'
          `.execute(transaction)
        ).rows[0];
        if (cust === undefined) {
          throw new ApplicationException(
            "customer_not_found",
            "The selected Customer is not active in this Company",
            HttpStatus.BAD_REQUEST,
          );
        }
        const addr = (
          await sql<{
            areaCode: string;
            areaId: string;
            areaName: string;
            areaNameAr: string | null;
            deliveryInstructions: string | null;
            id: string;
            locationLink: string | null;
          }>`
            select ca.id, ca.area_id as "areaId", a.code as "areaCode",
                   a.name_en as "areaName", a.name_ar as "areaNameAr",
                   ca.location_link as "locationLink",
                   ca.delivery_instructions as "deliveryInstructions"
            from customer_addresses ca
            join areas a on a.id = ca.area_id and a.company_id = ca.company_id and a.is_active
            where ca.id = ${input.customerAddressId}::uuid and ca.customer_id = ${cust.id}::uuid
              and ca.company_id = ${companyId}::uuid and ca.is_active
          `.execute(transaction)
        ).rows[0];
        if (addr === undefined) {
          throw new ApplicationException(
            "customer_address_not_found",
            "The selected Customer address is not available",
            HttpStatus.BAD_REQUEST,
          );
        }
        areaId = addr.areaId;
        customerColumns = {
          addressId: addr.id,
          areaCode: addr.areaCode,
          areaName: addr.areaName,
          areaNameAr: addr.areaNameAr,
          code: cust.code,
          customerId: cust.id,
          deliveryNotes: addr.deliveryInstructions ?? cust.deliveryNotes,
          locationLink: addr.locationLink,
          reference: cust.customerReference,
        };
        track("customer", "user_action", current.customerCodeSnapshot, cust.code);
        track("delivery_area", "user_action", current.areaNameSnapshot, addr.areaName);
      }

      // A directly selected Area is valid for manually entered/optional Customers too.
      // It deliberately wins over the previous Area when no saved Customer address was
      // selected in this edit.
      if (!customerChanged && input.areaId !== undefined && input.areaId !== current.areaId) {
        const selectedArea = (
          await sql<{ id: string; name: string }>`
            select id, name_en as name from areas
             where id=${input.areaId}::uuid and company_id=${companyId}::uuid and is_active
          `.execute(transaction)
        ).rows[0];
        if (selectedArea === undefined) {
          throw new ApplicationException(
            "area_not_found",
            "The selected Area is not active in this Company",
            HttpStatus.BAD_REQUEST,
          );
        }
        areaId = selectedArea.id;
        track("delivery_area", "user_action", current.areaNameSnapshot, selectedArea.name);
        customerColumns = {
          addressId: current.customerAddressId,
          areaCode: "",
          areaName: selectedArea.name,
          areaNameAr: null,
          code: current.customerCodeSnapshot ?? "",
          customerId: current.customerId,
          deliveryNotes: null,
          locationLink: null,
          reference: null,
        };
      }

      // --- Pricing ------------------------------------------------------------
      const areaChanged = areaId !== current.areaId;
      const identityRepriced = traderChanged || areaChanged;
      const currentCod = new Decimal(current.codAmount);
      const currentFee = new Decimal(current.serviceFee);
      const nextCod = input.codAmount === undefined ? currentCod : new Decimal(input.codAmount);
      const codChanged = !this.money(nextCod).equals(this.money(currentCod));
      const manualFeeProvided = input.serviceFee !== undefined;
      const manualFee = manualFeeProvided ? new Decimal(input.serviceFee ?? 0) : currentFee;
      const manualFeeChanged =
        !identityRepriced &&
        manualFeeProvided &&
        !this.money(manualFee).equals(this.money(currentFee));

      if (manualFeeChanged) {
        if (
          !identity.permissions.has("orders.override_service_fee") &&
          !identity.permissions.has("users_roles.manage")
        ) {
          throw new ApplicationException(
            "service_fee_override_denied",
            "You do not have permission to change the service fee",
            HttpStatus.FORBIDDEN,
          );
        }
        if ((input.serviceFeeReason ?? "").trim() === "") {
          throw new ApplicationException(
            "service_fee_override_reason_required",
            "A reason is required to change the service fee",
            HttpStatus.BAD_REQUEST,
          );
        }
      }

      // When the Trader or Area changes, re-run pricing so provenance/rule follow the new
      // context; otherwise a supplied fee is a manual override of the existing price.
      const pricing = identityRepriced
        ? await this.resolveServiceFee(transaction, {
            areaId,
            companyId,
            permissions: identity.permissions,
            ...(input.serviceFee === undefined ? {} : { requestedFee: input.serviceFee }),
            ...(input.serviceFeeReason === undefined
              ? {}
              : { requestedReason: input.serviceFeeReason }),
            traderId,
          })
        : null;
      const finalFee = pricing ? pricing.finalFee : manualFeeProvided ? manualFee : currentFee;
      const feeValueChanged = !this.money(finalFee).equals(this.money(currentFee));

      const isProspective = current.financialModelVersion === "trader_deduction_v1";
      const currentVatPolicy = isProspective
        ? {
            enabled: current.vatEnabledSnapshot ?? false,
            priceMode: current.vatPriceModeSnapshot,
            rate: new Decimal(current.vatRateSnapshot ?? 0),
          }
        : await this.vatPolicy(transaction, companyId);
      const financials = this.calculateOrderFinancials({
        additionalFees: new Decimal(input.additionalFees ?? current.additionalFees ?? 0),
        codAmount: nextCod,
        driverCost: new Decimal(current.driverCost),
        prospective: isProspective,
        serviceFee: finalFee,
        vatPolicy: currentVatPolicy,
      });

      const next = {
        customerAddress: input.customerAddress?.trim() ?? current.customerAddress,
        customerMobileNumber: input.customerMobileNumber?.trim() ?? current.customerMobileNumber,
        customerName: input.customerName?.trim() ?? current.customerName,
        customerSecondMobileNumber:
          input.customerSecondMobileNumber === undefined
            ? current.customerSecondMobileNumber
            : input.customerSecondMobileNumber.trim() || null,
        notes: input.notes === undefined ? current.notes : input.notes.trim() || null,
        packageCount: input.packageCount ?? current.packageCount,
      };

      track("customer_name", "user_action", current.customerName, next.customerName);
      track(
        "customer_mobile_number",
        "user_action",
        current.customerMobileNumber,
        next.customerMobileNumber,
      );
      track(
        "customer_second_mobile_number",
        "user_action",
        current.customerSecondMobileNumber,
        next.customerSecondMobileNumber,
      );
      track("customer_address", "user_action", current.customerAddress, next.customerAddress);
      track(
        "package_count",
        "user_action",
        String(current.packageCount),
        String(next.packageCount),
      );
      track("notes", "user_action", current.notes, next.notes);
      if (codChanged) {
        changes.push({
          category: "financial_change",
          field: "cod_amount",
          next: this.money(nextCod).toFixed(2),
          previous: this.money(currentCod).toFixed(2),
          reason: null,
        });
      }
      if (feeValueChanged) {
        changes.push({
          category: "financial_change",
          field: "service_fee",
          next: this.money(finalFee).toFixed(2),
          previous: this.money(currentFee).toFixed(2),
          reason: (input.serviceFeeReason ?? "").trim() || null,
        });
      }
      if (
        input.additionalFees !== undefined &&
        !this.money(new Decimal(input.additionalFees)).equals(
          this.money(new Decimal(current.additionalFees ?? 0)),
        )
      ) {
        changes.push({
          category: "financial_change",
          field: "additional_fees",
          next: this.money(new Decimal(input.additionalFees)).toFixed(2),
          previous: this.money(new Decimal(current.additionalFees ?? 0)).toFixed(2),
          reason: null,
        });
      }

      if (changes.length === 0) return;

      const financial = {
        codAmount: financials.codAmount.toFixed(2),
        companyRevenue: financials.companyRevenue.toFixed(2),
        customerAmountDue: financials.customerAmountDue.toFixed(2),
        orderProfit: financials.orderProfit.toFixed(2),
        serviceFee: financials.serviceFee.toFixed(2),
        traderNetPayable: financials.traderNetPayable.toFixed(2),
        vatAmount: financials.vatAmount.toFixed(2),
      };
      // Pricing identity columns: re-resolved when Trader/Area changed, otherwise kept (a
      // manual fee edit only moves the final fee, not the provenance).
      const pricingProvenance = pricing ? pricing.provenance : current.pricingProvenance;
      const traderServicePriceId = pricing ? pricing.servicePriceId : current.traderServicePriceId;
      const configuredFeeSnapshot = pricing
        ? pricing.configuredFee.toFixed(2)
        : current.configuredFee;

      await sql`
        update orders
           set serial_number=${serialNumber},
               serial_number_normalized=${serialNumberNormalized},
               reference_number=${referenceNumber},
               reference_number_normalized=${referenceNumberNormalized},
               trader_id = ${traderId}::uuid,
               customer_id = ${customerColumns?.customerId ?? current.customerId}::uuid,
               customer_address_id = ${
                 customerColumns?.addressId ?? current.customerAddressId
               }::uuid,
               area_id = ${areaId}::uuid,
               customer_code_snapshot = ${customerColumns?.code ?? current.customerCodeSnapshot},
               customer_reference_snapshot = case when ${customerColumns !== undefined}
                 then ${customerColumns?.reference ?? null} else customer_reference_snapshot end,
               customer_area_code_snapshot = case when ${customerColumns !== undefined}
                 then ${customerColumns?.areaCode ?? null} else customer_area_code_snapshot end,
               customer_area_name_snapshot = ${
                 customerColumns?.areaName ?? current.areaNameSnapshot
               },
               customer_area_name_ar_snapshot = case when ${customerColumns !== undefined}
                 then ${customerColumns?.areaNameAr ?? null}
                 else customer_area_name_ar_snapshot end,
               area_name_fallback_used = case when ${customerColumns !== undefined}
                 then ${customerColumns?.areaNameAr === null}
                 else area_name_fallback_used end,
               customer_location_link_snapshot = case when ${customerColumns !== undefined}
                 then ${customerColumns?.locationLink ?? null}
                 else customer_location_link_snapshot end,
               customer_delivery_notes_snapshot = case when ${customerColumns !== undefined}
                 then ${customerColumns?.deliveryNotes ?? null}
                 else customer_delivery_notes_snapshot end,
               pricing_provenance_status = ${pricingProvenance},
               trader_service_price_id = ${traderServicePriceId}::uuid,
               configured_service_fee_snapshot = ${configuredFeeSnapshot},
               final_service_fee_snapshot = ${financial.serviceFee},
               customer_name = ${next.customerName},
               customer_mobile_number = ${next.customerMobileNumber},
               customer_second_mobile_number = ${next.customerSecondMobileNumber},
               customer_address = ${next.customerAddress},
               package_count = ${next.packageCount},
               notes = ${next.notes},
               cod_amount = ${financial.codAmount},
               service_fee = ${financial.serviceFee},
               service_fee_net_amount = case when ${isProspective}
                 then ${financials.serviceFeeNetAmount.toFixed(2)}
                 else service_fee_net_amount end,
               service_fee_vat_amount = case when ${isProspective}
                 then ${financials.serviceFeeVatAmount.toFixed(2)}
                 else service_fee_vat_amount end,
               additional_fees = case when ${isProspective}
                 then ${financials.additionalFees.toFixed(2)}
                 else additional_fees end,
               additional_fee_vat_amount = case when ${isProspective}
                 then ${financials.additionalFeeVatAmount.toFixed(2)}
                 else additional_fee_vat_amount end,
               total_deductions = case when ${isProspective}
                 then ${financials.totalDeductions.toFixed(2)}
                 else total_deductions end,
               vat_amount = ${financial.vatAmount},
               customer_amount_due = ${financial.customerAmountDue},
               company_revenue = ${financial.companyRevenue},
               trader_gross_payable = ${financial.codAmount},
               trader_paid_service_fee = case when ${isProspective}
                 then ${financials.serviceFeeNetAmount
                   .plus(financials.serviceFeeVatAmount)
                   .toFixed(2)}
                 else ${financial.serviceFee} end,
               trader_deductions = case when ${isProspective}
                 then ${financials.additionalFees
                   .plus(financials.additionalFeeVatAmount)
                   .toFixed(2)}
                 else trader_deductions end,
               trader_net_payable = ${financial.traderNetPayable},
               order_profit = ${financial.orderProfit},
               updated_at = now(),
               version = version + 1
         where id = ${orderId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);

      const role = await sql<{ name: string }>`
        select coalesce(string_agg(distinct r.name, ', ' order by r.name), a.account_kind) as name
        from accounts a
        left join account_roles ar on ar.account_id = a.id and ar.company_id = a.company_id
        left join roles r on r.id = ar.role_id and r.company_id = ar.company_id
        where a.id = ${identity.identityId}::uuid and a.company_id = ${companyId}::uuid
        group by a.id
      `.execute(transaction);
      const actorRole = role.rows[0]?.name ?? identity.kind;
      for (const change of changes) {
        await sql`
          insert into order_events (
            company_id, order_id, event_type, event_category, field_name,
            previous_value, new_value, actor_account_id, actor_role, source,
            reason, correlation_id
          ) values (
            ${companyId}::uuid, ${orderId}::uuid, 'order.updated', ${change.category},
            ${change.field},
            ${change.previous === null ? null : sql`to_jsonb(${change.previous}::text)`},
            ${change.next === null ? null : sql`to_jsonb(${change.next}::text)`},
            ${identity.identityId}::uuid, ${actorRole}, 'web_portal',
            ${change.reason}, ${correlationId}
          )
        `.execute(transaction);
      }
      await this.audit(transaction, {
        action: "order.update",
        actorId: identity.identityId,
        after: { changedFields: changes.map((change) => change.field) },
        companyId,
        correlationId,
        subjectId: orderId,
        subjectType: "order",
      });
    });
    return this.orderById(companyId, orderId);
  }

  public async changeOrderStatus(
    orderId: string,
    input: ChangeOrderStatusDto,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<OperationsOrder> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const status = input.status;
    // Driver Order Detail status-action fix: the guard on this route no
    // longer requires any permission (see `operations.controller.ts`), so
    // authorization is decided here. A plain Operator still needs one of
    // these two — completely unchanged from before.
    const hasOperatorStatusPermission =
      identity.permissions.has("orders.update_delivery_status") ||
      identity.permissions.has("users_roles.manage");
    // A "Driver User" — a `company_user` whose linked Employee backs a
    // `drivers.employee_id` record (`currentEmployeeDriverId`) — reaches this
    // SAME endpoint (a `company_user` can never call the driver-only
    // `/portal/driver/*` routes) but may hold none of the Operator
    // permissions above; that must not block them from managing their OWN
    // Driver's Orders, exactly like a genuine `driver`-kind identity needs no
    // permission at all. Resolved only when actually needed (an ordinary
    // Operator with the right permission never pays for this extra lookup).
    const ownDriverIdForStatusChange =
      identity.kind === "company_user" && !hasOperatorStatusPermission
        ? await this.currentEmployeeDriverId()
        : undefined;
    const actingAsDriverUser = ownDriverIdForStatusChange !== undefined;
    if (identity.kind === "company_user" && !hasOperatorStatusPermission && !actingAsDriverUser) {
      // No broad Operator permission, and not a Driver User either (no
      // linked Driver at all) — the same rejection the guard used to give,
      // just relocated here.
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
    // Prompt 16 (Driver offline sync): a Driver's queued offline mutation
    // carries a stable idempotency key so a retried sync submission (app
    // kill, timeout, duplicate reconnect attempt) can never create a second
    // status-history/event row for the same logical action. Optional and
    // driver-only by construction — Operator's own call site never passes a
    // key, so this reservation dance never runs for it and its behavior is
    // byte-for-byte unchanged. Mirrors `createOrder`'s exact
    // `idempotency_records` pattern (reservation -> on conflict, compare
    // request hash -> replay or reject).
    const key = identity.kind === "driver" ? idempotencyKey?.trim() : undefined;
    if (key !== undefined && key !== "" && !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
      throw new ApplicationException(
        "idempotency_key_invalid",
        "A valid idempotency key is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const requestHash =
      key === undefined || key === ""
        ? undefined
        : createHash("sha256")
            .update(
              JSON.stringify({
                expectedStatus: input.expectedStatus ?? null,
                orderId,
                reason: input.reason?.trim() || null,
                status,
              }),
            )
            .digest("hex");
    await this.transactions.execute(async (transaction) => {
      if (key !== undefined && key !== "" && requestHash !== undefined) {
        const reservation = await sql<{ id: string }>`
          insert into idempotency_records (
            company_id, operation, idempotency_key, request_hash, expires_at
          ) values (
            ${companyId}::uuid, 'driver.order_status_change', ${key}, ${requestHash},
            now() + interval '24 hours'
          )
          on conflict (company_id, operation, idempotency_key) do nothing
          returning id
        `.execute(transaction);
        if (reservation.rows[0] === undefined) {
          const existing = await sql<{ requestHash: string; resourceId: string | null }>`
            select request_hash as "requestHash", resource_id as "resourceId"
              from idempotency_records
             where company_id = ${companyId}::uuid
               and operation = 'driver.order_status_change'
               and idempotency_key = ${key}
             for update
          `.execute(transaction);
          const record = existing.rows[0];
          if (record === undefined || record.requestHash !== requestHash) {
            throw new ApplicationException(
              "idempotency_key_reused",
              "This submission key was already used for a different status change",
              HttpStatus.CONFLICT,
            );
          }
          if (record.resourceId !== null) {
            // The exact same mutation already completed — a safe replay, not
            // a second logical action. No new history/event row is written.
            return;
          }
          throw new ApplicationException(
            "order_status_change_in_progress",
            "This status change is still being processed",
            HttpStatus.CONFLICT,
          );
        }
      }
      const current = await sql<{
        amountCollected: string;
        assignedDriverId: string | null;
        customerAmountDue: string;
        deliveryStatus: string;
        driverReconciliationStatus: string;
        isFreeOrder: boolean;
        orderType: string;
        returnStatus: string;
        settlementStatus: string;
        traderNetPayable: string;
      }>`
        select amount_collected::text as "amountCollected",
               assigned_driver_id as "assignedDriverId",
               customer_amount_due::text as "customerAmountDue",
               delivery_status as "deliveryStatus",
               driver_reconciliation_status as "driverReconciliationStatus",
               is_free_order as "isFreeOrder",
               order_type as "orderType",
               return_status as "returnStatus",
               trader_settlement_status as "settlementStatus",
               trader_net_payable::text as "traderNetPayable"
        from orders
        where id = ${orderId}::uuid
          and company_id = ${companyId}::uuid
          and (
            ${identity.kind} <> 'driver'
            or assigned_driver_id = ${identity.profileId ?? null}::uuid
          )
          and (
            ${!actingAsDriverUser}
            or assigned_driver_id = ${ownDriverIdForStatusChange ?? null}::uuid
          )
        for update
      `.execute(transaction);
      const order = current.rows[0];
      if (order === undefined) {
        throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
      }
      // Prompt 16 Section O/P: the Order changed while the caller was
      // offline in a way its queued action did not anticipate — reject
      // rather than silently overwrite newer server state. Excludes the
      // "already applied" case just below, which is a safe no-op, not a
      // conflict.
      if (
        input.expectedStatus !== undefined &&
        input.expectedStatus !== order.deliveryStatus &&
        order.deliveryStatus !== status
      ) {
        throw new ApplicationException(
          "order_status_conflict",
          "This Order changed since it was last synced",
          HttpStatus.CONFLICT,
        );
      }
      // Section P Case 1/4: the target state was already reached (this
      // exact request already succeeded under a different sync attempt, or
      // another session/actor reached the same state independently). Resolve
      // as already-applied rather than re-running the transition — no
      // duplicate history/event row.
      if (order.deliveryStatus === status) {
        if (key !== undefined && key !== "") {
          await sql`
            update idempotency_records
               set response_status = 200, resource_type = 'order', resource_id = ${orderId}::uuid
             where company_id = ${companyId}::uuid and operation = 'driver.order_status_change'
               and idempotency_key = ${key}
          `.execute(transaction);
        }
        return;
      }
      const reason = input.reason?.trim() || null;
      // Driver Physical Correction (Section F): "Hold" is not a new status —
      // it already exists for Operations (`operationsTransitions` below) with
      // its own reason requirement and audit/history recording, both handled
      // identically regardless of identity kind by the shared code after this
      // lookup. The Driver's own approved action set is deliberately narrower
      // than Operations' full lifecycle: `assigned_to_driver` only ever moves
      // forward to `out_for_delivery` ("Start Delivery"); once Out for
      // Delivery, a Driver may additionally Hold it (their own no-move-yet
      // case, e.g. customer unreachable), Deliver it, or Return it to Branch.
      // Deliberately NOT included for a Driver: assigning/reassigning,
      // `cancelled`, `returned_to_trader`, or resuming an Order OUT of Hold —
      // those remain Operations-only, unchanged from before this correction.
      const driverTransitions: Readonly<Record<string, readonly string[]>> = {
        assigned_to_driver: ["out_for_delivery"],
        out_for_delivery: ["hold", "delivered", "returned_to_branch"],
        collect_order: ["closed"],
      };
      // Operations/admin can drive every step of the lifecycle, including the
      // driver-facing moves (out for delivery, delivered, return to branch),
      // recorded against the operator's identity for the audit trail.
      const operationsTransitions: Readonly<Record<string, readonly string[]>> = {
        new: ["in_branch", "hold", "cancelled"],
        in_branch: ["cancelled"],
        assigned_to_driver: ["out_for_delivery", "hold", "cancelled"],
        out_for_delivery: ["hold", "delivered", "returned_to_branch", "cancelled"],
        hold: ["out_for_delivery", "delivered", "returned_to_trader", "cancelled"],
        delivered: ["closed"],
        returned_to_branch: ["returned_to_trader"],
        returned_to_trader: ["closed"],
        collect_order: ["closed"],
      };
      // A Driver User gets exactly the narrow set a genuine Driver gets here
      // too — never the broader Operator lifecycle, regardless of holding
      // `orders.assign_driver` or any other Orders permission on their Role.
      const transitions =
        identity.kind === "driver" || actingAsDriverUser
          ? driverTransitions
          : operationsTransitions;
      if (!(transitions[order.deliveryStatus] ?? []).includes(status)) {
        throw new ApplicationException(
          "order_status_transition_invalid",
          "This Delivery Status change is not allowed for the current Order and account",
          HttpStatus.CONFLICT,
        );
      }
      if (
        ["hold", "cancelled", "returned_to_branch", "returned_to_trader"].includes(status) &&
        reason === null
      ) {
        throw new ApplicationException(
          "order_status_reason_required",
          status === "hold"
            ? "A Hold reason is required."
            : status === "cancelled"
              ? "A cancellation reason is required"
              : "A return reason is required",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (
        (status === "out_for_delivery" || status === "delivered") &&
        order.assignedDriverId === null
      ) {
        throw new ApplicationException(
          "order_driver_required_for_delivery",
          status === "out_for_delivery"
            ? "A Driver must be assigned before this Order can be moved Out for Delivery."
            : "A Driver must be assigned before this Order can be delivered.",
          HttpStatus.CONFLICT,
        );
      }
      if (status === "closed") {
        const cashComplete = ["reconciled", "not_applicable"].includes(
          order.driverReconciliationStatus,
        );
        const settlementComplete = [
          "money_sent_to_trader",
          "money_received_by_trader",
          "not_eligible",
        ].includes(order.settlementStatus);
        const returnComplete =
          order.deliveryStatus !== "returned_to_trader" ||
          order.returnStatus === "returned_to_trader";
        if (!cashComplete || !settlementComplete || !returnComplete) {
          throw new ApplicationException(
            "order_close_ineligible",
            "Driver Cash, Trader Settlement, and Return processing must be complete before closing",
            HttpStatus.CONFLICT,
          );
        }
      }

      const amountDue = Number(order.customerAmountDue);
      const traderPayable = Number(order.traderNetPayable);
      const deliveredFreeNoValue =
        status === "delivered" &&
        order.isFreeOrder === true &&
        amountDue === 0 &&
        traderPayable === 0;
      const amountCollected =
        status === "hold" ? Number(order.amountCollected) : status === "delivered" ? amountDue : 0;
      const reconciliationStatus =
        status === "hold"
          ? order.driverReconciliationStatus
          : status === "delivered" &&
              order.assignedDriverId !== null &&
              amountDue > 0 &&
              !deliveredFreeNoValue
            ? "pending"
            : status === "closed"
              ? order.driverReconciliationStatus
              : "not_applicable";
      const returnStatus =
        status === "hold"
          ? order.returnStatus
          : status === "returned_to_branch" || status === "returned_to_trader"
            ? status
            : status === "closed"
              ? order.returnStatus
              : "not_applicable";
      const traderSettlementStatus =
        status === "hold"
          ? order.settlementStatus
          : status === "cancelled" ||
              status === "returned_to_branch" ||
              status === "returned_to_trader"
            ? "not_eligible"
            : deliveredFreeNoValue
              ? "not_eligible"
              : status === "closed" || status === "in_branch"
                ? order.settlementStatus
                : "unsettled";
      await sql`
        update orders
           set delivery_status = ${status},
               delivery_reason = ${reason},
               amount_collected = case when ${status} = 'closed' then amount_collected else ${amountCollected} end,
               driver_reconciliation_status = ${reconciliationStatus},
               trader_settlement_status = ${traderSettlementStatus},
               return_status = ${returnStatus},
               delivered_at = case when ${status} = 'delivered' then now() else delivered_at end,
               operational_completed_at = case
                 when ${status} in ('delivered', 'returned_to_trader', 'cancelled')
                 then coalesce(operational_completed_at, now()) else operational_completed_at end,
               closed_at = case when ${status} = 'closed' then now() else null end,
               updated_at = now(),
               version = version + 1
         where id = ${orderId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await sql`
        insert into order_status_history (
          company_id, order_id, status_dimension, from_status, to_status,
          reason, changed_by_account_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, 'delivery',
          ${order.deliveryStatus}, ${status}, ${reason},
          ${identity.identityId}::uuid
        )
      `.execute(transaction);
      const role = await sql<{ name: string }>`
        select coalesce(string_agg(distinct r.name, ', ' order by r.name), a.account_kind) as name
        from accounts a
        left join account_roles ar on ar.account_id = a.id and ar.company_id = a.company_id
        left join roles r on r.id = ar.role_id and r.company_id = ar.company_id
        where a.id = ${identity.identityId}::uuid and a.company_id = ${companyId}::uuid
        group by a.id
      `.execute(transaction);
      await sql`
        insert into order_events (
          company_id, order_id, event_type, event_category, field_name,
          previous_value, new_value, actor_account_id, actor_role, source,
          reason, correlation_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, ${`order.${status}`}, 'status_change',
          'delivery_status', to_jsonb(${order.deliveryStatus}::text), to_jsonb(${status}::text),
          ${identity.identityId}::uuid, ${role.rows[0]?.name ?? identity.kind},
          ${identity.kind === "driver" ? "driver_mobile_app" : "web_portal"},
          ${reason}, ${correlationId}
        )
      `.execute(transaction);
      await this.audit(transaction, {
        action: "order.delivery_status_change",
        actorId: identity.identityId,
        after: { from: order.deliveryStatus, to: status },
        companyId,
        correlationId,
        subjectId: orderId,
        subjectType: "order",
      });
      // Trader push: the statuses that actually change what a Trader would
      // want to know, not every internal step (Section O: "keep this
      // operational, not noisy").
      if (
        [
          "out_for_delivery",
          "delivered",
          "returned_to_branch",
          "returned_to_trader",
          "cancelled",
        ].includes(status)
      ) {
        await this.pushOutbox.writeOrderStatusChanged(transaction, {
          companyId,
          orderId,
          newStatus: status,
          correlationId,
        });
      }
      if (status === "delivered") {
        await this.outsourcedDriverFees.createForDeliveredOrder(
          transaction,
          orderId,
          identity.identityId,
          correlationId,
        );
        // Employee Drivers accrue per-delivery earnings here, in the SAME
        // transaction as the status change: the accrual reads the delivered_at
        // this statement just wrote, and an outside transaction would still see
        // the pre-delivery null. It rolls back with the delivery for the same
        // reason — an earning for a delivery that did not stick is not owed.
        //
        // Returns null for Orders with no employee Driver or no rule in force,
        // and the existing earning on a replay. Neither is an error, so the
        // result is deliberately not inspected: nothing downstream depends on
        // it, and this must never be the reason a delivery fails to record.
        await this.employeeDeliveryEarnings.accrueForDelivery(transaction, orderId);
      }
      if (key !== undefined && key !== "") {
        await sql`
          update idempotency_records
             set response_status = 200, resource_type = 'order', resource_id = ${orderId}::uuid
           where company_id = ${companyId}::uuid and operation = 'driver.order_status_change'
             and idempotency_key = ${key}
        `.execute(transaction);
      }
    });
    return this.orderById(companyId, orderId);
  }

  public async settleOrderTrader(
    orderId: string,
    input: FinancialPaymentDto = {},
    correlationId: string,
  ): Promise<OperationsOrder> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    await this.transactions.execute(async (transaction) => {
      const current = await sql<{
        deductions: string;
        grossPayable: string;
        netPayable: string;
        serviceFee: string;
        settlementStatus: string;
        traderAdjustments: string;
        traderCharges: string;
        traderId: string;
      }>`
        select trader_id as "traderId",
               trader_gross_payable::text as "grossPayable",
               trader_paid_service_fee::text as "serviceFee",
               trader_deductions::text as deductions,
               trader_charges::text as "traderCharges",
               trader_adjustments::text as "traderAdjustments",
               trader_net_payable::text as "netPayable",
               trader_settlement_status as "settlementStatus"
        from orders
        where id = ${orderId}::uuid
          and company_id = ${companyId}::uuid
          and delivery_status = 'delivered'
          and driver_reconciliation_status in ('reconciled', 'not_applicable')
        for update
      `.execute(transaction);
      const order = current.rows[0];
      if (order === undefined) {
        throw new ApplicationException(
          "order_not_settleable",
          "Only delivered orders with reconciled driver cash can be settled",
          HttpStatus.CONFLICT,
        );
      }
      if (order.settlementStatus !== "unsettled") {
        throw new ApplicationException(
          "settlement_not_pending",
          "Only unsettled trader orders can be settled",
          HttpStatus.CONFLICT,
        );
      }

      const grossPayable = Number(order.grossPayable);
      const serviceFee = Number(order.serviceFee);
      const deductions = Number(order.deductions);
      const charges = Number(order.traderCharges);
      const adjustments = Number(order.traderAdjustments);
      const netPayable = Number(order.netPayable);
      const payment = await this.resolveFinancialPayment(transaction, companyId, input);
      const beneficiary =
        payment.method === "bank_transfer"
          ? await this.resolveTraderBeneficiary(
              transaction,
              companyId,
              order.traderId,
              input.traderBankAccountId,
            )
          : null;
      const settlementNumber = await this.nextReferenceNumber(
        transaction,
        companyId,
        "settlement",
        "SET",
      );
      const settlement = await sql<{ id: string }>`
        insert into trader_settlements (
          company_id, settlement_number, trader_id, business_date,
          gross_payable, service_fee_deductions, other_deductions, charges,
          adjustments, net_payable, status, created_by_account_id
        ) values (
          ${companyId}::uuid, ${settlementNumber}, ${order.traderId}::uuid,
          current_date, ${grossPayable}, ${serviceFee}, ${deductions}, ${charges},
          ${adjustments}, ${netPayable}, 'draft', ${identity.identityId}::uuid
        )
        returning id
      `.execute(transaction);
      const settlementId = settlement.rows[0]?.id;
      if (settlementId === undefined) {
        throw new Error("Trader settlement creation did not return an identifier");
      }
      await sql`
        insert into trader_settlement_orders (
          company_id, settlement_id, order_id, gross_payable,
          deductions_and_charges, adjustments, net_payable
        ) values (
          ${companyId}::uuid, ${settlementId}::uuid, ${orderId}::uuid, ${grossPayable},
          ${serviceFee + deductions + charges}, ${adjustments}, ${netPayable}
        )
      `.execute(transaction);
      if (netPayable > 0) {
        await sql`
          insert into trader_settlement_payments (
            company_id, settlement_id, payment_method, amount, company_bank_account_id,
            bank_reference, created_by_account_id, payment_at,
            trader_bank_account_id, trader_bank_account_snapshot
          ) values (
            ${companyId}::uuid, ${settlementId}::uuid, ${payment.method}, ${netPayable},
            ${payment.bankAccountId}::uuid, ${payment.bankReference},
            ${identity.identityId}::uuid, now(), ${beneficiary?.id ?? null}::uuid,
            ${beneficiary === null ? null : JSON.stringify(beneficiary.snapshot)}::jsonb
          )
        `.execute(transaction);
      }
      await sql`
        update trader_settlements
           set status = 'confirmed',
               confirmed_by_account_id = ${identity.identityId}::uuid,
               confirmed_at = now(),
               updated_at = now()
         where id = ${settlementId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await sql`
        update orders
           set trader_settlement_status = 'money_sent_to_trader',
               updated_at = now(),
               version = version + 1
         where id = ${orderId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await sql`
        insert into order_status_history (
          company_id, order_id, status_dimension, from_status, to_status, changed_by_account_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, 'trader_settlement',
          'unsettled', 'money_sent_to_trader', ${identity.identityId}::uuid
        )
      `.execute(transaction);
      await sql`
        insert into order_events (
          company_id, order_id, event_type, event_category, field_name,
          previous_value, new_value, actor_account_id, actor_role, source,
          related_settlement_id, correlation_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, 'trader_settlement.money_sent',
          'financial_change', 'trader_settlement_status', to_jsonb('unsettled'::text),
          to_jsonb('money_sent_to_trader'::text), ${identity.identityId}::uuid,
          'Company User', 'web_portal', ${settlementId}::uuid, ${correlationId}
        )
      `.execute(transaction);
      await this.audit(transaction, {
        action: "trader_settlement.confirm",
        actorId: identity.identityId,
        after: { netPayable, paymentMethod: payment.method, settlementNumber },
        companyId,
        correlationId,
        subjectId: orderId,
        subjectType: "order",
      });
    });
    return this.orderById(companyId, orderId);
  }

  // "Money out to trader" for several delivered orders of ONE trader at once: creates a single
  // settlement with one line per order and one payment for the total, then flips every order to
  // money_sent_to_trader. Orders that aren't ready are skipped and reported.
  public async bulkSettleTrader(
    input: BulkSettleTraderDto,
    correlationId: string,
  ): Promise<{
    netPaid: string;
    processedCount: number;
    settlementNumber: string;
    skipped: readonly { orderNumber: string; reason: string }[];
    traderName: string;
  }> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    return this.transactions.execute(async (transaction) => {
      const orders = await this.resolveSettleableOrders(transaction, companyId, input, true);
      if (orders.length === 0) {
        throw new ApplicationException(
          "no_settleable_orders",
          "None of the selected orders are ready for money out. They must be delivered, with driver cash reconciled, and not yet settled.",
          HttpStatus.CONFLICT,
        );
      }
      const traderIds = new Set(orders.map((order) => order.traderId));
      if (traderIds.size > 1) {
        throw new ApplicationException(
          "settlement_trader_mismatch",
          "All selected orders must belong to the same Trader for one money-out settlement.",
          HttpStatus.CONFLICT,
        );
      }
      const traderId = orders[0]!.traderId;
      const traderName = orders[0]!.traderName;

      const totals = orders.reduce(
        (acc, order) => ({
          adjustments: acc.adjustments.plus(order.traderAdjustments),
          charges: acc.charges.plus(order.traderCharges),
          deductions: acc.deductions.plus(order.deductions),
          gross: acc.gross.plus(order.grossPayable),
          net: acc.net.plus(order.netPayable),
          serviceFee: acc.serviceFee.plus(order.serviceFee),
        }),
        {
          adjustments: new Decimal(0),
          charges: new Decimal(0),
          deductions: new Decimal(0),
          gross: new Decimal(0),
          net: new Decimal(0),
          serviceFee: new Decimal(0),
        },
      );
      const netPayable = this.money(totals.net).toNumber();

      const payment = await this.resolveFinancialPayment(transaction, companyId, input);
      const beneficiary =
        payment.method === "bank_transfer"
          ? await this.resolveTraderBeneficiary(
              transaction,
              companyId,
              traderId,
              input.traderBankAccountId,
            )
          : null;
      const settlementNumber = await this.nextReferenceNumber(
        transaction,
        companyId,
        "settlement",
        "SET",
      );
      const settlement = await sql<{ id: string }>`
        insert into trader_settlements (
          company_id, settlement_number, trader_id, business_date,
          gross_payable, service_fee_deductions, other_deductions, charges,
          adjustments, net_payable, status, created_by_account_id
        ) values (
          ${companyId}::uuid, ${settlementNumber}, ${traderId}::uuid,
          current_date, ${this.money(totals.gross).toNumber()},
          ${this.money(totals.serviceFee).toNumber()}, ${this.money(totals.deductions).toNumber()},
          ${this.money(totals.charges).toNumber()}, ${this.money(totals.adjustments).toNumber()},
          ${netPayable}, 'draft', ${identity.identityId}::uuid
        )
        returning id
      `.execute(transaction);
      const settlementId = settlement.rows[0]?.id;
      if (settlementId === undefined) {
        throw new Error("Trader settlement creation did not return an identifier");
      }
      for (const order of orders) {
        const lineGross = new Decimal(order.grossPayable);
        const lineDeductions = new Decimal(order.serviceFee)
          .plus(order.deductions)
          .plus(order.traderCharges);
        await sql`
          insert into trader_settlement_orders (
            company_id, settlement_id, order_id, gross_payable,
            deductions_and_charges, adjustments, net_payable
          ) values (
            ${companyId}::uuid, ${settlementId}::uuid, ${order.id}::uuid,
            ${this.money(lineGross).toNumber()}, ${this.money(lineDeductions).toNumber()},
            ${this.money(new Decimal(order.traderAdjustments)).toNumber()},
            ${this.money(new Decimal(order.netPayable)).toNumber()}
          )
        `.execute(transaction);
        await sql`
          update orders
             set trader_settlement_status = 'money_sent_to_trader',
                 updated_at = now(), version = version + 1
           where id = ${order.id}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
        await sql`
          insert into order_status_history (
            company_id, order_id, status_dimension, from_status, to_status, changed_by_account_id
          ) values (
            ${companyId}::uuid, ${order.id}::uuid, 'trader_settlement',
            'unsettled', 'money_sent_to_trader', ${identity.identityId}::uuid
          )
        `.execute(transaction);
        await sql`
          insert into order_events (
            company_id, order_id, event_type, event_category, field_name,
            previous_value, new_value, actor_account_id, actor_role, source,
            related_settlement_id, correlation_id
          ) values (
            ${companyId}::uuid, ${order.id}::uuid, 'trader_settlement.money_sent',
            'financial_change', 'trader_settlement_status', to_jsonb('unsettled'::text),
            to_jsonb('money_sent_to_trader'::text), ${identity.identityId}::uuid,
            'Company User', 'web_portal', ${settlementId}::uuid, ${correlationId}
          )
        `.execute(transaction);
      }
      if (netPayable > 0) {
        await sql`
          insert into trader_settlement_payments (
            company_id, settlement_id, payment_method, amount, company_bank_account_id,
            bank_reference, created_by_account_id, payment_at,
            trader_bank_account_id, trader_bank_account_snapshot
          ) values (
            ${companyId}::uuid, ${settlementId}::uuid, ${payment.method}, ${netPayable},
            ${payment.bankAccountId}::uuid, ${payment.bankReference},
            ${identity.identityId}::uuid, now(), ${beneficiary?.id ?? null}::uuid,
            ${beneficiary === null ? null : JSON.stringify(beneficiary.snapshot)}::jsonb
          )
        `.execute(transaction);
      }
      await sql`
        update trader_settlements
           set status = 'confirmed', confirmed_by_account_id = ${identity.identityId}::uuid,
               confirmed_at = now(), updated_at = now()
         where id = ${settlementId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await this.audit(transaction, {
        action: "trader_settlement.bulk_confirm",
        actorId: identity.identityId,
        after: { netPayable, orderCount: orders.length, settlementNumber, traderId },
        companyId,
        correlationId,
        subjectId: settlementId,
        subjectType: "trader_settlement",
      });
      return {
        netPaid: this.money(totals.net).toFixed(2),
        processedCount: orders.length,
        settlementNumber,
        skipped: [],
        traderName,
      };
    });
  }

  public async bulkSettlePreview(input: BulkSettleTraderDto): Promise<{
    netPayable: string;
    orderCount: number;
    traderMismatch: boolean;
    traderName: string;
  }> {
    const { companyId } = this.tenants.current();
    const orders = await this.resolveSettleableOrders(this.database, companyId, input, false);
    const net = orders.reduce((total, order) => total.plus(order.netPayable), new Decimal(0));
    return {
      netPayable: this.money(net).toFixed(2),
      orderCount: orders.length,
      traderMismatch: new Set(orders.map((order) => order.traderId)).size > 1,
      traderName: orders[0]?.traderName ?? "",
    };
  }

  private async resolveSettleableOrders(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    input: BulkSettleTraderDto,
    lock: boolean,
  ): Promise<
    readonly {
      deductions: string;
      grossPayable: string;
      id: string;
      netPayable: string;
      orderNumber: string;
      serviceFee: string;
      traderAdjustments: string;
      traderCharges: string;
      traderId: string;
      traderName: string;
    }[]
  > {
    const columns = sql`
      o.id, o.order_number as "orderNumber", o.trader_id as "traderId", t.name_en as "traderName",
      o.trader_gross_payable::text as "grossPayable", o.trader_paid_service_fee::text as "serviceFee",
      o.trader_deductions::text as deductions, o.trader_charges::text as "traderCharges",
      o.trader_adjustments::text as "traderAdjustments", o.trader_net_payable::text as "netPayable"`;
    const eligible = sql`
      o.delivery_status = 'delivered'
      and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
      and o.trader_settlement_status = 'unsettled'`;
    if (input.selectionMode === "ids") {
      const excluded = new Set(input.excludedOrderIds ?? []);
      const ids = (input.orderIds ?? []).filter((id) => !excluded.has(id));
      if (ids.length === 0) return [];
      const result = await sql<{
        deductions: string;
        grossPayable: string;
        id: string;
        netPayable: string;
        orderNumber: string;
        serviceFee: string;
        traderAdjustments: string;
        traderCharges: string;
        traderId: string;
        traderName: string;
      }>`
        select ${columns}
        from orders o
        join traders t on t.id = o.trader_id and t.company_id = o.company_id
        where o.company_id = ${companyId}::uuid
          and o.id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
          and ${eligible}
        order by o.id
        ${sql.raw(lock ? "for update of o" : "")}
      `.execute(database);
      return result.rows;
    }
    const search = input.search?.trim() || null;
    const result = await sql<{
      deductions: string;
      grossPayable: string;
      id: string;
      netPayable: string;
      orderNumber: string;
      serviceFee: string;
      traderAdjustments: string;
      traderCharges: string;
      traderId: string;
      traderName: string;
    }>`
      select ${columns}
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      where o.company_id = ${companyId}::uuid
        and ${eligible}
        and (${search}::text is null or o.order_number ilike '%' || ${search} || '%'
          or o.customer_name ilike '%' || ${search} || '%'
          or o.customer_mobile_number ilike '%' || ${search} || '%'
          or t.name_en ilike '%' || ${search} || '%')
        and (${input.traderId ?? null}::uuid is null or o.trader_id = ${input.traderId ?? null}::uuid)
        and (${input.driverId ?? null}::uuid is null or o.assigned_driver_id = ${input.driverId ?? null}::uuid)
        and (${input.areaId ?? null}::uuid is null or o.area_id = ${input.areaId ?? null}::uuid)
        and (${input.dateFrom ?? null}::date is null or o.order_date >= ${input.dateFrom ?? null}::date)
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

  public async confirmTraderReceipt(
    orderId: string,
    correlationId: string,
  ): Promise<OperationsOrder> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    await this.transactions.execute(async (transaction) => {
      const updated = await sql<{ orderNumber: string }>`
        update orders
           set trader_settlement_status = 'money_received_by_trader',
               updated_at = now(), version = version + 1
         where id = ${orderId}::uuid and company_id = ${companyId}::uuid
           and trader_settlement_status = 'money_sent_to_trader'
        returning order_number as "orderNumber"
      `.execute(transaction);
      if (updated.rows[0] === undefined) {
        throw new ApplicationException(
          "trader_receipt_ineligible",
          "Only an Order with Money Sent to Trader can be confirmed as received",
          HttpStatus.CONFLICT,
        );
      }
      await sql`
        insert into order_status_history (
          company_id, order_id, status_dimension, from_status, to_status,
          changed_by_account_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, 'trader_settlement',
          'money_sent_to_trader', 'money_received_by_trader', ${identity.identityId}::uuid
        )
      `.execute(transaction);
      await sql`
        insert into order_events (
          company_id, order_id, event_type, event_category, field_name,
          previous_value, new_value, actor_account_id, actor_role, source, correlation_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, 'trader_settlement.money_received',
          'financial_change', 'trader_settlement_status',
          to_jsonb('money_sent_to_trader'::text), to_jsonb('money_received_by_trader'::text),
          ${identity.identityId}::uuid, 'Company User', 'web_portal', ${correlationId}
        )
      `.execute(transaction);
      await this.audit(transaction, {
        action: "trader_settlement.receipt_confirmed",
        actorId: identity.identityId,
        after: { orderNumber: updated.rows[0]?.orderNumber },
        companyId,
        correlationId,
        subjectId: orderId,
        subjectType: "order",
      });
    });
    return this.orderById(companyId, orderId);
  }

  private async orderById(companyId: string, orderId: string): Promise<OperationsOrder> {
    const result = await sql<OperationsOrder>`
      select o.id,
             o.area_id as "areaId",
             o.order_number as "orderNumber",
             o.serial_number as "serialNumber",
             o.reference_number as "referenceNumber",
             o.order_date::text as "orderDate",
             t.name_en as "traderName",
             a.name_en as "areaNameEn",
             a.name_ar as "areaNameAr",
             coalesce(o.customer_area_name_ar_snapshot,a.name_ar,
                      o.customer_area_name_snapshot,a.name_en) as "areaName",
             e.id as "emirateId",
             e.name_en as "emirateNameEn",
             e.name_ar as "emirateNameAr",
             o.assigned_driver_id as "assignedDriverId",
             d.name_en as "assignedDriverName",
             d.mobile_number as "assignedDriverMobile",
             o.customer_name as "customerName",
             o.customer_address as "customerAddress",
             o.customer_mobile_number as "customerMobileNumber",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.service_fee_vat_amount::text as "serviceFeeVatAmount",
             o.additional_fees::text as "additionalFees",
             o.additional_fee_vat_amount::text as "additionalFeeVatAmount",
             o.total_deductions::text as "totalDeductions",
             o.trader_net_payable::text as "traderNetPayable",
             o.customer_amount_due::text as "customerAmountDue",
             o.amount_collected::text as "amountCollected",
             o.vat_amount::text as "vatAmount",
             o.company_revenue::text as "companyRevenue",
             o.order_profit::text as "orderProfit",
             o.delivery_status as "deliveryStatus",
             o.driver_reconciliation_status as "driverReconciliationStatus",
             o.trader_settlement_status as "traderSettlementStatus",
             case
               when d.id is null or d.driver_type <> 'outsourced' then 'not_required'
               when o.delivery_status <> 'delivered' then 'pending_delivery'
               when fee.id is null then 'missing_accrual'
               when fee.status = 'accrued' then 'unpaid'
               else fee.status
             end as "outsourcedDriverFeeStatus",
             fee.earned_amount::text as "outsourcedDriverFeeAmount",
             fee.paid_amount::text as "outsourcedDriverFeePaid",
             fee.outstanding_amount::text as "outsourcedDriverFeeOutstanding",
             fee_payments.payment_numbers as "outsourcedDriverFeePaymentNumbers",
             o.return_status as "returnStatus",
             o.delivered_at::text as "deliveredAt",
             ${orderAccountingColumns}
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      left join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join emirates e on e.id = a.emirate_id
      left join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
      left join outsourced_driver_fee_accruals fee
        on fee.order_id = o.id and fee.company_id = o.company_id
      left join lateral (
        select string_agg(payments.payment_number, ', ' order by payments.payment_number) as payment_numbers
        from (
          select distinct p.payment_number
          from outsourced_driver_fee_payment_allocations pa
          join outsourced_driver_fee_payments p
            on p.id = pa.payment_id and p.company_id = pa.company_id
          where pa.company_id = o.company_id
            and pa.accrual_id = fee.id
            and pa.reversed_at is null
            and p.status = 'confirmed'
        ) payments
      ) fee_payments on true
      where o.company_id = ${companyId}::uuid and o.id = ${orderId}::uuid
    `.execute(this.database);
    const order = result.rows[0];
    if (order === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    return order;
  }

  private async orderAttachments(
    companyId: string,
    orderId: string,
  ): Promise<readonly OperationsOrderAttachment[]> {
    const result = await sql<OperationsOrderAttachment>`
      select oa.id,
             oa.attachment_type as "attachmentType",
             f.id as "fileId",
             f.original_filename as "fileName",
             f.media_type as "mediaType",
             f.size_bytes::text as "sizeBytes",
             f.scan_status as "scanStatus",
             oa.created_at::text as "createdAt",
             a.username as "uploadedBy"
      from order_attachments oa
      join file_objects f on f.id = oa.file_object_id and f.company_id = oa.company_id
      join accounts a on a.id = oa.uploaded_by_account_id and a.company_id = oa.company_id
      where oa.company_id = ${companyId}::uuid
        and oa.order_id = ${orderId}::uuid
      order by oa.created_at desc, oa.id desc
    `.execute(this.database);
    return result.rows;
  }

  private async internationalShipment(
    companyId: string,
    orderId: string,
  ): Promise<OperationsInternationalShipment | null> {
    const result = await sql<OperationsInternationalShipment>`
      select s.id,
             p.name as "providerName",
             s.provider_reference_number as "providerReferenceNumber",
             s.destination_country_code as "destinationCountryCode",
             s.international_delivery_cost::text as "internationalDeliveryCost",
             s.customer_charge::text as "customerCharge",
             s.shipment_date::text as "shipmentDate",
             s.expected_delivery_date::text as "expectedDeliveryDate",
             s.current_status as "currentStatus",
             s.notes
      from international_shipments s
      join third_party_delivery_companies p
        on p.id = s.third_party_delivery_company_id and p.company_id = s.company_id
      where s.company_id = ${companyId}::uuid
        and s.order_id = ${orderId}::uuid
      limit 1
    `.execute(this.database);
    return result.rows[0] ?? null;
  }

  private async upsertThirdPartyDeliveryCompany(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    companyId: string,
    providerName: string,
  ): Promise<{ readonly id: string }> {
    const existing = await sql<{ id: string }>`
      select id
      from third_party_delivery_companies
      where company_id = ${companyId}::uuid
        and lower(name) = lower(${providerName})
      limit 1
    `.execute(database);
    if (existing.rows[0] !== undefined) {
      return existing.rows[0];
    }
    const inserted = await sql<{ id: string }>`
      insert into third_party_delivery_companies (company_id, name, is_active)
      values (${companyId}::uuid, ${providerName}, true)
      returning id
    `.execute(database);
    const provider = inserted.rows[0];
    if (provider === undefined) {
      throw new Error("Third-party delivery provider creation did not return an identifier");
    }
    return provider;
  }

  private async recordOrderUsageEvent(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    companyId: string,
    orderId: string,
  ): Promise<void> {
    await sql`
      insert into saas_usage_events (
        company_id, order_id, event_type, occurred_at, billing_period_start, idempotency_key
      ) values (
        ${companyId}::uuid,
        ${orderId}::uuid,
        'order_submitted',
        now(),
        date_trunc('month', current_date)::date,
        ${`order_submitted:${orderId}`}
      )
      on conflict (company_id, order_id, event_type) do nothing
    `.execute(database);
  }

  private async traderForAccount(
    companyId: string,
    accountId: string,
    profileId?: string,
  ): Promise<{ readonly id: string }> {
    const result = await sql<{ id: string }>`
      select t.id from traders t
      join user_business_links l on l.company_id=t.company_id and l.entity_type='trader'
        and l.entity_id=t.id and l.account_id=${accountId}::uuid and l.access_status='active'
      where t.company_id = ${companyId}::uuid
        and t.id=${profileId ?? null}::uuid and t.account_status = 'active'
      limit 1
    `.execute(this.database);
    const trader = result.rows[0];
    if (trader === undefined) {
      throw new ApplicationException(
        profileId === undefined ? "profile_scope_required" : "profile_access_inactive",
        profileId === undefined
          ? "An authenticated profile is required"
          : "The profile is not active",
        HttpStatus.FORBIDDEN,
      );
    }
    return trader;
  }

  private normalizeOrderIdentifier(value: string): string {
    const display = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (display.length === 0 || !/^[\p{L}\p{N} _/-]+$/u.test(display)) {
      throw new ApplicationException(
        "order_identifier_invalid",
        "Use letters, numbers, spaces, hyphens, underscores or slashes only",
        HttpStatus.BAD_REQUEST,
      );
    }
    return display.toLocaleLowerCase("en-US");
  }

  private async assertOrderIdentifiersAvailable(
    transaction: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    companyId: string,
    input: {
      referenceNumber: string | null;
      referenceNumberNormalized: string | null;
      serialNumber: string;
      serialNumberNormalized: string;
    },
  ): Promise<void> {
    // Serial Number uniqueness is scoped to the Order's own Business Date
    // (`orders.order_date`, always `current_date` at creation — there is no
    // separate Business Date column). `current_date` is referenced from SQL
    // rather than computed in JS so the lock key, the duplicate check, and
    // the eventual INSERT's own `current_date` can never disagree due to a
    // clock or timezone mismatch between the app process and the database.
    await sql`
      select pg_advisory_xact_lock(
        hashtext(${companyId}),
        hashtext('order-serial:' || current_date::text || ':' || ${input.serialNumberNormalized})
      )
    `.execute(transaction);
    if (input.referenceNumberNormalized !== null) {
      await sql`
        select pg_advisory_xact_lock(
          hashtext(${companyId}),
          hashtext(${"order-reference:" + input.referenceNumberNormalized})
        )
      `.execute(transaction);
    }
    const duplicate = await sql<{
      orderDate: string;
      referenceExists: boolean;
      serialExists: boolean;
    }>`
      select
        current_date::text as "orderDate",
        exists(
          select 1 from orders
          where company_id=${companyId}::uuid
            and order_date = current_date
            and serial_number_normalized=${input.serialNumberNormalized}
        ) as "serialExists",
        exists(
          select 1 from orders
          where company_id=${companyId}::uuid
            and ${input.referenceNumberNormalized}::text is not null
            and reference_number_normalized=${input.referenceNumberNormalized}
        ) as "referenceExists"
    `.execute(transaction);
    if (duplicate.rows[0]?.serialExists) {
      throw new ApplicationException(
        "order_serial_already_exists_for_date",
        `Serial Number "${input.serialNumber}" already exists for ${duplicate.rows[0].orderDate}.`,
        HttpStatus.CONFLICT,
      );
    }
    if (input.referenceNumber !== null && duplicate.rows[0]?.referenceExists) {
      throw new ApplicationException(
        "reference_number_exists",
        `Reference Number "${input.referenceNumber}" is already used`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private async resolveCreateOrderCustomer(
    transaction: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    input: {
      companyId: string;
      correlationId: string;
      createdByAccountId: string;
      customerAddressId?: string;
      customerId?: string;
      inlineCustomer?: CreateOrderDto["inlineCustomer"];
      orderAreaId: string;
    },
  ): Promise<{
    address: {
      areaCode: string;
      areaId: string;
      areaNameAr: string | null;
      areaNameEn: string;
      deliveryInstructions: string | null;
      id: string;
      latitude: string | null;
      locationLink: string | null;
      longitude: string | null;
    };
    customer: {
      code: string;
      customerReference: string | null;
      deliveryNotes: string | null;
      id: string;
    };
  }> {
    if (input.inlineCustomer === undefined) {
      const customer = await sql<{
        code: string;
        customerReference: string | null;
        deliveryNotes: string | null;
        id: string;
      }>`
        select id,code,customer_reference as "customerReference",delivery_notes as "deliveryNotes"
        from customers
        where id=${input.customerId ?? null}::uuid
          and company_id=${input.companyId}::uuid and status='active'
      `.execute(transaction);
      const customerRow = customer.rows[0];
      if (customerRow === undefined) {
        throw new ApplicationException(
          "customer_not_found",
          "The selected Customer is not active in this Company",
          HttpStatus.BAD_REQUEST,
        );
      }
      const address = await sql<{
        areaCode: string;
        areaId: string;
        areaNameAr: string | null;
        areaNameEn: string;
        deliveryInstructions: string | null;
        id: string;
        latitude: string | null;
        locationLink: string | null;
        longitude: string | null;
      }>`
        select ca.id,ca.area_id as "areaId",a.code as "areaCode",
               a.name_en as "areaNameEn",a.name_ar as "areaNameAr",
               ca.location_link as "locationLink",ca.latitude::text,ca.longitude::text,
               ca.delivery_instructions as "deliveryInstructions"
        from customer_addresses ca
        join areas a on a.id=ca.area_id and a.company_id=ca.company_id and a.is_active
        where ca.id=${input.customerAddressId ?? null}::uuid
          and ca.customer_id=${customerRow.id}::uuid
          and ca.company_id=${input.companyId}::uuid and ca.is_active
      `.execute(transaction);
      const addressRow = address.rows[0];
      if (addressRow === undefined || addressRow.areaId !== input.orderAreaId) {
        throw new ApplicationException(
          "customer_address_not_found",
          "The selected Customer address and Area are not available",
          HttpStatus.BAD_REQUEST,
        );
      }
      return { address: addressRow, customer: customerRow };
    }

    const draft = input.inlineCustomer;
    // The mobile is stored exactly as entered (flexible text). Duplicate matching
    // compares on a normalized key so equivalent forms (0506468442,
    // 971506468442, +971 50 646 8442) still collide, while distinct international
    // numbers do not. The key is used for the advisory lock and the lookup; the
    // sentinel guards an empty key (e.g. a symbol-only value) from matching.
    const primaryKey = mobileComparisonKey(draft.mobileNumber) || "__none__";
    const secondKey =
      draft.secondMobileNumber && draft.secondMobileNumber.trim() !== ""
        ? mobileComparisonKey(draft.secondMobileNumber) || "__none__"
        : "__none__";
    await sql`
      select pg_advisory_xact_lock(
        hashtext(${input.companyId}),
        hashtext(${"customer-mobile:" + primaryKey})
      )
    `.execute(transaction);
    const duplicate = await sql<{ code: string; name: string }>`
      select code,name from customers
      where company_id=${input.companyId}::uuid
        and (
          customer_mobile_comparison_key(mobile_number) in (${primaryKey},${secondKey})
          or (
            second_mobile_number is not null
            and customer_mobile_comparison_key(second_mobile_number) in (${primaryKey},${secondKey})
          )
        )
      limit 1
    `.execute(transaction);
    if (duplicate.rows[0] !== undefined) {
      throw new ApplicationException(
        "customer_duplicate",
        "A Customer with this mobile number already exists. Select that Customer instead.",
        HttpStatus.CONFLICT,
      );
    }
    const area = await this.activeArea(transaction, input.companyId, input.orderAreaId);
    const code = await this.nextReferenceNumber(transaction, input.companyId, "customer", "CUS");
    const customer = await sql<{ code: string; id: string }>`
      insert into customers(
        company_id,code,name,mobile_number,second_mobile_number,created_by_account_id
      ) values (
        ${input.companyId}::uuid,${code},${draft.name.trim()},${draft.mobileNumber},
        ${draft.secondMobileNumber?.trim() || null},${input.createdByAccountId}::uuid
      )
      returning id,code
    `.execute(transaction);
    const customerRow = customer.rows[0];
    if (customerRow === undefined) throw new Error("Customer creation returned no identifier");
    /* The address record is ALWAYS created, even with no street line.
       `orders_customer_provenance_check` requires `customer_address_id` on a
       'resolved' Order, so skipping the record is not an option -- the Order
       would be rejected. The Area is known regardless, so the record is
       meaningful; only the address text may be empty, which is why
       `customer_addresses_address_nonempty` was dropped. No placeholder is
       invented: an empty line reads as absent, "n/a" reads as data. */
    const address = await sql<{ id: string }>`
      insert into customer_addresses(
        company_id,customer_id,area_id,address,is_default,created_by_account_id
      ) values (
        ${input.companyId}::uuid,${customerRow.id}::uuid,${area.id}::uuid,
        ${draft.address?.trim() ?? ""},true,${input.createdByAccountId}::uuid
      )
      returning id
    `.execute(transaction);
    const addressId = address.rows[0]?.id;
    if (addressId === undefined)
      throw new Error("Customer address creation returned no identifier");
    await this.audit(transaction, {
      action: "customer.create_from_order",
      actorId: input.createdByAccountId,
      after: { code, mobileNumber: draft.mobileNumber, name: draft.name.trim() },
      companyId: input.companyId,
      correlationId: input.correlationId,
      subjectId: customerRow.id,
      subjectType: "customer",
    });
    return {
      address: {
        areaCode: area.code,
        areaId: area.id,
        areaNameAr: area.nameAr,
        areaNameEn: area.nameEn,
        deliveryInstructions: null,
        id: addressId,
        latitude: null,
        locationLink: null,
        longitude: null,
      },
      customer: {
        code,
        customerReference: null,
        deliveryNotes: null,
        id: customerRow.id,
      },
    };
  }

  private async driverForAccount(
    companyId: string,
    accountId: string,
    profileId?: string,
  ): Promise<{ readonly id: string }> {
    const result = await sql<{ id: string }>`
      select d.id from drivers d
      join user_business_links l on l.company_id=d.company_id and l.entity_type='driver'
        and l.entity_id=d.id and l.account_id=${accountId}::uuid and l.access_status='active'
      where d.company_id = ${companyId}::uuid
        and d.id=${profileId ?? null}::uuid and d.account_status = 'active'
      limit 1
    `.execute(this.database);
    const driver = result.rows[0];
    if (driver === undefined) {
      throw new ApplicationException(
        profileId === undefined ? "profile_scope_required" : "profile_access_inactive",
        profileId === undefined
          ? "An authenticated profile is required"
          : "The profile is not active",
        HttpStatus.FORBIDDEN,
      );
    }
    return driver;
  }

  private async defaultArea(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    companyId: string,
  ): Promise<{ code: string; id: string; name: string; nameAr: string | null; nameEn: string }> {
    const existing = await sql<{
      code: string;
      id: string;
      name: string;
      nameAr: string | null;
      nameEn: string;
    }>`
      select id,code,name_en as name,name_en as "nameEn",name_ar as "nameAr"
      from areas
      where company_id = ${companyId}::uuid and is_active
      order by lower(name_en)
      limit 1
    `.execute(database);
    if (existing.rows[0] !== undefined) {
      return existing.rows[0];
    }
    /*
     * Previously this silently created a "Default Area" with a hardcoded code.
     * Areas now belong to an Emirate, and inventing one would file operational
     * records under an Emirate nobody chose. Fail with an actionable message
     * instead.
     */
    throw new ApplicationException(
      "area_required",
      "No active Area is configured. Create an Area under the correct Emirate in " +
        "Configuration → Areas before creating Orders.",
      HttpStatus.BAD_REQUEST,
    );
  }

  private async activeArea(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    companyId: string,
    areaId: string,
  ): Promise<{ code: string; id: string; name: string; nameAr: string | null; nameEn: string }> {
    const existing = await sql<{
      code: string;
      id: string;
      name: string;
      nameAr: string | null;
      nameEn: string;
    }>`
      select id,code,name_en as name,name_en as "nameEn",name_ar as "nameAr"
      from areas
      where id = ${areaId}::uuid
        and company_id = ${companyId}::uuid
        and is_active
      limit 1
    `.execute(database);
    const area = existing.rows[0];
    if (area === undefined) {
      throw new ApplicationException(
        "area_not_found",
        "The selected area is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    return area;
  }

  private async insertOrder(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    input: InsertOrderInput,
  ): Promise<OperationsOrder> {
    const { companyId } = this.tenants.current();
    const customerName = input.customerName.trim();
    const customerMobileNumber = input.customerMobileNumber.trim();
    // Optional, same as the primary create path: absent becomes '', which the
    // NOT NULL column accepts because it carries no non-empty check.
    const customerAddress = (input.customerAddress ?? "").trim();
    const serialNumber = input.serialNumber.trim();
    const referenceNumber = input.referenceNumber?.trim() || null;
    const serialNumberNormalized = this.normalizeOrderIdentifier(serialNumber);
    const referenceNumberNormalized =
      referenceNumber === null ? null : this.normalizeOrderIdentifier(referenceNumber);
    const packageCount = input.packageCount ?? 1;
    await this.assertOrderIdentifiersAvailable(database, companyId, {
      referenceNumber,
      referenceNumberNormalized,
      serialNumber,
      serialNumberNormalized,
    });
    const trader = await sql<{ id: string; name: string }>`
      select id, name_en as name
      from traders
      where id = ${input.traderId}::uuid
        and company_id = ${companyId}::uuid
        and account_status = 'active'
    `.execute(database);
    const traderRow = trader.rows[0];
    if (traderRow === undefined) {
      throw new ApplicationException(
        "trader_not_found",
        "The selected trader is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
    }

    const driverRow =
      input.driverId === undefined
        ? undefined
        : (
            await sql<{ id: string; name: string; outsourcedFee: string | null }>`
              select id,
                     name_en as name,
                     outsourced_fee_per_delivered_order::text as "outsourcedFee"
              from drivers
              where id = ${input.driverId}::uuid
                and company_id = ${companyId}::uuid
                and account_status = 'active'
            `.execute(database)
          ).rows[0];
    if (input.driverId !== undefined && driverRow === undefined) {
      throw new ApplicationException(
        "driver_not_found",
        "The selected driver is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
    }

    const area =
      input.areaId === undefined
        ? await this.defaultArea(database, companyId)
        : await this.activeArea(database, companyId, input.areaId);
    const customer = await this.resolveImportedCustomer(database, {
      address: customerAddress,
      area,
      companyId,
      correlationId: input.correlationId,
      createdByAccountId: input.createdByAccountId,
      mobileNumber: customerMobileNumber,
      name: customerName,
      secondMobileNumber: input.customerSecondMobileNumber?.trim() || null,
    });
    const pricing = await this.resolveServiceFee(database, {
      areaId: area.id,
      companyId,
      permissions: this.identities.current().permissions,
      ...(input.serviceFee === undefined ? {} : { requestedFee: input.serviceFee }),
      ...(input.serviceFeeOverrideReason === undefined
        ? {}
        : { requestedReason: input.serviceFeeOverrideReason }),
      traderId: traderRow.id,
    });
    const vatPolicy = await this.vatPolicy(database, companyId);
    const orderNumber = await this.nextOrderNumber(database, companyId);
    const driverCost = new Decimal(driverRow?.outsourcedFee ?? 0);
    const financials = this.calculateOrderFinancials({
      additionalFees: new Decimal(input.additionalFees ?? 0),
      codAmount: new Decimal(input.codAmount),
      driverCost,
      prospective: true,
      serviceFee: pricing.finalFee,
      vatPolicy,
    });
    const deliveryStatus = driverRow === undefined ? "new" : "assigned_to_driver";
    const traderSettlementStatus = financials.traderNetPayable.isZero()
      ? "not_eligible"
      : "unsettled";

    const inserted = await sql<{ id: string }>`
      insert into orders (
        company_id, order_number, serial_number, serial_number_normalized,
        reference_number, reference_number_normalized, financial_model_version,
        order_date, trader_id, area_id, created_by_account_id,
        import_batch_id, assigned_driver_id,customer_id,customer_address_id,
        customer_name, customer_mobile_number,customer_second_mobile_number,customer_address,
        customer_code_snapshot,customer_reference_snapshot,customer_area_code_snapshot,
        customer_area_name_snapshot,customer_location_link_snapshot,customer_delivery_notes_snapshot,
        customer_provenance_status,
        customer_area_name_ar_snapshot,area_name_fallback_used,
        package_count, payment_condition, cod_amount, service_fee, service_fee_net_amount,
        service_fee_vat_amount,additional_fees,additional_fee_vat_amount,total_deductions,
        customer_amount_due,trader_gross_payable,trader_paid_service_fee,trader_deductions,
        trader_net_payable,driver_cost,vat_amount,vat_enabled_snapshot,vat_rate_snapshot,
        vat_price_mode_snapshot,company_revenue,order_profit,delivery_status,trader_settlement_status,
        pricing_provenance_status, trader_service_price_id,
        configured_service_fee_snapshot, final_service_fee_snapshot,
        service_fee_override_reason
      ) values (
        ${companyId}::uuid, ${orderNumber}, ${serialNumber}, ${serialNumberNormalized},
        ${referenceNumber}, ${referenceNumberNormalized}, 'trader_deduction_v1',
        current_date, ${traderRow.id}::uuid,
        ${area.id}::uuid, ${input.createdByAccountId}::uuid,
        ${input.importBatchId ?? null}::uuid, ${driverRow?.id ?? null}::uuid,
        ${customer.id}::uuid,${customer.addressId}::uuid,${customerName}, ${customerMobileNumber},
        ${input.customerSecondMobileNumber?.trim() || null},${customerAddress},${customer.code},
        ${customer.customerReference},${area.code},${area.name},${customer.locationLink},
        ${customer.deliveryNotes},'resolved',${area.nameAr},${area.nameAr === null},${packageCount},
        'customer_pays_cod_trader_pays_fee', ${financials.codAmount.toFixed(2)},
        ${financials.serviceFee.toFixed(2)},${financials.serviceFeeNetAmount.toFixed(2)},
        ${financials.serviceFeeVatAmount.toFixed(2)},${financials.additionalFees.toFixed(2)},
        ${financials.additionalFeeVatAmount.toFixed(2)},${financials.totalDeductions.toFixed(2)},
        ${financials.customerAmountDue.toFixed(2)},${financials.codAmount.toFixed(2)},
        ${financials.serviceFeeNetAmount.plus(financials.serviceFeeVatAmount).toFixed(2)},
        ${financials.additionalFees.plus(financials.additionalFeeVatAmount).toFixed(2)},
        ${financials.traderNetPayable.toFixed(2)}, ${driverCost.toFixed(2)},
        ${financials.vatAmount.toFixed(2)},${vatPolicy.enabled},${vatPolicy.rate.toFixed(4)},
        ${vatPolicy.enabled ? vatPolicy.priceMode : null},${financials.companyRevenue.toFixed(2)},
        ${financials.orderProfit.toFixed(2)}, ${deliveryStatus}, ${traderSettlementStatus},
        ${pricing.provenance}, ${pricing.servicePriceId}::uuid,
        ${pricing.configuredFee.toFixed(2)}, ${pricing.finalFee.toFixed(2)},
        ${pricing.overrideReason}
      )
      returning id
    `.execute(database);
    const orderId = inserted.rows[0]?.id;
    if (orderId === undefined) {
      throw new Error("Order creation did not return an identifier");
    }
    await this.createOrderTraderReceivableIfNeeded(database, {
      actorAccountId: input.createdByAccountId,
      amountDue: financials.traderReceivableDue,
      companyId,
      correlationId: input.correlationId,
      orderId,
      orderNumber,
      traderId: traderRow.id,
    });

    if (driverRow !== undefined) {
      await sql`
        insert into order_assignments (
          company_id, order_id, driver_id, assigned_by_account_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, ${driverRow.id}::uuid,
          ${input.createdByAccountId}::uuid
        )
      `.execute(database);
    }

    await sql`
      insert into order_status_history (
        company_id, order_id, status_dimension, to_status, changed_by_account_id
      ) values (
        ${companyId}::uuid, ${orderId}::uuid, 'delivery', ${deliveryStatus},
        ${input.createdByAccountId}::uuid
      )
    `.execute(database);
    await sql`
      insert into order_events (
        company_id, order_id, event_type, event_category, field_name,
        new_value, actor_account_id, actor_role, source, correlation_id,
        related_driver_id
      ) values (
        ${companyId}::uuid, ${orderId}::uuid, 'order.created', 'user_action',
        'delivery_status', to_jsonb(${deliveryStatus}::text),
        ${input.createdByAccountId}::uuid, 'Company User', 'import',
        ${input.correlationId}, ${driverRow?.id ?? null}::uuid
      )
    `.execute(database);
    await this.recordOrderUsageEvent(database, companyId, orderId);

    return {
      // The four components the capture trigger tests, computed here so a caller
      // acting on the freshly created Order sees the same classification the
      // list and detail queries will later report.
      accountingRequired: !(
        financials.codAmount.isZero() &&
        financials.serviceFee.isZero() &&
        financials.additionalFees.isZero() &&
        financials.vatAmount.isZero()
      ),
      amountCollected: "0.00",
      additionalFees: financials.additionalFees.toFixed(2),
      additionalFeeVatAmount: financials.additionalFeeVatAmount.toFixed(2),
      areaName: area.nameAr ?? area.nameEn,
      assignedDriverId: driverRow?.id ?? null,
      assignedDriverMobile: null,
      assignedDriverName: driverRow?.name ?? null,
      codAmount: financials.codAmount.toFixed(2),
      companyRevenue: financials.companyRevenue.toFixed(2),
      customerAmountDue: financials.customerAmountDue.toFixed(2),
      customerAddress,
      customerMobileNumber,
      customerName,
      deliveryStatus,
      driverReconciliationStatus: "not_applicable",
      id: orderId,
      orderDate: new Date().toISOString().slice(0, 10),
      orderNumber,
      orderProfit: financials.orderProfit.toFixed(2),
      outsourcedDriverFeeAmount: null,
      outsourcedDriverFeeOutstanding: null,
      outsourcedDriverFeePaid: null,
      outsourcedDriverFeePaymentNumbers: null,
      outsourcedDriverFeeStatus:
        driverRow?.outsourcedFee == null ? "not_required" : "pending_delivery",
      referenceNumber,
      returnStatus: "not_applicable",
      serialNumber,
      serviceFee: financials.serviceFee.toFixed(2),
      serviceFeeOverrideReason: pricing.overrideReason,
      serviceFeeVatAmount: financials.serviceFeeVatAmount.toFixed(2),
      totalDeductions: financials.totalDeductions.toFixed(2),
      traderNetPayable: financials.traderNetPayable.toFixed(2),
      traderName: traderRow.name,
      traderSettlementStatus: "unsettled",
      vatAmount: financials.vatAmount.toFixed(2),
    };
  }

  /**
   * Builds a word-by-word search condition: every whitespace/dash-separated
   * word in the term must appear somewhere in the given haystack expression.
   * An empty term matches everything.
   */
  private searchMatch(term: string, haystack: ReturnType<typeof sql>): ReturnType<typeof sql> {
    const tokens = term.split(/[\s-]+/).filter((token) => token.length > 0);
    if (tokens.length === 0) return sql`true`;
    return sql.join(
      tokens.map((token) => sql`${haystack} like ${`%${token}%`}`),
      sql` and `,
    );
  }

  private async resolveServiceFee(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly areaId: string;
      readonly companyId: string;
      readonly permissions: ReadonlySet<string>;
      readonly requestedFee?: number | undefined;
      readonly requestedReason?: string | undefined;
      readonly traderId: string;
    },
  ): Promise<ResolvedServiceFee> {
    // Walk the pricing hierarchy most-specific first: the exact Area, then the
    // Emirate's All-Areas default, then the global All-Emirates row.
    const result = await sql<{ fee: string; id: string }>`
      select p.id, p.service_fee::text as fee
        from areas a
        join trader_service_prices p
          on p.company_id = a.company_id
         and p.trader_id = ${input.traderId}::uuid
         and (
           (p.emirate_id = a.emirate_id and p.area_id = a.id)
           or (p.emirate_id = a.emirate_id and p.area_id is null)
           or (p.emirate_id is null and p.area_id is null)
         )
       where a.id = ${input.areaId}::uuid and a.company_id = ${input.companyId}::uuid
       order by (p.area_id is not null) desc, (p.emirate_id is not null) desc
       limit 1
    `.execute(database);

    const requested =
      input.requestedFee === undefined ? undefined : this.money(new Decimal(input.requestedFee));
    // A caller must not be able to hand us the system marker and have it stored
    // as though the pricing engine wrote it. Fee Source is derived from this
    // string, so accepting it verbatim would let any client make a manual
    // override present itself as an ordinary configured zero price.
    //
    // The marker is discarded rather than rejected: it is not a user's reason,
    // so the correct treatment is "no reason was given". A manual zero then
    // fails the normal reason check with the normal message, and a genuine
    // configured zero has the marker re-applied below by the server.
    const submitted = input.requestedReason?.trim() || null;
    const reason = submitted === configuredZeroPriceReason ? null : submitted;
    const matched = result.rows[0];

    if (matched === undefined) {
      // No configured price at any level. The operator may enter one manually
      // rather than being blocked. The 'manual' provenance already records that
      // the fee was hand-entered, so a reason is optional (kept if supplied).
      if (requested === undefined) {
        throw new ApplicationException(
          "pricing_not_configured",
          "No service fee is configured for this Trader in the selected Emirate and Area. " +
            "Enter a fee manually to continue.",
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      // This branch is only reached when the caller hand-entered a fee (there
      // is no configured price at any level), so a zero here is always a
      // deliberate manual decision. Trader mobile never reaches this path: it
      // sends no fee, so an unpriced Area fails earlier above with
      // pricing_not_configured.
      //
      // `overrideApplied` is false here — there is no configured price to
      // override — so the permission gate further down never fires. A zero fee
      // is exactly the decision that gate exists to control, so it is enforced
      // explicitly. Deliberately limited to zero: entering a NON-zero fee for
      // an unpriced Area remains open to any User who can create Orders, which
      // is the existing approved behaviour and is not changed here.
      if (requested.isZero() && !input.permissions.has("orders.override_service_fee")) {
        throw new ApplicationException(
          "service_fee_override_denied",
          "You do not have permission to apply a zero service fee",
          HttpStatus.FORBIDDEN,
        );
      }
      this.assertZeroServiceFeeReason(requested, reason);
      return {
        configuredFee: requested,
        finalFee: requested,
        overrideApplied: false,
        overrideReason: reason,
        provenance: "manual",
        servicePriceId: null,
      };
    }

    const configuredFee = this.money(new Decimal(matched.fee));
    const finalFee = requested ?? configuredFee;
    const overrideApplied = !finalFee.equals(configuredFee);
    if (overrideApplied && !input.permissions.has("orders.override_service_fee")) {
      throw new ApplicationException(
        "service_fee_override_denied",
        "You do not have permission to override the configured service fee",
        HttpStatus.FORBIDDEN,
      );
    }
    if (overrideApplied && reason === null) {
      throw new ApplicationException(
        "service_fee_override_reason_required",
        "A reason is required when overriding the configured service fee",
        HttpStatus.BAD_REQUEST,
      );
    }
    // A zero Service Fee has two very different origins, and conflating them
    // breaks Trader mobile:
    //
    //   MANUAL ZERO   - the caller asked for 0 against a priced Area. This is
    //                   an exceptional business decision and needs a reason.
    //   CONFIGURED 0  - the Trader/Area is simply priced at 0 and the caller
    //                   asked for nothing. That is ordinary pricing, not an
    //                   override, and Trader mobile has no field to supply a
    //                   reason with. Demanding one would reject a perfectly
    //                   valid Order.
    //
    // So the reason is required only when the ZERO WAS REQUESTED. A configured
    // zero records a system-generated explanation instead, which keeps the
    // constraint satisfied without inventing a user's words.
    const requestedZero = requested !== undefined && requested.isZero();
    if (requestedZero) this.assertZeroServiceFeeReason(finalFee, reason);
    const resolvedReason =
      finalFee.isZero() && !requestedZero && reason === null ? configuredZeroPriceReason : reason;
    return {
      configuredFee,
      finalFee,
      overrideApplied,
      overrideReason: resolvedReason,
      provenance: "resolved",
      servicePriceId: matched.id,
    };
  }

  /**
   * A Service Fee of exactly zero always requires a reason.
   *
   * `isZero()` on the Decimal, never `!fee` or `fee === 0`: the value is a
   * Decimal, so a truthy test would be meaningless and a strict equality
   * test would miss `0.00`.
   *
   * This mirrors the `orders_zero_service_fee_reason_check` constraint, so
   * the rule is refused with a clear business error before the database has
   * to refuse it with a constraint violation.
   */
  private assertZeroServiceFeeReason(fee: Decimal, reason: string | null): void {
    if (!fee.isZero() || reason !== null) return;
    throw new ApplicationException(
      "service_fee_zero_reason_required",
      "A reason is required when the Service Fee is zero",
      HttpStatus.BAD_REQUEST,
    );
  }

  private async loadOrder(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    companyId: string,
    orderId: string,
  ): Promise<OperationsOrder> {
    const result = await sql<OperationsOrder>`
      select o.id,
             o.order_number as "orderNumber",
             o.serial_number as "serialNumber",
             o.reference_number as "referenceNumber",
             o.order_date::text as "orderDate",
             t.name_en as "traderName",
             a.name_en as "areaNameEn",
             a.name_ar as "areaNameAr",
             coalesce(o.customer_area_name_ar_snapshot,a.name_ar,
                      o.customer_area_name_snapshot,a.name_en) as "areaName",
             o.assigned_driver_id as "assignedDriverId",
             d.name_en as "assignedDriverName",
             d.mobile_number as "assignedDriverMobile",
             o.customer_name as "customerName",
             o.customer_mobile_number as "customerMobileNumber",
             o.customer_address as "customerAddress",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.service_fee_vat_amount::text as "serviceFeeVatAmount",
             o.additional_fees::text as "additionalFees",
             o.additional_fee_vat_amount::text as "additionalFeeVatAmount",
             o.total_deductions::text as "totalDeductions",
             o.trader_net_payable::text as "traderNetPayable",
             o.vat_amount::text as "vatAmount",
             o.customer_amount_due::text as "customerAmountDue",
             o.company_revenue::text as "companyRevenue",
             o.order_profit::text as "orderProfit",
             o.amount_collected::text as "amountCollected",
             o.delivery_status as "deliveryStatus",
             o.driver_reconciliation_status as "driverReconciliationStatus",
             o.trader_settlement_status as "traderSettlementStatus"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      left join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
      where o.id = ${orderId}::uuid and o.company_id = ${companyId}::uuid
      limit 1
    `.execute(database);
    const order = result.rows[0];
    if (order === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    return order;
  }

  private async vatPolicy(database: Kysely<DatabaseSchema>, companyId: string): Promise<VatPolicy> {
    const result = await sql<{
      readonly vatEnabled: boolean;
      readonly vatPriceMode: "exclusive" | "inclusive" | null;
      readonly vatRate: string | null;
    }>`
      select vat_enabled as "vatEnabled",
             vat_price_mode as "vatPriceMode",
             vat_rate::text as "vatRate"
      from company_settings
      where company_id = ${companyId}::uuid
    `.execute(database);
    const settings = result.rows[0];
    if (settings === undefined || !settings.vatEnabled) {
      return { enabled: false, priceMode: null, rate: new Decimal(0) };
    }
    return {
      enabled: true,
      priceMode: settings.vatPriceMode,
      rate: new Decimal(settings.vatRate ?? 0),
    };
  }

  private calculateOrderFinancials(input: {
    readonly additionalFees?: Decimal;
    readonly codAmount: Decimal;
    readonly driverCost: Decimal;
    readonly prospective?: boolean;
    readonly serviceFee: Decimal;
    readonly vatPolicy: VatPolicy;
  }): OrderFinancials {
    const additionalFeeInput = input.additionalFees ?? new Decimal(0);
    const serviceFeeVatAmount = this.calculateVatAmount(input.serviceFee, input.vatPolicy);
    const additionalFeeVatAmount = this.calculateVatAmount(additionalFeeInput, input.vatPolicy);
    const inclusive = input.vatPolicy.enabled && input.vatPolicy.priceMode === "inclusive";
    const serviceFeeNetAmount = inclusive
      ? input.serviceFee.minus(serviceFeeVatAmount)
      : input.serviceFee;
    const additionalFees = inclusive
      ? additionalFeeInput.minus(additionalFeeVatAmount)
      : additionalFeeInput;
    const totalDeductions = serviceFeeNetAmount
      .plus(serviceFeeVatAmount)
      .plus(additionalFees)
      .plus(additionalFeeVatAmount);
    const vatAmount = input.prospective
      ? serviceFeeVatAmount.plus(additionalFeeVatAmount)
      : serviceFeeVatAmount;
    const companyRevenue = input.prospective
      ? serviceFeeNetAmount.plus(additionalFees)
      : serviceFeeNetAmount;
    const customerAmountDue = input.prospective
      ? input.codAmount
      : input.vatPolicy.enabled && input.vatPolicy.priceMode === "exclusive"
        ? input.codAmount.plus(input.serviceFee).plus(serviceFeeVatAmount)
        : input.codAmount.plus(input.serviceFee);
    const signedTraderPosition = input.codAmount.minus(totalDeductions);
    const traderNetPayable = input.prospective
      ? Decimal.max(signedTraderPosition, 0)
      : Decimal.max(input.codAmount.minus(input.serviceFee), 0);
    const traderReceivableDue = input.prospective
      ? Decimal.max(signedTraderPosition.negated(), 0)
      : new Decimal(0);
    return {
      additionalFees: this.money(additionalFees),
      additionalFeeVatAmount: this.money(additionalFeeVatAmount),
      codAmount: this.money(input.codAmount),
      companyRevenue: this.money(companyRevenue),
      customerAmountDue: this.money(customerAmountDue),
      orderProfit: this.money(Decimal.max(companyRevenue.minus(input.driverCost), 0)),
      serviceFee: this.money(input.serviceFee),
      serviceFeeNetAmount: this.money(serviceFeeNetAmount),
      serviceFeeVatAmount: this.money(serviceFeeVatAmount),
      totalDeductions: this.money(totalDeductions),
      traderReceivableDue: this.money(traderReceivableDue),
      traderNetPayable: this.money(traderNetPayable),
      vatAmount: this.money(vatAmount),
    };
  }

  private async createOrderTraderReceivableIfNeeded(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    input: {
      readonly actorAccountId: string;
      readonly amountDue: Decimal;
      readonly companyId: string;
      readonly correlationId: string;
      readonly orderId: string;
      readonly orderNumber: string;
      readonly traderId: string;
    },
  ): Promise<void> {
    const amountDue = this.money(input.amountDue);
    if (amountDue.lessThanOrEqualTo(0)) {
      return;
    }
    const receivableNumber = await this.nextReferenceNumber(
      database,
      input.companyId,
      "trader_receivable",
      "RCV",
    );
    const reason = "Order service fee owed by Trader";
    await sql`
      insert into trader_receivables (
        company_id, receivable_number, trader_id, source_type, source_reference,
        business_date, original_amount_due, amount_collected, status, reason, notes,
        created_by_account_id
      ) values (
        ${input.companyId}::uuid, ${receivableNumber}, ${input.traderId}::uuid,
        'service_charge', ${input.orderNumber}, current_date, ${amountDue.toFixed(2)},
        0, 'outstanding', ${reason},
        ${`Created automatically because Order ${input.orderNumber} has fees greater than COD. Collect from Trader as a Receivable, not a negative settlement.`},
        ${input.actorAccountId}::uuid
      )
      on conflict do nothing
    `.execute(database);
    await sql`
      insert into order_events (
        company_id, order_id, event_type, event_category, field_name, new_value,
        actor_account_id, actor_role, source, correlation_id
      ) values (
        ${input.companyId}::uuid, ${input.orderId}::uuid,
        'trader_receivable.created_from_order', 'financial_change',
        'trader_receivable_due', to_jsonb(${amountDue.toFixed(2)}::text),
        ${input.actorAccountId}::uuid, 'Company User', 'system', ${input.correlationId}
      )
    `.execute(database);
  }
  private calculateVatAmount(serviceFee: Decimal, vatPolicy: VatPolicy): Decimal {
    if (!vatPolicy.enabled || vatPolicy.rate.isZero()) {
      return new Decimal(0);
    }
    if (vatPolicy.priceMode === "inclusive") {
      return this.money(serviceFee.mul(vatPolicy.rate).div(new Decimal(100).plus(vatPolicy.rate)));
    }
    return this.money(serviceFee.mul(vatPolicy.rate).div(100));
  }

  private money(amount: Decimal): Decimal {
    return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  private parseOrdersCsv(csv: string): {
    readonly errors: readonly string[];
    /** Rows that failed validation, already phrased for the importer. */
    readonly invalid: readonly OperationsOrderImportRow[];
    /** Rows that passed, each still carrying the file line it came from. */
    readonly rows: readonly { readonly row: CreateOrderDto; readonly rowNumber: number }[];
    readonly totalRows: number;
  } {
    const lines = this.parseCsv(csv).filter((row) => row.some((cell) => cell.trim().length > 0));
    if (lines.length === 0) {
      return { errors: [], invalid: [], rows: [], totalRows: 0 };
    }
    const header = lines[0]?.map((cell) => cell.trim()) ?? [];
    const index = new Map(header.map((name, position) => [name, position]));
    // `serviceFee` is deliberately NOT required.
    //
    // Leaving the column out — or leaving a cell blank — means "price this from
    // the authoritative Trader/Area table", which is the same path the Operator
    // form and Trader mobile take. A configured zero price then imports
    // normally, with the system explanation recorded, and nobody has to invent
    // a justification for the Company's own price list.
    //
    // Supplying a value keeps the old behaviour exactly: it is a requested fee,
    // and a requested zero is a manual override subject to the usual permission
    // and reason rules. Existing import files that carry the column are
    // therefore unaffected.
    const required = [
      "serialNumber",
      "traderId",
      "customerName",
      "customerMobileNumber",
      "customerAddress",
      "codAmount",
    ];
    const missing = required.filter((name) => !index.has(name));
    if (missing.length > 0) {
      return {
        errors: [`Missing required columns: ${missing.join(", ")}`],
        invalid: [],
        rows: [],
        totalRows: Math.max(lines.length - 1, 0),
      };
    }

    const errors: string[] = [];
    const invalid: OperationsOrderImportRow[] = [];
    const rows: { row: CreateOrderDto; rowNumber: number }[] = [];
    const totalRows = Math.max(lines.length - 1, 0);
    for (const [offset, line] of lines.slice(1).entries()) {
      const rowNumber = offset + 2;
      const read = (column: string) => line[index.get(column) ?? -1]?.trim() ?? "";
      const codAmountText = read("codAmount");
      // Blank is NOT zero. `Number("")` is 0, which would silently turn a
      // forgotten cell into a legitimate zero-COD Order, so the blank check
      // below runs against the raw text and not the parsed number.
      const codAmount = Number(codAmountText);
      const serviceFeeText = read("serviceFee");
      const serviceFee = serviceFeeText.length === 0 ? undefined : Number(serviceFeeText);
      const zeroFeeReason = read("serviceFeeOverrideReason");
      const additionalFeesText = read("additionalFees");
      const additionalFees = additionalFeesText.length === 0 ? 0 : Number(additionalFeesText);
      const packageCountText = read("packageCount");
      const packageCount = packageCountText.length === 0 ? 1 : Number(packageCountText);
      const rowErrors: string[] = [];
      for (const column of required) {
        if (read(column).length === 0) rowErrors.push(`${column} is required`);
      }
      if (!Number.isFinite(codAmount)) {
        rowErrors.push("Invalid COD: enter a number, or 0 for a no-collection Order");
      } else if (codAmount < 0) {
        rowErrors.push("Negative COD: the amount to collect cannot be less than 0");
      }
      if (serviceFee !== undefined && (!Number.isFinite(serviceFee) || serviceFee < 0)) {
        rowErrors.push(
          serviceFee < 0
            ? "Negative Service Fee: the fee cannot be less than 0"
            : "Invalid Service Fee: enter a number, or leave blank to use configured pricing",
        );
      }
      // An explicitly imported zero IS a requested zero, so it is a manual
      // override and owes a reason — the same rule the Operator form applies.
      // Caught here, per row, rather than as an exception that would abort the
      // whole file with no indication of which line caused it.
      //
      // Authorization is NOT decided here: `resolveServiceFee` holds the single
      // permission gate, and duplicating it in the parser would give two places
      // to disagree about who may do this.
      if (serviceFee === 0 && zeroFeeReason.trim() === "") {
        rowErrors.push(
          "Zero Service Fee Reason Required: give a reason, or leave Service Fee " +
            "blank to use configured pricing",
        );
      }
      if (!Number.isFinite(additionalFees) || additionalFees < 0) {
        rowErrors.push("additionalFees must be 0 or more");
      }
      if (!/^9715[0-9]{8}$/.test(read("customerMobileNumber"))) {
        rowErrors.push("customerMobileNumber must use 9715XXXXXXXX");
      }
      if (!Number.isInteger(packageCount) || packageCount < 1) {
        rowErrors.push("packageCount must be a whole number greater than 0");
      }
      // Read as raw text, never through Number(): a Reference Number is an
      // identifier, not a quantity, and "0042" must survive as "0042".
      const rowReference = this.optionalCsvValue(read("referenceNumber")) ?? null;
      if (rowErrors.length > 0) {
        errors.push(`Row ${rowNumber}: ${rowErrors.join("; ")}`);
        invalid.push({
          accountingRequired: null,
          errorField: this.importErrorField(rowErrors[0] ?? ""),
          errorMessage: rowErrors.join("; "),
          feeSource: null,
          orderNumber: null,
          referenceNumber: rowReference,
          resolvedServiceFee: null,
          rowNumber,
          status: "invalid",
          zeroFeeReason: zeroFeeReason.trim() === "" ? null : zeroFeeReason.trim(),
        });
        continue;
      }
      const parsedRow = {
        additionalFees,
        codAmount,
        customerAddress: read("customerAddress"),
        customerMobileNumber: read("customerMobileNumber"),
        customerName: read("customerName"),
        packageCount,
        serialNumber: read("serialNumber"),
        traderId: read("traderId"),
      } as CreateOrderDto;
      // Omitted rather than sent as undefined: `insertOrder` spreads the fee in
      // only when the key is present, and a present-but-undefined key would
      // read as a requested fee of nothing.
      if (serviceFee !== undefined) {
        (parsedRow as { serviceFee: number }).serviceFee = serviceFee;
      }
      if (zeroFeeReason.trim() !== "") {
        (parsedRow as { serviceFeeOverrideReason: string }).serviceFeeOverrideReason =
          zeroFeeReason.trim();
      }
      if (rowReference !== null) {
        (parsedRow as { referenceNumber: string }).referenceNumber = rowReference;
      }
      const areaId = this.optionalCsvValue(read("areaId"));
      const driverId = this.optionalCsvValue(read("driverId"));
      if (areaId !== undefined) {
        (parsedRow as { areaId: string }).areaId = areaId;
      }
      if (driverId !== undefined) {
        (parsedRow as { driverId: string }).driverId = driverId;
      }
      rows.push({ row: parsedRow, rowNumber });
    }
    return { errors, invalid, rows, totalRows };
  }

  /**
   * Which cell the importer should go and look at.
   *
   * Derived from the message we just wrote, so the two can never disagree about
   * what went wrong. Only the first error is attributed — pointing at five
   * fields at once helps nobody.
   */
  private importErrorField(message: string): string | null {
    if (message.startsWith("Invalid COD") || message.startsWith("Negative COD")) return "codAmount";
    if (message.startsWith("Invalid Service Fee") || message.startsWith("Negative Service Fee")) {
      return "serviceFee";
    }
    if (message.startsWith("Zero Service Fee Reason")) return "serviceFeeOverrideReason";
    if (message.startsWith("customerMobileNumber")) return "customerMobileNumber";
    if (message.startsWith("packageCount")) return "packageCount";
    if (message.startsWith("additionalFees")) return "additionalFees";
    const requiredField = /^([A-Za-z]+) is required$/.exec(message);
    return requiredField?.[1] ?? null;
  }

  private parseCsv(csv: string): string[][] {
    const rows: string[][] = [];
    let cell = "";
    let row: string[] = [];
    let quoted = false;
    for (let index = 0; index < csv.length; index += 1) {
      const character = csv[index];
      const next = csv[index + 1];
      if (character === '"' && quoted && next === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (character === "," && !quoted) {
        row.push(cell);
        cell = "";
      } else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && next === "\n") index += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += character;
      }
    }
    row.push(cell);
    rows.push(row);
    return rows;
  }

  private optionalCsvValue(value: string): string | undefined {
    return value.length > 0 ? value : undefined;
  }

  private async resolveFinancialPayment(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    companyId: string,
    input: FinancialPaymentDto,
  ): Promise<ResolvedFinancialPayment> {
    const method = input.paymentMethod ?? "cash";
    const bankAccountId = input.bankAccountId?.trim() || null;
    const bankReference = input.bankReference?.trim() || null;
    if (method === "cash") {
      if (bankAccountId !== null || bankReference !== null) {
        throw new ApplicationException(
          "cash_payment_bank_details_not_allowed",
          "Cash payments cannot include bank account or bank reference",
          HttpStatus.BAD_REQUEST,
        );
      }
      return { bankAccountId: null, bankReference: null, method };
    }
    if (bankAccountId === null || bankReference === null) {
      throw new ApplicationException(
        "bank_payment_incomplete",
        "Bank account and bank reference are required for bank transfer payments",
        HttpStatus.BAD_REQUEST,
      );
    }
    const existing = await sql<{ id: string }>`
      select id
      from company_bank_accounts
      where id = ${bankAccountId}::uuid
        and company_id = ${companyId}::uuid
        and is_active
      limit 1
    `.execute(database);
    if (existing.rows[0] === undefined) {
      throw new ApplicationException(
        "bank_account_not_found",
        "The selected bank account is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    return { bankAccountId, bankReference, method };
  }

  private async resolveTraderBeneficiary(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    companyId: string,
    traderId: string,
    requestedId?: string,
  ): Promise<{ readonly id: string; readonly snapshot: Record<string, string> }> {
    const result = await sql<{
      accountName: string;
      accountNumber: string;
      bankName: string;
      iban: string;
      id: string;
      swiftCode: string | null;
    }>`
      select id, bank_name as "bankName", account_name as "accountName",
             account_number as "accountNumber", iban, swift_code as "swiftCode"
        from trader_bank_accounts
       where company_id=${companyId}::uuid and trader_id=${traderId}::uuid and is_active
         and (${requestedId ?? null}::uuid is null or id=${requestedId ?? null}::uuid)
       order by case when id=${requestedId ?? null}::uuid then 0 when is_default then 1 else 2 end,
                created_at desc
       limit 1
    `.execute(database);
    const account = result.rows[0];
    if (account === undefined) {
      throw new ApplicationException(
        "trader_beneficiary_required",
        "An active Trader beneficiary bank account is required for bank transfer",
        HttpStatus.BAD_REQUEST,
      );
    }
    return {
      id: account.id,
      snapshot: {
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        bankName: account.bankName,
        iban: account.iban,
        swiftCode: account.swiftCode ?? "",
      },
    };
  }

  private async nextOrderNumber(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    companyId: string,
  ): Promise<string> {
    return this.nextReferenceNumber(database, companyId, "order", "ORD");
  }

  private async resolveImportedCustomer(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    input: {
      address: string;
      area: { code: string; id: string; name: string };
      companyId: string;
      correlationId: string;
      createdByAccountId: string;
      mobileNumber: string;
      name: string;
      secondMobileNumber: string | null;
    },
  ): Promise<{
    addressId: string;
    code: string;
    customerReference: string | null;
    deliveryNotes: string | null;
    id: string;
    locationLink: string | null;
  }> {
    await sql`select pg_advisory_xact_lock(hashtext(${input.companyId}),hashtext(${input.mobileNumber}))`.execute(
      database,
    );
    const matches = await sql<{
      code: string;
      customerReference: string | null;
      deliveryNotes: string | null;
      id: string;
    }>`
      select id,code,customer_reference as "customerReference",delivery_notes as "deliveryNotes"
        from customers where company_id=${input.companyId}::uuid and status='active'
         and (mobile_number=${input.mobileNumber} or second_mobile_number=${input.mobileNumber})
       order by created_at limit 2
    `.execute(database);
    if (matches.rows.length > 1) {
      throw new ApplicationException(
        "customer_duplicate",
        "The imported mobile matches more than one Customer",
        HttpStatus.CONFLICT,
      );
    }
    let customer = matches.rows[0];
    if (customer === undefined) {
      const code = await this.nextReferenceNumber(database, input.companyId, "customer", "CUS");
      const inserted = await sql<{
        code: string;
        customerReference: string | null;
        deliveryNotes: string | null;
        id: string;
      }>`
        insert into customers(company_id,code,name,mobile_number,second_mobile_number,created_by_account_id)
        values(${input.companyId}::uuid,${code},${input.name},${input.mobileNumber},
          ${input.secondMobileNumber},${input.createdByAccountId}::uuid)
        returning id,code,customer_reference as "customerReference",delivery_notes as "deliveryNotes"
      `.execute(database);
      customer = inserted.rows[0]!;
      await sql`insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,
        after_data,correlation_id,actor_role,source) values(${input.companyId}::uuid,
        ${input.createdByAccountId}::uuid,'customer.create_from_import','customer',${customer.id},
        ${JSON.stringify({ code: customer.code, mobileNumber: input.mobileNumber })}::jsonb,
        ${input.correlationId},'Company User','import')`.execute(database);
    }
    const addressMatch = await sql<{ id: string; locationLink: string | null }>`
      select id,location_link as "locationLink" from customer_addresses
       where company_id=${input.companyId}::uuid and customer_id=${customer.id}::uuid and is_active
         and area_id=${input.area.id}::uuid and lower(address)=lower(${input.address})
       order by is_default desc,created_at limit 1
    `.execute(database);
    let address = addressMatch.rows[0];
    if (address === undefined) {
      const count = await sql<{
        count: number;
      }>`select count(*)::int count from customer_addresses where company_id=${input.companyId}::uuid and customer_id=${customer.id}::uuid and is_active`.execute(
        database,
      );
      const inserted = await sql<{ id: string; locationLink: string | null }>`
        insert into customer_addresses(company_id,customer_id,area_id,address,is_default,created_by_account_id)
        values(${input.companyId}::uuid,${customer.id}::uuid,${input.area.id}::uuid,${input.address},
          ${(count.rows[0]?.count ?? 0) === 0},${input.createdByAccountId}::uuid)
        returning id,location_link as "locationLink"
      `.execute(database);
      address = inserted.rows[0]!;
      await sql`insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,
        after_data,correlation_id,actor_role,source) values(${input.companyId}::uuid,
        ${input.createdByAccountId}::uuid,'customer_address.create_from_import','customer_address',
        ${address.id},${JSON.stringify({ customerId: customer.id, areaId: input.area.id })}::jsonb,
        ${input.correlationId},'Company User','import')`.execute(database);
    }
    return {
      addressId: address.id,
      code: customer.code,
      customerReference: customer.customerReference,
      deliveryNotes: customer.deliveryNotes,
      id: customer.id,
      locationLink: address.locationLink,
    };
  }

  private async nextReferenceNumber(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    companyId: string,
    referenceType: string,
    prefix: string,
  ): Promise<string> {
    const result = await sql<{ nextValue: string; prefix: string }>`
      insert into company_reference_counters (company_id, reference_type, next_value, prefix)
      values (${companyId}::uuid, ${referenceType}, 2, ${prefix})
      on conflict (company_id, reference_type)
      do update set next_value = company_reference_counters.next_value + 1,
                    updated_at = now()
      returning prefix, (next_value - 1)::text as "nextValue"
    `.execute(database);
    const counter = result.rows[0];
    if (counter === undefined) {
      throw new Error("Reference counter did not return a value");
    }
    return `${counter.prefix}-${counter.nextValue.padStart(6, "0")}`;
  }

  private rethrowDuplicate(error: unknown, code: string, message: string): void {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new ApplicationException(code, message, HttpStatus.CONFLICT);
    }
  }

  private optionalFilter(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
  }

  private optionalDate(value: string | undefined): string | null {
    const date = this.optionalFilter(value);
    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ApplicationException(
        "date_invalid",
        "The selected date is invalid",
        HttpStatus.BAD_REQUEST,
      );
    }
    return date;
  }

  private optionalUuidFilter(value: string | undefined): string | null {
    const id = this.optionalFilter(value);
    if (
      id !== null &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ) {
      throw new ApplicationException(
        "filter_invalid",
        "The selected filter is invalid",
        HttpStatus.BAD_REQUEST,
      );
    }
    return id;
  }

  private async activeDriverCost(companyId: string, driverId: string): Promise<Decimal> {
    const result = await sql<{ outsourcedFee: string | null }>`
      select outsourced_fee_per_delivered_order::text as "outsourcedFee"
        from drivers
       where id = ${driverId}::uuid
         and company_id = ${companyId}::uuid
         and account_status = 'active'
    `.execute(this.database);
    const driver = result.rows[0];
    if (driver === undefined) {
      throw new ApplicationException(
        "driver_not_found",
        "The selected driver is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    return new Decimal(driver.outsourcedFee ?? 0);
  }

  private toCsv(rows: readonly (readonly string[])[]): string {
    return `${rows.map((row) => row.map((cell) => this.csvCell(cell)).join(",")).join("\r\n")}\r\n`;
  }

  private csvCell(value: string): string {
    if (!/[",\r\n]/.test(value)) {
      return value;
    }
    return `"${value.replaceAll('"', '""')}"`;
  }

  private async audit(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    input: {
      action: string;
      actorId: string;
      after: object;
      companyId: string;
      correlationId: string;
      subjectId: string;
      subjectType: string;
    },
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id
      ) values (
        ${input.companyId}::uuid, ${input.actorId}::uuid, ${input.action},
        ${input.subjectType}, ${input.subjectId}, ${JSON.stringify(input.after)}::jsonb,
        ${input.correlationId}
      )
    `.execute(database);
  }
}
