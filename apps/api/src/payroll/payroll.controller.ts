import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { PayrollAdjustmentService } from "./payroll-adjustment.service.js";
import { PayrollCalculationService } from "./payroll-calculation.service.js";
// Runtime classes are required by Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ConfirmPayrollPaymentDto,
  CreatePayrollAdjustmentDto,
  CreatePayrollPeriodDto,
  PayrollLineListQueryDto,
  PayrollPaymentListQueryDto,
  PayrollPaymentProposalDto,
  PayrollPeriodListQueryDto,
  PayrollReasonDto,
} from "./payroll.dto.js";
import { PayrollPaymentService } from "./payroll-payment.service.js";
import { PayrollPeriodService } from "./payroll-period.service.js";
import { PayrollQueryService } from "./payroll-query.service.js";
import { PayrollReportService } from "./payroll-report.service.js";
import {
  ConfirmOutsourcedDriverFeePaymentDto,
  DailyDriverFeeAccrualReportQueryDto,
  OutstandingDriverFeesReportQueryDto,
  OutsourcedDriverFeeAccrualListQueryDto,
  OutsourcedDriverFeeBackfillDto,
  OutsourcedDriverFeePaymentListQueryDto,
  OutsourcedDriverFeePaymentProposalDto,
  OutsourcedDriverFeeReasonDto,
  OutsourcedDriverFeeReconcileDto,
  OutsourcedDriverFeeStatementQueryDto,
} from "./outsourced-driver-fee.dto.js";
import { OutsourcedDriverFeeService } from "./outsourced-driver-fee.service.js";
import { OutsourcedDriverFeeReportService } from "./outsourced-driver-fee-report.service.js";

@ApiTags("payroll")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/payroll")
export class PayrollController {
  public constructor(
    @Inject(PayrollPeriodService) private readonly periodsService: PayrollPeriodService,
    @Inject(PayrollCalculationService)
    private readonly calculationService: PayrollCalculationService,
    @Inject(PayrollAdjustmentService)
    private readonly adjustmentService: PayrollAdjustmentService,
    @Inject(PayrollPaymentService) private readonly paymentService: PayrollPaymentService,
    @Inject(PayrollQueryService) private readonly queries: PayrollQueryService,
    @Inject(PayrollReportService) private readonly reports: PayrollReportService,
    @Inject(OutsourcedDriverFeeService)
    private readonly outsourcedDriverFees: OutsourcedDriverFeeService,
    @Inject(OutsourcedDriverFeeReportService)
    private readonly outsourcedDriverFeeReports: OutsourcedDriverFeeReportService,
  ) {}

  @RequireAnyPermission("outsourced_driver_fees.view", "users_roles.manage")
  @Get("outsourced-driver-fees/drivers/:driverId/statement")
  public outsourcedDriverStatement(
    @Param("driverId", new ParseUUIDPipe()) driverId: string,
    @Query() query: OutsourcedDriverFeeStatementQueryDto,
  ) {
    return this.outsourcedDriverFeeReports.statement(driverId, query);
  }

  @RequireAnyPermission(
    "outsourced_driver_fees.view",
    "reports.export",
    "users_roles.manage",
  )
  @Get("outsourced-driver-fees/drivers/:driverId/statement/pdf")
  public async outsourcedDriverStatementPdf(
    @Param("driverId", new ParseUUIDPipe()) driverId: string,
    @Query() query: OutsourcedDriverFeeStatementQueryDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.sendPdf(
      response,
      await this.outsourcedDriverFeeReports.statementPdf(
        driverId,
        query,
        query.language === "ar" ? "ar" : "en",
        this.correlationId(request),
      ),
    );
  }

  @RequireAnyPermission("outsourced_driver_fees.view", "users_roles.manage")
  @Get("outsourced-driver-fees/reports/outstanding")
  public outstandingDriverFees(@Query() query: OutstandingDriverFeesReportQueryDto) {
    return this.outsourcedDriverFeeReports.outstanding(query);
  }

  @RequireAnyPermission(
    "outsourced_driver_fees.view",
    "reports.export",
    "users_roles.manage",
  )
  @Get("outsourced-driver-fees/reports/outstanding/pdf")
  public async outstandingDriverFeesPdf(
    @Query() query: OutstandingDriverFeesReportQueryDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.sendPdf(
      response,
      await this.outsourcedDriverFeeReports.outstandingPdf(
        query,
        query.language === "ar" ? "ar" : "en",
        this.correlationId(request),
      ),
    );
  }

