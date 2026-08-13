import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import {
  AuthenticationService,
  type LoginResult,
} from "../authentication/authentication.service.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { SessionTokenService } from "../authentication/session-token.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { normalizeUaeMobile } from "../shared/uae-mobile.js";
import type {
  CompleteCommerceCustomerPasswordResetDto,
  RegisterCommerceCustomerDto,
} from "./commerce-customer-auth.dto.js";

/** How long a Customer password-reset link stays usable. */
const RESET_TOKEN_TTL_MINUTES = 60;

/**
 * Registration, and password reset, for the marketplace Customer identity.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE SERVICE FROM `AuthenticationService`/`AccountSetupService`
 * ---------------------------------------------------------------------------
 *
 * `AuthenticationService.loginCustomer` (added alongside this file) already
 * covers sign-in by reusing the shared, kind-agnostic `login()`/lockout/
 * session machinery -- nothing new was needed there. Registration and
 * password reset ARE new: no existing service creates an `accounts` row
 * (Company/Trader/Driver onboarding lives in `UserAdministrationService`,
 * which is company-scoped throughout) or resets a Company-less account's
 * password (`AccountSetupService.issue`/`findUsableToken`/`complete` all
 * require a non-null `companyId` and join to `companies`/`company_users`
 * hardcoded by name -- see that file's own doc comment). Both are
 * Customer-specific by nature and get their own home rather than widening
 * either existing service's Company assumptions.
 *
 * The LEAF dependencies -- `PasswordHasher`, `SessionTokenService`, the
 * `password_reset_tokens` table itself -- are reused directly; only the
 * Company-shaped orchestration around them is new.
 */
