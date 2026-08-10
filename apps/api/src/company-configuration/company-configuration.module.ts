import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { BusinessDayService } from "./business-day.service.js";
import { ReportDateModeService } from "./report-date-mode.js";
import { AreaConfigurationController } from "./area-configuration.controller.js";
import { AreaConfigurationService } from "./area-configuration.service.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { CompanyConfigurationController } from "./company-configuration.controller.js";
import { CompanyConfigurationService } from "./company-configuration.service.js";
import { CustomerConfigurationController } from "./customer-configuration.controller.js";
import { CustomerConfigurationService } from "./customer-configuration.service.js";
import { WorkforceConfigurationController } from "./workforce-configuration.controller.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { EmployeeVariableEarningService } from "./employee-variable-earning.service.js";
import { WorkforceConfigurationService } from "./workforce-configuration.service.js";
import { TraderConfigurationController } from "./trader-configuration.controller.js";
import { TraderConfigurationService } from "./trader-configuration.service.js";
import { DriverRoleProvisioningService } from "../users/driver-role-provisioning.service.js";

@Module({
  imports: [AuthenticationModule],
  controllers: [
    AreaConfigurationController,
    CompanyConfigurationController,
    WorkforceConfigurationController,
    TraderConfigurationController,
    CustomerConfigurationController,
  ],
  providers: [
    AreaConfigurationService,
    BusinessDayService,
    ReportDateModeService,
    CompanyConfigurationService,
    EmployeeVariableEarningService,
    // Required by EmployeeVariableEarningService for rule-change auditing. The
    // writer is dependency-free, so providing it here is enough -- without it
    // Nest cannot construct the module and the whole API fails to boot.
    OperationsHistoryWriter,
    WorkforceConfigurationService,
    TraderConfigurationService,
    CustomerConfigurationService,
    PasswordHasher,
    // Re-provided rather than importing UserAdministrationModule: this is a
    // leaf service (DATABASE only), and WorkforceConfigurationService needs
    // it to revoke the Driver role when a Driver is deactivated directly
    // (not via its Employee) -- matching the established pattern elsewhere
    // in this codebase of re-providing a shared leaf service instead of a
    // cross-module import (see OperationsModule's own comment on this).
    DriverRoleProvisioningService,
  ],
  exports: [BusinessDayService, ReportDateModeService],
})
export class CompanyConfigurationModule {}
