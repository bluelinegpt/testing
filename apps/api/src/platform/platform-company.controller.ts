import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { IdentityContextAccessor } from "../security/identity-context.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { correlationIdOf } from "./platform-audit.service.js";
import {
  PLATFORM_AUDIT_READ,
  PLATFORM_COMPANIES_MANAGE,
  PLATFORM_COMPANIES_DELETE,
  PLATFORM_COMPANIES_READ,
  PLATFORM_COMPANIES_RESET,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CompanyListQueryDto,
  CloseCompanyDto,
  CreateCompanyDeletionBackupDto,
  PermanentDeleteCompanyDto,
  CreateCompanyDto,
  LifecycleActionDto,
  ResetCompanyDataDto,
  SuspendCompanyDto,
  UpdateCompanyProfileDto,
  UpdateShipmentPrefixDto,
  ActivateShipmentSerialDto,
} from "./platform-company.dto.js";
import { PlatformCompanyResetService } from "./platform-company-reset.service.js";
import { PlatformCompanyService } from "./platform-company.service.js";
import { PlatformCompanyDeletionService } from "./platform-company-deletion.service.js";
import { PlatformCompanyDeletionBackupService } from "./platform-company-deletion-backup.service.js";
import { PlatformCompanyDeletionExecutionService } from "./platform-company-deletion-execution.service.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";

/**
 * Company routes that are not scoped to one Company.
 *
 * Read and create are split from the per-Company routes below so that
 * `PlatformTargetCompanyGuard` applies to every route that names a
 * `:companyId` — a guard opted into route by route is a guard somebody
 * eventually forgets.
 */
