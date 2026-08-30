import { Module } from "@nestjs/common";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { AuthenticationModule } from "../authentication/authentication.module.js";
import { FilesModule } from "../files/files.module.js";
import { UserAdministrationModule } from "../users/user-administration.module.js";
import { PlatformAuditController } from "./platform-audit.controller.js";
import { DemoRequestsModule } from "../demo-requests/demo-requests.module.js";
import { PlatformDemoRequestController } from "./platform-demo-request.controller.js";
import { TraderApplicationsModule } from "../trader-applications/trader-applications.module.js";
import { PlatformTraderApplicationController } from "./platform-trader-application.controller.js";
import { CustomerQuotesModule } from "../customer-quotes/customer-quotes.module.js";
import { PlatformCustomerQuoteController } from "./platform-customer-quote.controller.js";
import { BlogModule } from "../blog/blog.module.js";
import { PlatformBlogController } from "./platform-blog.controller.js";
import { WebsiteCmsModule } from "../website-cms/website-cms.module.js";
import { PlatformWebsiteCmsController } from "./platform-website-cms.controller.js";
import { AgentModule } from "../agent/agent.module.js";
import { PlatformAgentController } from "./platform-agent.controller.js";
import { PlatformAuditQueryService } from "./platform-audit.query.js";
import { PlatformAuditService } from "./platform-audit.service.js";
import { PlatformCompanyUserController } from "./platform-company-user.controller.js";
import { PlatformCompanyUserService } from "./platform-company-user.service.js";
import { PlatformUserDeletionService } from "./platform-user-deletion.service.js";
import { PlatformCompanyService } from "./platform-company.service.js";
import { PlatformCompanyResetService } from "./platform-company-reset.service.js";
import { PlatformCompanyDeletionService } from "./platform-company-deletion.service.js";
import {
  COMPANY_DELETION_FAILURE_INJECTOR,
  noCompanyDeletionFailure,
  PlatformCompanyDeletionExecutionService,
} from "./platform-company-deletion-execution.service.js";
import {
  COMPANY_DELETION_BACKUP_RUNNER,
  PlatformCompanyDeletionBackupService,
  runBackupProcess,
} from "./platform-company-deletion-backup.service.js";
import { PlatformAuthController } from "./platform-auth.controller.js";
import {
  PlatformCompanyController,
  PlatformCompanyDeletionController,
  PlatformTargetCompanyController,
} from "./platform-company.controller.js";
import { PlatformDashboardController } from "./platform-dashboard.controller.js";
import { PlatformDashboardService } from "./platform-dashboard.service.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";
import { PlatformService } from "./platform.service.js";
import {
  PlatformCompanyWebsiteController,
  PublicCompanyWebsiteController,
} from "./company-website.controller.js";
import { CompanyWebsiteService } from "./company-website.service.js";
import { CompanyWebsiteDomainService } from "./company-website-domain.service.js";
import {
  CloudflareCompanyWebsiteDomainProvider,
  CompanyWebsiteDomainProvider,
} from "./company-website-domain.provider.js";
import { CompanyWebsiteAgentService } from "./company-website-agent.service.js";
import { CompanyWebsiteAgentProvider } from "./company-website-agent.provider.js";
import { CompanyWebsiteAiSetupProvider } from "./company-website-ai-setup.provider.js";

/**
 * The Platform Administration API.
 *
 * Everything the Platform Portal calls lives under `/api/v1/platform/...` and
 * is owned here, rather than being scattered through the Company modules. That
 * separation is the point: a reader can see every route a Platform actor can
 * reach by reading one module, and the Company modules keep their existing
 * `@RequireIdentityKinds("company_user")` posture unchanged.
 *
 * The Company test-data reset engine gained its Portal surface with
 * `PlatformCompanyResetService` — the preview, backup and typed-confirmation
 * flow this comment previously deferred to the Company Maintenance phase.
 * The CLI remains available; both fronts drive the same reviewed engine, and
 * the service refuses any Company whose environment is 'production'.
 */
@Module({
  controllers: [
    PlatformAuditController,
    PlatformAuthController,
    PlatformCompanyController,
    PlatformCompanyDeletionController,
    PlatformDashboardController,
    PlatformDemoRequestController,
    PlatformTraderApplicationController,
    PlatformCustomerQuoteController,
    PlatformBlogController,
    PlatformWebsiteCmsController,
    PlatformAgentController,
    PlatformTargetCompanyController,
    PlatformCompanyUserController,
    PlatformCompanyWebsiteController,
    PublicCompanyWebsiteController,
  ],
  exports: [PlatformService, PlatformAuditService, PlatformCompanyService],
  imports: [
    AuthenticationModule,
    DemoRequestsModule,
    TraderApplicationsModule,
    CustomerQuotesModule,
    BlogModule,
    WebsiteCmsModule,
    AgentModule,
    FilesModule,
    UserAdministrationModule,
  ],
  providers: [
    PlatformService,
    PlatformAuditService,
    PlatformAuditQueryService,
    PlatformCompanyService,
    PlatformCompanyResetService,
    PlatformDashboardService,
    PlatformCompanyDeletionService,
    PlatformCompanyDeletionExecutionService,
    { provide: COMPANY_DELETION_FAILURE_INJECTOR, useValue: noCompanyDeletionFailure },
    PlatformCompanyDeletionBackupService,
    { provide: COMPANY_DELETION_BACKUP_RUNNER, useValue: runBackupProcess },
    PlatformCompanyUserService,
    PlatformUserDeletionService,
    AccountingTemplateImporter,
    PlatformTargetCompanyGuard,
    CompanyWebsiteService,
    CompanyWebsiteDomainService,
    CloudflareCompanyWebsiteDomainProvider,
    { provide: CompanyWebsiteDomainProvider, useExisting: CloudflareCompanyWebsiteDomainProvider },
    CompanyWebsiteAgentService,
    CompanyWebsiteAgentProvider,
    CompanyWebsiteAiSetupProvider,
  ],
})
export class PlatformModule {}
