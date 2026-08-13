import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { PLATFORM_INTEGRITY_READ, RequirePlatformPermissions } from "../platform/platform-authorization.js";
import type { IntegrityFinding } from "./integrity-check.service.js";
import { IntegrityCheckService } from "./integrity-check.service.js";
// Imported as a value, not a type: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to
// runtime, so this query contract is actually validated.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RunIntegrityChecksQueryDto } from "./integrity-check.dto.js";

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
  ) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: "Run every integrity check, across all Companies or one" })
  @RequirePlatformPermissions(PLATFORM_INTEGRITY_READ)
  @Get()
  public run(@Query() query: RunIntegrityChecksQueryDto): Promise<readonly IntegrityFinding[]> {
    return this.checks.runAll(query.companyId);
  }
}
