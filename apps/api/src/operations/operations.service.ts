import { createHash, randomBytes, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { PasswordHasher } from "../authentication/password-hasher.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { mobileComparisonKey, normalizeUaeMobile } from "../shared/uae-mobile.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import type {
  BulkSettleTraderDto,
  ChangeOrderStatusDto,
  CreateDriverDto,
  CreateOrderDto,
  CreateTraderDto,
  FinancialPaymentDto,
  ImportOrdersCsvDto,
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

export interface OperationsOrderFilters {
  readonly areaId?: string | undefined;
  readonly cashStatus?: string | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  readonly deliveryStatus?: string | undefined;
  readonly driverId?: string | undefined;
  readonly search?: string | undefined;
  readonly settlementStatus?: string | undefined;
  readonly quickView?: "active" | "all" | "cancelled" | "closed" | "hold" | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: 25 | 50 | 100 | undefined;
  readonly sortBy?: "amountToCollect" | "createdAt" | "orderDate" | "orderNumber" | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
  readonly traderId?: string | undefined;
}

export interface OperationsOrderPage {
  readonly filteredCount: number;
  readonly items: readonly OperationsOrder[];
  readonly page: number;
  readonly pageSize: 25 | 50 | 100;
  readonly totalCount: number;
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
  readonly additionalFees: string | null;
  readonly additionalFeeVatAmount: string | null;
  readonly amountCollected: string;
  readonly areaName: string;
  readonly assignedDriverId: string | null;
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
  readonly orderDate: string;
  readonly orderNumber: string;
  readonly orderProfit: string;
  readonly returnStatus: string;
  readonly referenceNumber: string | null;
  readonly serialNumber: string | null;
  readonly serviceFee: string;
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
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerAmountDue: string;
  readonly customerAddress: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly deliveryStatus: string;
  readonly id: string;
  readonly orderDate: string;
  readonly orderNumber: string;
  readonly serviceFee: string;
  readonly traderName: string;
  readonly traderSettlementStatus: string;
}

export interface OperationsOrderImportResult {
  readonly errors: readonly string[];
  readonly importNumber: string;
  readonly importedRows: number;
  readonly invalidRows: number;
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

interface InsertOrderInput extends CreateOrderDto {
  readonly correlationId: string;
  readonly createdByAccountId: string;
  readonly importBatchId?: string;
}

@Injectable()
export class OperationsService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(PasswordHasher) private readonly passwords: PasswordHasher,
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

  public async orders(filters: OperationsOrderFilters = {}): Promise<OperationsOrderPage> {
    const { companyId } = this.tenants.current();
    const search = this.optionalFilter(filters.search);
    const deliveryStatus = this.optionalFilter(filters.deliveryStatus);
    const cashStatus = this.optionalFilter(filters.cashStatus);
    const settlementStatus = this.optionalFilter(filters.settlementStatus);
    const traderId = this.optionalUuidFilter(filters.traderId);
    const driverId = this.optionalUuidFilter(filters.driverId);
    const areaId = this.optionalUuidFilter(filters.areaId);
    const dateFrom = this.optionalDate(filters.dateFrom);
    const dateTo = this.optionalDate(filters.dateTo);
    const quickView = filters.quickView ?? "active";
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
    const quickViewPredicate = sql`
      (${quickView} = 'all'
        or (${quickView} = 'active' and o.delivery_status not in ('hold', 'closed', 'cancelled'))
        or (${quickView} = 'closed' and o.delivery_status = 'closed')
        or (${quickView} = 'hold' and o.delivery_status = 'hold')
        or (${quickView} = 'cancelled' and o.delivery_status = 'cancelled'))
    `;
    const filterPredicate = sql`
      ${quickViewPredicate}
      and (${search}::text is null or (
        o.order_number ilike '%' || ${search}::text || '%'
        or coalesce(o.serial_number,'') ilike '%' || ${search}::text || '%'
        or coalesce(o.reference_number,'') ilike '%' || ${search}::text || '%'
        or o.customer_name ilike '%' || ${search}::text || '%'
        or o.customer_mobile_number ilike '%' || ${search}::text || '%'
        or t.name_en ilike '%' || ${search}::text || '%'
        or coalesce(t.name_ar, '') ilike '%' || ${search}::text || '%'
      ))
      and (${deliveryStatus}::text is null or o.delivery_status = ${deliveryStatus})
      and (${cashStatus}::text is null or o.driver_reconciliation_status = ${cashStatus})
      and (${settlementStatus}::text is null or o.trader_settlement_status = ${settlementStatus})
      and (${traderId}::uuid is null or o.trader_id = ${traderId}::uuid)
      and (${driverId}::uuid is null or o.assigned_driver_id = ${driverId}::uuid)
      and (${areaId}::uuid is null or o.area_id = ${areaId}::uuid)
      and (${dateFrom}::date is null or o.order_date >= ${dateFrom}::date)
      and (${dateTo}::date is null or o.order_date <= ${dateTo}::date)
    `;
    const result = await sql<OperationsOrder>`
      select o.id,
             o.order_number as "orderNumber",
             o.serial_number as "serialNumber",
             o.reference_number as "referenceNumber",
             o.order_date::text as "orderDate",
             t.name_en as "traderName",
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
             o.return_status as "returnStatus"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
      where o.company_id = ${companyId}::uuid
        and ${filterPredicate}
      order by ${sql.raw(sortColumn)} ${sql.raw(sortDirection)}, o.id ${sql.raw(sortDirection)}
      limit ${pageSize} offset ${offset}
    `.execute(this.database);
    const counts = await sql<{ filteredCount: number; totalCount: number }>`
      select
        (select count(*)::int from orders where company_id = ${companyId}::uuid) as "totalCount",
        count(*)::int as "filteredCount"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      where o.company_id = ${companyId}::uuid and ${filterPredicate}
    `.execute(this.database);
    return {
      filteredCount: counts.rows[0]?.filteredCount ?? 0,
      items: result.rows,
      page,
      pageSize,
      totalCount: counts.rows[0]?.totalCount ?? 0,
    };
  }

  public async exportOrders(filters: OperationsOrderFilters = {}): Promise<OperationsExportFile> {
    const { companyId } = this.tenants.current();
    const search = this.optionalFilter(filters.search);
    const deliveryStatus = this.optionalFilter(filters.deliveryStatus);
    const cashStatus = this.optionalFilter(filters.cashStatus);
    const settlementStatus = this.optionalFilter(filters.settlementStatus);
    const traderId = this.optionalUuidFilter(filters.traderId);
    const driverId = this.optionalUuidFilter(filters.driverId);
    const areaId = this.optionalUuidFilter(filters.areaId);
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
      join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
      where o.company_id = ${companyId}::uuid
        and (${search}::text is null or (
          o.order_number ilike '%' || ${search}::text || '%'
          or coalesce(o.serial_number,'') ilike '%' || ${search}::text || '%'
          or coalesce(o.reference_number,'') ilike '%' || ${search}::text || '%'
          or o.customer_name ilike '%' || ${search}::text || '%'
          or o.customer_mobile_number ilike '%' || ${search}::text || '%'
          or t.name_en ilike '%' || ${search}::text || '%'
          or coalesce(d.name_en, '') ilike '%' || ${search}::text || '%'
        ))
        and (${deliveryStatus}::text is null or o.delivery_status = ${deliveryStatus})
        and (${cashStatus}::text is null or o.driver_reconciliation_status = ${cashStatus})
        and (${settlementStatus}::text is null or o.trader_settlement_status = ${settlementStatus})
        and (${traderId}::uuid is null or o.trader_id = ${traderId}::uuid)
        and (${driverId}::uuid is null or o.assigned_driver_id = ${driverId}::uuid)
        and (${areaId}::uuid is null or o.area_id = ${areaId}::uuid)
        and (${dateFrom}::date is null or o.order_date >= ${dateFrom}::date)
        and (${dateTo}::date is null or o.order_date <= ${dateTo}::date)
      order by o.order_date desc, o.created_at desc, o.order_number
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
    const [order, history, attachments, internationalShipment, metadata, events] =
      await Promise.all([
        this.orderById(companyId, orderId),
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
      join areas a on a.id = o.area_id and a.company_id = o.company_id
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

  public async traderPortalOrders(): Promise<readonly PortalOrder[]> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const trader = await this.traderForAccount(identity.companyId, identity.identityId);
    const result = await sql<PortalOrder>`
      select o.id,
             o.order_number as "orderNumber",
             o.order_date::text as "orderDate",
             t.name_en as "traderName",
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
             o.trader_settlement_status as "traderSettlementStatus"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      join areas a on a.id = o.area_id and a.company_id = o.company_id
      where o.company_id = ${identity.companyId}::uuid
        and o.trader_id = ${trader.id}::uuid
      order by o.order_date desc, o.created_at desc, o.order_number
      limit 100
    `.execute(this.database);
    return result.rows;
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
    const driver = await this.driverForAccount(identity.companyId, identity.identityId);
    const result = await sql<PortalOrder>`
      select o.id,
             o.order_number as "orderNumber",
             o.order_date::text as "orderDate",
             t.name_en as "traderName",
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
             o.trader_settlement_status as "traderSettlementStatus"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      join areas a on a.id = o.area_id and a.company_id = o.company_id
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

  public async changeDriverPortalOrderStatus(
    orderId: string,
    input: ChangeOrderStatusDto,
    correlationId: string,
  ): Promise<PortalOrder> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      throw new ApplicationException(
        "tenant_required",
        "A Company account is required",
        HttpStatus.FORBIDDEN,
      );
    }
    const driver = await this.driverForAccount(identity.companyId, identity.identityId);
    const current = await sql<{ driverId: string | null }>`
      select assigned_driver_id as "driverId"
      from orders
      where id = ${orderId}::uuid and company_id = ${identity.companyId}::uuid
      limit 1
    `.execute(this.database);
    if (current.rows[0]?.driverId !== driver.id) {
      throw new ApplicationException(
        "driver_order_not_found",
        "The order is not assigned to this driver",
        HttpStatus.NOT_FOUND,
      );
    }
    await this.changeOrderStatus(orderId, input, correlationId);
    const updated = (await this.driverPortalOrders()).find((order) => order.id === orderId);
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
             coalesce(sum(o.trader_net_payable) filter (where o.trader_settlement_status = 'unsettled'), 0)::text as "unsettledNetPayable"
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
    const mobileNumber = input.mobileNumber.trim();
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
        mobileNumber,
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
  ): Promise<OperationsOrder> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
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
    const inlineCustomer = input.inlineCustomer;
    const hasExistingCustomer =
      input.customerId !== undefined && input.customerAddressId !== undefined;
    if (hasExistingCustomer === (inlineCustomer !== undefined)) {
      throw new ApplicationException(
        "order_customer_selection_invalid",
        "Select an existing Customer or enter one new Customer",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (inlineCustomer !== undefined && inlineCustomer.areaId !== input.areaId) {
      throw new ApplicationException(
        "customer_area_mismatch",
        "The new Customer Area must match the Order Area",
        HttpStatus.BAD_REQUEST,
      );
    }
    const customerName = (inlineCustomer?.name ?? input.customerName).trim();
    const customerMobileNumber = (
      inlineCustomer?.mobileNumber ?? input.customerMobileNumber
    ).trim();
    const customerSecondMobileNumber =
      (inlineCustomer?.secondMobileNumber ?? input.customerSecondMobileNumber)?.trim() || null;
    const customerAddress = (inlineCustomer?.address ?? input.customerAddress).trim();
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
          driverId: input.driverId ?? null,
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

      const { address: customerAddressRow, customer: customerRow } =
        await this.resolveCreateOrderCustomer(transaction, {
          companyId,
          correlationId,
          createdByAccountId: identity.identityId,
          ...(input.customerAddressId === undefined
            ? {}
            : { customerAddressId: input.customerAddressId }),
          ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
          ...(inlineCustomer === undefined ? {} : { inlineCustomer }),
          orderAreaId: input.areaId,
        });
      const latitude = input.customerLatitude ?? customerAddressRow.latitude;
      const longitude = input.customerLongitude ?? customerAddressRow.longitude;
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
        input.customerLocationLink?.trim() || customerAddressRow.locationLink;
      const customerDeliveryNotes =
        input.customerDeliveryNotes?.trim() ||
        customerAddressRow.deliveryInstructions ||
        customerRow.deliveryNotes;

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
              `.execute(transaction)
            ).rows[0];
      if (input.driverId !== undefined && driverRow === undefined) {
        throw new ApplicationException(
          "driver_not_found",
          "The selected driver is not active in this Company",
          HttpStatus.BAD_REQUEST,
        );
      }

      const area = await this.activeArea(transaction, companyId, input.areaId);
      const pricing = await this.resolveServiceFee(transaction, {
        areaId: area.id,
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
        additionalFees: new Decimal(additionalFees),
        codAmount: new Decimal(input.codAmount),
        driverCost,
        prospective: true,
        serviceFee: pricing.finalFee,
        vatPolicy,
      });
      const deliveryStatus = driverRow === undefined ? "new" : "assigned_to_driver";

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
          configured_service_fee_snapshot, final_service_fee_snapshot
        ) values (
          ${companyId}::uuid, ${orderNumber}, ${serialNumber}, ${serialNumberNormalized},
          ${referenceNumber}, ${referenceNumberNormalized}, 'trader_deduction_v1',
          current_date, ${traderRow.id}::uuid,
          ${area.id}::uuid, ${identity.identityId}::uuid,
          ${driverRow?.id ?? null}::uuid,${customerRow.id}::uuid,${customerAddressRow.id}::uuid,
          ${customerName}, ${customerMobileNumber},${customerSecondMobileNumber}, ${customerAddress},
          ${latitude ?? null},${longitude ?? null},${notes},${customerRow.code},
          ${customerRow.customerReference},${customerAddressRow.areaCode},${customerAddressRow.areaNameEn},
          ${customerAddressRow.areaNameAr},${customerAddressRow.areaNameAr === null},
          ${customerLocationLink},${customerDeliveryNotes},'resolved',
          ${packageCount}, 'customer_pays_cod_trader_pays_fee',
          ${financials.codAmount.toFixed(2)}, ${financials.serviceFee.toFixed(2)},
          ${financials.serviceFeeNetAmount.toFixed(2)},${financials.serviceFeeVatAmount.toFixed(2)},
          ${financials.additionalFees.toFixed(2)},${financials.additionalFeeVatAmount.toFixed(2)},
          ${financials.totalDeductions.toFixed(2)},${financials.customerAmountDue.toFixed(2)},
          ${financials.codAmount.toFixed(2)},${financials.serviceFeeNetAmount.plus(financials.serviceFeeVatAmount).toFixed(2)},
          ${financials.additionalFees.plus(financials.additionalFeeVatAmount).toFixed(2)},
          ${financials.traderNetPayable.toFixed(2)},${driverCost.toFixed(2)},
          ${financials.vatAmount.toFixed(2)},${vatPolicy.enabled},${vatPolicy.rate.toFixed(4)},
          ${vatPolicy.enabled ? vatPolicy.priceMode : null},
          ${financials.companyRevenue.toFixed(2)}, ${financials.orderProfit.toFixed(2)},
          ${deliveryStatus}, 'unsettled', ${pricing.provenance}, ${pricing.servicePriceId}::uuid,
          ${pricing.configuredFee.toFixed(2)}, ${pricing.finalFee.toFixed(2)}
        )
        returning id
      `.execute(transaction);
      const orderId = inserted.rows[0]?.id;
      if (orderId === undefined) {
        throw new Error("Order creation did not return an identifier");
      }

      if (driverRow !== undefined) {
        await sql`
          insert into order_assignments (
            company_id, order_id, driver_id, assigned_by_account_id
          ) values (
            ${companyId}::uuid, ${orderId}::uuid, ${driverRow.id}::uuid,
            ${identity.identityId}::uuid
          )
        `.execute(transaction);
      }

      await sql`
        insert into order_status_history (
          company_id, order_id, status_dimension, to_status, changed_by_account_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, 'delivery', ${deliveryStatus},
          ${identity.identityId}::uuid
        )
      `.execute(transaction);
      await sql`
        insert into order_events (
          company_id, order_id, event_type, event_category, field_name,
          new_value, actor_account_id, actor_role, source, correlation_id,
          related_driver_id
        ) values (
          ${companyId}::uuid, ${orderId}::uuid, 'order.created', 'user_action',
          'delivery_status', to_jsonb(${deliveryStatus}::text), ${identity.identityId}::uuid,
          'Company User', 'web_portal', ${correlationId}, ${driverRow?.id ?? null}::uuid
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
            ${identity.identityId}::uuid, 'Company User', 'web_portal', ${correlationId},
            ${driverRow.id}::uuid
          )
        `.execute(transaction);
      }
      await this.recordOrderUsageEvent(transaction, companyId, orderId);
      await this.audit(transaction, {
        action: "order.create",
        actorId: identity.identityId,
        after: { orderNumber, traderId: traderRow.id, driverId: driverRow?.id ?? null },
        companyId,
        correlationId,
        subjectId: orderId,
        subjectType: "order",
      });
      await this.audit(transaction, {
        action: "customer.selected_for_order",
        actorId: identity.identityId,
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

      if (pricing.overrideApplied) {
        await this.audit(transaction, {
          action: "order.service_fee_override",
          actorId: identity.identityId,
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
            to_jsonb(${pricing.finalFee.toFixed(2)}::text), ${identity.identityId}::uuid,
            'Company User', 'web_portal', ${pricing.overrideReason}, ${correlationId}
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
        additionalFees: financials.additionalFees.toFixed(2),
        additionalFeeVatAmount: financials.additionalFeeVatAmount.toFixed(2),
        amountCollected: "0.00",
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
        referenceNumber,
        returnStatus: "not_applicable",
        serialNumber,
        serviceFee: financials.serviceFee.toFixed(2),
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

  public async importOrdersCsv(
    input: ImportOrdersCsvDto,
    correlationId: string,
  ): Promise<OperationsOrderImportResult> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const csv = String((input as { readonly csv?: unknown }).csv ?? "");
    const parsed = this.parseOrdersCsv(csv);
    const errors = parsed.errors.slice();
    if (errors.length > 0) {
      return {
        errors,
        importNumber: "",
        importedRows: 0,
        invalidRows: errors.length,
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
          ${identity.identityId}::uuid
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
          ${identity.identityId}::uuid, null
        )
        returning id
      `.execute(transaction);
      const importBatchId = batch.rows[0]?.id;
      if (importBatchId === undefined) {
        throw new Error("Import batch creation did not return an identifier");
      }

      let importedRows = 0;
      for (const row of parsed.rows) {
        const created = await this.insertOrder(transaction, {
          ...row,
          correlationId,
          createdByAccountId: identity.identityId,
          importBatchId,
        });
        await this.audit(transaction, {
          action: "order.import_create",
          actorId: identity.identityId,
          after: { importNumber, orderNumber: created.orderNumber },
          companyId,
          correlationId,
          subjectId: created.id,
          subjectType: "order",
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
        totalRows: parsed.totalRows,
      };
    });
  }

  // Edits an order's business fields before delivery. Changing the Trader, or the Customer +
  // address (which sets the Area), re-prices the order. Recomputes VAT and the customer/trader
  // money whenever COD, the fee, the Trader, or the Area changes, and records one order_events
  // row per changed field (old -> new) so the audit shows exactly what the user changed.
  public async updateOrder(
    orderId: string,
    input: UpdateOrderDto,
    correlationId: string,
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
          orderProfit: string;
          packageCount: number;
          pricingProvenance: string;
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
                 o.order_profit::text as "orderProfit",
                 o.package_count as "packageCount",
                 o.pricing_provenance_status as "pricingProvenance",
                 o.service_fee::text as "serviceFee",
                 o.trader_id as "traderId",
                 t.name_en as "traderName",
                 o.trader_net_payable::text as "traderNetPayable",
                 o.trader_service_price_id as "traderServicePriceId",
                 o.vat_amount::text as "vatAmount"
          from orders o
          join traders t on t.id = o.trader_id and t.company_id = o.company_id
          where o.id = ${orderId}::uuid and o.company_id = ${companyId}::uuid
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
        additionalFees: new Decimal(current.additionalFees ?? 0),
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
           set trader_id = ${traderId}::uuid,
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
  ): Promise<OperationsOrder> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const status = input.status;
    await this.transactions.execute(async (transaction) => {
      const current = await sql<{
        amountCollected: string;
        assignedDriverId: string | null;
        customerAmountDue: string;
        deliveryStatus: string;
        driverReconciliationStatus: string;
        returnStatus: string;
        settlementStatus: string;
      }>`
        select amount_collected::text as "amountCollected",
               assigned_driver_id as "assignedDriverId",
               customer_amount_due::text as "customerAmountDue",
               delivery_status as "deliveryStatus",
               driver_reconciliation_status as "driverReconciliationStatus",
               return_status as "returnStatus",
               trader_settlement_status as "settlementStatus"
        from orders
        where id = ${orderId}::uuid and company_id = ${companyId}::uuid
        for update
      `.execute(transaction);
      const order = current.rows[0];
      if (order === undefined) {
        throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
      }
      const reason = input.reason?.trim() || null;
      const driverTransitions: Readonly<Record<string, readonly string[]>> = {
        assigned_to_driver: ["out_for_delivery"],
        out_for_delivery: ["delivered", "returned_to_branch"],
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
      };
      const transitions = identity.kind === "driver" ? driverTransitions : operationsTransitions;
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
      const amountCollected =
        status === "hold" ? Number(order.amountCollected) : status === "delivered" ? amountDue : 0;
      const reconciliationStatus =
        status === "hold"
          ? order.driverReconciliationStatus
          : status === "delivered" && order.assignedDriverId !== null && amountDue > 0
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
             o.order_number as "orderNumber",
             o.serial_number as "serialNumber",
             o.reference_number as "referenceNumber",
             o.order_date::text as "orderDate",
             t.name_en as "traderName",
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
             o.return_status as "returnStatus"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      join areas a on a.id = o.area_id and a.company_id = o.company_id
      left join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
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
  ): Promise<{ readonly id: string }> {
    const result = await sql<{ id: string }>`
      select id
      from traders
      where company_id = ${companyId}::uuid
        and account_id = ${accountId}::uuid
        and account_status = 'active'
      limit 1
    `.execute(this.database);
    const trader = result.rows[0];
    if (trader === undefined) {
      throw new ApplicationException(
        "trader_profile_not_found",
        "The trader profile is not active",
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
    const duplicate = await sql<{ orderDate: string; referenceExists: boolean; serialExists: boolean }>`
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
    const address = await sql<{ id: string }>`
      insert into customer_addresses(
        company_id,customer_id,area_id,address,is_default,created_by_account_id
      ) values (
        ${input.companyId}::uuid,${customerRow.id}::uuid,${area.id}::uuid,${draft.address.trim()},
        true,${input.createdByAccountId}::uuid
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
  ): Promise<{ readonly id: string }> {
    const result = await sql<{ id: string }>`
      select id
      from drivers
      where company_id = ${companyId}::uuid
        and account_id = ${accountId}::uuid
        and account_status = 'active'
      limit 1
    `.execute(this.database);
    const driver = result.rows[0];
    if (driver === undefined) {
      throw new ApplicationException(
        "driver_profile_not_found",
        "The driver profile is not active",
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
    const customerAddress = input.customerAddress.trim();
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
        configured_service_fee_snapshot, final_service_fee_snapshot
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
        ${financials.orderProfit.toFixed(2)}, ${deliveryStatus}, 'unsettled',
        ${pricing.provenance}, ${pricing.servicePriceId}::uuid,
        ${pricing.configuredFee.toFixed(2)}, ${pricing.finalFee.toFixed(2)}
      )
      returning id
    `.execute(database);
    const orderId = inserted.rows[0]?.id;
    if (orderId === undefined) {
      throw new Error("Order creation did not return an identifier");
    }

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
      referenceNumber,
      returnStatus: "not_applicable",
      serialNumber,
      serviceFee: financials.serviceFee.toFixed(2),
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
    const reason = input.requestedReason?.trim() || null;
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
    return {
      configuredFee,
      finalFee,
      overrideApplied,
      overrideReason: reason,
      provenance: "resolved",
      servicePriceId: matched.id,
    };
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
      join areas a on a.id = o.area_id and a.company_id = o.company_id
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
    if (input.prospective && totalDeductions.greaterThan(input.codAmount)) {
      throw new ApplicationException(
        "order_deductions_exceed_cod",
        "Total Company deductions cannot exceed the COD Amount",
        HttpStatus.BAD_REQUEST,
      );
    }
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
    const traderNetPayable = input.prospective
      ? input.codAmount.minus(totalDeductions)
      : Decimal.max(input.codAmount.minus(input.serviceFee), 0);
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
      traderNetPayable: this.money(traderNetPayable),
      vatAmount: this.money(vatAmount),
    };
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
    readonly rows: readonly CreateOrderDto[];
    readonly totalRows: number;
  } {
    const lines = this.parseCsv(csv).filter((row) => row.some((cell) => cell.trim().length > 0));
    if (lines.length === 0) {
      return { errors: [], rows: [], totalRows: 0 };
    }
    const header = lines[0]?.map((cell) => cell.trim()) ?? [];
    const index = new Map(header.map((name, position) => [name, position]));
    const required = [
      "serialNumber",
      "traderId",
      "customerName",
      "customerMobileNumber",
      "customerAddress",
      "codAmount",
      "serviceFee",
    ];
    const missing = required.filter((name) => !index.has(name));
    if (missing.length > 0) {
      return {
        errors: [`Missing required columns: ${missing.join(", ")}`],
        rows: [],
        totalRows: Math.max(lines.length - 1, 0),
      };
    }

    const errors: string[] = [];
    const rows: CreateOrderDto[] = [];
    const totalRows = Math.max(lines.length - 1, 0);
    for (const [offset, line] of lines.slice(1).entries()) {
      const rowNumber = offset + 2;
      const read = (column: string) => line[index.get(column) ?? -1]?.trim() ?? "";
      const codAmount = Number(read("codAmount"));
      const serviceFee = Number(read("serviceFee"));
      const additionalFeesText = read("additionalFees");
      const additionalFees = additionalFeesText.length === 0 ? 0 : Number(additionalFeesText);
      const packageCountText = read("packageCount");
      const packageCount = packageCountText.length === 0 ? 1 : Number(packageCountText);
      const rowErrors: string[] = [];
      for (const column of required) {
        if (read(column).length === 0) rowErrors.push(`${column} is required`);
      }
      if (!Number.isFinite(codAmount) || codAmount < 0)
        rowErrors.push("codAmount must be 0 or more");
      if (!Number.isFinite(serviceFee) || serviceFee < 0) {
        rowErrors.push("serviceFee must be 0 or more");
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
      if (rowErrors.length > 0) {
        errors.push(`Row ${rowNumber}: ${rowErrors.join("; ")}`);
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
        serviceFee,
        traderId: read("traderId"),
      } as CreateOrderDto;
      const referenceNumber = this.optionalCsvValue(read("referenceNumber"));
      if (referenceNumber !== undefined) {
        (parsedRow as { referenceNumber: string }).referenceNumber = referenceNumber;
      }
      const areaId = this.optionalCsvValue(read("areaId"));
      const driverId = this.optionalCsvValue(read("driverId"));
      if (areaId !== undefined) {
        (parsedRow as { areaId: string }).areaId = areaId;
      }
      if (driverId !== undefined) {
        (parsedRow as { driverId: string }).driverId = driverId;
      }
      rows.push(parsedRow);
    }
    return { errors, rows, totalRows };
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
