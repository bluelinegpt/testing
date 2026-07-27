import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";

export interface AccountPreferences {
  /** Per-user business-data display language (separate from UI layout language). */
  readonly textLanguage: "en" | "ar";
}

/**
 * Self-service preferences for the signed-in account. The per-user Text
 * Language reuses the existing `accounts.preferred_language` column. A user may
 * only ever read and change their own preference — the account is taken from
 * the authenticated identity, never from the request body.
 */
@Injectable()
export class AccountPreferencesService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async myPreferences(): Promise<AccountPreferences> {
    const identity = this.identities.current();
    const result = await sql<{ textLanguage: "en" | "ar" }>`
      select preferred_language as "textLanguage"
      from accounts
      where id = ${identity.identityId}::uuid
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException("account_not_found", "Account not found", HttpStatus.NOT_FOUND);
    }
    return { textLanguage: row.textLanguage };
  }

  public async updateTextLanguage(
    textLanguage: "en" | "ar",
    correlationId: string,
  ): Promise<AccountPreferences> {
    const identity = this.identities.current();
    await this.transactions.execute(async (transaction) => {
      const result = await sql<{ id: string }>`
        update accounts
           set preferred_language = ${textLanguage}, updated_at = now(), version = version + 1
         where id = ${identity.identityId}::uuid
         returning id
      `.execute(transaction);
      if (result.rows[0] === undefined) {
        throw new ApplicationException(
          "account_not_found",
          "Account not found",
          HttpStatus.NOT_FOUND,
        );
      }
      if (identity.companyId !== null) {
        await sql`
          insert into audit_events (
            company_id, actor_account_id, action, subject_type, subject_id,
            after_data, correlation_id
          ) values (
            ${identity.companyId}::uuid, ${identity.identityId}::uuid,
            'account.text_language_update', 'account', ${identity.identityId},
            ${JSON.stringify({ textLanguage })}::jsonb, ${correlationId}
          )
        `.execute(transaction);
      }
    });
    return { textLanguage };
  }
}
