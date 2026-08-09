import {
  Body,
  Controller,
  Get,
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
  PLATFORM_COMPANIES_READ,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CompanyListQueryDto,
  CreateCompanyDto,
  LifecycleActionDto,
  SuspendCompanyDto,
  UpdateCompanyProfileDto,
} from "./platform-company.dto.js";
import { PlatformCompanyService } from "./platform-company.service.js";
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
        code: input.code,
        subdomain: input.subdomain,
        environment: input.environment,
        countryCode: input.countryCode,
        timezone: input.timezone,
        defaultLanguage: input.defaultLanguage,
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
  @ApiOperation({ summary: "Disable (close) a Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @HttpCode(204)
  @Post("disable")
  public disable(
    @Param("companyId") companyId: string,
    @Body() input: SuspendCompanyDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.companies.transition(companyId, "disabled", input.reason, this.actor(request));
  }
}
