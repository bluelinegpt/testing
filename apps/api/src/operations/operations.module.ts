import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { CompanyProfileModule } from "../company-profile/company-profile.module.js";
import { PayrollAdjustmentService } from "../payroll/payroll-adjustment.service.js";
import { PayrollCalculationService } from "../payroll/payroll-calculation.service.js";
import { PayrollController } from "../payroll/payroll.controller.js";
import { PayrollOperationSupport } from "../payroll/payroll-operation.support.js";
import { PayrollOperationalRepository } from "../payroll/payroll-operational.repository.js";
import { PayrollPaymentService } from "../payroll/payroll-payment.service.js";
import { PayrollPeriodService } from "../payroll/payroll-period.service.js";
import { PayrollQueryService } from "../payroll/payroll-query.service.js";
import { PayrollReportService } from "../payroll/payroll-report.service.js";
import { OutsourcedDriverFeeService } from "../payroll/outsourced-driver-fee.service.js";
import { OutsourcedDriverFeeReportService } from "../payroll/outsourced-driver-fee-report.service.js";
import {
  OperationsController,
  PortalController,
  PublicTrackingController,
} from "./operations.controller.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import { DriverShipmentManifestService } from "./driver-shipment-manifest.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { OperationsService } from "./operations.service.js";
import { OrdersWorkflowService } from "./orders-workflow.service.js";
import { TraderReceivableController } from "./trader-receivable.controller.js";
import { TraderReceivableService } from "./trader-receivable.service.js";
import { TraderAccountStatementService } from "./trader-account-statement.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

@Module({
  imports: [AuthenticationModule, CompanyProfileModule],
  controllers: [
    OperationsController,
    PortalController,
    PublicTrackingController,
    PayrollController,
    TraderReceivableController,
  ],
  providers: [
    DriverCashReconciliationService,
    DriverCollectionPdfService,
    DriverShipmentManifestService,
    OperationsHistoryWriter,
    OperationsService,
    OrdersWorkflowService,
    OutsourcedDriverFeeService,
    OutsourcedDriverFeeReportService,
    PayrollAdjustmentService,
    PayrollCalculationService,
    PayrollOperationSupport,
    PayrollOperationalRepository,
    PayrollPaymentService,
    PayrollPeriodService,
    PayrollQueryService,
    PayrollReportService,
    PasswordHasher,
    TraderReceivableService,
    TraderAccountStatementService,
    TraderSettlementService,
  ],
})
export class OperationsModule {}
