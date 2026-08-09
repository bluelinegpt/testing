import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, type Transaction, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { PasswordHasher } from "./password-hasher.js";
import { SessionTokenService } from "./session-token.service.js";

/**
 * Account activation and password recovery for Company users.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE WAS ALREADY BUILT FOR THIS
 * ---------------------------------------------------------------------------
 *
 * `password_reset_tokens` already carries everything this flow needs and was
 * never wired to anything: a unique SHA-256 `token_hash` (format-checked),
 * `expires_at`, `used_at` for single use, `revoked_at` for invalidation,
 * request metadata, and a `created_by_source` constrained to exactly
 * `self_service` | `administrator`. That last column is the Platform-initiated
 * case, named before this prompt existed. A new table would have re-invented a
 * design the schema had already made.
 *
 * A database trigger (`password_reset_tokens_scope_guard`) additionally forces
 * the token's `company_id` to equal the account's, so a token can never be
 * minted against one Company for an account belonging to another.
 *
 * ---------------------------------------------------------------------------
 * ONLY THE HASH IS STORED
 * ---------------------------------------------------------------------------
 *
 * The raw token exists for exactly as long as one HTTP response. It is never
 * written to the database, never logged, and never recorded in audit — the
 * audit trail records that a link was issued, not what the link was. Anyone who
 * later reads the database, the logs or the audit history learns nothing that
 * lets them take over an account.
 */

/** How long an administrator-issued link stays usable. */
const ACTIVATION_TTL_HOURS = 48;
const RESET_TTL_HOURS = 2;

export type TokenPurpose = "activation" | "reset";

export interface IssuedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

