import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { PLATFORM_ERRORS_MANAGE, PLATFORM_INTEGRITY_READ, RequirePlatformPermissions } from "../platform/platform-authorization.js";
import type { IntegrityFinding } from "./integrity-check.service.js";
import { IntegrityCheckService } from "./integrity-check.service.js";
import { MigrationStateService } from "./migration-state.service.js";
// Imported as a value, not a type: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to
// runtime, so this query contract is actually validated.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AcceptIntegrityDto, IntegrityAcceptanceParamsDto, IntegrityCheckParamsDto, IntegrityCompanyParamsDto, RunIntegrityChecksQueryDto, VerifyIntegrityQueryDto } from "./integrity-check.dto.js";
import { IdentityContextAccessor } from "../security/identity-context.js";


/**
 * The Integration Integrity Checker's Platform screen -- see
 * `IntegrityCheckService`'s own comment for what it checks and why it is
 * read-only. Platform-only: which Companies have data drift is exactly the
 * kind of cross-tenant visibility a Company Administrator must never get
 * from their own session, same reasoning as the Error Handler.
 */
@ApiTags("platform integrity")
@Controller("platform/integrity")
export class PlatformIntegrityController {
  public constructor(
    @Inject(IntegrityCheckService) private readonly checks: IntegrityCheckService,
    @Inject(MigrationStateService) private readonly migrations: MigrationStateService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: "Read the migration ledger and legacy-name compatibility state" })
  @RequirePlatformPermissions(PLATFORM_INTEGRITY_READ)
  @Get("migrations")
  public migrationState() {
    return this.migrations.state();
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Run Company-scoped Order and Finance integrity checks" })
  @RequirePlatformPermissions(PLATFORM_INTEGRITY_READ)
  @Get("companies/:companyId/verify")
  public verifyCompany(@Param() params: IntegrityCompanyParamsDto, @Query() query: VerifyIntegrityQueryDto) {
    return this.checks.verifyCompany(params.companyId, query.includeAccepted, query.thresholdDays);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Run one Company-scoped integrity check" })
  @RequirePlatformPermissions(PLATFORM_INTEGRITY_READ)
  @Get("companies/:companyId/checks/:code")
  public verifyCheck(
    @Param() params: IntegrityCheckParamsDto,
    @Query() query: VerifyIntegrityQueryDto,
  ) {
    return this.checks.verifyCheck(params.companyId, params.code, query.includeAccepted, query.thresholdDays);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Accept a reviewed integrity finding" })
  @RequirePlatformPermissions(PLATFORM_INTEGRITY_READ, PLATFORM_ERRORS_MANAGE)
  @Post("companies/:companyId/acceptances")
  public accept(@Param() params: IntegrityCompanyParamsDto, @Body() body: AcceptIntegrityDto) {
    return this.checks.accept(params.companyId, {
      checkCode: body.check_code,
      subjectType: body.subject_type,
      subjectId: body.subject_id,
      fingerprint: body.fingerprint,
      note: body.note,
      acceptedBy: this.identities.current().identityId,
    });
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Remove an integrity finding acceptance" })
  @RequirePlatformPermissions(PLATFORM_INTEGRITY_READ, PLATFORM_ERRORS_MANAGE)
  @Delete("companies/:companyId/acceptances/:id")
  public unaccept(@Param() params: IntegrityAcceptanceParamsDto) {
    return this.checks.unaccept(params.companyId, params.id);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Run every integrity check, across all Companies or one" })
  @RequirePlatformPermissions(PLATFORM_INTEGRITY_READ)
  @Get()
  public run(@Query() query: RunIntegrityChecksQueryDto): Promise<readonly IntegrityFinding[]> {
    return this.checks.runAll(query.companyId);
  }
}