@ApiTags("platform companies")
@Controller("platform/companies")
export class PlatformCompanyController {
  public constructor(
    @Inject(PlatformCompanyService) private readonly companies: PlatformCompanyService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: "List Companies with search, filters and paging" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get()
  public list(@Query() query: CompanyListQueryDto): Promise<object> {
    return this.companies.list({
      search: query.search,
      status: query.status,
      environment: query.environment,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 25,
      sort: query.sort,
      direction: query.direction,
    });
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "List the Accounting Templates approved for onboarding" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("accounting-templates")
  public templates(): object {
    return { items: this.companies.templates() };
  }

  /**
   * Creates a Company in `draft`, with its Accounting setup, in one
   * transaction. Requires `platform.companies.manage`: a read-only Platform
   * account can see everything here and change nothing.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a Company and initialise its Accounting setup" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @HttpCode(201)
  @Post()
  public async create(@Body() input: CreateCompanyDto, @Req() request: Request): Promise<object> {
    const identity = this.identities.current();
    const created = await this.companies.create(
      {
        name: input.name,
        subdomain: input.subdomain,
        environment: input.environment,
        baseCurrency: input.baseCurrency ?? "AED",
        countryCode: input.countryCode ?? "AE",
        timezone: input.timezone ?? "Asia/Dubai",
        defaultLanguage: input.defaultLanguage ?? "en",
        contactName: input.contactName,
        telephone: input.telephone,
        email: input.email,
        businessDayStart: input.businessDayStart,
        accountingTemplateCode: input.accountingTemplateCode,
        accountingTemplateVersion: input.accountingTemplateVersion,
      },
      {
        accountId: identity.identityId,
        correlationId: correlationIdOf(request),
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      },
    );
    return created;
  }
}

/**
 * Routes acting against one explicitly targeted Company.
 *
 * The target is resolved server-side from the route parameter by
 * `PlatformTargetCompanyGuard`; nothing the client sends about the Company is
 * trusted, and the Platform actor's own `companyId` stays null throughout.
 */
@ApiTags("platform companies")
@Controller("platform/companies/:companyId")
@UseGuards(PlatformTargetCompanyGuard)
export class PlatformTargetCompanyController {
  public constructor(
    @Inject(PlatformCompanyService) private readonly companies: PlatformCompanyService,
    @Inject(PlatformCompanyResetService) private readonly reset: PlatformCompanyResetService,
    @Inject(PlatformCompanyDeletionService)
    private readonly deletion: PlatformCompanyDeletionService,
    @Inject(PlatformCompanyDeletionBackupService)
    private readonly deletionBackups: PlatformCompanyDeletionBackupService,
    @Inject(PlatformCompanyDeletionExecutionService)
    private readonly deletionExecution: PlatformCompanyDeletionExecutionService,
    @Inject(RequestSecurityContextStore) private readonly contextStore: RequestSecurityContextStore,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  private actor(request: Request): { accountId: string; correlationId: string } {
    return {
      accountId: this.identities.current().identityId,
      correlationId: correlationIdOf(request),
    };
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Return one Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get()
  public details(@Param("companyId") companyId: string): Promise<object> {
    return this.companies.details(companyId);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Return the Company's Accounting setup summary" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("accounting-setup")
  public accountingSetup(@Param("companyId") companyId: string): Promise<object> {
    return this.companies.accountingSetup(companyId);
  }

  /**
   * Platform audit for this Company, gated by `platform.audit.read`.
   *
   * A separate permission from `companies.read` because seeing that a Company
   * exists and seeing every administrative action taken against it are
   * different levels of access. The code already exists; none was invented.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Return recent Platform audit entries for the Company" })
  @RequirePlatformPermissions(PLATFORM_AUDIT_READ)
  @Get("audit")
  public audit(@Param("companyId") companyId: string): Promise<object> {
    return this.companies.auditSummary(companyId).then((items) => ({ items }));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Return the Company's server-derived onboarding readiness" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("readiness")
  public readiness(@Param("companyId") companyId: string): Promise<object> {
    return this.companies.readiness(companyId);
  }

  /**
   * The server-resolved target Company, as the request sees it.
   *
   * Retained from Prompt 2: `actor.companyId` must read `null` for a Platform
   * Administrator on every response, and a test asserts it.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Return the server-resolved target Company for this request" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("context")
  public context(): object {
    const identity = this.identities.current();
    return {
      actor: {
        accountId: identity.identityId,
        kind: identity.kind,
        companyId: identity.companyId,
      },
      targetCompany: this.contextStore.targetCompany(),
      tenantCompanyId: this.tenants.current().companyId,
    };
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Update editable Company profile fields" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @Patch()
  @HttpCode(204)
  public async update(
    @Param("companyId") companyId: string,
    @Body() input: UpdateCompanyProfileDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.companies.updateProfile(
      companyId,
      input as unknown as Record<string, string | null>,
      this.actor(request),
    );
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Correct an unused Company shipment prefix" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @HttpCode(200)
  @Patch("shipment-prefix")
  public updateShipmentPrefix(
    @Param("companyId") companyId: string,
    @Body() input: UpdateShipmentPrefixDto,
    @Req() request: Request,
  ): Promise<object> {
    return this.companies.updateShipmentPrefix(companyId, input, this.actor(request));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Permanently activate PSystem Serials for a legacy Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @HttpCode(200)
  @Post("shipment-serial/activate")
  public activateShipmentSerial(
    @Param("companyId") companyId: string,
    @Body() input: ActivateShipmentSerialDto,
    @Req() request: Request,
  ): Promise<object> {
    return this.companies.activateShipmentSerial(companyId, input, this.actor(request));
  }

  /**
   * Lifecycle is expressed as explicit commands, never as a status field on a
   * PATCH. A generic status write would make every illegal transition one typo
   * away, and would leave no place to require a reason.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Activate a draft Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @HttpCode(204)
  @Post("activate")
  public activate(
    @Param("companyId") companyId: string,
    @Body() input: LifecycleActionDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.companies.transition(companyId, "active", input.reason, this.actor(request));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Suspend an active Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @HttpCode(204)
  @Post("suspend")
  public suspend(
    @Param("companyId") companyId: string,
    @Body() input: SuspendCompanyDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.companies.transition(companyId, "suspended", input.reason, this.actor(request));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Return a suspended Company to active" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @HttpCode(204)
  @Post("reactivate")
  public reactivate(
    @Param("companyId") companyId: string,
    @Body() input: LifecycleActionDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.companies.transition(companyId, "active", input.reason, this.actor(request));
  }

  /**
   * Closes a Company. There is deliberately no DELETE route anywhere in this
   * module: a Company's history — its orders, journals and audit trail — must
   * survive the Company being closed.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Permanently close Company operations without deleting data" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @HttpCode(204)
  @Post("close")
  public close(
    @Param("companyId") companyId: string,
    @Body() input: CloseCompanyDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.companies.close(companyId, input.reason, input.confirmation, this.actor(request));
  }

  /**
   * The Company test-data reset, gated by its own permission. The preview is
   * read-only and safe to call repeatedly; execution re-verifies everything —
   * including the Company's environment, under lock — inside the service.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Preview what a Company test-data reset would remove" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_RESET)
  @Get("reset-preview")
  public resetPreview(@Param("companyId") companyId: string): Promise<object> {
    return this.reset.preview(companyId);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Reset a development or demo Company's transactional data" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_RESET)
  @HttpCode(200)
  @Post("reset-execute")
  public resetExecute(
    @Param("companyId") companyId: string,
    @Body() input: ResetCompanyDataDto,
    @Req() request: Request,
  ): Promise<object> {
    return this.reset.execute(companyId, input.confirmation, this.actor(request));
  }

  /**
   * One-way: there is no route that moves a Company out of production,
   * because `environment` is the gate the data reset above depends on.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Move a Company's environment to production (one-way)" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @HttpCode(204)
  @Post("move-to-production")
  public moveToProduction(
    @Param("companyId") companyId: string,
    @Body() input: LifecycleActionDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.companies.moveToProduction(companyId, input.reason, this.actor(request));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Return server-authoritative Company deletion eligibility" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("deletion-eligibility")
  public deletionEligibility(@Param("companyId") companyId: string): Promise<object> {
    return this.deletion.eligibility(companyId);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a read-only Company deletion preview" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_DELETE)
  @HttpCode(200)
  @Post("deletion-preview")
  public deletionPreview(
    @Param("companyId") companyId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<object> {
    if (idempotencyKey === undefined || idempotencyKey.trim().length < 8) {
      throw new BadRequestException("A valid Idempotency-Key header is required");
    }
    return this.deletion.preview(companyId, this.actor(request), idempotencyKey.trim());
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Create and verify the required full-database deletion backup" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_DELETE)
  @HttpCode(200)
  @Post("deletion-backup")
  public deletionBackup(
    @Param("companyId") companyId: string,
    @Body() input: CreateCompanyDeletionBackupDto,
  ): Promise<object> {
    return this.deletionBackups.createVerifiedBackup(
      companyId,
      input.operationId,
      this.identities.current().identityId,
    );
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Permanently delete an eligible closed Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_DELETE)
  @HttpCode(200)
  @Post("permanent-delete")
  public permanentDelete(
    @Param("companyId") companyId: string,
    @Body() input: PermanentDeleteCompanyDto,
  ): Promise<object> {
    return this.deletionExecution.execute(companyId, input);
  }
}

@ApiTags("platform company deletions")
@Controller("platform/company-deletions")
export class PlatformCompanyDeletionController {
  public constructor(
    @Inject(PlatformCompanyDeletionExecutionService)
    private readonly deletionExecution: PlatformCompanyDeletionExecutionService,
  ) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: "Retry pending external cleanup after Company deletion" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_DELETE)
  @HttpCode(200)
  @Post(":operationId/retry-cleanup")
  public retryCleanup(@Param("operationId") operationId: string): Promise<object> {
    return this.deletionExecution.retryCleanup(operationId);
  }
}
