import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { ClientErrorReportController } from "./client-error-report.controller.js";
import { ClientErrorReportService } from "./client-error-report.service.js";
import { IntegrityCheckService } from "./integrity-check.service.js";
import { PlatformErrorReportController } from "./platform-error-report.controller.js";
import { PlatformIntegrityController } from "./platform-integrity.controller.js";

/**
 * Observability for any app: crash capture/triage (see
 * `ClientErrorReportService`'s own comment) and the cross-module Integration
 * Integrity Checker (see `IntegrityCheckService`'s own comment). Grouped
 * together because both exist for the same reason -- surfacing a defect the
 * normal request/response cycle would otherwise leave invisible, on the one
 * screen a Platform Administrator can actually work from.
 *
 * `ClientErrorReportService` is exported so `ApiExceptionFilter` (constructed
 * manually in `bootstrap/create-application.ts`, outside Nest's own request
 * lifecycle) can be handed an instance via `app.get(ClientErrorReportService)`
 * and report the API's own 500s through the identical path a frontend crash
 * uses.
 */
@Module({
  controllers: [
    ClientErrorReportController,
    PlatformErrorReportController,
    PlatformIntegrityController,
  ],
  exports: [ClientErrorReportService],
  imports: [AuthenticationModule],
  providers: [ClientErrorReportService, IntegrityCheckService],
})
export class ObservabilityModule {}
