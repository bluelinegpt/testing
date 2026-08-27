import { Body, Controller, Inject, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";

import { Public, RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { ClientErrorReportService } from "./client-error-report.service.js";
// Imported as a value, not a type: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to
// runtime, so this body contract is actually validated.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ReportClientErrorDto } from "./client-error-report.dto.js";

/**
 * Where every app's error boundary posts the moment it catches a crash.
 *
 * Two routes to the same underlying capture, not one:
 *
 * - `POST /errors` requires an authenticated identity of any kind. Used by
 *   `web` and `platform-web`, where the app shell is never usable at all
 *   without a session, so a crash always has one to attach.
 * - `POST /errors/public` requires nothing. The Store serves anonymous
 *   shoppers who may never have signed in, and a crash can happen before
 *   that ever changes -- requiring auth there would silently drop exactly
 *   the reports a public storefront needs most. `@Public()` means
 *   `AuthenticationGuard` never attempts to resolve a session for this
 *   route, so a report through here is always company/account-less, even if
 *   the caller happens to be a signed-in Customer; see
 *   `ClientErrorReportService.reportFromRequest`'s own comment for why that
 *   trade-off is deliberate rather than building an "optional auth" mode
 *   into the shared guard just for this one endpoint.
 */
@ApiTags("observability")
@Controller("errors")
export class ClientErrorReportController {
  public constructor(
    @Inject(ClientErrorReportService) private readonly reports: ClientErrorReportService,
  ) {}

  // Throttled, not exempted from the global limiter: a looping frontend
  // failure (a render error firing on every re-render, a retry storm) must
  // not be able to flood `client_error_reports` just because it's honestly
  // trying to report itself. One genuine crash reports once; a broken loop
  // is exactly the case this protects the Platform inbox from (System-Wide
  // Error Handler Audit prompt, §45). The public route gets the tighter
  // limit -- it has no session to already be rate-limited by anything else.
  @ApiBearerAuth()
  @ApiOperation({ summary: "Report a frontend crash (authenticated apps)" })
  @RequireIdentityKinds("company_user", "trader", "driver", "platform_administrator", "customer")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  public report(@Body() input: ReportClientErrorDto): Promise<{ id: string }> {
    return this.reports.reportFromRequest(input);
  }

  @ApiOperation({ summary: "Report a frontend crash (anonymous — the public Store)" })
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("public")
  public reportAnonymous(@Body() input: ReportClientErrorDto): Promise<{ id: string }> {
    return this.reports.reportFromRequest(input);
  }
}
