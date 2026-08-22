import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  PLATFORM_ERRORS_MANAGE,
  PLATFORM_ERRORS_READ,
  RequirePlatformPermissions,
} from "../platform/platform-authorization.js";
import type { ClientErrorReportRow } from "./client-error-report.service.js";
import { ClientErrorReportService } from "./client-error-report.service.js";
// Imported as values, not types: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to
// runtime, so these query/body contracts are actually validated.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  DeleteClientErrorReportsDto,
  ListClientErrorReportsQueryDto,
  UpdateClientErrorReportDto,
} from "./client-error-report.dto.js";

/**
 * The Platform's Error Handler screen -- every captured crash from every app,
 * which Company (if any) it happened to, and the triage a Platform
 * Administrator has done on it.
 *
 * Separate from `ClientErrorReportController` (`POST /errors`) on purpose:
 * that one is reachable by any authenticated identity kind so a crash can
 * always be reported; this one is Platform-only, because "which Companies
 * are having errors" is exactly the kind of cross-tenant visibility a
 * Company Administrator must never get from their own session.
 */
@ApiTags("platform errors")
@Controller("platform/errors")
export class PlatformErrorReportController {
  public constructor(
    @Inject(ClientErrorReportService) private readonly reports: ClientErrorReportService,
  ) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: "List captured application errors" })
  @RequirePlatformPermissions(PLATFORM_ERRORS_READ)
  @Get()
  public list(@Query() query: ListClientErrorReportsQueryDto) {
    return this.reports.list(query);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "View one captured error in full detail" })
  @RequirePlatformPermissions(PLATFORM_ERRORS_READ)
  @Get(":id")
  public detail(@Param("id", new ParseUUIDPipe()) id: string): Promise<ClientErrorReportRow> {
    return this.reports.detail(id);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Triage a captured error -- severity, status, explanation, notes" })
  @RequirePlatformPermissions(PLATFORM_ERRORS_MANAGE)
  @Patch(":id")
  public update(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() input: UpdateClientErrorReportDto,
  ): Promise<ClientErrorReportRow> {
    return this.reports.update(id, input);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete selected captured error reports" })
  @RequirePlatformPermissions(PLATFORM_ERRORS_MANAGE)
  @Delete()
  @HttpCode(HttpStatus.OK)
  public bulkDelete(@Body() input: DeleteClientErrorReportsDto): Promise<{ deletedCount: number }> {
    return this.reports.bulkDelete(input.ids);
  }
}