  @RequireAnyPermission("outsourced_driver_fees.view", "users_roles.manage")
  @Get("outsourced-driver-fees/reports/accruals")
  public dailyDriverFeeAccruals(@Query() query: DailyDriverFeeAccrualReportQueryDto) {
    return this.outsourcedDriverFeeReports.dailyAccruals(query);
  }

  @RequireAnyPermission(
    "outsourced_driver_fees.view",
    "reports.export",
    "users_roles.manage",
  )
  @Get("outsourced-driver-fees/reports/accruals/pdf")
  public async dailyDriverFeeAccrualsPdf(
    @Query() query: DailyDriverFeeAccrualReportQueryDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.sendPdf(
      response,
      await this.outsourcedDriverFeeReports.dailyAccrualsPdf(
        query,
        query.language === "ar" ? "ar" : "en",
        this.correlationId(request),
      ),
    );
  }

  @RequireAnyPermission("outsourced_driver_fees.view", "users_roles.manage")
  @Get("outsourced-driver-fees/payments/:paymentId/receipt")
  public outsourcedDriverFeeReceipt(
    @Param("paymentId", new ParseUUIDPipe()) paymentId: string,
  ) {
    return this.outsourcedDriverFeeReports.receipt(paymentId);
  }

  @RequireAnyPermission(
    "outsourced_driver_fees.view",
    "reports.export",
    "users_roles.manage",
  )
  @Get("outsourced-driver-fees/payments/:paymentId/receipt/pdf")
  public async outsourcedDriverFeeReceiptPdf(
    @Param("paymentId", new ParseUUIDPipe()) paymentId: string,
    @Query("language") language: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.sendPdf(
      response,
      await this.outsourcedDriverFeeReports.receiptPdf(
        paymentId,
        language === "ar" ? "ar" : "en",
        this.correlationId(request),
      ),
    );
  }

  @RequireAnyPermission("outsourced_driver_fees.view", "users_roles.manage")
  @Get("outsourced-driver-fees/summary")
  public outsourcedDriverFeeSummary() {
    return this.outsourcedDriverFees.accrualSummary();
  }

  @RequireAnyPermission("outsourced_driver_fees.view", "users_roles.manage")
  @Get("outsourced-driver-fees/accruals")
  public outsourcedDriverFeeAccruals(@Query() query: OutsourcedDriverFeeAccrualListQueryDto) {
    return this.outsourcedDriverFees.accruals(query);
  }

  @RequireAnyPermission("outsourced_driver_fees.view", "users_roles.manage")
  @Get("outsourced-driver-fees/accruals/:accrualId")
  public outsourcedDriverFeeAccrualDetail(
    @Param("accrualId", new ParseUUIDPipe()) accrualId: string,
  ) {
    return this.outsourcedDriverFees.accrualDetail(accrualId);
  }

