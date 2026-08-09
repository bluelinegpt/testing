import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, type Transaction, sql } from "kysely";

import { AccountSetupService, type IssuedToken } from "../authentication/account-setup.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { UserAdministrationService } from "../users/user-administration.service.js";
import { normalizeUaeMobile } from "../shared/uae-mobile.js";
import { PlatformAuditService } from "./platform-audit.service.js";

/**
 * Company user administration performed by a Platform Administrator.
 *
 * ---------------------------------------------------------------------------
 * A THIN LAYER OVER SERVICES THAT ALREADY EXIST
 * ---------------------------------------------------------------------------
 *
 * `UserAdministrationService` already implements creation, locking, unlocking,
 * activation, deactivation, session listing and session revocation, and every
 * one of its statements is scoped by the tenant context. Running it under the
 * Platform target-Company context therefore inherits its Company scoping
 * wholesale: `lockCompanyUser` matches on `a.company_id = <target>`, so an
 * account belonging to another Company is not "rejected by a check" — it simply
 * does not exist to the query. Reimplementing any of this would mean writing a
 * second, subtly different set of tenant rules.
 *
 * What this service adds is the part the Company portal cannot do: the FIRST
 * administrator, created before the Company has any user at all, and the
 * credential-link flow that replaces handing out a password.
 *
 * ---------------------------------------------------------------------------
 * WHO THE ACTOR IS
 * ---------------------------------------------------------------------------
 *
 * The Platform Administrator stays `companyId: null` throughout. No Company
 * user is invented to stand in for them, and no fabricated identifier is
 * written anywhere. `account_roles.assigned_by_account_id` is a PLAIN foreign
 * key to `accounts(id)` — unlike the composite `(id, company_id)` keys on the
 * Accounting setup tables — so recording the Platform account there is both
 * permitted by the schema and TRUE. That is the provenance answer, and it
 * needed no schema change to reach.
 */

/**
 * Permissions a brand-new Company Administrator receives.
 *
 * Taken from what this repository itself gives a freshly bootstrapped Company:
 * `bootstrapDevelopmentCompany` grants `users_roles.manage`, and the Company
 * Profile migration granted `company_profile.manage` to every role holding it.
 * Those two are exactly "can finish setting up this Company".
 *
 * Deliberately NOT the 27 permissions the long-lived development Company has
 * accumulated. Those were configured over time by people making decisions about
 * that Company; copying them here would be inventing an operational policy for
 * every future tenant. The first administrator holds `users_roles.manage`, so
 * they can grant themselves and their colleagues whatever the Company actually
 * needs, through the Company portal that owns that decision.
 */
const FIRST_ADMIN_PERMISSIONS = ["users_roles.manage", "company_profile.manage"] as const;
const COMPANY_ADMIN_ROLE_CODE = "company_admin";

export interface CompanyUserRow {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly username: string;
  readonly email: string | null;
  readonly mobileNumber: string | null;
  readonly status: string;
  readonly roles: readonly string[];
  readonly lockedUntil: Date | null;
  readonly failedLoginAttempts: number;
  readonly lastLoginAt: Date | null;
  readonly forcePasswordChange: boolean;
  readonly passwordChangedAt: Date | null;
  readonly createdAt: Date;
  readonly activeSetupLinkExpiresAt: Date | null;
}

export interface CreateAdministratorInput {
  readonly displayName: string;
  readonly username: string;
  readonly email: string;
  readonly mobileNumber: string;
  readonly preferredLanguage: "en" | "ar";
}

export interface PlatformActor {
  readonly accountId: string;
  readonly correlationId: string;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * A Company user's state, as a Platform Administrator needs to read it.
 *
 * Four states, mapped from real columns rather than a new status field:
 *  - `disabled`            — account status
 *  - `locked`              — a live `locked_until`
 *  - `invitation_pending`  — active, but no password has ever been set
 *  - `active`              — signed in, or at least able to
 */
export function describeUserState(user: {
  status: string;
  lockedUntil: Date | null;
  passwordChangedAt: Date | null;
  forcePasswordChange: boolean;
}): "disabled" | "locked" | "invitation_pending" | "active" {
  if (user.status !== "active") return "disabled";
  if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) return "locked";
  if (user.passwordChangedAt === null || user.forcePasswordChange) return "invitation_pending";
  return "active";
}

