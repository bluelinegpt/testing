import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { PLATFORM_AUDIT_READ, RequirePlatformPermissions } from "./platform-authorization.js";
// Runtime class value is required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PlatformAuditQueryDto } from "./platform-audit.dto.js";
import { PlatformAuditQueryService } from "./platform-audit.query.js";

/**
 * The Platform-wide administrative trail.
 *
 * Separate from the per-Company `GET /platform/companies/:companyId/audit`
 * because the two answer different questions: that one shows what was done to
 * one Company, this one shows what a Platform administrator did anywhere.
 * Both are gated by `platform.audit.read` and neither can reach a Company's
 * operational history.
 */
@ApiTags("platform audit")
@Controller("platform/audit")
export class PlatformAuditController {
  public constructor(
    @Inject(PlatformAuditQueryService) private readonly audit: PlatformAuditQueryService,
  ) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: "Search the Platform administrative trail" })
  @RequirePlatformPermissions(PLATFORM_AUDIT_READ)
  @Get()
  public list(@Query() query: PlatformAuditQueryDto): Promise<object> {
    return this.audit.search({
      companyId: query.companyId,
      action: query.action,
      actorAccountId: query.actorAccountId,
      from: query.from,
      to: query.to,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 25,
    });
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "List the Platform actions present in the trail" })
  @RequirePlatformPermissions(PLATFORM_AUDIT_READ)
  @Get("actions")
  public actions(): Promise<object> {
    return this.audit.actions().then((items) => ({ items }));
  }
}