@Injectable()
export class CommerceCustomerAuthService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(SessionTokenService) private readonly sessionTokens: SessionTokenService,
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
  ) {}

  /**
   * Atomically creates the `accounts` row and its `commerce_customers`
   * profile (§19 -- one fails, neither remains), then signs the new
   * Customer in through the exact same `loginCustomer` path an ordinary
   * sign-in uses, so registration produces a real, correctly-issued session
   * rather than a parallel, hand-rolled one.
   */
  public async register(
    input: RegisterCommerceCustomerDto,
    context: { readonly createdIp?: string | undefined; readonly userAgent?: string | undefined },
  ): Promise<LoginResult> {
    const normalizedMobile = normalizeUaeMobile(input.mobile);
    if (normalizedMobile === undefined) {
      throw new ApplicationException(
        "invalid_mobile",
        "Enter a valid UAE mobile number",
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalizedEmail = input.email === undefined ? null : input.email.trim().toLowerCase();
    const passwordHash = await this.passwordHasher.hash(input.password);
    const accountId = randomUUID();

    try {
      await this.transactions.execute(async (transaction) => {
        // `accounts_mobile_format` requires the normalized `9715XXXXXXXX`
        // shape on `mobile_number` itself, not only on
        // `normalized_mobile_number` -- unlike the free-text convention used
        // elsewhere in this codebase (e.g. `operations.dto.ts`'s
        // `customerMobileNumber`), `accounts.mobile_number` is normalized
        // for every account kind.
        await sql`
          insert into accounts (
            id, company_id, account_kind, username, normalized_username, password_hash,
            mobile_number, normalized_mobile_number, email, normalized_email, preferred_language
          ) values (
            ${accountId}::uuid, null, 'customer', ${normalizedMobile}, ${normalizedMobile}, ${passwordHash},
            ${normalizedMobile}, ${normalizedMobile}, ${normalizedEmail}, ${normalizedEmail},
            ${input.preferredLanguage ?? "en"}
          )
        `.execute(transaction);
        // `commerce_customers_mobile_format` requires the normalized
        // `9715XXXXXXXX` shape (mirroring `accounts.mobile_number`'s own
        // CHECK) -- unlike `accounts.mobile_number`, which keeps the raw
        // as-entered text alongside its own `normalized_mobile_number`
        // column, `commerce_customers` has no separate normalized column,
        // so the normalized form IS the stored value here.
        await sql`
          insert into commerce_customers (account_id, name, mobile_number, email, preferred_language)
          values (
            ${accountId}::uuid, ${input.name}, ${normalizedMobile}, ${normalizedEmail},
            ${input.preferredLanguage ?? "en"}
          )
        `.execute(transaction);
      });
    } catch (cause) {
      // §22: duplicate mobile/email must return a useful, non-leaky
      // validation failure rather than a raw constraint-violation message.
      // The two partial unique indexes added by the 3A migration are the
      // only ones that can fire here for well-formed input, so the SQLSTATE
      // ("23505" -- unique_violation) is the safe, generic signal to test
      // rather than parsing the constraint name out of the driver error.
      if (this.isUniqueViolation(cause)) {
        throw new ApplicationException(
          "customer_already_registered",
          "An account with this mobile number or email already exists",
          HttpStatus.CONFLICT,
        );
      }
      throw cause;
    }

    return this.authentication.loginCustomer({
      createdIp: context.createdIp,
      identifier: normalizedMobile,
      password: input.password,
      userAgent: context.userAgent,
    });
  }

  /**
   * §38 -- enumeration-safe by construction: the caller always sees the
   * same generic acknowledgement regardless of whether the identifier
   * matched an account, because the token is only ever created and never
   * reported back through this method's return type (`void`).
   */
  public async requestPasswordReset(identifier: string): Promise<void> {
    const trimmed = identifier.trim();
    const normalizedMobile = normalizeUaeMobile(trimmed);
    const account = await sql<{ id: string }>`
      select id from accounts
       where company_id is null and account_kind = 'customer'
         and (
           normalized_email = lower(btrim(${trimmed}))
           or (${normalizedMobile ?? null}::text is not null and normalized_mobile_number = ${normalizedMobile ?? null})
         )
       limit 1
    `.execute(this.database);
    const accountId = account.rows[0]?.id;
    if (accountId === undefined) return;

    const { hash, token } = this.sessionTokens.create();
    void token; // Only the hash is persisted (§40); returned separately below.
    await sql`
      insert into password_reset_tokens (account_id, company_id, token_hash, expires_at, created_by_source)
      values (
        ${accountId}::uuid, null, ${hash},
        now() + (${RESET_TOKEN_TTL_MINUTES} * interval '1 minute'), 'self_service'
      )
    `.execute(this.database);
    // §42: no outbound email/SMS delivery is configured in this foundation.
    // The raw token exists only in `hash`'s pre-image above and is
    // deliberately not persisted or logged anywhere -- a caller relying on
    // this method alone gets a real, usable reset flow with no way to
    // retrieve the token outside a delivery channel that does not exist
    // yet. See `issueResetTokenForTesting` for the explicit, non-production
    // harness this limitation requires.
  }

  /**
   * §42's explicit dev-only exception: since no outbound delivery exists,
   * something must be able to retrieve a real, usable token for testing.
   * Returns the RAW token (never persisted) so a test can complete a reset
   * end-to-end. Never called by the public HTTP surface -- only by test
   * code that imports this service directly.
   */
  public async issueResetTokenForTesting(identifier: string): Promise<string | undefined> {
    const trimmed = identifier.trim();
    const normalizedMobile = normalizeUaeMobile(trimmed);
    const account = await sql<{ id: string }>`
      select id from accounts
       where company_id is null and account_kind = 'customer'
         and (
           normalized_email = lower(btrim(${trimmed}))
           or (${normalizedMobile ?? null}::text is not null and normalized_mobile_number = ${normalizedMobile ?? null})
         )
       limit 1
    `.execute(this.database);
    const accountId = account.rows[0]?.id;
    if (accountId === undefined) return undefined;
    const { hash, token } = this.sessionTokens.create();
    await sql`
      insert into password_reset_tokens (account_id, company_id, token_hash, expires_at, created_by_source)
      values (
        ${accountId}::uuid, null, ${hash},
        now() + (${RESET_TOKEN_TTL_MINUTES} * interval '1 minute'), 'self_service'
      )
    `.execute(this.database);
    return token;
  }

  /**
   * §41 -- validates the token, updates the password, marks the token
   * one-time-used, and revokes every other active session for the account
   * (§41: "revoke active Customer sessions").
   */
  public async completePasswordReset(input: CompleteCommerceCustomerPasswordResetDto): Promise<void> {
    const tokenHash = this.sessionTokens.hash(input.token);
    await this.transactions.execute(async (transaction) => {
      const found = await sql<{ accountId: string }>`
        select account_id as "accountId" from password_reset_tokens
         where token_hash = ${tokenHash}
           and used_at is null
           and revoked_at is null
           and expires_at > now()
         for update
      `.execute(transaction);
      const accountId = found.rows[0]?.accountId;
      if (accountId === undefined) {
        throw new ApplicationException(
          "password_reset_token_invalid",
          "This password reset link is invalid or has expired",
          HttpStatus.BAD_REQUEST,
        );
      }
      const passwordHash = await this.passwordHasher.hash(input.newPassword);
      await sql`
        update accounts set password_hash = ${passwordHash}, failed_login_attempts = 0,
          locked_until = null, password_changed_at = now(), updated_at = now(), version = version + 1
         where id = ${accountId}::uuid
      `.execute(transaction);
      await sql`
        update password_reset_tokens set used_at = now() where token_hash = ${tokenHash}
      `.execute(transaction);
      await sql`
        update account_sessions set revoked_at = coalesce(revoked_at, now())
         where account_id = ${accountId}::uuid and revoked_at is null
      `.execute(transaction);
    });
  }

  private isUniqueViolation(cause: unknown): boolean {
    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "23505"
    );
  }
}
