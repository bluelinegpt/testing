import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { IdentityContext } from "../security/identity-context.js";
import { PLATFORM_PERMISSION_PREFIX } from "./platform-authorization.js";

export interface PlatformSessionView {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly kind: "platform_administrator";
  /** Always null. A Platform Administrator belongs to no Company, by constraint. */
  readonly companyId: null;
  readonly permissions: readonly string[];
  readonly roles: readonly string[];
}

export interface PlatformCompanySummary {
  readonly id: string;
  readonly code: string;
  readonly subdomain: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly status: string;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Platform read services.
 *
 * The Company list here is intentionally minimal and read-only. Company
 * creation, profile editing and lifecycle transitions belong to Phase 1
 * Prompt 3; what this list exists for now is to give the permission model and
 * the target-Company guard a real route to be proved against, rather than a
 * probe endpoint invented for tests and then left in production.
 */
@Injectable()
export class PlatformService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async describeSession(identity: IdentityContext): Promise<PlatformSessionView> {
    const account = (
      await sql<{ username: string }>`
        select username from accounts
         where id = ${identity.identityId}::uuid
           and account_kind = 'platform_administrator'
           and company_id is null
         limit 1
      `.execute(this.database)
    ).rows[0];
    if (account === undefined) {
      // The session authenticated, so the account existed moments ago. Reaching
      // here means it is no longer a Platform account, which must not resolve
      // to a usable Platform session.
      throw new ApplicationException(
        "platform_identity_unavailable",
        "The authenticated account is not a Platform Administrator",
        HttpStatus.FORBIDDEN,
      );
    }
    const roles = (
      await sql<{ code: string }>`
        select r.code from account_roles ar
          join roles r on r.id = ar.role_id
         where ar.account_id = ${identity.identityId}::uuid
           and r.company_id is null
           and r.is_active = true
         order by r.code
      `.execute(this.database)
    ).rows.map((row) => row.code);

    return {
      accountId: identity.identityId,
      username: account.username,
      displayName: account.username,
      kind: "platform_administrator",
      companyId: null,
      // Only Platform codes are returned. A Platform account should never hold
      // a Company permission, and if one were ever granted by mistake the
      // Portal must not act on it.
      permissions: [...identity.permissions]
        .filter((code) => code.startsWith(PLATFORM_PERMISSION_PREFIX))
        .sort(),
      roles,
    };
  }

  public async listCompanies(): Promise<readonly PlatformCompanySummary[]> {
    return (
      await sql<PlatformCompanySummary>`
        select id,
               code,
               subdomain,
               name_en as "nameEn",
               name_ar as "nameAr",
               status,
               activated_at as "activatedAt",
               created_at as "createdAt"
          from companies
         order by lower(code)
      `.execute(this.database)
    ).rows;
  }
}
