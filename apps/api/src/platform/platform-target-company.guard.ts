import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import { type Kysely, sql } from "kysely";
import type { Request } from "express";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  RequestSecurityContextStore,
  type TargetCompanyContext,
} from "../security/request-security-context.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Establishes, server-side, which Company a Platform request is acting against.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTE PARAMETER IS AN INPUT, NOT AN AUTHORISATION
 * ---------------------------------------------------------------------------
 *
 * `:companyId` is untrusted. It arrives from a browser and can be edited in the
 * address bar. This guard therefore treats it as nothing more than a lookup
 * key: it is format-checked, then the Company row is read from the database,
 * and every fact the rest of the request uses — code, subdomain, name, status —
 * comes from that row. Nothing the client sent about the Company survives.
 *
 * That is the whole point. A later phase will decide whether destructive
 * maintenance is permitted for a Company; if it read the Company's environment
 * from the request instead of from the row, the answer would be whatever the
 * browser claimed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not authorise. Authorisation already happened in the global
 * `AuthenticationGuard` via `RequirePlatformPermissions`, which runs first
 * because global guards precede controller-bound ones. A caller who reaches
 * this guard has already proved they are a Platform Administrator holding
 * `platform.access` and the route's granular code.
 *
 * It does not change who is acting. `identity.companyId` stays `null` for the
 * whole request — see `enterTargetCompany`. Only the tenant slot moves, which
 * is what allows an existing Company-scoped service to run under an explicit
 * target without being taught that Platform actors exist.
 *
 * ---------------------------------------------------------------------------
 * WHY UNKNOWN AND MALFORMED FAIL THE SAME WAY
 * ---------------------------------------------------------------------------
 *
 * A distinct "no such Company" response would turn this route into a
 * Company-id oracle for anyone who got hold of a Platform session. Both cases
 * return the same 404, so a probe learns nothing it did not already know.
 */
@Injectable()
export class PlatformTargetCompanyGuard implements CanActivate {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(RequestSecurityContextStore) private readonly contextStore: RequestSecurityContextStore,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const raw = (request.params as Record<string, string | undefined>).companyId;
    // A route under this guard that carries no `:companyId` is a programming
    // error, not a request the caller can influence. Refusing outright is safer
    // than silently running with no target.
    if (raw === undefined) {
      throw new ApplicationException(
        "target_company_required",
        "This operation requires an explicit target Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!uuidPattern.test(raw)) {
      throw this.notFound();
    }

    const company = (
      await sql<TargetCompanyContext>`
        select id as "companyId", code, subdomain, name_en as "nameEn", status
          from companies
         where id = ${raw}::uuid
         limit 1
      `.execute(this.database)
    ).rows[0];
    if (company === undefined) {
      throw this.notFound();
    }

    this.contextStore.enterTargetCompany(company);
    return true;
  }

  private notFound(): ApplicationException {
    return new ApplicationException(
      "company_not_found",
      "The requested Company does not exist",
      HttpStatus.NOT_FOUND,
    );
  }
}
