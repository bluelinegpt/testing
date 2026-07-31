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
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import {
  AccountingBackfillPreviewDto,
  AccountingEventBulkReprocessDto,
  AccountingEventListQueryDto,
  AccountingEventReprocessDto,
  AccountingReconciliationQueryDto,
  AutomaticPostingChangeDto,
  AutomaticPostingDisableDto,
} from "./accounting-integration.dto.js";
import { AccountingEventQueryService } from "./accounting-event-query.service.js";
import { AutomaticPostingService } from "./automatic-posting.service.js";

@ApiTags("accounting-operational-integration")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/accounting")
export class AccountingIntegrationController {
  public constructor(
    @Inject(AutomaticPostingService)
    private readonly automaticPosting: AutomaticPostingService,
    @Inject(AccountingEventQueryService)
    private readonly events: AccountingEventQueryService,
  ) {}

  @Get("automatic-posting/status")
  @RequireAnyPermission("accounting.view", "accounting.configuration.manage", "users_roles.manage")
  public automaticPostingStatus() {
    return this.automaticPosting.status();
  }

  @Get("automatic-posting/readiness")
  @RequireAnyPermission("accounting.view", "accounting.configuration.manage", "users_roles.manage")
  public automaticPostingReadiness() {
    return this.automaticPosting.readiness();
  }

  @Post("automatic-posting/enable")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public enableAutomaticPosting(
    @Body() input: AutomaticPostingChangeDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.automaticPosting.enable(input, idempotencyKey);
  }

  @Post("automatic-posting/disable")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public disableAutomaticPosting(
    @Body() input: AutomaticPostingDisableDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.automaticPosting.disable(input.reason, idempotencyKey);
  }

  @Get("events/summary")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public eventSummary() {
    return this.events.summary();
  }

  @Get("events")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public eventList(@Query() query: AccountingEventListQueryDto) {
    return this.events.list(query);
  }

  @Post("events/reprocess-preview")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public reprocessPreview(@Body() input: AccountingEventBulkReprocessDto) {
    return this.events.reprocessPreview(input);
  }

  @Post("events/reprocess")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public reprocessBulk(
    @Body() input: AccountingEventBulkReprocessDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.events.reprocessBulk(input, idempotencyKey);
  }

  @Get("events/:eventId/reprocessing-readiness")
  @RequireAnyPermission("accounting.view", "accounting.post", "accounting.manage", "users_roles.manage")
  public reprocessingReadiness(
    @Param("eventId", new ParseUUIDPipe()) eventId: string,
  ) {
    return this.events.reprocessingReadiness(eventId);
  }

  @Post("events/:eventId/reprocess")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public reprocessEvent(
    @Param("eventId", new ParseUUIDPipe()) eventId: string,
    @Body() input: AccountingEventReprocessDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.events.reprocess(eventId, input, idempotencyKey);
  }

  @Get("events/:eventId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public eventDetail(@Param("eventId", new ParseUUIDPipe()) eventId: string) {
    return this.events.detail(eventId);
  }

  @Get("reconciliation/summary")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public reconciliationSummary() {
    return this.events.reconciliationSummary();
  }

  @Get("reconciliation")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public reconciliation(@Query() query: AccountingReconciliationQueryDto) {
    return this.events.reconciliation(query);
  }

  @Post("reconciliation/preview-backfill")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public previewBackfill(@Body() input: AccountingBackfillPreviewDto) {
    return this.events.previewBackfill(input);
  }

  @Get("reconciliation/:area/:sourceId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public reconciliationDetail(
    @Param("area") area: string,
    @Param("sourceId", new ParseUUIDPipe()) sourceId: string,
  ) {
    return this.events.reconciliationDetail(area, sourceId);
  }

  @Get("operational-status/:area/:sourceId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public operationalStatus(
    @Param("area") area: string,
    @Param("sourceId", new ParseUUIDPipe()) sourceId: string,
  ) {
    return this.events.operationalStatus(area, sourceId);
  }
}
