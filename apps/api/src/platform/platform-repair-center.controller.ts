import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  CompanyOrderHealthService,
  type CompanyOrderHealthPage,
  type CompanyOrderHealthSummary,
} from "../operations/company-order-health.service.js";
import {
  type FinancialVerification,
  OrderMaintenanceService,
} from "../operations/order-maintenance.service.js";
import {
  type AccountingHealthPage,
  type AccountingHealthSummary,
  type AccountingIntegrityPage,
  PlatformAccountingHealthService,
} from "../accounting/platform-accounting-health.service.js";
import {
  type AccountingEventDetails,
  type AccountingRecoveryPreview,
  RepairAccountingRecoveryService,
} from "../operations/repair-accounting-recovery.service.js";
import {
  type PayrollHealthPage,
  type PayrollHealthSummary,
  PlatformPayrollHealthService,
  RepairPayrollService,
} from "../operations/payroll-repair.service.js";
import {
  type RepairCenterOverview,
  RepairCenterOverviewService,
} from "../operations/repair-center-overview.service.js";
import {
  type RepairHistoryDetail,
  type RepairHistoryPage,
  RepairHistoryService,
} from "../operations/repair-history.service.js";
import {
  type AccountingRecoveryResult,
  type RepairExecutionResult,
  RepairExecutionService,
} from "../operations/repair-execution.service.js";
import {
  type OrderRepairAnalysis,
  type RepairPreview,
  RepairPreviewService,
} from "../operations/repair-preview.service.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { correlationIdOf } from "./platform-audit.service.js";
import {
  PLATFORM_COMPANIES_READ,
  PLATFORM_REPAIR_CENTER_EXECUTE,
  PLATFORM_REPAIR_CENTER_READ,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
// Runtime DTO imports are required so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AccountingHealthQueryDto,
  AccountingIntegrityQueryDto,
  AccountingRecoveryPreviewRequestDto,
  OrderHealthListQueryDto,
  PayrollHealthQueryDto,
  OrderHealthScopeQueryDto,
  RepairExecutionRequestDto,
  RepairHistoryQueryDto,
  RepairPreviewRequestDto,
} from "./platform-repair-center.dto.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";

/**
 * Platform Administration -> Companies -> selected Company -> Repair Center.
 *
 * READ-ONLY foundation (Phase 2, Prompt 1). Every route:
 *   - is Platform-only (`platform_administrator` kind + `platform.access`)
 *     and needs `platform.companies.read` AND the dedicated
 *     `platform.companies.repair_center.read`;
 *   - names the Company explicitly by UUID in the path, re-resolved by
 *     `PlatformTargetCompanyGuard` (unknown / malformed id -> 404); an Order
 *     is only ever looked up together with that Company, never by its
 *     number alone;
 *   - reads write nothing and are not audited.
 *
 * EXECUTION (Prompt 3) is ONE route, `orders/:orderId/execute`, behind the
 * separate `platform.companies.repair_center.execute` permission. It runs
 * only a certified capability whose finding the server re-proves READY with
 * an unchanged previewVersion, atomically, with an immutable repair audit.
 * There is no reset, reverse, reprocess, force-status, bulk or automatic
 * repair route.
 */
@ApiTags("platform repair center")
@ApiBearerAuth()
@Controller("platform/companies/:companyId/repair-center")
@UseGuards(PlatformTargetCompanyGuard)
export class PlatformRepairCenterController {
  public constructor(
    @Inject(CompanyOrderHealthService) private readonly health: CompanyOrderHealthService,
    @Inject(OrderMaintenanceService) private readonly maintenance: OrderMaintenanceService,
    @Inject(RepairPreviewService) private readonly repairs: RepairPreviewService,
    @Inject(RepairExecutionService) private readonly executions: RepairExecutionService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(PlatformAccountingHealthService) private readonly accountingHealth: PlatformAccountingHealthService,
    @Inject(RepairAccountingRecoveryService) private readonly accountingRecovery: RepairAccountingRecoveryService,
    @Inject(RepairHistoryService) private readonly history: RepairHistoryService,
    @Inject(RepairCenterOverviewService) private readonly overviews: RepairCenterOverviewService,
    @Inject(PlatformPayrollHealthService) private readonly payrollHealth: PlatformPayrollHealthService,
    @Inject(RepairPayrollService) private readonly payrollRepairs: RepairPayrollService,
  ) {}

  // ------------------------------------------- Landing + History (Prompt 5)

