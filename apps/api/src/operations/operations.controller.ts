import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import { accountingReportHtml, LABEL_SPAN } from "../accounting/accounting-report-html.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";

import {
  Public,
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import {
  type OperationsDriver,
  type OperationsBillingSummary,
  type OperationsExportFile,
  type OperationsInternationalShipment,
  type OperationsOrderAttachment,
  type OperationsOrderDetail,
  type OperationsOrderFilters,
  type OperationsOrder,
  type OperationsOrderPage,
  type OrdersReportFilters,
  type OrdersReportPage,
  type OperationsDriverDashboardSummary,
  type OperationsOperatorDashboardSummary,
  type OperationsOverview,
  type OperationsOrderQuote,
  type OperationsOrderImportResult,
  type OperationsPendingCashOrder,
  type OperationsPendingSettlementOrder,
  type OperationsTrackingLink,
  OperationsService,
  type PortalOrder,
  type TraderPortalArea,
  type TraderPortalDashboard,
  type TraderPortalOrderPage,
  type TraderPortalProfile,
  type PublicOrderTracking,
  type OperationsTraderSettlementDetail,
  type OperationsTraderSettlement,
  type OperationsTrader,
  type OperationsTraderOption,
  type SearchPage,
  type OrdersReportExcelFile,
} from "./operations.service.js";
import { LookupTrackingDto, VerifyTrackingDto } from "./public-tracking.dto.js";
import {
  type PublicTrackingLookupOutcome,
  type PublicTrackingVerifyOutcome,
  PublicTrackingService,
} from "./public-tracking.service.js";
import {
  DriverCashReconciliationService,
  type DriverCollectionReportData,
  type DriverCollectionsSummary,
  type DriverReconciliationPreview,
  type DriverReconciliationResult,
  type EligibleOrderRow,
  type ExpenseTypeOption,
  type Page,
  type ReconciliationDriver,
  type ReconciliationListRow,
  type SelectionTotals,
} from "./driver-cash-reconciliation.service.js";
import {
  type BulkActionPreview,
  type BulkActionResult,
  OrdersWorkflowService,
} from "./orders-workflow.service.js";
import { DriverShipmentManifestService } from "./driver-shipment-manifest.service.js";
import type { ManifestData } from "./driver-shipment-manifest-html.js";
import {
  TraderAccountStatementService,
  type TraderAccountStatement,
} from "./trader-account-statement.service.js";
import {
  TraderSettlementService,
  type CreateTraderSettlementResult,
  type Page as TraderSettlementPage,
  type TraderAllocationProposal,
  type TraderEligibleOrderRow,
  type TraderSettlementDetail,
  type TraderSettlementListRow,
  type TraderSettlementReportData,
  type TraderSettlementSummary,
  type TraderSettlementDraft,
} from "./trader-settlement.service.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ChangeOrderStatusDto,
  ChangeInternationalCarrierStatusDto,
  BulkAssignDriverDto,
  BulkChangeOrderStatusDto,
  BulkChangeInternationalCarrierStatusDto,
  BulkSettleTraderDto,
  ConfirmTraderSettlementReceiptDto,
  CreateDriverReconciliationDto,
  CreateDriverDto,
  CreateInternationalCatalogEntryDto,
  CreateTraderSettlementDto,
  DriverCollectionsSummaryQueryDto,
  DriverSearchQueryDto,
  EligibleOrdersQueryDto,
  ProposeTraderAllocationDto,
  ReconciliationListQueryDto,
  ReopenDeliveredOrderDto,
  ReverseTraderSettlementDto,
  ReverseTraderSettlementReceiptDto,
  ReverseTraderCollectionDto,
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
  OrderSelectionDto,
  ReverseDriverReconciliationDto,
  ReactivateHoldOrdersDto,
  TraderSettlementEligibleOrdersQueryDto,
  TraderSettlementListQueryDto,
  TraderSettlementSummaryQueryDto,
  TraderSettlementDraftListQueryDto,
  TraderAccountStatementQueryDto,
  UpdateOrderDto,
  GenerateShipmentManifestDto,
  UpdateTraderPortalProfileDto,
} from "./operations.dto.js";
import { OrderDeliveryReopenService } from "./order-delivery-reopen.service.js";
import { OrderMaintenanceService, type TraderReceivableResetPreview } from "./order-maintenance.service.js";
import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";

@ApiTags("operations")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequireAnyPermission("users_roles.manage")
@Controller("operations")
export class OperationsController {
  private readonly logger = new Logger(OperationsController.name);
  public constructor(
    @Inject(OperationsService) private readonly operations: OperationsService,
    @Inject(OrdersWorkflowService) private readonly ordersWorkflow: OrdersWorkflowService,
    @Inject(DriverCashReconciliationService)
    private readonly reconciliations: DriverCashReconciliationService,
    @Inject(DriverShipmentManifestService)
    private readonly manifest: DriverShipmentManifestService,
    @Inject(TraderSettlementService)
    private readonly traderSettlementService: TraderSettlementService,
    @Inject(TraderAccountStatementService)
    private readonly traderAccountStatementService: TraderAccountStatementService,
    @Inject(OrderDeliveryReopenService)
    private readonly deliveryReopen: OrderDeliveryReopenService,
    @Inject(OrderMaintenanceService)
    private readonly orderMaintenance: OrderMaintenanceService,
    @Inject(DriverCollectionPdfService)
    private readonly pdf: DriverCollectionPdfService,
    @Inject(CompanyProfileService)
    private readonly companyProfile: CompanyProfileService,
  ) {}

  // Either permission reaches the route; the SERVICE decides which one the
  // actual path needs (unused delete: users_roles.manage; processed financial
  // reset: trader_receivables.reverse, with no manage override).
  @RequireAnyPermission("users_roles.manage", "trader_receivables.reverse")
  @ApiOperation({ summary: "Preview Delete / Reset Trader Receivable maintenance action" })
  @Get("orders/:orderId/trader-receivable-reset-preview")
  public traderReceivableResetPreview(@Param("orderId", new ParseUUIDPipe()) orderId: string): Promise<TraderReceivableResetPreview> {
    return this.orderMaintenance.receivableResetPreview(orderId);
  }

  @RequireAnyPermission("users_roles.manage", "trader_receivables.reverse")
  @Get("orders/:orderId/financial-verification")
  public financialVerification(@Param("orderId", new ParseUUIDPipe()) orderId: string) {
    return this.orderMaintenance.financialVerification(orderId);
  }

  @RequireAnyPermission("users_roles.manage", "trader_receivables.reverse")
  @ApiOperation({ summary: "Delete unused or financially reset a Trader Receivable" })
  @Post("orders/:orderId/reset-trader-receivable")
  public resetTraderReceivable(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: ReverseTraderCollectionDto,
    @Req() request: Request,
  ): Promise<TraderReceivableResetPreview> {
    return this.orderMaintenance.resetTraderReceivable(orderId, input.reason, this.correlationId(request));
  }

  @ApiOperation({ summary: "Show operational totals for the authenticated Company" })
  @RequireAnyPermission("reports.financial.view", "users_roles.manage")
  @Get("overview")
  public overview(
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
  ): Promise<OperationsOverview> {
    return this.operations.overview({ dateFrom, dateTo });
  }