@Injectable()
export class AccountSetupService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(SessionTokenService) private readonly tokens: SessionTokenService,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
  ) {}

  /**
   * Mints a single-use link for an account, inside the caller's transaction.
   *
   * Every previously-active token for the account is revoked first. Two live
   * links would mean an old one — possibly sent to a stale address, or already
   * intercepted — still opening the account after a fresh one was issued.
   * "Reissue" therefore means "replace", which is what an administrator
   * pressing the button a second time actually intends.
   */
  public async issue(
    transaction: Transaction<DatabaseSchema>,
    input: {
      accountId: string;
      companyId: string;
      purpose: TokenPurpose;
      requestIp?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<IssuedToken> {
    await sql`
      update password_reset_tokens
         set revoked_at = now(), version = version + 1
       where account_id = ${input.accountId}::uuid
         and used_at is null and revoked_at is null and expires_at > now()
    `.execute(transaction);

    const { token, hash } = this.tokens.create();
    const hours = input.purpose === "activation" ? ACTIVATION_TTL_HOURS : RESET_TTL_HOURS;
    const expiresAt = new Date(Date.now() + hours * 3_600_000);
    await sql`
      insert into password_reset_tokens (
        company_id, account_id, token_hash, expires_at, created_by_source,
        requested_ip_hash, requested_user_agent
      ) values (
        ${input.companyId}::uuid, ${input.accountId}::uuid, ${hash}, ${expiresAt},
        'administrator',
        ${input.requestIp === undefined ? null : this.hashIp(input.requestIp)},
        ${input.userAgent?.slice(0, 1_000) ?? null}
      )
    `.execute(transaction);

    return { token, expiresAt };
  }

  /**
   * The requesting IP is stored as a HASH, not an address.
   *
   * It is kept so a support investigation can tell "same requester" from
   * "different requester" across attempts, which is all anyone actually needs.
   * Retaining the address itself would be personal data collected for no
   * question anybody asks.
   */
  private hashIp(ip: string): string {
    return createHash("sha256").update(ip, "utf8").digest("hex");
  }

  /**
   * Describes a token to the person holding it, without confirming anything to
   * someone who is not.
   *
   * A rejected token yields one generic failure whether it never existed, has
   * expired, was revoked or was already used. Distinguishing them would let an
   * attacker with a guessed token learn that the account exists.
   */
  public async describe(rawToken: string): Promise<{
    displayName: string;
    username: string;
    companyName: string;
    companySubdomain: string;
    purpose: TokenPurpose;
  }> {
    const row = await this.findUsableToken(this.database, rawToken);
    return {
      displayName: row.displayName ?? row.username,
      username: row.username,
      companyName: row.companyName,
      companySubdomain: row.companySubdomain,
      // A first-time activation is one where no password has ever been set.
      purpose: row.passwordChangedAt === null ? "activation" : "reset",
    };
  }

  /**
   * Completes setup: validates, stores the new password, burns the token and
   * ends every existing session — all in one transaction.
   *
   * The token is marked used AFTER the password is stored, never before. The
   * opposite order would let a failed write consume the only link the user had
   * and lock them out of their own account.
   */
  public async complete(
    rawToken: string,
    newPassword: string,
    correlationId: string,
  ): Promise<void> {
    await this.transactions.execute(async (transaction) => {
      // Re-read inside the transaction and lock, so two concurrent submissions
      // of the same link cannot both succeed.
      const row = await this.findUsableToken(transaction, rawToken, true);
      const passwordHash = await this.passwordHasher.hash(newPassword);

      await sql`
        update accounts
           set password_hash = ${passwordHash},
               force_password_change = false,
               temporary_password_expires_at = null,
               password_changed_at = now(),
               failed_login_attempts = 0,
               locked_until = null,
               updated_at = now(),
               version = version + 1
         where id = ${row.accountId}::uuid
      `.execute(transaction);

      await sql`
        update password_reset_tokens set used_at = now(), version = version + 1
         where id = ${row.tokenId}::uuid
      `.execute(transaction);

      // Any other live link for this account dies with it.
      await sql`
        update password_reset_tokens set revoked_at = now(), version = version + 1
         where account_id = ${row.accountId}::uuid and id <> ${row.tokenId}::uuid
           and used_at is null and revoked_at is null
      `.execute(transaction);

      // Every pre-existing session is ended. A stolen session must not survive
      // the credential recovery that was performed because it was stolen.
      await sql`
        update account_sessions set revoked_at = coalesce(revoked_at, now())
         where account_id = ${row.accountId}::uuid and revoked_at is null
      `.execute(transaction);

      await sql`
        insert into audit_events (
          company_id, actor_account_id, action, subject_type, subject_id,
          before_data, after_data, correlation_id, actor_role, source
        ) values (
          ${row.companyId}::uuid, ${row.accountId}::uuid, 'company_user.account_setup_completed',
          'account', ${row.accountId},
          '{"forcePasswordChange":true}'::jsonb,
          '{"forcePasswordChange":false,"sessionsRevoked":true}'::jsonb,
          ${correlationId}, 'self', 'web'
        )
      `.execute(transaction);
    });
  }

  private async findUsableToken(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    rawToken: string,
    lock = false,
  ): Promise<{
    tokenId: string;
    accountId: string;
    companyId: string;
    username: string;
    displayName: string | null;
    companyName: string;
    companySubdomain: string;
    passwordChangedAt: Date | null;
  }> {
    // The raw token is hashed before it touches a query, so it never appears in
    // a statement, a query log or a slow-query report.
    const hash = this.tokens.hash(rawToken);
    const row = (
      await sql<{
        tokenId: string;
        accountId: string;
        companyId: string;
        username: string;
        displayName: string | null;
        companyName: string;
        companySubdomain: string;
        passwordChangedAt: Date | null;
      }>`
        select t.id as "tokenId", a.id as "accountId", a.company_id as "companyId",
               a.username, cu.display_name as "displayName",
               c.name_en as "companyName", c.subdomain as "companySubdomain",
               a.password_changed_at as "passwordChangedAt"
          from password_reset_tokens t
          join accounts a on a.id = t.account_id
          join companies c on c.id = a.company_id
          left join company_users cu on cu.account_id = a.id and cu.company_id = a.company_id
         where t.token_hash = ${hash}
           and t.used_at is null
           and t.revoked_at is null
           and t.expires_at > now()
           and a.status = 'active'
         ${lock ? sql`for update of t` : sql``}
         limit 1
      `.execute(executor)
    ).rows[0];

    if (row === undefined) {
      throw new ApplicationException(
        "account_setup_token_invalid",
        "This link is no longer valid. Ask your administrator for a new one.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return row;
  }
}
