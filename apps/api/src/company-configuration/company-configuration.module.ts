import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { AreaConfigurationController } from "./area-configuration.controller.js";
import { AreaConfigurationService } from "./area-configuration.service.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { CompanyConfigurationController } from "./company-configuration.controller.js";
import { CompanyConfigurationService } from "./company-configuration.service.js";
import { CustomerConfigurationController } from "./customer-configuration.controller.js";
import { CustomerConfigurationService } from "./customer-configuration.service.js";
import { WorkforceConfigurationController } from "./workforce-configuration.controller.js";
import { WorkforceConfigurationService } from "./workforce-configuration.service.js";
import { TraderConfigurationController } from "./trader-configuration.controller.js";
import { TraderConfigurationService } from "./trader-configuration.service.js";

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
    CompanyConfigurationService,
    WorkforceConfigurationService,
    TraderConfigurationService,
    CustomerConfigurationService,
    PasswordHasher,
  ],
})
export class CompanyConfigurationModule {}
