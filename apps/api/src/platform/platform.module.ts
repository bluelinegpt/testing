import { Module } from "@nestjs/common";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import { AuthenticationModule } from "../authentication/authentication.module.js";
import { FilesModule } from "../files/files.module.js";
import { UserAdministrationModule } from "../users/user-administration.module.js";
import { PlatformAuditController } from "./platform-audit.controller.js";
import { PlatformAuditQueryService } from "./platform-audit.query.js";
import { PlatformAuditService } from "./platform-audit.service.js";
import { PlatformCompanyUserController } from "./platform-company-user.controller.js";
import { PlatformCompanyUserService } from "./platform-company-user.service.js";
import { PlatformUserDeletionService } from "./platform-user-deletion.service.js";
import { PlatformCompanyService } from "./platform-company.service.js";
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

/**
 * The Platform Administration API.
 *
 * Everything the Platform Portal calls lives under `/api/v1/platform/...` and
 * is owned here, rather than being scattered through the Company modules. That
 * separation is the point: a reader can see every route a Platform actor can
 * reach by reading one module, and the Company modules keep their existing
 * `@RequireIdentityKinds("company_user")` posture unchanged.
 *
 * The Company test-data reset tools also live in `apps/api/src/platform/` but
 * are deliberately NOT registered here. They are a CLI capability today, they
 * remain one, and exposing them through a Nest module before the Company
 * Maintenance phase has designed the preview, backup and confirmation flow
 * would create a reachable destructive surface for no benefit.
 */
@Module({
  controllers: [
    PlatformAuditController,
    PlatformAuthController,
    PlatformCompanyController,
    PlatformCompanyDeletionController,
    PlatformDashboardController,
    PlatformTargetCompanyController,
    PlatformCompanyUserController,
  ],
  exports: [PlatformService, PlatformAuditService, PlatformCompanyService],
  imports: [AuthenticationModule, FilesModule, UserAdministrationModule],
  providers: [
    PlatformService,
    PlatformAuditService,
    PlatformAuditQueryService,
    PlatformCompanyService,
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
  ],
})
export class PlatformModule {}