  @ApiOperation({ summary: "Repair Center landing: consolidated Company health (read-only)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("overview")
  public overview(@Param("companyId") companyId: string): Promise<RepairCenterOverview> {
    return this.overviews.overview(companyId);
  }

  @ApiOperation({ summary: "Repair Center history: executions and attempts, newest first (read-only)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("history")
  public repairHistory(
    @Param("companyId") companyId: string,
    @Query() query: RepairHistoryQueryDto,
  ): Promise<RepairHistoryPage> {
    return this.history.list(companyId, query);
  }

  @ApiOperation({ summary: "One Repair Center history record (read-only, no customer data)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("history/:kind/:recordId")
  public repairHistoryRecord(
    @Param("companyId") companyId: string,
    @Param("kind", new ParseEnumPipe(["execution", "attempt"] as const)) kind: "execution" | "attempt",
    @Param("recordId", new ParseUUIDPipe()) recordId: string,
  ): Promise<RepairHistoryDetail> {
    return this.history.detail(companyId, kind, recordId);
  }

  @ApiOperation({ summary: "Company Order Health summary (read-only)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("health/orders/summary")
  public orderHealthSummary(
    @Param("companyId") companyId: string,
    @Query() query: OrderHealthScopeQueryDto,
  ): Promise<CompanyOrderHealthSummary> {
    return this.health.summary(companyId, query);
  }

  @ApiOperation({ summary: "Company Order Health list, paginated (read-only)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("health/orders")
  public orderHealthList(
    @Param("companyId") companyId: string,
    @Query() query: OrderHealthListQueryDto,
  ): Promise<CompanyOrderHealthPage> {
    return this.health.list(companyId, query);
  }

  /**
   * View Details: the existing Verify First, run inside the selected
   * Company. `PlatformTargetCompanyGuard` has already moved the tenant slot to
   * that Company, so the Order is matched by (Company, Order id) -- an Order
   * of another Company is "not found".
   */
  @ApiOperation({ summary: "Verify First for one Order of the selected Company (read-only)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("orders/:orderId/verify")
  public verifyOrder(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
  ): Promise<FinancialVerification> {
    return this.maintenance.financialVerification(orderId);
  }

  /**
   * Finding Details (Prompt 2): every current finding of the Order with its
   * repairability, the Order's dependency graph split CURRENT / HISTORICAL,
   * and the state fingerprint. Recomputed from the database; read-only.
   */
  @ApiOperation({ summary: "Repair Center finding details for one Order (read-only)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("orders/:orderId/findings")
  public orderFindings(
    @Param("companyId") companyId: string,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
  ): Promise<OrderRepairAnalysis> {
    return this.repairs.analyze(companyId, orderId);
  }

  /**
   * Repair Plan Preview (Prompt 2). POST only because it carries preview
   * parameters; it is READ-ONLY (PostgreSQL read-only transaction) and
   * executes nothing. There is no execution route.
   */
  @ApiOperation({ summary: "Repair plan preview for one Order (read-only, executes nothing)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @HttpCode(200)
  @Post("orders/:orderId/repair-preview")
  public repairPreview(
    @Param("companyId") companyId: string,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: RepairPreviewRequestDto,
  ): Promise<RepairPreview> {
    return this.repairs.preview(companyId, orderId, input);
  }

  /**
   * Execute ONE certified, READY repair (Prompt 3). Everything is recomputed
   * server-side under a row lock; a stale preview (409
   * `repair_preview_stale`), a finding that no longer exists (409
   * `repair_finding_not_current`) or anything not READY is refused with zero
   * mutation. Retries with the same idempotency key return the original
   * result.
   */
  @ApiOperation({ summary: "Execute a certified READY repair for one Order (audited, idempotent)" })
  @RequirePlatformPermissions(
    PLATFORM_COMPANIES_READ,
    PLATFORM_REPAIR_CENTER_READ,
    PLATFORM_REPAIR_CENTER_EXECUTE,
  )
  @HttpCode(200)
  @Post("orders/:orderId/execute")
  public executeRepair(
    @Param("companyId") companyId: string,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() input: RepairExecutionRequestDto,
    @Req() request: Request,
  ): Promise<RepairExecutionResult> {
    return this.executions.execute(companyId, orderId, input, {
      accountId: this.identities.current().identityId,
      authority: PLATFORM_REPAIR_CENTER_EXECUTE,
      correlationId: correlationIdOf(request),
    });
  }

  // ------------------------------------------------- Accounting Health (Prompt 4)

  @ApiOperation({ summary: "Accounting Health summary for the selected Company (read-only, mode-aware)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("accounting/health/summary")
  public accountingHealthSummary(@Param("companyId") companyId: string): Promise<AccountingHealthSummary> {
    return this.accountingHealth.summary(companyId);
  }

  @ApiOperation({ summary: "Accounting Health event list, triaged and paginated (read-only)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("accounting/health/events")
  public accountingHealthEvents(
    @Param("companyId") companyId: string,
    @Query() query: AccountingHealthQueryDto,
  ): Promise<AccountingHealthPage> {
    return this.accountingHealth.list(companyId, query);
  }

  @ApiOperation({
    summary: "Accounting journal-integrity and missing-required-event findings (read-only, MANUAL_REVIEW)",
  })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("accounting/health/integrity")
  public accountingHealthIntegrity(
    @Param("companyId") companyId: string,
    @Query() query: AccountingIntegrityQueryDto,
  ): Promise<AccountingIntegrityPage> {
    return this.accountingHealth.integrityFindings(companyId, query);
  }

  @ApiOperation({ summary: "Accounting event finding details (read-only, no payload)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("accounting/events/:eventId")
  public accountingEventDetails(
    @Param("companyId") companyId: string,
    @Param("eventId", new ParseUUIDPipe()) eventId: string,
  ): Promise<AccountingEventDetails> {
    return this.accountingRecovery.details(companyId, eventId);
  }

  @ApiOperation({ summary: "Accounting recovery preview: the certified precheck, read-only" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @HttpCode(200)
  @Post("accounting/events/:eventId/repair-preview")
  public accountingRecoveryPreview(
    @Param("companyId") companyId: string,
    @Param("eventId", new ParseUUIDPipe()) eventId: string,
    @Body() input: AccountingRecoveryPreviewRequestDto,
  ): Promise<AccountingRecoveryPreview> {
    void input;
    return this.accountingRecovery.preview(companyId, eventId);
  }

  /**
   * Recover ONE READY accounting event (Prompt 4): the certified precheck,
   * re-queue, claim and posting in one transaction, verified, audited and
   * idempotent. Same protections as order execution.
   */
  @ApiOperation({ summary: "Execute a READY accounting event recovery (audited, idempotent, atomic)" })
  @RequirePlatformPermissions(
    PLATFORM_COMPANIES_READ,
    PLATFORM_REPAIR_CENTER_READ,
    PLATFORM_REPAIR_CENTER_EXECUTE,
  )
  @HttpCode(200)
  @Post("accounting/events/:eventId/execute")
  public executeAccountingRecovery(
    @Param("companyId") companyId: string,
    @Param("eventId", new ParseUUIDPipe()) eventId: string,
    @Body() input: RepairExecutionRequestDto,
    @Req() request: Request,
  ): Promise<AccountingRecoveryResult> {
    return this.executions.executeAccountingEvent(companyId, eventId, input, {
      accountId: this.identities.current().identityId,
      authority: PLATFORM_REPAIR_CENTER_EXECUTE,
      correlationId: correlationIdOf(request),
    });
  }

  // ------------------------------------------------- Payroll (Phase 5 Prompt 1)

  @ApiOperation({ summary: "Payroll Health summary for the selected Company (read-only)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("payroll/health/summary")
  public payrollHealthSummary(@Param("companyId") companyId: string): Promise<PayrollHealthSummary> {
    return this.payrollHealth.summary(companyId);
  }

  @ApiOperation({ summary: "Payroll Health findings, paginated (read-only)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @Get("payroll/health/findings")
  public payrollHealthFindings(
    @Param("companyId") companyId: string,
    @Query() query: PayrollHealthQueryDto,
  ): Promise<PayrollHealthPage> {
    return this.payrollHealth.list(companyId, query);
  }

  @ApiOperation({ summary: "Preview the Payroll repairs of ONE period (read-only, recomputed)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ, PLATFORM_REPAIR_CENTER_READ)
  @HttpCode(200)
  @Post("payroll/periods/:periodId/repair-preview")
  public payrollRepairPreview(
    @Param("companyId") companyId: string,
    @Param("periodId", new ParseUUIDPipe()) periodId: string,
    @Body() input: AccountingRecoveryPreviewRequestDto,
  ) {
    void input;
    return this.payrollRepairs.preview(companyId, periodId);
  }

  @ApiOperation({ summary: "Execute a READY Payroll repair for ONE period (audited, idempotent, atomic)" })
  @RequirePlatformPermissions(
    PLATFORM_COMPANIES_READ,
    PLATFORM_REPAIR_CENTER_READ,
    PLATFORM_REPAIR_CENTER_EXECUTE,
  )
  @HttpCode(200)
  @Post("payroll/periods/:periodId/execute")
  public executePayrollRepair(
    @Param("companyId") companyId: string,
    @Param("periodId", new ParseUUIDPipe()) periodId: string,
    @Body() input: RepairExecutionRequestDto,
    @Req() request: Request,
  ) {
    return this.payrollRepairs.execute(companyId, periodId, input, {
      accountId: this.identities.current().identityId,
      authority: PLATFORM_REPAIR_CENTER_EXECUTE,
      correlationId: correlationIdOf(request),
    });
  }
}