  @ApiOperation({ summary: "List recent orders for the authenticated Company" })
  @RequireAnyPermission(
    "orders.edit_before_processing",
    "orders.driver_self_service",
    "orders.assign_driver",
    "orders.update_delivery_status",
    "reconciliations.create",
    "reconciliations.reverse",
    "settlements.create",
    "settlements.reverse",
    "users_roles.manage",
  )
  @Get("orders")
  public orders(
    @Query("search") search?: string,
    @Query("deliveryStatus") deliveryStatus?: string,
    @Query("internationalCarrierStatus") internationalCarrierStatus?: string,
    @Query("orderType") orderType?: "collect_order" | "delivery" | "gcc_international",
    @Query("thirdPartyDeliveryCompanyName") thirdPartyDeliveryCompanyName?: string,
    @Query("destinationCountryName") destinationCountryName?: string,
    @Query("cashStatus") cashStatus?: string,
    @Query("settlementStatus") settlementStatus?: string,
    @Query("workflowStep")
    workflowStep?: "complete" | "collect_from_driver" | "collect_from_trader" | "settle_trader",
    @Query("traderId") traderId?: string,
    @Query("driverId") driverId?: string,
    @Query("areaId") areaId?: string,
    @Query("emirateId") emirateId?: string,
    @Query("referenceNumber") referenceNumber?: string,
    @Query("serialNumber") serialNumber?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("quickView")
    quickView?: "active" | "all" | "cancelled" | "closed" | "hold" | "accountant",
    @Query("deliveredOnly") deliveredOnly?: string,
    @Query("deliveryDateFrom") deliveryDateFrom?: string,
    @Query("deliveryDateTo") deliveryDateTo?: string,
    @Query("dateMode") dateMode?: string,
    @Query("businessDateFrom") businessDateFrom?: string,
    @Query("businessDateTo") businessDateTo?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("sortBy") sortBy?: "amountToCollect" | "createdAt" | "orderDate" | "orderNumber",
    @Query("sortDirection") sortDirection?: "asc" | "desc",
  ): Promise<OperationsOrderPage> {
    const filters: OperationsOrderFilters = {
      cashStatus,
      dateFrom,
      dateTo,
      deliveryStatus,
      internationalCarrierStatus,
      orderType,
      thirdPartyDeliveryCompanyName,
      destinationCountryName,
      driverId,
      areaId,
      emirateId,
      referenceNumber,
      search,
      serialNumber,
      quickView,
      // Delivery Activity. `dateFrom`/`dateTo` above still mean Order Date.
      deliveredOnly: deliveredOnly === "true",
      deliveryDateFrom,
      deliveryDateTo,
      dateMode,
      businessDateFrom,
      businessDateTo,
      page: Number(page),
      pageSize: Number(pageSize) as 25 | 50 | 100,
      sortBy,
      sortDirection,
      settlementStatus,
      workflowStep,
      traderId,
    };
    return this.operations.orders(filters);
  }

  // Deliberately narrower than `overview`: no financial totals (COD, revenue,
  // profit) are computed or returned here, so the same operational
  // permissions that unlock the Orders list are enough — an Operator scoped
  // to dispatch-only permissions must never need `reports.financial.view`
  // just to see how many Orders are New today (Prompt 12B).
  @ApiOperation({
    summary: "Operational Order counts for the authenticated Company (no financials)",
  })
  @RequireAnyPermission(
    "orders.edit_before_processing",
    "orders.driver_self_service",
    "orders.assign_driver",
    "orders.update_delivery_status",
    "reconciliations.create",
    "reconciliations.reverse",
    "settlements.create",
    "settlements.reverse",
    "users_roles.manage",
  )
  @Get("orders/dashboard-summary")
  public orderDashboardSummary(): Promise<OperationsOperatorDashboardSummary> {
    return this.operations.operatorDashboardSummary();
  }

  @RequireAnyPermission("orders.assign_driver", "users_roles.manage")
  @ApiOperation({ summary: "Preview eligibility for assigning one Driver to selected Orders" })
  @Post("orders/bulk-assign/preview")
  public bulkAssignPreview(@Body() input: BulkAssignDriverDto): Promise<BulkActionPreview> {
    return this.ordersWorkflow.assignmentPreview(input);
  }

  @ApiOperation({ summary: "Calculate count and Amount to Collect for selected Orders" })
  @Post("orders/selection-summary")
  public orderSelectionSummary(@Body() input: OrderSelectionDto): Promise<BulkActionPreview> {
    return this.ordersWorkflow.selectionSummary(input);
  }

  @RequireAnyPermission("orders.assign_driver", "users_roles.manage")
  @ApiOperation({ summary: "Assign one Driver to eligible New, Unassigned Orders" })
  @Post("orders/bulk-assign")
  public bulkAssign(
    @Body() input: BulkAssignDriverDto,
    @Req() request: Request,
  ): Promise<BulkActionResult> {
    return this.ordersWorkflow.bulkAssignDriver(input, this.correlationId(request));
  }

  @RequireAnyPermission("orders.update_delivery_status", "users_roles.manage")
  @ApiOperation({ summary: "Apply an Operations-owned status to selected eligible Orders" })
  @Post("orders/bulk-status")
  public bulkStatus(
    @Body() input: BulkChangeOrderStatusDto,
    @Req() request: Request,
  ): Promise<BulkActionResult> {
    return this.ordersWorkflow.bulkChangeStatus(input, this.correlationId(request));
  }

  @RequireAnyPermission("reconciliations.create", "users_roles.manage")
  @ApiOperation({ summary: "List active Driver reconciliation expense types" })
  @Get("cash/expense-types")
  public reconciliationExpenseTypes(): Promise<readonly ExpenseTypeOption[]> {
    return this.reconciliations.expenseTypes();
  }

  @RequireAnyPermission("reconciliations.create", "users_roles.manage")
  @ApiOperation({ summary: "Validate and calculate selected Driver reconciliation Orders" })
  @Post("cash/reconciliations/preview")
  public reconciliationPreview(
    @Body() input: CreateDriverReconciliationDto,
  ): Promise<DriverReconciliationPreview> {
    return this.reconciliations.preview(input);
  }

  @RequireAnyPermission("reconciliations.create", "users_roles.manage")
  @ApiOperation({ summary: "Confirm one atomic reconciliation for selected Driver Orders" })
  @Post("cash/reconciliations/selected")
  public reconcileSelectedDriverOrders(
    @Body() input: CreateDriverReconciliationDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<DriverReconciliationResult> {
    return this.reconciliations.confirm(input, this.correlationId(request), idempotencyKey);
  }

  @ApiOperation({ summary: "Export filtered Company orders as CSV content" })
  @Get("reports/orders-export")
  public exportOrders(
    @Query("search") search?: string,
    @Query("deliveryStatus") deliveryStatus?: string,
    @Query("cashStatus") cashStatus?: string,
    @Query("settlementStatus") settlementStatus?: string,
    @Query("workflowStep")
    workflowStep?: "complete" | "collect_from_driver" | "collect_from_trader" | "settle_trader",
    @Query("traderId") traderId?: string,
    @Query("driverId") driverId?: string,
    @Query("areaId") areaId?: string,
    @Query("emirateId") emirateId?: string,
    @Query("referenceNumber") referenceNumber?: string,
    @Query("serialNumber") serialNumber?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
  ): Promise<OperationsExportFile> {
    return this.operations.exportOrders({
      cashStatus,
      dateFrom,
      dateTo,
      deliveryStatus,
      driverId,
      areaId,
      emirateId,
      referenceNumber,
      search,
      serialNumber,
      settlementStatus,
      workflowStep,
      traderId,
    });
  }

  @RequireAnyPermission("reports.export", "users_roles.manage", "orders.edit_before_processing")
  @ApiOperation({ summary: "List Company Orders Report rows" })
  @Get("reports/orders")
  public ordersReport(
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("traderId") traderId?: string,
    @Query("statuses") statuses?: string,
    @Query("references") references?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query() query: Readonly<Record<string, unknown>> = {},
  ): Promise<OrdersReportPage> {
    const filters: OrdersReportFilters = {
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
      ...(traderId === undefined ? {} : { traderId }),
      statuses: statuses === undefined || statuses === "" ? [] : statuses.split(","),
      referenceNumbers: splitReferenceNumbers(references),
      ...extraOrdersReportFilters(query),
      page: Number(page), pageSize: Number(pageSize),
    };
    return this.operations.ordersReport(filters);
  }

  @RequireAnyPermission("reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Export the complete filtered Company Orders Report as Excel" })
  @Get("reports/orders.xlsx")
  public async ordersReportExcel(
    @Query("dateFrom") dateFrom: string | undefined,
    @Query("dateTo") dateTo: string | undefined,
    @Query("traderId") traderId: string | undefined,
    @Query("statuses") statuses: string | undefined,
    @Query("references") references: string | undefined,
    @Query() query: Readonly<Record<string, unknown>>,
    @Res() response: Response,
  ): Promise<void> {
    const report: OrdersReportExcelFile = await this.operations.ordersReportExcel({
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
      ...(traderId === undefined ? {} : { traderId }),
      statuses: statuses === undefined || statuses === "" ? [] : statuses.split(","),
      referenceNumbers: splitReferenceNumbers(references),
      ...extraOrdersReportFilters(query),
    });
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(report.bytes);
  }

