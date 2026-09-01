import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { CompanyConfigurationModule } from "../company-configuration/company-configuration.module.js";
import { CompanyProfileModule } from "../company-profile/company-profile.module.js";
import { PushModule } from "../push/push.module.js";
// Balance control for Payroll Payment confirmation. These are PROVIDED here
// rather than reached by importing AccountingModule, matching the pattern
// already used for PaymentFundingAccountService in this file and for
// OperationsHistoryWriter in AccountingModule: the two modules deliberately
// re-provide each other's leaf services instead of importing each other, so
// neither ends up depending on the other at module level.
import { AccountingOperationSupport } from "../accounting/accounting-operation.support.js";
import { BalanceControlService } from "../accounting/balance-control.service.js";
import { BalanceEnforcementCoordinator } from "../accounting/balance-enforcement.coordinator.js";
import { CashBankQueryService } from "../accounting/cash-bank-query.service.js";
import { FundingAccountBalanceService } from "../accounting/funding-account-balance.service.js";
import { FundingAccountLockService } from "../accounting/funding-account-lock.service.js";
import { GeneralExpenseQueryService } from "../accounting/general-expense-query.service.js";
import { PaymentFundingAccountService } from "../accounting/payment-funding-account.service.js";
import { EmployeeDeliveryEarningService } from "../payroll/employee-delivery-earning.service.js";
import { Clock, SystemClock } from "../shared/time/clock.js";
import { PayrollAdjustmentService } from "../payroll/payroll-adjustment.service.js";
import { PayrollCalculationService } from "../payroll/payroll-calculation.service.js";
import { PayrollController } from "../payroll/payroll.controller.js";
import { PayrollOperationSupport } from "../payroll/payroll-operation.support.js";
import { PayrollOperationalRepository } from "../payroll/payroll-operational.repository.js";
import { PayrollPaymentService } from "../payroll/payroll-payment.service.js";
import { PayrollPeriodService } from "../payroll/payroll-period.service.js";
import { PayrollQueryService } from "../payroll/payroll-query.service.js";
import { PayrollReportService } from "../payroll/payroll-report.service.js";
import { EmployeeCollectionEarningService } from "../payroll/employee-collection-earning.service.js";
import { OutsourcedDriverFeeService } from "../payroll/outsourced-driver-fee.service.js";
import { OutsourcedDriverFeeReportService } from "../payroll/outsourced-driver-fee-report.service.js";
import { DriverEarningsService } from "../payroll/driver-earnings.service.js";
import {
  OperationsController,
  PortalController,
  PublicTrackingController,
} from "./operations.controller.js";
import { DailyOperationsSummaryController } from "./daily-operations-summary.controller.js";
import { DailyOperationsSummaryService } from "./daily-operations-summary.service.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import { DriverShipmentManifestService } from "./driver-shipment-manifest.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { WhatsAppOutboxWriter } from "../whatsapp/whatsapp-outbox-writer.service.js";
import { OperationsService } from "./operations.service.js";
import { OrdersWorkflowService } from "./orders-workflow.service.js";
import { PublicTrackingService } from "./public-tracking.service.js";
import { TraderReceivableController } from "./trader-receivable.controller.js";
import { TraderReceivableService } from "./trader-receivable.service.js";
import { TraderAccountStatementService } from "./trader-account-statement.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

@Module({
  // CompanyConfigurationModule exports BusinessDayService and
  // ReportDateModeService, which the activity lists inject to resolve Date Mode.
  imports: [AuthenticationModule, CompanyProfileModule, CompanyConfigurationModule, PushModule],
  controllers: [
    OperationsController,
    PortalController,
    PublicTrackingController,
    PayrollController,
    TraderReceivableController,
    DailyOperationsSummaryController,
  ],
  providers: [
    // The balance-control chain, in dependency order. Every one of these is
    // satisfiable here: AccountingOperationSupport needs OperationsHistoryWriter
    // which this module already provides, and everything else resolves from the
    // global tenancy, identity and database providers.
    AccountingOperationSupport,
    GeneralExpenseQueryService,
    CashBankQueryService,
    FundingAccountBalanceService,
    FundingAccountLockService,
    BalanceControlService,
    BalanceEnforcementCoordinator,
    // The Daily Operations Summary's "Today"/"Yesterday" quick filters resolve
    // the Company Business Date from "now" (see `currentBusinessDate()`), so
    // "now" is injected rather than read via a bare `new Date()` -- a DB test
    // can then swap in a fixed instant to exercise the 08:00 cutoff exactly.
    { provide: Clock, useClass: SystemClock },
    DailyOperationsSummaryService,
    DriverCashReconciliationService,
    DriverCollectionPdfService,
    DriverShipmentManifestService,
    OperationsHistoryWriter,
    WhatsAppOutboxWriter,
    OperationsService,
    OrdersWorkflowService,
    PublicTrackingService,
    EmployeeDeliveryEarningService,
    EmployeeCollectionEarningService,
    OutsourcedDriverFeeService,
    OutsourcedDriverFeeReportService,
    DriverEarningsService,
    PayrollAdjustmentService,
    PayrollCalculationService,
    PayrollOperationSupport,
    PayrollOperationalRepository,
    PaymentFundingAccountService,
    PayrollPaymentService,
    PayrollPeriodService,
    PayrollQueryService,
    PayrollReportService,
    PasswordHasher,
    TraderReceivableService,
    TraderAccountStatementService,
    TraderSettlementService,
  ],
  // Customer Commerce Prompt C4: `OperationsService` is the single
  // authoritative Delivery Order creation path (`createOrder`). Exporting it
  // (nothing else) lets `StoreOrderConversionModule` reuse that exact method
  // to create a real Delivery Order from a converted Store Order, rather
  // than building a second Order-creation engine. No other provider here is
  // exported -- this module's internal composition (balance control, payroll,
  // DCR-adjacent services) stays exactly as private as it was.
  //
  // `PublicTrackingService` is exported the same way, for the same reason:
  // `AgentModule` imports this module to reuse the exact same central
  // tracking lookup/verify logic Yousef calls, rather than a second tracking
  // implementation living inside the Agent.
  exports: [OperationsService, PublicTrackingService],
})
export class OperationsModule {}
