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
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";

import { Public } from "../authentication/authentication.decorators.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { correlationIdOf } from "./platform-audit.service.js";
import {
  PLATFORM_COMPANIES_READ,
  PLATFORM_COMPANY_WEBSITES_MANAGE,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";
// Runtime DTO imports are required so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ConfigureCompanyWebsiteDto, MutateCompanyWebsiteDto } from "./company-website.dto.js";
import { CompanyWebsiteService } from "./company-website.service.js";
import { CompanyWebsiteAgentService } from "./company-website-agent.service.js";
import { CompanyWebsiteDomainService } from "./company-website-domain.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AddCompanyWebsiteDomainDto,
  MakePrimaryCompanyWebsiteDomainDto,
  MutateCompanyWebsiteDomainDto,
} from "./company-website-domain.dto.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CompanyWebsiteAgentMessageDto,
  StartCompanyWebsiteAgentDto,
} from "./company-website-agent.dto.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  PublicWebsiteDeliveryRequestDto,
  PublicWebsiteTrackingDto,
} from "./company-website-public.dto.js";

@ApiTags("platform company websites")
@ApiBearerAuth()
@Controller("platform/companies/:companyId/website")
@UseGuards(PlatformTargetCompanyGuard)
export class PlatformCompanyWebsiteController {
  public constructor(
    @Inject(CompanyWebsiteService) private readonly websites: CompanyWebsiteService,
    @Inject(CompanyWebsiteAgentService) private readonly websiteAgent: CompanyWebsiteAgentService,
    @Inject(CompanyWebsiteDomainService) private readonly domains: CompanyWebsiteDomainService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}
  private actor(request: Request) {
    return {
      accountId: this.identities.current().identityId,
      correlationId: correlationIdOf(request),
    };
  }

  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get()
  public get(@Param("companyId") companyId: string) {
    return this.websites.get(companyId);
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post()
  public configure(
    @Param("companyId") companyId: string,
    @Body() input: ConfigureCompanyWebsiteDto,
    @Req() request: Request,
  ) {
    return this.websites.configure(companyId, input, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Patch()
  public update(
    @Param("companyId") companyId: string,
    @Body() input: ConfigureCompanyWebsiteDto,
    @Req() request: Request,
  ) {
    return this.websites.configure(companyId, input, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post("publish")
  @HttpCode(200)
  public publish(
    @Param("companyId") companyId: string,
    @Body() input: MutateCompanyWebsiteDto,
    @Req() request: Request,
  ) {
    return this.websites.publish(companyId, input.expectedVersion, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post("disable")
  @HttpCode(200)
  public disable(
    @Param("companyId") companyId: string,
    @Body() input: MutateCompanyWebsiteDto,
    @Req() request: Request,
  ) {
    return this.websites.disable(companyId, input.expectedVersion, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post("enable")
  @HttpCode(200)
  public enable(
    @Param("companyId") companyId: string,
    @Body() input: MutateCompanyWebsiteDto,
    @Req() request: Request,
  ) {
    return this.websites.enable(companyId, input.expectedVersion, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post("discard-draft")
  @HttpCode(200)
  public discardDraft(
    @Param("companyId") companyId: string,
    @Body() input: MutateCompanyWebsiteDto,
    @Req() request: Request,
  ) {
    return this.websites.discardDraft(companyId, input.expectedVersion, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @ApiOperation({ summary: "Preview a Company website, including drafts" })
  @Get("preview")
  public preview(
    @Param("companyId") companyId: string,
    @Query("templateKey") templateKey?: string,
  ) {
    return this.websites.preview(companyId, templateKey);
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post("preview-agent")
  @HttpCode(200)
  public previewAgent(
    @Param("companyId") companyId: string,
    @Body() input: CompanyWebsiteAgentMessageDto,
  ) {
    return this.websiteAgent.preview(companyId, input.message, input.language);
  }

  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get("domains")
  public domainsList(@Param("companyId") companyId: string) {
    return this.domains.list(companyId);
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post("domains")
  public addDomain(
    @Param("companyId") companyId: string,
    @Body() input: AddCompanyWebsiteDomainDto,
    @Req() request: Request,
  ) {
    return this.domains.add(companyId, input.hostname, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post("domains/:domainId/refresh")
  @HttpCode(200)
  public refreshDomain(
    @Param("companyId") companyId: string,
    @Param("domainId") domainId: string,
    @Body() input: MutateCompanyWebsiteDomainDto,
    @Req() request: Request,
  ) {
    return this.domains.refresh(companyId, domainId, input.expectedVersion, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post("domains/:domainId/make-primary")
  @HttpCode(200)
  public primaryDomain(
    @Param("companyId") companyId: string,
    @Param("domainId") domainId: string,
    @Body() input: MakePrimaryCompanyWebsiteDomainDto,
    @Req() request: Request,
  ) {
    return this.domains.makePrimary(
      companyId,
      domainId,
      input.expectedVersion,
      input.expectedWebsiteVersion,
      this.actor(request),
    );
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post("domains/:domainId/disable")
  @HttpCode(200)
  public disableDomain(
    @Param("companyId") companyId: string,
    @Param("domainId") domainId: string,
    @Body() input: MutateCompanyWebsiteDomainDto,
    @Req() request: Request,
  ) {
    return this.domains.disable(companyId, domainId, input.expectedVersion, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WEBSITES_MANAGE)
  @Post("domains/:domainId/remove")
  @HttpCode(200)
  public removeDomain(
    @Param("companyId") companyId: string,
    @Param("domainId") domainId: string,
    @Body() input: MutateCompanyWebsiteDomainDto,
    @Req() request: Request,
  ) {
    return this.domains.remove(companyId, domainId, input.expectedVersion, this.actor(request));
  }
}

@ApiTags("public company websites")
@Public()
@Controller("public/company-website")
export class PublicCompanyWebsiteController {
  public constructor(
    @Inject(CompanyWebsiteService) private readonly websites: CompanyWebsiteService,
    @Inject(CompanyWebsiteAgentService) private readonly websiteAgent: CompanyWebsiteAgentService,
  ) {}
  private host(request: Request): string | undefined {
    const actualHost = request.headers.host ?? request.hostname;
    const forwarded = request.headers["x-blueline-tenant-host"];
    const localSimulation =
      process.env.NODE_ENV !== "production" &&
      /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/iu.test(actualHost ?? "");
    return localSimulation
      ? ((Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? actualHost)
      : actualHost;
  }

  @Get()
  public get(@Req() request: Request) {
    return this.websites.resolvePublic(this.host(request));
  }

  @Get("sitemap.xml")
  public async sitemap(@Req() request: Request, @Res() response: Response) {
    response.type("application/xml").send(await this.websites.publicSitemap(this.host(request)));
  }

  @Post("track")
  @HttpCode(200)
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  public track(@Req() request: Request, @Body() input: PublicWebsiteTrackingDto) {
    return this.websites.trackPublic(this.host(request), input.trackingToken);
  }

  @Post("delivery-requests")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  public requestDelivery(@Req() request: Request, @Body() input: PublicWebsiteDeliveryRequestDto) {
    return this.websites.createDeliveryRequest(this.host(request), input);
  }

  @Post("agent/conversations")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  public startAgent(@Req() request: Request, @Body() input: StartCompanyWebsiteAgentDto) {
    return this.websiteAgent.start(this.host(request), input.language, request.ip ?? null);
  }

  @Post("agent/conversations/:token/messages")
  @HttpCode(200)
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  public messageAgent(
    @Req() request: Request,
    @Param("token") token: string,
    @Body() input: CompanyWebsiteAgentMessageDto,
  ) {
    return this.websiteAgent.message(this.host(request), token, input.message, input.language);
  }

  @Get("logo")
  public async logo(
    @Req() request: Request,
    @Query("host") simulatedHost: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const actualHost = this.host(request);
    const allowSimulation =
      process.env.NODE_ENV !== "production" &&
      /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/iu.test(
        request.headers.host ?? request.hostname ?? "",
      );
    const logo = await this.websites.publicLogo(
      allowSimulation ? (simulatedHost ?? actualHost) : actualHost,
    );
    response.setHeader("Content-Type", logo.mediaType);
    response.setHeader("Cache-Control", "public, max-age=300");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(logo.bytes);
  }
}
