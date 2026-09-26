import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { IdentityContextAccessor } from "../security/identity-context.js";

export interface DeviceRegistrationResult {
  readonly id: string;
  readonly status: "active";
}

/**
 * Device registration lifecycle. Every write derives `companyId`/`accountId`
 * from `IdentityContextAccessor.current()` — the same authenticated-request
 * identity every other business service uses. Nothing here ever trusts a
 * client-supplied account/Company id (Section B).
 *
 * Identity is not re-validated as "active" here: `AuthenticationGuard`'s
 * session lookup (`authentication.repository.ts` `findActiveSession`) already
 * requires `accounts.status = 'active' and companies.status = 'active'` on
 * EVERY authenticated request before `identities.current()` can resolve at
 * all — by the time this service runs, that is already guaranteed. The
 * dispatcher (`PushDispatcher`), which reads registrations back out on its
 * own schedule long after the request that created them, re-checks this
 * independently — see `push-event.repository.ts`.
 */
@Injectable()
export class DeviceRegistrationService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  /**
   * Idempotent upsert keyed on (provider, push_token) — see the migration's
   * comment for why the token, not the account, is the uniqueness key. Any
   * OTHER active registration this account holds under a different token
   * (a rotated token, or a stale row left by an app reinstall) is revoked in
   * the same statement, so an account can never accumulate more than one
   * active registration — the durable half of Section C's "prevent unlimited
   * duplicate active records".
   */
  public async register(
    platform: "android" | "ios",
    token: string,
    appVersion: string | undefined,
  ): Promise<DeviceRegistrationResult> {
    const identity = this.identities.current();
    if (identity.companyId === null) {
      // Platform-administrator identities have no Company context and are not
      // a mobile-app audience; there is nothing to register.
      throw new Error("device_registration_requires_company_identity");
    }
    const companyId = identity.companyId;
    const accountId = identity.identityId;
    const result = await this.transactions.execute(async (transaction) => {
      const upserted = await sql<{ id: string }>`
        insert into device_registrations (
          company_id, account_id, platform, provider, push_token, app_version,
          status, last_seen_at
        ) values (
          ${companyId}::uuid, ${accountId}::uuid, ${platform}, 'fcm', ${token},
          ${appVersion ?? null}, 'active', now()
        )
        on conflict (provider, push_token) do update set
          company_id = excluded.company_id,
          account_id = excluded.account_id,
          platform = excluded.platform,
          app_version = excluded.app_version,
          status = 'active',
          revoked_at = null,
          revoked_reason = null,
          updated_at = now(),
          last_seen_at = now()
        returning id
      `.execute(transaction);
      const row = upserted.rows[0];
      if (row === undefined) throw new Error("device_registration_upsert_failed");
      // Token rotation / reinstall cleanup: any other active row this SAME
      // account holds is now stale.
      await sql`
        update device_registrations
           set status = 'revoked', revoked_at = now(), revoked_reason = 'token_rotated',
               updated_at = now()
         where company_id = ${companyId}::uuid and account_id = ${accountId}::uuid
           and push_token <> ${token} and status = 'active'
      `.execute(transaction);
      return row;
    });
    return { id: result.id, status: "active" };
  }

  /**
   * `token` provided -> revoke exactly that registration (only if it belongs
   * to the authenticated account/Company; otherwise a no-op — never lets one
   * account revoke another's row). `token` omitted -> revoke every active
   * registration for the authenticated account (used on logout when the
   * client already deleted its local token before calling this).
   */
  public async deregister(token: string | undefined, reason: string): Promise<void> {
    const identity = this.identities.current();
    if (identity.companyId === null) return;
    await sql`
      update device_registrations
         set status = 'revoked', revoked_at = now(), revoked_reason = ${reason}, updated_at = now()
       where company_id = ${identity.companyId}::uuid and account_id = ${identity.identityId}::uuid
         and status = 'active'
         and (${token ?? null}::text is null or push_token = ${token ?? null})
    `.execute(this.database);
  }
}
