import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { CompanyConfigurationModule } from "../company-configuration/company-configuration.module.js";
import { CompanyProfileModule } from "../company-profile/company-profile.module.js";
import { FilesModule } from "../files/files.module.js";
import { DriverCollectionPdfService } from "../operations/driver-collection-pdf.service.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { WhatsAppOutboxWriter } from "../whatsapp/whatsapp-outbox-writer.service.js";
import { AccountingController } from "./accounting.controller.js";
import { AccountMappingResolver } from "./account-mapping.resolver.js";
import { AccountingEventProcessor } from "./accounting-event.processor.js";
import { AccountingEventQueryService } from "./accounting-event-query.service.js";
import { AccountingEventRepository } from "./accounting-event.repository.js";
import { AccountingFoundationRepository } from "./accounting-foundation.repository.js";
import { AccountingFoundationService } from "./accounting-foundation.service.js";
import { AccountingManagementController } from "./accounting-management.controller.js";
import { AccountingManagementService } from "./accounting-management.service.js";
import { AccountingIntegrationController } from "./accounting-integration.controller.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { AccountingQueryService } from "./accounting-query.service.js";
import { FiscalCalendarService } from "./fiscal-calendar.service.js";
import { ManualJournalController } from "./manual-journal.controller.js";
import { ManualJournalService } from "./manual-journal.service.js";
import { OpeningBalanceController } from "./opening-balance.controller.js";
import { OpeningBalanceService } from "./opening-balance.service.js";
import { AutomaticPostingService } from "./automatic-posting.service.js";
import { OperationalJournalPostingService } from "./operational-journal-posting.service.js";
import { OperationalSourceLoader } from "./operational-source.loader.js";
import { GeneralExpenseController } from "./general-expense.controller.js";
import { GeneralExpenseAccountingEventWriter } from "./general-expense-accounting-event.writer.js";
import { GeneralExpensePaymentService } from "./general-expense-payment.service.js";
import { GeneralExpenseQueryService } from "./general-expense-query.service.js";
import { GeneralExpenseService } from "./general-expense.service.js";
import { CashBankController } from "./cash-bank.controller.js";
import { CashBankManagementService } from "./cash-bank-management.service.js";
import { CashBankQueryService } from "./cash-bank-query.service.js";
import { AccountingReportController } from "./accounting-report.controller.js";
import { BalanceControlController } from "./balance-control.controller.js";
import { AccountingClosingController } from "./accounting-closing.controller.js";
import { AccountingBatchController } from "./accounting-batch.controller.js";
import { AccountingBatchService } from "./accounting-batch.service.js";
import { AccountingDashboardController } from "./accounting-dashboard.controller.js";
import { AccountingDashboardService } from "./accounting-dashboard.service.js";
import { AccountingRecoveryController } from "./accounting-recovery.controller.js";
import { AccountingRecoveryService } from "./accounting-recovery.service.js";
import { AccountingReprocessPrecheckService } from "./accounting-reprocess-precheck.service.js";
import { AccountingClosingReadinessService } from "./accounting-closing-readiness.service.js";
import { AccountingClosingService } from "./accounting-closing.service.js";
import { AccountingYearEndService } from "./accounting-year-end.service.js";
import { BalanceControlService } from "./balance-control.service.js";
import { BalanceEnforcementCoordinator } from "./balance-enforcement.coordinator.js";
import { DailyCashActivityController } from "./daily-cash-activity.controller.js";
import { FundingAccountBalanceService } from "./funding-account-balance.service.js";
import { FundingAccountLockService } from "./funding-account-lock.service.js";
import { PaymentFundingAccountService } from "./payment-funding-account.service.js";
import { PaymentPositionController } from "./payment-position.controller.js";
import { PaymentPositionService } from "./payment-position.service.js";
import { DailyCashActivityService } from "./daily-cash-activity.service.js";
import { AccountingReportExportService } from "./accounting-report-export.service.js";
import { AccountingReportService } from "./accounting-report.service.js";
import { AccountingSetupController } from "./accounting-setup.controller.js";
import { AccountingSetupService } from "./accounting-setup.service.js";

@Module({
  imports: [AuthenticationModule, CompanyConfigurationModule, CompanyProfileModule, FilesModule],
  controllers: [
    AccountingBatchController,
    AccountingClosingController,
    AccountingRecoveryController,
    AccountingDashboardController,
    BalanceControlController,
    AccountingManagementController,
    AccountingIntegrationController,
    AccountingController,
    ManualJournalController,
    OpeningBalanceController,
    GeneralExpenseController,
    CashBankController,
    AccountingReportController,
    DailyCashActivityController,
    PaymentPositionController,
    AccountingSetupController,
  ],
  exports: [
    AccountingFoundationRepository,
    BalanceControlService,
    BalanceEnforcementCoordinator,
    FundingAccountBalanceService,
    FundingAccountLockService,
    PaymentFundingAccountService,
    AccountingFoundationService,
    AccountingManagementService,
    AccountingQueryService,
    AccountingEventQueryService,
    AutomaticPostingService,
    FiscalCalendarService,
    ManualJournalService,
    OpeningBalanceService,
    CashBankManagementService,
    CashBankQueryService,
    AccountingReportService,
  ],
  providers: [
    AccountingBatchService,
    AccountingDashboardService,
    AccountingRecoveryService,
    AccountingReprocessPrecheckService,
    AccountingClosingReadinessService,
    AccountingClosingService,
    AccountingYearEndService,
    BalanceControlService,
    BalanceEnforcementCoordinator,
    DailyCashActivityService,
    FundingAccountBalanceService,
    FundingAccountLockService,
    PaymentFundingAccountService,
    PaymentPositionService,
    AccountingFoundationRepository,
    AccountMappingResolver,
    AccountingEventProcessor,
    AccountingEventQueryService,
    AccountingEventRepository,
    AccountingFoundationService,
    AccountingManagementService,
    AutomaticPostingService,
    AccountingOperationSupport,
    AccountingQueryService,
    FiscalCalendarService,
    ManualJournalService,
    OpeningBalanceService,
    OperationalJournalPostingService,
    OperationalSourceLoader,
    OperationsHistoryWriter,
    WhatsAppOutboxWriter,
    GeneralExpenseAccountingEventWriter,
    GeneralExpensePaymentService,
    GeneralExpenseQueryService,
    GeneralExpenseService,
    CashBankManagementService,
    CashBankQueryService,
    AccountingReportService,
    AccountingReportExportService,
    AccountingSetupService,
    DriverCollectionPdfService,
  ],
})
export class AccountingModule {}
