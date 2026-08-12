import {
  BadRequestException,
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
// Imported as values, not types: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to runtime,
// so these query/body contracts are actually validated.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
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
import { AccountingReprocessPrecheckService } from "./accounting-reprocess-precheck.service.js";
import { AutomaticPostingService } from "./automatic-posting.service.js";

/**
 * Source entity types the Accounting capture triggers write to
 * `accounting_events.source_entity_type`. Anything outside this set is not a
 * record Accounting can be related to.
 */
const relatedSourceTypes: readonly string[] = [
  "cash_bank_movement",
  "driver_reconciliation",
  "general_expense",
  "general_expense_payment",
  "order",
  "outsourced_driver_fee_accrual",
  "outsourced_driver_fee_payment",
  "payroll_payment",
  "payroll_period",
  "trader_collection",
  "trader_receivable",
  "trader_settlement",
];

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
    @Inject(AccountingReprocessPrecheckService)
    private readonly precheck: AccountingReprocessPrecheckService,
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
  @RequireAnyPermission(
    "accounting.view",
    "accounting.post",
    "accounting.manage",
    "users_roles.manage",
  )
  public reprocessingReadiness(@Param("eventId", new ParseUUIDPipe()) eventId: string) {
    return this.events.reprocessingReadiness(eventId);
  }

  /**
   * Read-only dry run of the posting pipeline for one Event. POST to match the
   * sibling reprocess-preview route, but it writes nothing, changes no status
   * and creates no Journal — safe to call any number of times.
   */
  @Post("events/:eventId/reprocess-precheck")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public reprocessPrecheck(@Param("eventId", new ParseUUIDPipe()) eventId: string) {
    return this.precheck.precheck(eventId);
  }

  /**
   * Controlled single-Event reprocess: the existing requeue flow, with the
   * full precheck re-run inside it as final revalidation. The route and
   * contract are unchanged and additive (`expectedStatus` is optional).
   */
  @Post("events/:eventId/reprocess")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public reprocessEvent(
    @Param("eventId", new ParseUUIDPipe()) eventId: string,
    @Body() input: AccountingEventReprocessDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.precheck.execute(eventId, input, idempotencyKey);
  }

  @Get("events/:eventId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public eventDetail(@Param("eventId", new ParseUUIDPipe()) eventId: string) {
    return this.events.detail(eventId);
  }

  /**
   * Related Accounting records for one operational record. Read-only; the
   * source type is validated against the closed set the capture triggers can
   * write, so an unknown value is rejected rather than silently returning an
   * empty list that would read as "nothing was posted".
   */
  @Get("related/:sourceEntityType/:sourceEntityId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public relatedRecords(
    @Param("sourceEntityType") sourceEntityType: string,
    @Param("sourceEntityId", new ParseUUIDPipe()) sourceEntityId: string,
  ) {
    if (!relatedSourceTypes.includes(sourceEntityType)) {
      throw new BadRequestException("accounting_related_source_type_invalid");
    }
    return this.events.relatedRecords(sourceEntityType, sourceEntityId);
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