/**
 * Backstop for a uniqueness collision that reaches the INSERT.
 *
 * Not the normal path. `UserAdministrationService.assertIdentifiersAvailable`
 * checks username, email and mobile before inserting and already raises
 * `username_already_exists` / `email_already_exists` / `mobile_already_exists`
 * with a message naming the field, which is what an administrator actually
 * sees. This exists for the gap that check cannot close: it is a read followed
 * by a write, so two administrators creating the same username at the same
 * moment both pass it and one then hits the unique index. Without this, that
 * one person gets "The operation conflicts with current data integrity rules."
 * for something the other one was told plainly.
 *
 * Matched on the constraint NAME rather than the column, because one field is
 * enforced by more than one index: the username has both a plain and a
 * normalized unique index, and email is enforced on `accounts` AND on
 * `company_users`. All spellings must give the same answer.
 *
 * Anything unrecognised is re-thrown untouched, so a genuinely unexpected
 * integrity error still reaches the global filter and is still genericised
 * rather than leaking a constraint name to the client.
 */
export function translateUserConflict(error: unknown): unknown {
  if (error instanceof ApplicationException) return error;
  const code = (error as { code?: string }).code;
  const constraint = (error as { constraint?: string }).constraint ?? "";

  /**
   * CHECK violations get a message naming the field too.
   *
   * These are the last line of defence, so reaching one means something
   * upstream let a bad value through. The caller still deserves to know WHICH
   * value -- "the operation conflicts with current data integrity rules" is
   * true, unactionable, and indistinguishable from a dozen other failures.
   */
  if (code === "23514") {
    if (constraint.includes("mobile")) {
      return new ApplicationException(
        "company_user_mobile_invalid",
        "Enter a UAE mobile number, for example 0506468442 or 971506468442.",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (constraint.includes("email")) {
      return new ApplicationException(
        "company_user_email_invalid",
        "Enter a valid email address.",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (constraint.includes("username")) {
      return new ApplicationException(
        "company_user_username_invalid",
        "Enter a username of 3-128 characters using letters, digits and . _ -",
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  if (code !== "23505") return error;

  if (constraint.includes("username")) {
    return new ApplicationException(
      "company_user_username_taken",
      "That username is already used by another user in this Company",
      HttpStatus.CONFLICT,
    );
  }
  if (constraint.includes("email")) {
    return new ApplicationException(
      "company_user_email_taken",
      "That email address is already used by another user in this Company",
      HttpStatus.CONFLICT,
    );
  }
  if (constraint.includes("mobile")) {
    return new ApplicationException(
      "company_user_mobile_taken",
      "That mobile number is already used by another user in this Company",
      HttpStatus.CONFLICT,
    );
  }
  return new ApplicationException(
    "company_user_duplicate",
    "Another user in this Company already uses one of these details",
    HttpStatus.CONFLICT,
  );
}

/**
 * Normalises the request a second time, in the service.
 *
 * The DTO already declares `@NormalizeUaeMobile()` and a matching pattern, so
 * in principle this is redundant. In practice it is not: the development
 * runner (`tsx`, which uses esbuild) does not emit `emitDecoratorMetadata`, so
 * Nest's ValidationPipe receives `metatype === undefined` and returns the body
 * untouched -- no validation, no transformation. The raw `0506568441` then
 * reached `accounts` and the `accounts_mobile_format` CHECK rejected it, which
 * surfaced as an opaque "conflicts with data integrity rules".
 *
 * Normalising here does not depend on decorator metadata, so the same input
 * behaves identically under `tsx`, under a compiled build and under test. It
 * also means the service is correct on its own terms rather than only when its
 * caller happens to have been validated -- which is the right property for a
 * method that writes accounts.
 *
 * A number that is not a UAE mobile is REJECTED here with a message naming the
 * field, rather than passed through for the database to refuse anonymously.
 */
function normalizeAdministratorInput(input: CreateAdministratorInput): CreateAdministratorInput {
  const mobileNumber = normalizeUaeMobile(input.mobileNumber);
  if (mobileNumber === undefined) {
    throw new ApplicationException(
      "company_user_mobile_invalid",
      "Enter a UAE mobile number, for example 0506468442 or 971506468442.",
      HttpStatus.BAD_REQUEST,
    );
  }
  return {
    displayName: input.displayName.trim(),
    username: input.username.trim(),
    email: input.email.trim().toLowerCase(),
    mobileNumber,
    preferredLanguage: input.preferredLanguage,
  };
}

@Injectable()
export class PlatformCompanyUserService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(UserAdministrationService) private readonly users: UserAdministrationService,
    @Inject(AccountSetupService) private readonly setup: AccountSetupService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  public async list(companyId: string): Promise<readonly (CompanyUserRow & { state: string })[]> {
    const rows = (
      await sql<CompanyUserRow>`
        select a.id as "accountId",
               cu.display_name as "displayName",
               a.username,
               a.email,
               a.mobile_number as "mobileNumber",
               a.status,
               a.locked_until as "lockedUntil",
               a.failed_login_attempts as "failedLoginAttempts",
               a.last_login_at as "lastLoginAt",
               a.force_password_change as "forcePasswordChange",
               a.password_changed_at as "passwordChangedAt",
               a.created_at as "createdAt",
               coalesce(
                 (select array_agg(r.code order by r.code)
                    from account_roles ar join roles r on r.id = ar.role_id
                   where ar.account_id = a.id and r.is_active),
                 array[]::text[]
               ) as roles,
               (select max(t.expires_at) from password_reset_tokens t
                 where t.account_id = a.id and t.used_at is null and t.revoked_at is null
                   and t.expires_at > now()) as "activeSetupLinkExpiresAt"
          from accounts a
          left join company_users cu on cu.account_id = a.id and cu.company_id = a.company_id
         where a.company_id = ${companyId}::uuid
           and a.account_kind = 'company_user'
         order by cu.display_name nulls last, a.username
      `.execute(this.database)
    ).rows;
    // No hash, no token, no session material — only what the columns above hold.
    return rows.map((row) => ({ ...row, state: describeUserState(row) }));
  }

  /** Resolves an account and proves it belongs to the target Company. */
  private async requireAccount(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    accountId: string,
  ): Promise<{ accountId: string; username: string; status: string }> {
    const row = (
      await sql<{ accountId: string; username: string; status: string }>`
        select id as "accountId", username, status from accounts
         where id = ${accountId}::uuid and company_id = ${companyId}::uuid
           and account_kind = 'company_user'
         limit 1
      `.execute(executor)
    ).rows[0];
    if (row === undefined) {
      // The same response whether the account is another Company's or does not
      // exist: a distinct answer would confirm accounts across tenants.
      throw new ApplicationException(
        "company_user_not_found",
        "The requested user does not exist in this Company",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // First administrator
  // -------------------------------------------------------------------------

  /**
   * Creates a Company Administrator and returns a one-time setup link.
   *
   * The account is created through `UserAdministrationService.create`, which
   * generates a random temporary password nobody ever sees — it is discarded
   * here and is not returned to the caller. The account is therefore reachable
   * ONLY through the setup link, which is the property §9 asks for: Platform
   * staff never hold a working credential for a Company.
   */
  public async createAdministrator(
    companyId: string,
    rawInput: CreateAdministratorInput,
    actor: PlatformActor,
  ): Promise<{ accountId: string; setupUrl: string; expiresAt: Date }> {
    const input = normalizeAdministratorInput(rawInput);
    const company = (
      await sql<{ status: string; subdomain: string }>`
        select status, subdomain from companies where id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (company === undefined) {
      throw new ApplicationException(
        "company_not_found",
        "Company not found",
        HttpStatus.NOT_FOUND,
      );
    }
    if (company.status === "disabled") {
      throw new ApplicationException(
        "company_closed",
        "A closed Company cannot receive new administrators",
        HttpStatus.CONFLICT,
      );
    }

    const result = await this.createAccount(companyId, input, actor);

    await this.audit.record({
      action: "platform.company_user.administrator_created",
      actorAccountId: actor.accountId,
      companyId,
      subjectType: "account",
      subjectId: result.accountId,
      // The link is NOT recorded. The audit says one was issued.
      after: { username: input.username, role: COMPANY_ADMIN_ROLE_CODE, setupLinkIssued: true },
      correlationId: actor.correlationId,
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });

    return {
      accountId: result.accountId,
      setupUrl: this.setupUrl(company.subdomain, result.issued.token),
      expiresAt: result.issued.expiresAt,
    };
  }

  /**
   * Ensures the Company has its system Company Administrator role.
   *
   * A Company created by the Platform Portal has no roles at all — Prompt 3
   * creates accounting configuration, not people. The role is created on first
   * use rather than at Company creation so that a Company which never gets an
   * administrator does not carry an empty one.
   *
   * Permissions come from the constant above, never from the request.
   */
  /**
   * Creates the role, the account and the activation link.
   *
   * ---------------------------------------------------------------------------
   * WHY THESE ARE THREE TRANSACTIONS AND NOT ONE
   * ---------------------------------------------------------------------------
   *
   * They used to be one, and it did not work.
   *
   * `KyselyTransactionManager.execute` calls `database.transaction()`, which
   * takes a NEW connection every time. So wrapping all three in an outer
   * transaction and then calling `UserAdministrationService.create` — which
   * opens its own — produced two independent transactions on two connections.
   * The `company_admin` role inserted by the outer one was still uncommitted
   * and therefore invisible to the inner one, whose `assertRoles` correctly
   * concluded the role did not exist and refused with "Every assigned Role must
   * be active and belong to the authenticated Company".
   *
   * It reproduced only against a real server. The database tests override the
   * transaction manager with a savepoint-based one, where the inner call joins
   * the outer transaction and sees the role — so the suite passed while the
   * product failed on the first administrator of every new Company.
   *
   * Nesting is therefore avoided rather than worked around. Each step commits
   * before the next depends on it.
   *
   * ---------------------------------------------------------------------------
   * WHAT IS GIVEN UP, AND WHY IT IS ACCEPTABLE
   * ---------------------------------------------------------------------------
   *
   * The three steps are no longer atomic together. Both partial outcomes are
   * benign and self-correcting:
   *
   *  - Role created, account not: the role is empty, carries only the two
   *    standard permissions, and `ensureCompanyAdminRole` finds and reuses it on
   *    the next attempt. It is also exactly the role the Company needs anyway.
   *  - Account created, link not: the account exists with no usable credential,
   *    and the Portal's existing "Send activation link" action issues one. That
   *    is the same path used when a link expires.
   *
   * Neither leaves anything a person has to repair by hand, which is the bar
   * that matters. The alternative — making the transaction manager reentrant so
   * nested calls join the outer transaction, as the test override already does
   * — would fix this class of bug everywhere rather than here, and is worth
   * doing, but it changes shared infrastructure used by every service and needs
   * validating far beyond this path.
   */
  private async createAccount(
    companyId: string,
    input: CreateAdministratorInput,
    actor: PlatformActor,
  ): Promise<{ accountId: string; issued: IssuedToken }> {
    try {
      // 1. The role, committed, so the account creation below can see it.
      const roleId = await this.transactions.execute((transaction) =>
        this.ensureCompanyAdminRole(transaction, companyId, actor),
      );

      // 2. The account, its profile and its role grant — atomic among
      //    themselves inside the shared service's own transaction. The role is
      //    chosen by the SERVER; the request has no field for a role or a
      //    permission list, so a browser cannot aim this at anything else.
      const created = (await this.users.create({
        displayName: input.displayName,
        email: input.email,
        forcePasswordChange: true,
        mobileNumber: input.mobileNumber,
        preferredLanguage: input.preferredLanguage,
        roleIds: [roleId],
        status: "active",
        username: input.username,
        correlationId: actor.correlationId,
      })) as { accountId: string };

      // 3. The activation link.
      const issued = await this.transactions.execute((transaction) =>
        this.setup.issue(transaction, {
          accountId: created.accountId,
          companyId,
          purpose: "activation",
          requestIp: actor.ip,
          userAgent: actor.userAgent,
        }),
      );

      return { accountId: created.accountId, issued };
    } catch (error) {
      throw translateUserConflict(error);
    }
  }

  private async ensureCompanyAdminRole(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    actor: PlatformActor,
  ): Promise<string> {
    const existing = (
      await sql<{ id: string; isActive: boolean }>`
        select id, is_active as "isActive" from roles
         where company_id = ${companyId}::uuid and lower(code) = ${COMPANY_ADMIN_ROLE_CODE}
         limit 1
      `.execute(transaction)
    ).rows[0];
    if (existing !== undefined) {
      if (!existing.isActive) {
        throw new ApplicationException(
          "company_admin_role_inactive",
          "The Company Administrator role is deactivated for this Company",
          HttpStatus.CONFLICT,
        );
      }
      return existing.id;
    }

    const roleId = randomUUID();
    await sql`
      insert into roles (id, company_id, code, name, description, is_system, is_active)
      values (
        ${roleId}::uuid, ${companyId}::uuid, ${COMPANY_ADMIN_ROLE_CODE}, 'Company Administrator',
        'Created with the first Company Administrator during Platform onboarding', true, true
      )
    `.execute(transaction);
    for (const permission of FIRST_ADMIN_PERMISSIONS) {
      await sql`
        insert into role_permissions (role_id, permission_code)
        values (${roleId}::uuid, ${permission})
        on conflict (role_id, permission_code) do nothing
      `.execute(transaction);
    }
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id, actor_role, source, result, source_application
      ) values (
        ${companyId}::uuid, ${actor.accountId}::uuid, 'platform.company_user.admin_role_created',
        'role', ${roleId},
        ${JSON.stringify({ code: COMPANY_ADMIN_ROLE_CODE, permissions: FIRST_ADMIN_PERMISSIONS })}::jsonb,
        ${actor.correlationId}, 'platform_administrator', 'platform_portal',
        'success', 'platform-web'
      )
    `.execute(transaction);
    return roleId;
  }

  // -------------------------------------------------------------------------
  // Credential links
  // -------------------------------------------------------------------------

  /**
   * Issues a fresh setup or reset link for an existing account.
   *
   * A reset also ends every existing session, before the new password is even
   * chosen. Waiting until the password changes would leave a stolen session
   * alive during the window the recovery exists to close.
   */
  public async issueLink(
    companyId: string,
    accountId: string,
    purpose: "activation" | "reset",
    actor: PlatformActor,
  ): Promise<{ setupUrl: string; expiresAt: Date }> {
    const subdomain = (
      await sql<{ subdomain: string }>`
        select subdomain from companies where id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0]?.subdomain;
    if (subdomain === undefined) {
      throw new ApplicationException(
        "company_not_found",
        "Company not found",
        HttpStatus.NOT_FOUND,
      );
    }

    const issued = await this.transactions.execute(async (transaction) => {
      const account = await this.requireAccount(transaction, companyId, accountId);
      if (account.status !== "active") {
        throw new ApplicationException(
          "account_not_active",
          "A deactivated account cannot receive a setup link. Reactivate it first.",
          HttpStatus.CONFLICT,
        );
      }
      const token = await this.setup.issue(transaction, {
        accountId,
        companyId,
        purpose,
        requestIp: actor.ip,
        userAgent: actor.userAgent,
      });
      if (purpose === "reset") {
        await sql`
          update account_sessions set revoked_at = coalesce(revoked_at, now())
           where account_id = ${accountId}::uuid and revoked_at is null
        `.execute(transaction);
      }
      return token;
    });

    await this.audit.record({
      action:
        purpose === "reset"
          ? "platform.company_user.password_reset_requested"
          : "platform.company_user.activation_link_issued",
      actorAccountId: actor.accountId,
      companyId,
      subjectType: "account",
      subjectId: accountId,
      after: { purpose, sessionsRevoked: purpose === "reset", linkIssued: true },
      correlationId: actor.correlationId,
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });

    return { setupUrl: this.setupUrl(subdomain, issued.token), expiresAt: issued.expiresAt };
  }

  /**
   * Builds the Company-facing setup URL.
   *
   * The host is derived on the SERVER from the Company's own subdomain and the
   * configured tenant host suffix. Nothing about the destination comes from the
   * browser, so there is no redirect for a caller to point elsewhere.
   */
  private setupUrl(subdomain: string, token: string): string {
    const suffix = process.env.BLUELINE_TENANT_HOST_SUFFIX?.trim();
    const base =
      suffix === undefined || suffix === ""
        ? (process.env.BLUELINE_COMPANY_PORTAL_ORIGIN?.trim() ?? "http://localhost:5174")
        : `https://${subdomain}.${suffix}`;
    return `${base.replace(/\/$/, "")}/account-setup?token=${encodeURIComponent(token)}`;
  }

  // -------------------------------------------------------------------------
  // Account support
  // -------------------------------------------------------------------------

  public async unlock(companyId: string, accountId: string, actor: PlatformActor): Promise<void> {
    const account = await this.requireAccount(this.database, companyId, accountId);
    // Delegated: the existing service owns what "unlocked" means, and it clears
    // the failed-attempt state without touching the password or the status.
    await this.users.unlock(accountId, actor.correlationId);
    await this.audit.record({
      action: "platform.company_user.unlocked",
      actorAccountId: actor.accountId,
      companyId,
      subjectType: "account",
      subjectId: accountId,
      after: { username: account.username },
      correlationId: actor.correlationId,
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  public async setActive(
    companyId: string,
    accountId: string,
    active: boolean,
    reason: string,
    actor: PlatformActor,
  ): Promise<void> {
    await this.requireAccount(this.database, companyId, accountId);
    if (active) {
      await this.users.reactivate(accountId, actor.correlationId);
    } else {
      // The existing service revokes sessions as part of deactivation.
      await this.users.deactivate(accountId, reason, actor.correlationId);
    }
    await this.audit.record({
      action: active ? "platform.company_user.reactivated" : "platform.company_user.deactivated",
      actorAccountId: actor.accountId,
      companyId,
      subjectType: "account",
      subjectId: accountId,
      reason,
      after: { active },
      correlationId: actor.correlationId,
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  public async sessions(companyId: string, accountId: string): Promise<readonly unknown[]> {
    await this.requireAccount(this.database, companyId, accountId);
    // The existing service selects no token column; only metadata is returned.
    return this.users.sessions(accountId);
  }

  public async revokeSession(
    companyId: string,
    accountId: string,
    sessionId: string,
    actor: PlatformActor,
  ): Promise<void> {
    await this.requireAccount(this.database, companyId, accountId);
    // The session must belong to THIS account, not merely exist.
    const owned = (
      await sql<{ id: string }>`
        select id from account_sessions
         where id = ${sessionId}::uuid and account_id = ${accountId}::uuid
         limit 1
      `.execute(this.database)
    ).rows[0];
    if (owned === undefined) {
      throw new ApplicationException(
        "session_not_found",
        "The requested session does not belong to this user",
        HttpStatus.NOT_FOUND,
      );
    }
    await this.users.revokeSession(
      accountId,
      sessionId,
      "Platform support action",
      actor.correlationId,
    );
    await this.audit.record({
      action: "platform.company_user.session_revoked",
      actorAccountId: actor.accountId,
      companyId,
      subjectType: "account",
      subjectId: accountId,
      after: { sessionId },
      correlationId: actor.correlationId,
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  public async revokeAllSessions(
    companyId: string,
    accountId: string,
    actor: PlatformActor,
  ): Promise<{ revoked: number }> {
    await this.requireAccount(this.database, companyId, accountId);
    const before = Number(
      (
        await sql<{ n: string }>`
          select count(*)::bigint n from account_sessions
           where account_id = ${accountId}::uuid and revoked_at is null and expires_at > now()
        `.execute(this.database)
      ).rows[0]?.n ?? 0,
    );
    // `preserveCurrent: false` - the Platform actor has no session in this
    // Company, so there is nothing of theirs to preserve, and "revoke all"
    // must mean all.
    await this.users.revokeSessions(
      accountId,
      false,
      "Platform support action",
      actor.correlationId,
    );
    await this.audit.record({
      action: "platform.company_user.all_sessions_revoked",
      actorAccountId: actor.accountId,
      companyId,
      subjectType: "account",
      subjectId: accountId,
      after: { revoked: before },
      correlationId: actor.correlationId,
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    return { revoked: before };
  }

  /** Reads the acting Platform administrator, for controllers. */
  public actorAccountId(): string {
    return this.identities.current().identityId;
  }
}