  @RequireAnyPermission("outsourced_driver_fees.manage", "users_roles.manage")
  @Post("outsourced-driver-fees/reconcile")
  public reconcileOutsourcedDriverFees(
    @Body() input: OutsourcedDriverFeeReconcileDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.outsourcedDriverFees.reconcile(
      input,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("outsourced_driver_fees.manage", "users_roles.manage")
  @Post("outsourced-driver-fees/backfill")
  public backfillOutsourcedDriverFees(
    @Body() input: OutsourcedDriverFeeBackfillDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.outsourcedDriverFees.backfill(
      input,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("outsourced_driver_fees.reverse", "users_roles.manage")
  @Post("outsourced-driver-fees/accruals/:accrualId/reverse")
  public reverseOutsourcedDriverFeeAccrual(
    @Param("accrualId", new ParseUUIDPipe()) accrualId: string,
    @Body() input: OutsourcedDriverFeeReasonDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.outsourcedDriverFees.reverseAccrual(
      accrualId,
      input.reason,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("outsourced_driver_fees.pay", "users_roles.manage")
  @Post("outsourced-driver-fees/payments/proposal")
  public outsourcedDriverFeePaymentProposal(
    @Body() input: OutsourcedDriverFeePaymentProposalDto,
  ) {
    return this.outsourcedDriverFees.paymentProposal(input);
  }

  @RequireAnyPermission("outsourced_driver_fees.pay", "users_roles.manage")
  @Post("outsourced-driver-fees/payments")
  public confirmOutsourcedDriverFeePayment(
    @Body() input: ConfirmOutsourcedDriverFeePaymentDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.outsourcedDriverFees.confirmPayment(
      input,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("outsourced_driver_fees.view", "users_roles.manage")
  @Get("outsourced-driver-fees/payments/summary")
  public outsourcedDriverFeePaymentSummary() {
    return this.outsourcedDriverFees.paymentSummary();
  }

  @RequireAnyPermission("outsourced_driver_fees.view", "users_roles.manage")
  @Get("outsourced-driver-fees/payments")
  public outsourcedDriverFeePayments(@Query() query: OutsourcedDriverFeePaymentListQueryDto) {
    return this.outsourcedDriverFees.payments(query);
  }

  @RequireAnyPermission("outsourced_driver_fees.view", "users_roles.manage")
  @Get("outsourced-driver-fees/payments/:paymentId")
  public outsourcedDriverFeePaymentDetail(
    @Param("paymentId", new ParseUUIDPipe()) paymentId: string,
  ) {
    return this.outsourcedDriverFees.paymentDetail(paymentId);
  }

  @RequireAnyPermission("outsourced_driver_fees.reverse", "users_roles.manage")
  @Post("outsourced-driver-fees/payments/:paymentId/reverse")
  public reverseOutsourcedDriverFeePayment(
    @Param("paymentId", new ParseUUIDPipe()) paymentId: string,
    @Body() input: OutsourcedDriverFeeReasonDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.outsourcedDriverFees.reversePayment(
      paymentId,
      input.reason,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("payroll.manage", "users_roles.manage")
  @ApiOperation({ summary: "Create a draft monthly Employee Payroll period" })
  @Post("periods")
  public createPeriod(
    @Body() input: CreatePayrollPeriodDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.periodsService.create(
      input.payrollMonth,
      input.notes,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("periods")
  public periods(@Query() query: PayrollPeriodListQueryDto) {
    return this.queries.periods(query);
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("periods/:periodId")
  public periodDetail(@Param("periodId", new ParseUUIDPipe()) periodId: string) {
    return this.queries.periodDetail(periodId);
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("periods/:periodId/summary")
  public periodSummary(@Param("periodId", new ParseUUIDPipe()) periodId: string) {
    return this.queries.periodSummary(periodId);
  }

  @RequireAnyPermission("payroll.manage", "users_roles.manage")
  @Post("periods/:periodId/calculate")
  public calculate(
    @Param("periodId", new ParseUUIDPipe()) periodId: string,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.calculationService.calculate(periodId, idempotencyKey, this.correlationId(request));
  }

  @RequireAnyPermission("payroll.manage", "users_roles.manage")
  @Post("periods/:periodId/recalculate")
  public recalculate(
    @Param("periodId", new ParseUUIDPipe()) periodId: string,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.calculationService.recalculate(
      periodId,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("payroll.approve", "users_roles.manage")
  @Post("periods/:periodId/approve")
  public approve(
    @Param("periodId", new ParseUUIDPipe()) periodId: string,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.periodsService.approve(periodId, idempotencyKey, this.correlationId(request));
  }

  @RequireAnyPermission("payroll.approve", "users_roles.manage")
  @Post("periods/:periodId/close")
  public close(
    @Param("periodId", new ParseUUIDPipe()) periodId: string,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.periodsService.close(periodId, idempotencyKey, this.correlationId(request));
  }

  @RequireAnyPermission("payroll.reverse", "users_roles.manage")
  @Post("periods/:periodId/reverse")
  public reversePeriod(
    @Param("periodId", new ParseUUIDPipe()) periodId: string,
    @Body() input: PayrollReasonDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.periodsService.reverse(
      periodId,
      input.reason,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("periods/:periodId/lines")
  public lines(
    @Param("periodId", new ParseUUIDPipe()) periodId: string,
    @Query() query: PayrollLineListQueryDto,
  ) {
    return this.queries.lines(periodId, query);
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("periods/:periodId/exceptions")
  public exceptions(@Param("periodId", new ParseUUIDPipe()) periodId: string) {
    return this.queries.exceptions(periodId);
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("lines/:lineId")
  public lineDetail(@Param("lineId", new ParseUUIDPipe()) lineId: string) {
    return this.queries.lineDetail(lineId);
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("lines/:lineId/payslip-data")
  public payslipData(@Param("lineId", new ParseUUIDPipe()) lineId: string) {
    return this.reports.payslipData(lineId);
  }

  @RequireAnyPermission("payroll.view", "reports.export", "users_roles.manage")
  @Get("lines/:lineId/payslip/pdf")
  public async payslipPdf(
    @Param("lineId", new ParseUUIDPipe()) lineId: string,
    @Query("language") language: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const report = await this.reports.payslipPdf(
      lineId,
      language === "ar" ? "ar" : "en",
      this.correlationId(request),
    );
    this.sendPdf(response, report);
  }

  @RequireAnyPermission("payroll.manage", "users_roles.manage")
  @Post("lines/:lineId/adjustments")
  public addAdjustment(
    @Param("lineId", new ParseUUIDPipe()) lineId: string,
    @Body() input: CreatePayrollAdjustmentDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.adjustmentService.create(
      lineId,
      input,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("payroll.reverse", "users_roles.manage")
  @Post("adjustments/:adjustmentId/reverse")
  public reverseAdjustment(
    @Param("adjustmentId", new ParseUUIDPipe()) adjustmentId: string,
    @Body() input: PayrollReasonDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.adjustmentService.reverse(
      adjustmentId,
      input.reason,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("payroll.pay", "users_roles.manage")
  @Post("payments/proposal")
  public paymentProposal(@Body() input: PayrollPaymentProposalDto) {
    return this.paymentService.proposal(input);
  }

  @RequireAnyPermission("payroll.pay", "users_roles.manage")
  @Post("payments")
  public confirmPayment(
    @Body() input: ConfirmPayrollPaymentDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.paymentService.confirm(input, idempotencyKey, this.correlationId(request));
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("payments")
  public payments(@Query() query: PayrollPaymentListQueryDto) {
    return this.queries.payments(query);
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("payments/:paymentId")
  public paymentDetail(@Param("paymentId", new ParseUUIDPipe()) paymentId: string) {
    return this.queries.paymentDetail(paymentId);
  }

  @RequireAnyPermission("payroll.reverse", "users_roles.manage")
  @Post("payments/:paymentId/reverse")
  public reversePayment(
    @Param("paymentId", new ParseUUIDPipe()) paymentId: string,
    @Body() input: PayrollReasonDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.paymentService.reverse(
      paymentId,
      input.reason,
      idempotencyKey,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("periods/:periodId/register-data")
  public registerData(@Param("periodId", new ParseUUIDPipe()) periodId: string) {
    return this.reports.registerData(periodId);
  }

  @RequireAnyPermission("payroll.view", "reports.export", "users_roles.manage")
  @Get("periods/:periodId/register/pdf")
  public async registerPdf(
    @Param("periodId", new ParseUUIDPipe()) periodId: string,
    @Query("language") language: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const report = await this.reports.registerPdf(
      periodId,
      language === "ar" ? "ar" : "en",
      this.correlationId(request),
    );
    this.sendPdf(response, report);
  }

  @RequireAnyPermission("payroll.view", "users_roles.manage")
  @Get("payments/:paymentId/report-data")
  public paymentReportData(
    @Param("paymentId", new ParseUUIDPipe()) paymentId: string,
  ) {
    return this.reports.paymentData(paymentId);
  }

  @RequireAnyPermission("payroll.view", "reports.export", "users_roles.manage")
  @Get("payments/:paymentId/pdf")
  public async paymentPdf(
    @Param("paymentId", new ParseUUIDPipe()) paymentId: string,
    @Query("language") language: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const report = await this.reports.paymentPdf(
      paymentId,
      language === "ar" ? "ar" : "en",
      this.correlationId(request),
    );
    this.sendPdf(response, report);
  }

  private sendPdf(
    response: Response,
    report: { readonly bytes: Buffer; readonly filename: string },
  ): void {
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.send(report.bytes);
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