  @RequireAnyPermission("reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Export the complete filtered Company Orders Report as PDF" })
  @Get("reports/orders.pdf")
  public async ordersReportPdf(
    @Query("dateFrom") dateFrom: string | undefined,
    @Query("dateTo") dateTo: string | undefined,
    @Query("traderId") traderId: string | undefined,
    @Query("statuses") statuses: string | undefined,
    @Query("references") references: string | undefined,
    @Query("language") language: string | undefined,
    @Query() query: Readonly<Record<string, unknown>>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const correlationId = this.correlationId(request);
    try {
    const reportLanguage = language === "ar" ? "ar" : "en";
      const filters: OrdersReportFilters = {
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
      ...(traderId === undefined ? {} : { traderId }),
      statuses: statuses === undefined || statuses === "" ? [] : statuses.split(","),
      referenceNumbers: splitReferenceNumbers(references),
      ...extraOrdersReportFilters(query),
      };
    const first = await this.operations.ordersReport({ ...filters, page: 1, pageSize: 200 });
    const rows = [...first.items];
    for (let page = 2; page <= Math.ceil(first.totalCount / first.pageSize); page += 1) {
      rows.push(...(await this.operations.ordersReport({ ...filters, page, pageSize: 200 })).items);
    }
    const branding = await this.companyProfile.branding();
    let logoDataUrl: string | undefined;
    if (branding.hasLogo) {
      try {
        const logo = await this.companyProfile.logoContent();
        logoDataUrl = `data:${logo.mediaType};base64,${logo.bytes.toString("base64")}`;
      } catch (error) {
        if (!(error instanceof ApplicationException) || error.errorCode !== "logo_not_found") throw error;
      }
    }
    const arabic = reportLanguage === "ar";
    const VOID = "--";
    const labels = arabic
      ? { serial: "م", referenceNumber: "رقم المرجع", orderDate: "تاريخ الطلب", deliveryDate: "تاريخ التسليم", traderName: "اسم التاجر", customer: "العميل", customerMobile: "جوال العميل", emirates: "الإمارة", area: "المنطقة", cod: "الدفع عند الاستلام", fee: "الرسوم", traderAmount: "مبلغ التاجر", paidToTrader: "مدفوع للتاجر", collectedFromTrader: "محصّل من التاجر", balance: "الرصيد", status: "الحالة" }
      : { serial: "No.", referenceNumber: "Reference Number", orderDate: "Order Date", deliveryDate: "Delivery Date", traderName: "Trader Name", customer: "Customer", customerMobile: "Customer Mobile", emirates: "Emirates", area: "Area", cod: "COD", fee: "Fee", traderAmount: "Trader Amount", paidToTrader: "Paid to Trader", collectedFromTrader: "Collected from Trader", balance: "Balance", status: "Status" };
    const statusLabels: Record<string, string> = arabic
      ? { new: "جديد", in_branch: "الصنف في الفرع", assigned_to_driver: "معين للمندوب", out_for_delivery: "خرج للتوصيل", hold: "معلّق", delivered: "تم التسليم", returned_to_branch: "عاد إلى الفرع", returned_to_trader: "عاد إلى التاجر", cancelled: "ملغى", closed: "مغلق", collect_order: "احضار طلب" }
      : { new: "New", in_branch: "Item in branch", assigned_to_driver: "Assigned to driver", out_for_delivery: "Out for delivery", hold: "Hold", delivered: "Delivered", returned_to_branch: "Returned to branch", returned_to_trader: "Returned to trader", cancelled: "Cancelled", closed: "Closed", collect_order: "Collect Order" };
    const formatDateTime = (value: Date): string => new Intl.DateTimeFormat(arabic ? "ar-AE" : "en-AE", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dubai" }).format(value);
    const filterLabels = arabic
      ? { from: "من تاريخ الطلب", to: "إلى تاريخ الطلب", trader: "التاجر", statuses: "الحالات", references: "أرقام المرجع", total: "الإجمالي", deliveryFrom: "التسليم من", deliveryTo: "التسليم إلى", emirate: "الإمارة", area: "المنطقة", driver: "المندوب", customer: "العميل", balance: "الرصيد", settlement: "التسوية" }
      : { from: "From order date", to: "To order date", trader: "Trader", statuses: "Statuses", references: "References", total: "Total", deliveryFrom: "Delivered from", deliveryTo: "Delivered to", emirate: "Emirate", area: "Area", driver: "Driver", customer: "Customer", balance: "Balance", settlement: "Settlement" };
    const referenceList = splitReferenceNumbers(references);
    const selectedTrader = traderId === undefined ? undefined : (await this.operations.traders()).find((item) => item.id === traderId);
    const selectedTraderName = selectedTrader === undefined
      ? undefined
      : (arabic ? first.items[0]?.traderNameAr || selectedTrader.name : selectedTrader.name);
    // One Trader selected: its name is shown once at the top (in red) and the
    // Trader Name column is dropped, giving that width to the other columns.
    const singleTrader = selectedTraderName !== undefined;
    const columns: readonly string[] = [
      labels.serial, labels.referenceNumber, labels.orderDate, labels.deliveryDate, ...(singleTrader ? [] : [labels.traderName]),
      labels.customer, labels.customerMobile, labels.emirates, labels.area, labels.cod, labels.fee,
      labels.traderAmount, labels.paidToTrader, labels.collectedFromTrader, labels.balance, labels.status,
    ];
    const columnWidths: Record<string, number> = {
      [labels.serial]: 3, [labels.referenceNumber]: 7, [labels.orderDate]: 7, [labels.deliveryDate]: 7, [labels.traderName]: 9, [labels.customer]: 9.5,
      [labels.customerMobile]: 8.5, [labels.emirates]: 8, [labels.area]: 11, [labels.cod]: 6, [labels.fee]: 5.5,
      [labels.traderAmount]: 6.5, [labels.paidToTrader]: 6, [labels.collectedFromTrader]: 7, [labels.balance]: 6, [labels.status]: 8,
    };
    // Summary rows: their label spans every column before COD.
    const summaryLabelSpan = columns.indexOf(labels.cod);
    const filtersForDocument = {
      [filterLabels.from]: dateFrom ?? (arabic ? "الكل" : "All"),
      [filterLabels.to]: dateTo ?? (arabic ? "الكل" : "All"),
      ...(singleTrader ? {} : { [filterLabels.trader]: arabic ? "جميع التجار" : "All Traders" }),
      [filterLabels.statuses]: statuses === undefined || statuses === "" || statuses.split(",").length === 11
        ? (arabic ? "كل الحالات" : "All Statuses")
        : statuses.split(",").map((status) => statusLabels[status] ?? status).join(arabic ? "، " : ", "),
      ...(referenceList.length === 0 ? {} : { [filterLabels.references]: referenceList.join(", ") }),
      ...(await this.ordersReportFilterLabels(filters, arabic, filterLabels, first.items[0])),
      [filterLabels.total]: String(first.totalCount),
    };
    const document = {
      columns,
      columnWidths,
      // Amounts never break mid-number (e.g. a "198.00" total split as "198.0 / 0").
      // Cancelled Orders: COD, Trader Amount and Balance show "--" in red (not in totals).
      voidMarker: VOID,
      noWrapColumns: [labels.serial, labels.referenceNumber, labels.orderDate, labels.deliveryDate, labels.customerMobile, labels.cod, labels.fee, labels.traderAmount, labels.paidToTrader, labels.collectedFromTrader, labels.balance],
      ...(singleTrader ? { highlight: { label: filterLabels.trader, value: selectedTraderName } } : {}),
      filters: filtersForDocument,
      generatedAt: formatDateTime(new Date()),
      snapshotAt: formatDateTime(new Date()),
      title: "Orders List / قائمة الطلبات",
      warnings: [],
      landscape: true,
      rows: rows.map((row, index): Record<string, string | number> => ({
        [labels.serial]: String(index + 1), [labels.referenceNumber]: row.referenceNumber ?? "", [labels.orderDate]: row.orderDate, [labels.deliveryDate]: row.deliveryDate ?? "",
        ...(singleTrader ? {} : { [labels.traderName]: arabic ? row.traderNameAr || row.traderName : row.traderName }),
        [labels.customer]: row.customer, [labels.customerMobile]: row.customerMobile,
        [labels.emirates]: arabic ? row.emiratesAr || row.emirates : row.emirates,
        [labels.area]: arabic ? row.areaAr || row.area : row.area, [labels.cod]: row.cod ?? VOID, [labels.fee]: row.fee,
        [labels.traderAmount]: row.traderAmount ?? VOID, [labels.paidToTrader]: row.paidToTrader, [labels.collectedFromTrader]: row.collectedFromTrader,
        [labels.balance]: row.balance ?? VOID, [labels.status]: statusLabels[row.status] ?? row.status,
      })).concat([{
        // Totals of the whole filtered report, as the last row.
        [LABEL_SPAN]: summaryLabelSpan,
        [labels.serial]: filterLabels.total, [labels.cod]: first.totals.cod, [labels.fee]: first.totals.fee,
        [labels.traderAmount]: first.totals.traderAmount, [labels.paidToTrader]: first.totals.paidToTrader,
        [labels.collectedFromTrader]: first.totals.collectedFromTrader, [labels.balance]: first.totals.balance,
      }]),
    };
    const rendered = accountingReportHtml({
      branding,
      document,
      language: reportLanguage,
      showTelephone: false,
      ...(logoDataUrl === undefined ? {} : { logoDataUrl }),
    });
    const bytes = await this.pdf.renderPdf(rendered.html, rendered.footer);
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", 'attachment; filename="orders-report.pdf"');
    response.setHeader("X-Content-Type-Options", "nosniff");
      response.send(bytes);
    } catch (error) {
      this.logger.error(
        `orders.pdf failed correlationId=${correlationId} stage=export`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /** Human-readable values of the extra Orders Report filters, for the PDF filter line. */
  private async ordersReportFilterLabels(
    filters: OrdersReportFilters,
    arabic: boolean,
    labels: Readonly<Record<"deliveryFrom" | "deliveryTo" | "emirate" | "area" | "driver" | "customer" | "balance" | "settlement", string>>,
    firstRow: OrdersReportPage["items"][number] | undefined,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    if (filters.deliveryFrom) result[labels.deliveryFrom] = filters.deliveryFrom;
    if (filters.deliveryTo) result[labels.deliveryTo] = filters.deliveryTo;
    // Every row shares the filtered Emirate, so the first row names it.
    if (filters.emirateId) result[labels.emirate] = firstRow === undefined ? "—" : (arabic ? firstRow.emiratesAr || firstRow.emirates : firstRow.emirates);
    if (filters.area) result[labels.area] = filters.area;
    if (filters.driverId) {
      const driver = (await this.operations.drivers(true)).find((item) => item.id === filters.driverId);
      result[labels.driver] = driver?.name ?? "—";
    }
    if (filters.customer) result[labels.customer] = filters.customer;
    const balanceNames: Record<string, readonly [string, string]> = {
      due_to_trader: ["Due to Trader", "مستحق للتاجر"],
      due_from_trader: ["Due from Trader", "مستحق من التاجر"],
      settled: ["Settled (zero)", "مسدد (صفر)"],
    };
    const balanceName = filters.balanceType === undefined ? undefined : balanceNames[filters.balanceType];
    if (balanceName !== undefined) result[labels.balance] = balanceName[arabic ? 1 : 0];
    const settlementNames: Record<string, readonly [string, string]> = {
      unsettled: ["Not settled", "غير مسوّى"],
      money_sent_to_trader: ["Money sent to Trader", "تم إرسال المبلغ للتاجر"],
      money_received_by_trader: ["Money received by Trader", "استلم التاجر المبلغ"],
      not_eligible: ["Not eligible", "غير مؤهل"],
    };
    const settlementName = filters.settlementStatus === undefined ? undefined : settlementNames[filters.settlementStatus];
    if (settlementName !== undefined) result[labels.settlement] = settlementName[arabic ? 1 : 0];
    return result;
  }

  @ApiOperation({ summary: "Calculate an order financial preview using Company VAT settings" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Post("orders/quote")
  public quoteOrder(@Body() input: OrderQuoteDto): Promise<OperationsOrderQuote> {
    return this.operations.quoteOrder(input);
  }

  @ApiOperation({ summary: "Check Company-scoped Order identifier availability" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Get("orders/identifier-availability")
  public identifierAvailability(
    @Query() query: OrderIdentifierAvailabilityQueryDto,
  ): Promise<{ referenceNumberAvailable: boolean; serialNumberAvailable: boolean }> {
    return this.operations.identifierAvailability(query);
  }

  @ApiOperation({ summary: "Get the next editable Order Serial Number for today's Business Date" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Get("orders/next-serial-number")
  public nextSerialNumber(): Promise<{ serialNumber: string }> {
    return this.operations.nextSerialNumber();
  }

  @ApiOperation({ summary: "Search active Traders for order entry" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Get("traders/search")
  public searchTraders(
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<SearchPage<OperationsTraderOption>> {
    return this.operations.searchTraders(search, Number(limit), Number(offset));
  }

  @ApiOperation({ summary: "Show Company SaaS usage and commercial setup summary" })
  @Get("billing/summary")
  public billingSummary(): Promise<OperationsBillingSummary> {
    return this.operations.billingSummary();
  }

  // Viewing detail requires the same operational access as the list — any
  // account that can see an Order in the list must be able to open it.
  // (Previously fell back to the class-level `users_roles.manage` default
  // only, silently blocking an Operator scoped to `orders.assign_driver`/
  // `orders.update_delivery_status` from opening an Order they can already
  // list — Prompt 12B.)
  @RequireAnyPermission(
    "orders.edit_before_processing",
    "orders.driver_self_service",
    "orders.assign_driver",
    "orders.update_delivery_status",
    "reconciliations.create",
    "reconciliations.reverse",
    "settlements.create",
    "settlements.reverse",
    "users_roles.manage",
  )
  @ApiOperation({ summary: "Show one order with status timeline" })
  @Get("orders/:orderId")
  public orderDetail(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
  ): Promise<OperationsOrderDetail> {
    return this.operations.orderDetail(orderId);
  }

  @RequireAnyPermission(
    "orders.edit_before_processing",
    "orders.driver_self_service",
    "orders.assign_driver",
    "orders.update_delivery_status",
    "reconciliations.create",
    "reconciliations.reverse",
    "settlements.create",
    "settlements.reverse",
    "users_roles.manage",
  )
  @ApiOperation({ summary: "Show one Order by its Company-scoped Order Number" })
  @Get("order-details/:orderNumber")
  public orderDetailByNumber(
    @Param("orderNumber") orderNumber: string,
  ): Promise<OperationsOrderDetail> {
    return this.operations.orderDetailByNumber(orderNumber);
  }

  @RequireAnyPermission("reconciliations.create", "reports.export", "users_roles.manage")
  @ApiOperation({
    summary: "Resolve the active Driver Collection linked to one Order, if any",
  })
  @Get("orders/:orderId/driver-collection")
  public async orderDriverCollection(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ reconciliationId: string; reconciliationNumber: string } | undefined> {
    const link = await this.reconciliations.reconciliationForOrder(orderId);
    // A bare `null` body is indistinguishable from an empty/no-content-type
    // response once it reaches the client, so "no linked collection" is
    // signalled with a real 204 instead.
    if (link === null) {
      response.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return link;
  }

  @RequireAnyPermission("settlements.create", "reports.export", "users_roles.manage")
  @ApiOperation({
    summary: "Resolve the active Trader Settlement linked to one Order, if any",
  })
  @Get("orders/:orderId/trader-settlement")
  public async orderTraderSettlement(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ settlementId: string; settlementNumber: string } | undefined> {
    const link = await this.traderSettlementService.settlementForOrder(orderId);
    if (link === null) {
      response.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return link;
  }

  @ApiOperation({ summary: "Create a public tracking link for one order" })
  @Post("orders/:orderId/tracking-links")
  public createTrackingLink(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Req() request: Request,
  ): Promise<OperationsTrackingLink> {
    return this.operations.createTrackingLink(orderId, this.correlationId(request));
  }

  @ApiOperation({ summary: "Register a document attachment against one order" })
  @Post("orders/:orderId/attachments")
  public registerOrderAttachment(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: RegisterOrderAttachmentDto,
    @Req() request: Request,
  ): Promise<OperationsOrderAttachment> {
    return this.operations.registerOrderAttachment(orderId, input, this.correlationId(request));
  }

  @ApiOperation({ summary: "Register or update international shipment details for one order" })
  @Post("orders/:orderId/international-shipment")
  public registerInternationalShipment(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: RegisterInternationalShipmentDto,
    @Req() request: Request,
  ): Promise<OperationsInternationalShipment> {
    return this.operations.registerInternationalShipment(
      orderId,
      input,
      this.correlationId(request),
    );
  }

  @ApiOperation({ summary: "List traders with operational totals" })
  @RequireAnyPermission("orders.create", "settlements.create", "users_roles.manage")
  @Get("traders")
  public traders(): Promise<readonly OperationsTrader[]> {
    return this.operations.traders();
  }

  @ApiOperation({ summary: "List drivers with operational totals" })
  @RequireAnyPermission(
    "orders.create",
    "orders.assign_driver",
    "orders.update_delivery_status",
    "users_roles.manage",
  )
  @Get("drivers")
  public drivers(
    // Opt-in, so assignment dropdowns keep getting active Drivers only. Filter
    // dropdowns pass it, because a departed Driver still has Orders to settle.
    @Query("includeInactive") includeInactive?: string,
  ): Promise<readonly OperationsDriver[]> {
    return this.operations.drivers(includeInactive === "true");
  }

  @RequireAnyPermission("orders.update_delivery_status", "users_roles.manage")
  @ApiOperation({ summary: "Advance selected International orders through carrier stages" })
  @Post("orders/bulk-carrier-status")
  public bulkCarrierStatus(@Body() input: BulkChangeInternationalCarrierStatusDto, @Req() request: Request): Promise<BulkActionResult> {
    return this.ordersWorkflow.bulkChangeInternationalCarrierStatus(input, this.correlationId(request));
  }

  @ApiOperation({ summary: "List active third-party delivery companies" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Get("third-party-delivery-companies")
  public thirdPartyDeliveryCompanies(@Query("search") search?: string): Promise<{ items: readonly { id: string; name: string }[]; total: number; hasMore: boolean }> {
    return this.operations.thirdPartyDeliveryCompanies(search);
  }

  @ApiOperation({ summary: "Create a third-party delivery company" })
  @RequireAnyPermission("company_profile.manage", "users_roles.manage")
  @Post("third-party-delivery-companies")
  public createThirdPartyDeliveryCompany(@Body() input: CreateInternationalCatalogEntryDto): Promise<{ id: string; name: string }> {
    return this.operations.createThirdPartyDeliveryCompany(input.name);
  }

  @Patch("third-party-delivery-companies/:id/deactivate")
  @RequireAnyPermission("company_profile.manage", "users_roles.manage")
  public deactivateThirdPartyDeliveryCompany(@Param("id", new ParseUUIDPipe()) id: string, @Req() request: Request) {
    return this.operations.deactivateThirdPartyDeliveryCompany(id, this.correlationId(request));
  }

  @Delete("third-party-delivery-companies/:id")
  @RequireAnyPermission("company_profile.manage", "users_roles.manage")
  public deleteThirdPartyDeliveryCompany(@Param("id", new ParseUUIDPipe()) id: string, @Req() request: Request) {
    return this.operations.deleteThirdPartyDeliveryCompany(id, this.correlationId(request));
  }

  @ApiOperation({ summary: "List active destination countries" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Get("destination-countries")
  public destinationCountries(@Query("search") search?: string): Promise<{ items: readonly { id: string; name: string }[]; total: number; hasMore: boolean }> {
    return this.operations.destinationCountries(search);
  }

  @ApiOperation({ summary: "Create a destination country" })
  @RequireAnyPermission("company_profile.manage", "users_roles.manage")
  @Post("destination-countries")
  public createDestinationCountry(@Body() input: CreateInternationalCatalogEntryDto): Promise<{ id: string; name: string }> {
    return this.operations.createDestinationCountry(input.name);
  }

  @Patch("destination-countries/:id/deactivate")
  @RequireAnyPermission("company_profile.manage", "users_roles.manage")
  public deactivateDestinationCountry(@Param("id", new ParseUUIDPipe()) id: string, @Req() request: Request) {
    return this.operations.deactivateDestinationCountry(id, this.correlationId(request));
  }

  @Delete("destination-countries/:id")
  @RequireAnyPermission("company_profile.manage", "users_roles.manage")
  public deleteDestinationCountry(@Param("id", new ParseUUIDPipe()) id: string, @Req() request: Request) {
    return this.operations.deleteDestinationCountry(id, this.correlationId(request));
  }

  @ApiOperation({ summary: "List delivered orders with pending driver cash" })
  @Get("cash/pending")
  public pendingCashOrders(): Promise<readonly OperationsPendingCashOrder[]> {
    return this.operations.pendingCashOrders();
  }

  @RequireAnyPermission("reconciliations.create", "users_roles.manage")
  @ApiOperation({ summary: "Search Drivers with pending Driver Cash for reconciliation" })
  @Get("cash/drivers")
  public reconciliationDrivers(
    @Query() query: DriverSearchQueryDto,
  ): Promise<Page<ReconciliationDriver>> {
    return this.reconciliations.searchDrivers(query);
  }

  @RequireAnyPermission("reconciliations.create", "users_roles.manage")
  @ApiOperation({ summary: "List eligible pending Orders for one Driver" })
  @Get("cash/eligible-orders")
  public reconciliationEligibleOrders(
    @Query() query: EligibleOrdersQueryDto,
  ): Promise<Page<EligibleOrderRow> & { readonly filteredTotals: SelectionTotals }> {
    return this.reconciliations.eligibleOrders(query);
  }

  @RequireAnyPermission("reconciliations.create", "users_roles.manage")
  @ApiOperation({ summary: "List Driver cash reconciliations" })
  @Get("cash/reconciliations")
  public driverReconciliations(
    @Query() query: ReconciliationListQueryDto,
  ): Promise<Page<ReconciliationListRow>> {
    return this.reconciliations.list(query);
  }

  // A static path segment ("summary") must be declared before the
  // ":reconciliationId" route below, or the router would try to parse
  // "summary" as a reconciliation ID first.
  @RequireAnyPermission("reconciliations.create", "users_roles.manage")
  @ApiOperation({ summary: "Server-calculated Driver Collections summary cards" })
  @Get("cash/reconciliations/summary")
  public driverCollectionsSummary(
    @Query() query: DriverCollectionsSummaryQueryDto,
  ): Promise<DriverCollectionsSummary> {
    return this.reconciliations.summary(query);
  }

  @RequireAnyPermission("reconciliations.create", "users_roles.manage")
  @ApiOperation({ summary: "Show one Driver cash reconciliation with Orders, payments and audit" })
  @Get("cash/reconciliations/:reconciliationId")
  public driverReconciliationDetail(
    @Param("reconciliationId", new ParseUUIDPipe()) reconciliationId: string,
  ): Promise<unknown> {
    return this.reconciliations.details(reconciliationId);
  }

  @ApiOperation({
    summary: "Read-only print data for the Driver collection document (grouped by Trader)",
  })
  @Get("cash/reconciliations/:reconciliationId/print-data")
  public driverReconciliationPrintData(
    @Param("reconciliationId", new ParseUUIDPipe()) reconciliationId: string,
  ): Promise<unknown> {
    return this.reconciliations.printData(reconciliationId);
  }

  @RequireAnyPermission("reconciliations.create", "reports.export", "users_roles.manage")
  @ApiOperation({
    summary: "Comprehensive server-authoritative report data for the Driver Collection Report",
  })
  @Get("cash/reconciliations/:reconciliationId/report-data")
  public driverReconciliationReportData(
    @Param("reconciliationId", new ParseUUIDPipe()) reconciliationId: string,
  ): Promise<DriverCollectionReportData> {
    return this.reconciliations.reportData(reconciliationId);
  }

  @RequireAnyPermission("reconciliations.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "True downloadable PDF file for the Driver Collection Report" })
  @Get("cash/reconciliations/:reconciliationId/pdf")
  public async driverReconciliationPdf(
    @Param("reconciliationId", new ParseUUIDPipe()) reconciliationId: string,
    @Query("language") language: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const resolvedLanguage = language === "ar" ? "ar" : "en";
    const { bytes, filename } = await this.reconciliations.reportPdf(
      reconciliationId,
      resolvedLanguage,
      this.correlationId(request),
    );
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.send(bytes);
  }

  @RequireAnyPermission(
    "reports.export",
    "orders.assign_driver",
    "orders.update_delivery_status",
    "users_roles.manage",
  )
  @ApiOperation({
    summary: "Server-authoritative data for the Driver Shipment Manifest, from selected Orders",
  })
  @Post("cash/driver-shipment-manifest/data")
  public driverShipmentManifestData(
    @Body() input: GenerateShipmentManifestDto,
  ): Promise<ManifestData> {
    return this.manifest.manifestData(input);
  }

  @RequireAnyPermission(
    "reports.export",
    "orders.assign_driver",
    "orders.update_delivery_status",
    "users_roles.manage",
  )
  @ApiOperation({ summary: "True downloadable PDF file for the Driver Shipment Manifest" })
  @Post("cash/driver-shipment-manifest/pdf")
  public async driverShipmentManifestPdf(
    @Body() input: GenerateShipmentManifestDto,
    @Query("language") language: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const resolvedLanguage = language === "ar" ? "ar" : "en";
    const { bytes, filename } = await this.manifest.manifestPdf(input, resolvedLanguage);
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.send(bytes);
  }

  @RequireAnyPermission("orders.update_delivery_status", "users_roles.manage")
  @Post("orders/hold-reactivation")
  public reactivateHoldOrders(@Body() input: ReactivateHoldOrdersDto, @Req() request: Request) {
    return this.ordersWorkflow.reactivateHoldOrders(input, this.correlationId(request));
  }

  @RequireAnyPermission(
    "reports.export",
    "orders.assign_driver",
    "orders.update_delivery_status",
    "users_roles.manage",
  )
  @Post("cash/driver-shipment-manifest/xlsx")
  public async driverShipmentManifestExcel(
    @Body() input: GenerateShipmentManifestDto,
    @Query("language") requestedLanguage: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const report = await this.manifest.manifestExcel(
      input,
      requestedLanguage === "ar" ? "ar" : "en",
    );
    response.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    response.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(report.bytes);
  }

  @RequireAnyPermission("reconciliations.reverse", "users_roles.manage")
  @ApiOperation({ summary: "Reverse a confirmed Driver cash reconciliation with a reason" })
  @Post("cash/reconciliations/:reconciliationId/reverse")
  public reverseDriverReconciliation(
    @Param("reconciliationId", new ParseUUIDPipe()) reconciliationId: string,
    @Body() input: ReverseDriverReconciliationDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<unknown> {
    return this.reconciliations.reverse(
      reconciliationId,
      input.reason,
      this.correlationId(request),
      idempotencyKey,
    );
  }

  @RequireAnyPermission("settlements.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "List delivered orders pending trader settlement" })
  @Get("settlements/pending")
  public pendingSettlementOrders(): Promise<readonly OperationsPendingSettlementOrder[]> {
    return this.operations.pendingSettlementOrders();
  }

  @RequireAnyPermission("settlements.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "List recent trader settlements" })
  @Get("settlements")
  public traderSettlements(): Promise<readonly OperationsTraderSettlement[]> {
    return this.operations.traderSettlements();
  }

  @ApiOperation({ summary: "Create an active trader in the authenticated Company" })
  @Post("traders")
  public createTrader(
    @Body() input: CreateTraderDto,
    @Req() request: Request,
  ): Promise<OperationsTrader> {
    return this.operations.createTrader(input, this.correlationId(request));
  }

  @ApiOperation({ summary: "Create an active outsourced driver in the authenticated Company" })
  @Post("drivers")
  public createDriver(
    @Body() input: CreateDriverDto,
    @Req() request: Request,
  ): Promise<OperationsDriver> {
    return this.operations.createDriver(input, this.correlationId(request));
  }

  @ApiOperation({ summary: "Create a delivery order in the authenticated Company" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Post("orders")
  public createOrder(
    @Body() input: CreateOrderDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<OperationsOrder> {
    return this.operations.createOrder(input, this.correlationId(request), idempotencyKey);
  }

  @ApiOperation({ summary: "Import delivery orders from Excel-compatible CSV text" })
  @RequireAnyPermission("orders.create", "users_roles.manage")
  @Post("orders/import-csv")
  public importOrdersCsv(
    @Body() input: ImportOrdersCsvDto,
    @Req() request: Request,
  ): Promise<OperationsOrderImportResult> {
    return this.operations.importOrdersCsv(input, this.correlationId(request));
  }

  @ApiOperation({ summary: "Edit an order's business fields before delivery" })
  @Patch("orders/:orderId")
  public updateOrder(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: UpdateOrderDto,
    @Req() request: Request,
  ): Promise<OperationsOrder> {
    return this.operations.updateOrder(orderId, input, this.correlationId(request));
  }

  @RequireAnyPermission("users_roles.manage")
  @Post("orders/:orderId/repair-trader-receivable")
  public repairTraderReceivable(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Req() request: Request,
  ): Promise<{ created: boolean; amount: string }> {
    return this.operations.repairTraderReceivable(orderId, this.correlationId(request));
  }

  @RequireAnyPermission("users_roles.manage")
  @ApiOperation({
    summary: "Administratively reopen a Delivered Order and reverse linked Driver financials",
  })
  @Post("orders/:orderId/reopen-delivery")
  public reopenDeliveredOrder(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: ReopenDeliveredOrderDto,
    @Req() request: Request,
  ): Promise<OperationsOrder> {
    return this.deliveryReopen.reopen(orderId, input.reason, this.correlationId(request));
  }

  // No permission requirement at the guard layer (deliberately empty, NOT
  // omitted — omitting it would fall back to the class-level
  // `users_roles.manage` default, which is MORE restrictive and would break
  // every ordinary Operator holding just `orders.update_delivery_status`).
  // Authorization is fully decided inside `OperationsService.changeOrderStatus`
  // instead, mirroring the driver-portal route's own established pattern
  // (`@RequireIdentityKinds("driver")` alone, ownership checked in the
  // service) — this lets a "Driver User" (a `company_user` whose linked
  // Employee backs a Driver record) reach this SAME endpoint and change
  // status on their OWN assigned Order without needing the broader Operator
  // permission, exactly like a genuine `driver`-kind identity needs none.
  // A plain Operator's existing behavior is completely unchanged: the
  // service still requires `orders.update_delivery_status`/`users_roles.manage`
  // for anyone who isn't acting on their own Driver-linked Order.
  @RequireAnyPermission()
  @ApiOperation({ summary: "Change an order delivery status" })
  @Patch("orders/:orderId/status")
  public changeOrderStatus(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: ChangeOrderStatusDto,
    @Req() request: Request,
  ): Promise<OperationsOrder> {
    return this.operations.changeOrderStatus(orderId, input, this.correlationId(request));
  }

  @RequireAnyPermission("orders.update_delivery_status", "users_roles.manage")
  @ApiOperation({ summary: "Advance an International order through its carrier handoff stages" })
  @Patch("orders/:orderId/carrier-status")
  public changeInternationalCarrierStatus(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: ChangeInternationalCarrierStatusDto,
    @Req() request: Request,
  ): Promise<OperationsOrder> {
    return this.operations.changeInternationalCarrierStatus(orderId, input, this.correlationId(request));
  }

  @RequireAnyPermission("reconciliations.create", "users_roles.manage")
  @ApiOperation({
    summary:
      "Deprecated: confirm received Driver cash for one Order. Delegates to the authoritative reconciliation service; use cash/reconciliations/selected instead.",
  })
  @Post("orders/:orderId/reconcile-cash")
  public reconcileOrderCash(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: FinancialPaymentDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<DriverReconciliationResult> {
    return this.reconciliations.confirmSingleOrder(
      orderId,
      input,
      this.correlationId(request),
      idempotencyKey,
    );
  }

  @RequireAnyPermission("settlements.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Confirm trader settlement for one order" })
  @Post("orders/:orderId/settle-trader")
  public async settleOrderTrader(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: FinancialPaymentDto,
    @Req() request: Request,
  ): Promise<OperationsOrder> {
    // Legacy route, kept for compatibility. The Settlement is created by the
    // canonical TraderSettlementService (see
    // OperationsService.legacySettlementTarget for why).
    const target = await this.operations.legacySettlementTarget(orderId);
    const amount = Number(target.outstanding);
    await this.traderSettlementService.createPayment(
      {
        allocations: [{ amount, orderId }],
        amount,
        ...(input.bankAccountId === undefined ? {} : { bankAccountId: input.bankAccountId }),
        ...(input.bankReference === undefined ? {} : { bankReference: input.bankReference }),
        ...(input.cashAccountId === undefined ? {} : { cashAccountId: input.cashAccountId }),
        paymentMethod: input.paymentMethod ?? "cash",
        ...(input.traderBankAccountId === undefined
          ? {}
          : { traderBankAccountId: input.traderBankAccountId }),
        traderId: target.traderId,
      } as CreateTraderSettlementDto,
      this.correlationId(request),
      // One key per Order version: a retry of the same request replays, a new
      // settlement after a reversal (the Order's version has moved) does not.
      `legacy-settle-order.${orderId}.v${target.version}`,
    );
    return this.operations.orderSummary(orderId);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Preview a money-out settlement for the selected orders" })
  @Post("settlements/selected/preview")
  public bulkSettlePreview(@Body() input: BulkSettleTraderDto) {
    return this.operations.bulkSettlePreview(input);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Money out to a trader for several delivered orders at once" })
  @Post("settlements/selected")
  public bulkSettleTrader(@Body() input: BulkSettleTraderDto, @Req() request: Request) {
    return this.operations.bulkSettleTrader(input, this.correlationId(request));
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Confirm that the Trader received a previously sent settlement" })
  @Post("orders/:orderId/confirm-trader-receipt")
  public confirmTraderReceipt(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Req() request: Request,
  ): Promise<OperationsOrder> {
    return this.operations.confirmTraderReceipt(orderId, this.correlationId(request));
  }

  // -------------------------------------------------------------------
  // Trader Settlement (Phase 4 Checkpoint 4): full/partial payment,
  // oldest-first allocation, Money Sent/Received, reversal, list/summary/
  // detail/report-data. Kept under a distinct `settlements/payments` prefix
  // so no route here can ever be shadowed by the legacy single-segment
  // `settlements/:settlementId` route above.
  // -------------------------------------------------------------------

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Eligible Orders for one Trader's settlement, paginated" })
  @Get("settlements/payments/eligible-orders")
  public traderSettlementEligibleOrders(
    @Query() query: TraderSettlementEligibleOrdersQueryDto,
  ): Promise<TraderSettlementPage<TraderEligibleOrderRow>> {
    return this.traderSettlementService.eligibleOrders(query);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Server-authoritative summary cards for Trader settlements" })
  @Get("settlements/payments/summary")
  public traderSettlementSummary(
    @Query() query: TraderSettlementSummaryQueryDto,
  ): Promise<TraderSettlementSummary> {
    return this.traderSettlementService.summary(query);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "List Trader settlements, paginated" })
  @Get("settlements/payments/list")
  public traderSettlementPaymentsList(
    @Query() query: TraderSettlementListQueryDto,
  ): Promise<TraderSettlementPage<TraderSettlementListRow>> {
    return this.traderSettlementService.list(query);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Oldest-first default allocation proposal for a Trader payment" })
  @Post("settlements/payments/propose-allocation")
  public proposeTraderAllocation(
    @Body() input: ProposeTraderAllocationDto,
  ): Promise<TraderAllocationProposal> {
    return this.traderSettlementService.proposeAllocation(input);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Save a financially inert Trader settlement draft" })
  @Post("settlements/drafts")
  public createTraderSettlementDraft(
    @Body() input: CreateTraderSettlementDto,
  ): Promise<TraderSettlementDraft> {
    return this.traderSettlementService.createDraft(input);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "List Trader settlement drafts" })
  @Get("settlements/drafts")
  public listTraderSettlementDrafts(
    @Query() query: TraderSettlementDraftListQueryDto,
  ) {
    return this.traderSettlementService.drafts(query);
  }

  // Declared BEFORE `settlements/drafts/:draftId`: Nest matches in declaration
  // order, so the parameterised route would otherwise capture "open" and the
  // UUID pipe would reject it.
  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "The Trader's open settlement draft, if any" })
  @Get("settlements/drafts/open")
  public openTraderSettlementDraft(
    @Query("traderId", new ParseUUIDPipe()) traderId: string,
  ): Promise<TraderSettlementDraft | null> {
    return this.traderSettlementService.openDraftForTrader(traderId);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Read a Trader settlement draft" })
  @Get("settlements/drafts/:draftId")
  public getTraderSettlementDraft(
    @Param("draftId", new ParseUUIDPipe()) draftId: string,
  ): Promise<TraderSettlementDraft> {
    return this.traderSettlementService.draft(draftId);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Edit a financially inert Trader settlement draft" })
  @Patch("settlements/drafts/:draftId")
  public updateTraderSettlementDraft(
    @Param("draftId", new ParseUUIDPipe()) draftId: string,
    @Body() input: CreateTraderSettlementDto,
  ): Promise<TraderSettlementDraft> {
    return this.traderSettlementService.updateDraft(draftId, input);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Discard an unconfirmed Trader settlement draft" })
  @Delete("settlements/drafts/:draftId")
  public deleteTraderSettlementDraft(
    @Param("draftId", new ParseUUIDPipe()) draftId: string,
  ): Promise<{ readonly id: string }> {
    return this.traderSettlementService.deleteDraft(draftId);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Confirm Money Sent to Trader for a saved draft" })
  @Post("settlements/drafts/:draftId/confirm")
  public confirmTraderSettlementDraft(
    @Param("draftId", new ParseUUIDPipe()) draftId: string,
    @Req() request: Request,
  ): Promise<CreateTraderSettlementResult> {
    return this.traderSettlementService.confirmDraft(draftId, this.correlationId(request));
  }

  @RequireAnyPermission("settlements.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Show one trader settlement with orders and payments" })
  @Get("settlements/:settlementId")
  public traderSettlementDetail(
    @Param("settlementId", new ParseUUIDPipe()) settlementId: string,
  ): Promise<OperationsTraderSettlementDetail> {
    return this.operations.traderSettlementDetail(settlementId);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Create a full or partial Trader payment with explicit allocation" })
  @Post("settlements/payments")
  public createTraderSettlementPayment(
    @Body() input: CreateTraderSettlementDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<CreateTraderSettlementResult> {
    return this.traderSettlementService.createPayment(
      input,
      this.correlationId(request),
      idempotencyKey,
    );
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Trader account statement with running payable balance" })
  @Get("settlements/payments/traders/:traderId/account-statement")
  public traderAccountStatement(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Query() query: TraderAccountStatementQueryDto,
  ): Promise<TraderAccountStatement> {
    return this.traderAccountStatementService.statement(traderId, query);
  }

  @RequireAnyPermission("settlements.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Download the Trader account statement as a PDF" })
  @Get("settlements/payments/traders/:traderId/account-statement/pdf")
  public async traderAccountStatementPdf(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Query() query: TraderAccountStatementQueryDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { bytes, filename } = await this.traderAccountStatementService.statementPdf(
      traderId,
      query,
      this.correlationId(request),
    );
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.send(bytes);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Show one Trader settlement payment in full detail" })
  @Get("settlements/payments/:settlementId")
  public traderSettlementPaymentDetail(
    @Param("settlementId", new ParseUUIDPipe()) settlementId: string,
  ): Promise<TraderSettlementDetail> {
    return this.traderSettlementService.detail(settlementId);
  }

  @RequireAnyPermission("settlements.create", "reports.export", "users_roles.manage")
  @ApiOperation({
    summary: "Server-authoritative report data for the Trader Settlement Statement",
  })
  @Get("settlements/payments/:settlementId/report-data")
  public traderSettlementReportData(
    @Param("settlementId", new ParseUUIDPipe()) settlementId: string,
  ): Promise<TraderSettlementReportData> {
    return this.traderSettlementService.reportData(settlementId);
  }

  @RequireAnyPermission("settlements.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "True downloadable PDF file for the Trader Settlement Statement" })
  @Get("settlements/payments/:settlementId/pdf")
  public async traderSettlementPdf(
    @Param("settlementId", new ParseUUIDPipe()) settlementId: string,
    @Query("language") language: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const resolvedLanguage = language === "ar" ? "ar" : "en";
    const { bytes, filename } = await this.traderSettlementService.settlementPdf(
      settlementId,
      resolvedLanguage,
      this.correlationId(request),
    );
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.send(bytes);
  }

  @RequireAnyPermission("settlements.create", "users_roles.manage")
  @ApiOperation({ summary: "Confirm that the Trader received a previously sent settlement" })
  @Post("settlements/payments/:settlementId/confirm-receipt")
  public confirmTraderSettlementReceipt(
    @Param("settlementId", new ParseUUIDPipe()) settlementId: string,
    @Body() input: ConfirmTraderSettlementReceiptDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<{ readonly orderCount: number; readonly settlementId: string }> {
    return this.traderSettlementService.confirmMoneyReceived(
      settlementId,
      input,
      this.correlationId(request),
      idempotencyKey,
    );
  }

  @RequireAnyPermission("settlements.reverse", "users_roles.manage")
  @ApiOperation({ summary: "Reverse a confirmed Trader settlement payment with a reason" })
  @Post("settlements/payments/:settlementId/reverse")
  public reverseTraderSettlementPayment(
    @Param("settlementId", new ParseUUIDPipe()) settlementId: string,
    @Body() input: ReverseTraderSettlementDto,
    @Req() request: Request,
  ): Promise<{
    readonly orderCount: number;
    readonly reversalSettlementId: string;
    readonly reversalSettlementNumber: string;
    readonly settlementId: string;
  }> {
    return this.traderSettlementService.reverse(
      settlementId,
      input.reason,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("settlements.reverse", "users_roles.manage")
  @ApiOperation({ summary: "Reverse a confirmed Trader Money Received acknowledgement" })
  @Post("settlements/payments/:settlementId/reverse-receipt")
  public reverseTraderSettlementReceipt(
    @Param("settlementId", new ParseUUIDPipe()) settlementId: string,
    @Body() input: ReverseTraderSettlementReceiptDto,
    @Req() request: Request,
  ): Promise<{ readonly orderCount: number; readonly settlementId: string }> {
    return this.traderSettlementService.reverseMoneyReceived(
      settlementId,
      input,
      this.correlationId(request),
    );
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}

@ApiTags("public-tracking")
@Controller("public/tracking")
export class PublicTrackingController {
  public constructor(
    @Inject(OperationsService) private readonly operations: OperationsService,
    @Inject(PublicTrackingService) private readonly publicTracking: PublicTrackingService,
  ) {}

  @Public()
  @ApiOperation({ summary: "Show customer-safe public order tracking for a shared tracking link" })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(":token")
  public tracking(@Param("token") token: string): Promise<PublicOrderTracking> {
    return this.operations.publicTracking(token);
  }

  // Central `tawseelhub.com/track` flow -- Airway Bill first, mobile
  // verification only when the Airway Bill is ambiguous across Tawseelhub.
  // POST (not GET) so neither the Airway Bill, the verification token, nor
  // the mobile number ever end up in access logs or browser history.
  @Public()
  @ApiOperation({ summary: "Look up public shipment tracking by Airway Bill / Tracking Number" })
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post("lookup")
  public lookup(@Body() input: LookupTrackingDto): Promise<PublicTrackingLookupOutcome> {
    return this.publicTracking.lookupByAirwayBill(input.airwayBill, input.language);
  }

  @Public()
  @ApiOperation({ summary: "Verify an ambiguous Airway Bill match by customer mobile number" })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post("verify")
  public verify(@Body() input: VerifyTrackingDto): Promise<PublicTrackingVerifyOutcome> {
    return this.publicTracking.verifyAmbiguousShipment(
      input.verificationToken,
      input.mobile,
      input.language,
    );
  }
}

@ApiTags("portal")
@ApiBearerAuth()
@Controller("portal")
export class PortalController {
  public constructor(@Inject(OperationsService) private readonly operations: OperationsService) {}

  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "Show the authenticated Trader profile" })
  @Get("trader/profile")
  public traderProfile(): Promise<TraderPortalProfile> {
    return this.operations.traderPortalProfile();
  }

  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "Update the authenticated Trader's own editable profile fields" })
  @Patch("trader/profile")
  public updateTraderProfile(
    @Body() body: UpdateTraderPortalProfileDto,
  ): Promise<TraderPortalProfile> {
    return this.operations.updateTraderPortalProfile(body);
  }

  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "Show the authenticated Trader's Dashboard summary" })
  @Get("trader/dashboard")
  public traderDashboard(): Promise<TraderPortalDashboard> {
    return this.operations.traderPortalDashboard();
  }

  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "List active delivery Areas available to the authenticated Trader" })
  @Get("trader/areas")
  public traderAreas(): Promise<readonly TraderPortalArea[]> {
    return this.operations.traderPortalAreas();
  }

  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "List orders for the authenticated Trader" })
  @Get("trader/orders")
  public traderOrders(): Promise<readonly PortalOrder[]> {
    return this.operations.traderPortalOrders();
  }

  /**
   * The searchable, paginated Trader Orders list (Trader Workspace Prompt
   * 3T-B, §4/§45). `traderId` is deliberately absent from the query params —
   * there is no client input that could name a different Trader here, unlike
   * the Company `orders()` endpoint above which legitimately filters by any
   * Trader in the Company.
   */
  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "Search the authenticated Trader's own Orders, paginated" })
  @Get("trader/orders/search")
  public traderOrdersSearch(
    @Query("search") search?: string,
    @Query("deliveryStatus") deliveryStatus?: string,
    @Query("referenceNumber") referenceNumber?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("quickView") quickView?: "active" | "all" | "cancelled" | "closed" | "hold",
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("sortBy") sortBy?: "amountToCollect" | "createdAt" | "orderDate" | "orderNumber",
    @Query("sortDirection") sortDirection?: "asc" | "desc",
  ): Promise<TraderPortalOrderPage> {
    return this.operations.traderPortalOrdersPage({
      dateFrom,
      dateTo,
      deliveryStatus,
      page: Number(page),
      pageSize: Number(pageSize) as 25 | 50 | 100,
      quickView,
      referenceNumber,
      search,
      sortBy,
      sortDirection,
    });
  }

  /**
   * The same Trader's Orders, aggregated across every Delivery Company its
   * Trader Commerce identity is linked to (Trader Portal Prompt 3T-C, Part
   * C) -- "one common Trader Order history" instead of the single session
   * Company `traderOrdersSearch` above is limited to. Read-only; see
   * `traderPortalOrdersPageAllCompanies` for why this is a separate method
   * rather than a parameter on the existing one.
   */
  @RequireIdentityKinds("trader")
  @ApiOperation({
    summary: "Search the authenticated Trader's Orders across all Delivery Companies",
  })
  @Get("trader/orders/search/all-companies")
  public traderOrdersSearchAllCompanies(
    @Query("search") search?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("deliveryCompanyId") deliveryCompanyId?: string,
    @Query("quickView") quickView?: "active" | "all" | "cancelled" | "closed" | "hold",
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ): Promise<TraderPortalOrderPage> {
    return this.operations.traderPortalOrdersPageAllCompanies({
      dateFrom,
      dateTo,
      deliveryCompanyId,
      page: Number(page),
      pageSize: Number(pageSize) as 25 | 50 | 100,
      quickView,
      search,
    });
  }

  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "List Delivery Companies the authenticated Trader is linked to" })
  @Get("trader/orders/companies")
  public traderOrdersCompanies(): Promise<
    readonly { readonly id: string; readonly isOwn: boolean; readonly name: string }[]
  > {
    return this.operations.traderPortalLinkedDeliveryCompanies();
  }

  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "Import several Orders owned by the authenticated Trader from CSV" })
  @Post("trader/orders/import-csv")
  public importTraderOrdersCsv(
    @Body() input: ImportTraderPortalOrdersCsvDto,
    @Req() request: Request,
  ): Promise<OperationsOrderImportResult> {
    return this.operations.createTraderPortalOrdersImport(input, this.correlationId(request));
  }

  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "Create an Order owned by the authenticated Trader" })
  @Post("trader/orders")
  public createTraderOrder(
    @Body() input: CreateTraderPortalOrderDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<unknown> {
    return this.operations.createTraderPortalOrder(
      input,
      this.correlationId(request),
      idempotencyKey,
    );
  }

  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "Edit an eligible Order owned by the authenticated Trader" })
  @Patch("trader/orders/:orderId")
  public updateTraderOrder(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: UpdateOrderDto,
    @Req() request: Request,
  ): Promise<unknown> {
    return this.operations.updateTraderPortalOrder(orderId, input, this.correlationId(request));
  }

  @RequireIdentityKinds("driver")
  @ApiOperation({ summary: "Dashboard summary scoped to the authenticated Driver only" })
  @Get("driver/dashboard-summary")
  public driverDashboardSummary(): Promise<OperationsDriverDashboardSummary> {
    return this.operations.driverDashboardSummary();
  }

  @RequireIdentityKinds("driver")
  @ApiOperation({ summary: "List orders assigned to the authenticated Driver" })
  @Get("driver/orders")
  public driverOrders(): Promise<readonly PortalOrder[]> {
    return this.operations.driverPortalOrders();
  }

  @RequireIdentityKinds("driver")
  @ApiOperation({ summary: "Read-only status history for one assigned Order, loaded on demand" })
  @Get("driver/orders/:orderId/history")
  public driverOrderHistory(@Param("orderId", new ParseUUIDPipe()) orderId: string) {
    return this.operations.driverPortalOrderHistory(orderId);
  }

  @RequireIdentityKinds("driver")
  @ApiOperation({ summary: "Update one assigned Driver portal order status" })
  @Patch("driver/orders/:orderId/status")
  public changeDriverOrderStatus(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: ChangeOrderStatusDto,
    @Req() request: Request,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
  ): Promise<PortalOrder> {
    return this.operations.changeDriverPortalOrderStatus(
      orderId,
      input,
      this.correlationId(request),
      idempotencyKey,
    );
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}

/** Reference Numbers typed as a list: split on commas (English or Arabic), semicolons or new lines. */
function splitReferenceNumbers(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(/[,،;\n\r]+/u).map((item) => item.trim()).filter((item) => item.length > 0);
}

/** The Orders Report filters beyond dates, Trader, statuses and references, read from the raw query. */
function extraOrdersReportFilters(query: Readonly<Record<string, unknown>>): Partial<OrdersReportFilters> {
  const text = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const keys = ["deliveryFrom", "deliveryTo", "emirateId", "area", "driverId", "customer", "balanceType", "settlementStatus"] as const;
  const result: { -readonly [K in (typeof keys)[number]]?: string } = {};
  for (const key of keys) {
    const value = text(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}
