import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

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
  type OperationsOverview,
  type OperationsOrderQuote,
  type OperationsOrderImportResult,
  type OperationsPendingCashOrder,
  type OperationsPendingSettlementOrder,
  type OperationsTrackingLink,
  OperationsService,
  type PortalOrder,
  type PublicOrderTracking,
  type OperationsTraderSettlementDetail,
  type OperationsTraderSettlement,
  type OperationsTrader,
  type OperationsTraderOption,
  type SearchPage,
} from "./operations.service.js";
import {
  DriverCashReconciliationService,
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
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ChangeOrderStatusDto,
  BulkAssignDriverDto,
  BulkChangeOrderStatusDto,
  BulkSettleTraderDto,
  CreateDriverReconciliationDto,
  CreateDriverDto,
  DriverSearchQueryDto,
  EligibleOrdersQueryDto,
  ReconciliationListQueryDto,
  CreateOrderDto,
  CreateTraderDto,
  FinancialPaymentDto,
  ImportOrdersCsvDto,
  OrderIdentifierAvailabilityQueryDto,
  OrderQuoteDto,
  RegisterInternationalShipmentDto,
  RegisterOrderAttachmentDto,
  OrderSelectionDto,
  UpdateOrderDto,
} from "./operations.dto.js";

@ApiTags("operations")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequireAnyPermission("users_roles.manage")
@Controller("operations")
export class OperationsController {
  public constructor(
    @Inject(OperationsService) private readonly operations: OperationsService,
    @Inject(OrdersWorkflowService) private readonly ordersWorkflow: OrdersWorkflowService,
    @Inject(DriverCashReconciliationService)
    private readonly reconciliations: DriverCashReconciliationService,
  ) {}

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
    @Query("cashStatus") cashStatus?: string,
    @Query("settlementStatus") settlementStatus?: string,
    @Query("traderId") traderId?: string,
    @Query("driverId") driverId?: string,
    @Query("areaId") areaId?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("quickView") quickView?: "active" | "all" | "cancelled" | "closed" | "hold",
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
      driverId,
      areaId,
      search,
      quickView,
      page: Number(page),
      pageSize: Number(pageSize) as 25 | 50 | 100,
      sortBy,
      sortDirection,
      settlementStatus,
      traderId,
    };
    return this.operations.orders(filters);
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
    @Query("traderId") traderId?: string,
    @Query("driverId") driverId?: string,
    @Query("areaId") areaId?: string,
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
      search,
      settlementStatus,
      traderId,
    });
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

  @ApiOperation({ summary: "Show one order with status timeline" })
  @Get("orders/:orderId")
  public orderDetail(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
  ): Promise<OperationsOrderDetail> {
    return this.operations.orderDetail(orderId);
  }

  @ApiOperation({ summary: "Show one Order by its Company-scoped Order Number" })
  @Get("order-details/:orderNumber")
  public orderDetailByNumber(
    @Param("orderNumber") orderNumber: string,
  ): Promise<OperationsOrderDetail> {
    return this.operations.orderDetailByNumber(orderNumber);
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
  public drivers(): Promise<readonly OperationsDriver[]> {
    return this.operations.drivers();
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

  @RequireAnyPermission("reconciliations.create", "users_roles.manage")
  @ApiOperation({ summary: "Show one Driver cash reconciliation with Orders, payments and audit" })
  @Get("cash/reconciliations/:reconciliationId")
  public driverReconciliationDetail(
    @Param("reconciliationId", new ParseUUIDPipe()) reconciliationId: string,
  ): Promise<unknown> {
    return this.reconciliations.details(reconciliationId);
  }

  @ApiOperation({ summary: "Read-only print data for the Driver collection document (grouped by Trader)" })
  @Get("cash/reconciliations/:reconciliationId/print-data")
  public driverReconciliationPrintData(
    @Param("reconciliationId", new ParseUUIDPipe()) reconciliationId: string,
  ): Promise<unknown> {
    return this.reconciliations.printData(reconciliationId);
  }

  @ApiOperation({ summary: "List delivered orders pending trader settlement" })
  @Get("settlements/pending")
  public pendingSettlementOrders(): Promise<readonly OperationsPendingSettlementOrder[]> {
    return this.operations.pendingSettlementOrders();
  }

  @ApiOperation({ summary: "List recent trader settlements" })
  @Get("settlements")
  public traderSettlements(): Promise<readonly OperationsTraderSettlement[]> {
    return this.operations.traderSettlements();
  }

  @ApiOperation({ summary: "Show one trader settlement with orders and payments" })
  @Get("settlements/:settlementId")
  public traderSettlementDetail(
    @Param("settlementId", new ParseUUIDPipe()) settlementId: string,
  ): Promise<OperationsTraderSettlementDetail> {
    return this.operations.traderSettlementDetail(settlementId);
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

  @ApiOperation({ summary: "Change an order delivery status" })
  @Patch("orders/:orderId/status")
  public changeOrderStatus(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: ChangeOrderStatusDto,
    @Req() request: Request,
  ): Promise<OperationsOrder> {
    return this.operations.changeOrderStatus(orderId, input, this.correlationId(request));
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

  @ApiOperation({ summary: "Confirm trader settlement for one order" })
  @Post("orders/:orderId/settle-trader")
  public settleOrderTrader(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: FinancialPaymentDto,
    @Req() request: Request,
  ): Promise<OperationsOrder> {
    return this.operations.settleOrderTrader(orderId, input, this.correlationId(request));
  }

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

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}

@ApiTags("public-tracking")
@Controller("public/tracking")
export class PublicTrackingController {
  public constructor(@Inject(OperationsService) private readonly operations: OperationsService) {}

  @Public()
  @ApiOperation({ summary: "Show customer-safe public order tracking" })
  @Get(":token")
  public tracking(@Param("token") token: string): Promise<PublicOrderTracking> {
    return this.operations.publicTracking(token);
  }
}

@ApiTags("portal")
@ApiBearerAuth()
@Controller("portal")
export class PortalController {
  public constructor(@Inject(OperationsService) private readonly operations: OperationsService) {}

  @RequireIdentityKinds("trader")
  @ApiOperation({ summary: "List orders for the authenticated Trader" })
  @Get("trader/orders")
  public traderOrders(): Promise<readonly PortalOrder[]> {
    return this.operations.traderPortalOrders();
  }

  @RequireIdentityKinds("driver")
  @ApiOperation({ summary: "List orders assigned to the authenticated Driver" })
  @Get("driver/orders")
  public driverOrders(): Promise<readonly PortalOrder[]> {
    return this.operations.driverPortalOrders();
  }

  @RequireIdentityKinds("driver")
  @ApiOperation({ summary: "Update one assigned Driver portal order status" })
  @Patch("driver/orders/:orderId/status")
  public changeDriverOrderStatus(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: ChangeOrderStatusDto,
    @Req() request: Request,
  ): Promise<PortalOrder> {
    return this.operations.changeDriverPortalOrderStatus(
      orderId,
      input,
      this.correlationId(request),
    );
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
