import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, type Transaction, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { PlatformAuditService } from "./platform-audit.service.js";

/**
 * Permanent deletion of a Company user, and the eligibility rules that gate it.
 *
 * ---------------------------------------------------------------------------
 * DELETE IS NOT DEACTIVATE
 * ---------------------------------------------------------------------------
 *
 * Deactivate keeps the person and their history and stops them working.
 * Delete removes the login itself, and is offered ONLY for an account that has
 * done nothing — a mistyped test user, or one left behind after a
 * non-production reset. It never removes business history to make an account
 * deletable. If history exists, the answer is Deactivate, and this service
 * says so rather than offering a destructive alternative.
 *
 * ---------------------------------------------------------------------------
 * ELIGIBILITY IS DERIVED FROM THE SCHEMA, NOT FROM A LIST
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is a hand-written list of the tables that matter —
 * orders, journals, collections, settlements, and so on. That list is wrong the
 * day someone adds a table and forgets to update it, and its failure mode is
 * silent: a user with real history looks deletable.
 *
 * So the dependency set is read from `pg_constraint` at request time: every
 * foreign key that points at `accounts` is discovered, and the rows referencing
 * THIS account are counted through each one. There are 181 such keys today and
 * the query finds all of them, including any added tomorrow. A new table is
 * covered the moment its foreign key exists.
 *
 * The database is also the final authority, not just the adviser. 170 of those
 * keys are `ON DELETE RESTRICT`, so if this service ever miscounted, the DELETE
 * itself still fails and the transaction rolls back. The check exists to give a
 * useful ANSWER; the constraint exists to make a wrong answer harmless.
 */

/**
 * References that are the account's own identity and access, and carry no
 * business history.
 *
 * Everything not named here is treated as blocking. That direction matters: an
 * unknown reference must block deletion rather than be assumed harmless, so a
 * newly added table is safe by default and only becomes deletable when somebody
 * deliberately classifies it here.
 */
const deletableReferences = new Set([
  // Ephemeral authentication state.
  "account_sessions.account_id",
  // Unused or spent credential links. Spent ones are not history in any
  // meaningful sense: they record that a password was set, which the account's
  // own `password_changed_at` already says.
  "password_reset_tokens.account_id",
  // Access grants to this account. NOT `assigned_by_account_id`, which records
  // that this account granted access to SOMEBODY ELSE and is that person's
  // provenance, not this one's.
  "account_roles.account_id",
  // Company membership.
  "company_users.account_id",
]);

/** Human-facing grouping, so the UI can say what kind of history exists. */
const dependencyCategories: readonly { match: RegExp; category: string }[] = [
  { match: /^orders?|^order_/, category: "Orders" },
  { match: /journal|accounting|fiscal|opening_balance|chart_of_accounts|account_mappings/, category: "Accounting" },
  { match: /collection|settlement|reconciliation|cash_bank|payment/, category: "Collections and settlements" },
  { match: /payroll|employee|salary|allowance|commission/, category: "Payroll" },
  { match: /expense/, category: "Expenses" },
  { match: /audit_events/, category: "Audit history" },
  { match: /storefront|commerce|marketplace|product/, category: "Storefront" },
  { match: /conversation|message|notification|communication/, category: "Communication" },
  { match: /file_objects|attachment|document/, category: "Files and documents" },
  { match: /account_roles/, category: "Access granted to other users" },
];

function categoryOf(table: string): string {
  return dependencyCategories.find((entry) => entry.match.test(table))?.category ?? "Other records";
}

export interface BlockingDependency {
  readonly category: string;
  readonly rows: number;
}

export interface UserDeletionEligibility {
  readonly eligible: boolean;
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly companyId: string;
  readonly companyName: string;
  readonly isActive: boolean;
  readonly activeSessions: number;
  readonly isLastAdministrator: boolean;
  readonly blockingRows: number;
  readonly blockingCategories: readonly BlockingDependency[];
  readonly recommendedAction: "delete" | "deactivate";
  readonly reason: string | null;
  /** The exact phrase the caller must type to confirm. Server-generated. */
  readonly confirmationChallenge: string;
}

interface ReferenceRow {
  referencingTable: string;
  referencingColumn: string;
}

@Injectable()
export class PlatformUserDeletionService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  /**
   * Every foreign key pointing at `accounts`, discovered from the catalogue.
   *
   * Read on each request rather than cached at boot: a migration applied while
   * the process is running would otherwise leave the service counting against
   * a schema that no longer exists, and this query is trivial next to the
   * per-table counts that follow.
   */
  private async accountReferences(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  ): Promise<readonly ReferenceRow[]> {
    return (
      await sql<ReferenceRow>`
        select cl.relname as "referencingTable", att.attname as "referencingColumn"
          from pg_constraint c
          join pg_class cl on cl.oid = c.conrelid
          join unnest(c.conkey) as k(attnum) on true
          join pg_attribute att on att.attrelid = c.conrelid and att.attnum = k.attnum
         where c.contype = 'f'
           and c.confrelid = 'accounts'::regclass
           and cl.relname <> 'accounts'
         order by cl.relname, att.attname
      `.execute(executor)
    ).rows;
  }

  /**
   * Counts the rows that would block deletion, one query per referencing key.
   *
   * Table and column names come from `pg_constraint`, never from a caller, and
   * are interpolated with `sql.ref` so they are quoted identifiers rather than
   * raw text. The account id stays a bound parameter throughout.
   */
  private async countBlocking(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    accountId: string,
  ): Promise<Map<string, number>> {
    const blocking = new Map<string, number>();
    for (const reference of await this.accountReferences(executor)) {
      const key = `${reference.referencingTable}.${reference.referencingColumn}`;
      if (deletableReferences.has(key)) continue;
      const count = Number(
        (
          await sql<{ n: string }>`
            select count(*)::bigint as n from ${sql.ref(reference.referencingTable)}
             where ${sql.ref(reference.referencingColumn)} = ${accountId}::uuid
          `.execute(executor)
        ).rows[0]?.n ?? 0,
      );
      if (count === 0) continue;
      const category = categoryOf(reference.referencingTable);
      blocking.set(category, (blocking.get(category) ?? 0) + count);
    }
    return blocking;
  }

  public async eligibility(
    companyId: string,
    accountId: string,
  ): Promise<UserDeletionEligibility> {
    return this.describe(this.database, companyId, accountId);
  }

  private async describe(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    accountId: string,
    lock = false,
  ): Promise<UserDeletionEligibility> {
    /**
     * The account is re-resolved AND constrained to the target Company in one
     * query. Matching on the identifier alone and checking the Company
     * afterwards would make a wrong Company id a 200 with the wrong data for
     * however long the two statements are apart.
     */
    const account = (
      await sql<{
        id: string;
        username: string;
        displayName: string | null;
        status: string;
        companyName: string;
      }>`
        select a.id, a.username, cu.display_name as "displayName", a.status,
               c.name_en as "companyName"
          from accounts a
          join companies c on c.id = a.company_id
          left join company_users cu on cu.account_id = a.id and cu.company_id = a.company_id
         where a.id = ${accountId}::uuid
           and a.company_id = ${companyId}::uuid
           and a.account_kind = 'company_user'
         ${lock ? sql`for update of a` : sql``}
         limit 1
      `.execute(executor)
    ).rows[0];

    // A user of another Company and a user that does not exist answer
    // identically, so a Platform actor cannot probe one Company's account ids
    // through another Company's route.
    if (account === undefined) {
      throw new ApplicationException(
        "company_user_not_found",
        "The requested user does not exist in this Company",
        HttpStatus.NOT_FOUND,
      );
    }

    const activeSessions = Number(
      (
        await sql<{ n: string }>`
          select count(*)::bigint as n from account_sessions
           where account_id = ${accountId}::uuid and revoked_at is null and expires_at > now()
        `.execute(executor)
      ).rows[0]?.n ?? 0,
    );

    /**
     * The last-administrator guard, reused in spirit from user administration.
     * A Company that still operates must keep somebody able to administer it;
     * deleting the last one would strand it in a state only a Platform actor
     * could repair.
     */
    const isLastAdministrator =
      Number(
        (
          await sql<{ n: string }>`
            select count(*)::bigint as n
              from accounts a
              join account_roles ar on ar.account_id = a.id
              join roles r on r.id = ar.role_id
             where a.company_id = ${companyId}::uuid
               and a.status = 'active'
               and a.id <> ${accountId}::uuid
               and lower(r.code) = 'company_admin'
          `.execute(executor)
        ).rows[0]?.n ?? 0,
      ) === 0 &&
      Number(
        (
          await sql<{ n: string }>`
            select count(*)::bigint as n
              from account_roles ar join roles r on r.id = ar.role_id
             where ar.account_id = ${accountId}::uuid and lower(r.code) = 'company_admin'
          `.execute(executor)
        ).rows[0]?.n ?? 0,
      ) > 0;

    const blocking = await this.countBlocking(executor, accountId);
    const blockingCategories = [...blocking.entries()]
      .map(([category, rows]) => ({ category, rows }))
      .sort((left, right) => right.rows - left.rows);
    const blockingRows = blockingCategories.reduce((total, entry) => total + entry.rows, 0);

    const reason =
      blockingRows > 0
        ? "This user has historical activity. Deactivate instead."
        : isLastAdministrator
          ? "This user is the last Company Administrator. Create another administrator before deleting this user."
          : null;

    return {
      eligible: reason === null,
      accountId: account.id,
      username: account.username,
      displayName: account.displayName,
      companyId,
      companyName: account.companyName,
      isActive: account.status === "active",
      activeSessions,
      isLastAdministrator,
      blockingRows,
      blockingCategories,
      recommendedAction: reason === null ? "delete" : "deactivate",
      reason,
      // Generated from the username by the SERVER. A challenge the client
      // composed would confirm nothing: the browser would be agreeing with
      // itself about which account it had asked to delete.
      confirmationChallenge: `DELETE ${account.username}`,
    };
  }

  /**
   * Permanently deletes an eligible user.
   *
   * Eligibility is re-evaluated INSIDE the transaction, with the account row
   * locked, rather than trusted from whatever the screen was showing. Between
   * the eligibility call that enabled the button and the click that follows it,
   * the user may have signed in, been given a role, or created a record — and a
   * preview is not a promise.
   */
  public async delete(
    companyId: string,
    accountId: string,
    confirmation: string,
    actor: {
      accountId: string;
      correlationId: string;
      ip?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<{ deleted: true; username: string }> {
    return this.transactions.execute(async (transaction) => {
      const state = await this.describe(transaction, companyId, accountId, true);

      const deny = async (failureReason: string, message: string): Promise<never> => {
        await this.audit.recordBestEffort({
          action: "platform.company_user.deletion_denied",
          actorAccountId: actor.accountId,
          companyId,
          subjectType: "account",
          subjectId: accountId,
          after: { username: state.username, blockingRows: state.blockingRows },
          result: "denied",
          failureReason,
          correlationId: actor.correlationId,
          ipAddress: actor.ip,
          userAgent: actor.userAgent,
        });
        throw new ApplicationException(message, state.reason ?? message, HttpStatus.CONFLICT);
      };

      if (confirmation !== state.confirmationChallenge) {
        await deny("confirmation_mismatch", "user_deletion_confirmation_mismatch");
      }
      if (!state.eligible) {
        await deny(
          state.blockingRows > 0 ? "has_history" : "last_administrator",
          "user_deletion_not_eligible",
        );
      }

      // The role summary is captured for the audit snapshot before any row
      // that could answer this question is removed.
      const roles = (
        await sql<{ code: string }>`
          select r.code from account_roles ar join roles r on r.id = ar.role_id
           where ar.account_id = ${accountId}::uuid order by r.code
        `.execute(transaction)
      ).rows.map((row) => row.code);

      /**
       * The audit entry is written BEFORE the rows go, and inside the same
       * transaction.
       *
       * It carries a snapshot rather than a reference, so it still says who was
       * deleted once the account no longer exists. Writing it afterwards would
       * mean a failure between the delete and the audit leaves a user gone with
       * no record of who removed them; writing it inside means a failure to
       * audit rolls the deletion back -- and this row only becomes durable if
       * the WHOLE transaction, deletes included, commits.
       *
       * `audit_events.actor_account_id` points at the PLATFORM actor, who is
       * not being deleted, so the RESTRICT key on that column is satisfied.
       * `subject_id` carries no foreign key at all, by design (see
       * `platform-audit.service.ts`), so this row survives the account it
       * describes with no special handling required.
       *
       * The eligibility and confirmation results are captured explicitly,
       * not just implied by the row existing: a reader of this audit later
       * should not have to infer "it must have been eligible" from the
       * absence of a denial entry.
       */
      await this.audit.record({
        action: "platform.company_user.deleted",
        actorAccountId: actor.accountId,
        companyId,
        subjectType: "account",
        subjectId: accountId,
        before: {
          username: state.username,
          displayName: state.displayName,
          status: state.isActive ? "active" : "inactive",
          companyName: state.companyName,
          roles,
          eligibilityResult: {
            eligible: state.eligible,
            blockingRows: state.blockingRows,
            isLastAdministrator: state.isLastAdministrator,
          },
          confirmationResult: "matched",
        },
        after: { deleted: true },
        result: "success",
        correlationId: actor.correlationId,
        ipAddress: actor.ip,
        userAgent: actor.userAgent,
      });

      /**
       * The narrow technical permission to execute the delete the checks
       * above have already approved -- not a second eligibility system. Set
       * as late as possible, immediately before the one statement that needs
       * it, and only for the account row this specific request has locked,
       * confirmed, and matched.
       *
       * `SET LOCAL` is scoped by PostgreSQL to this transaction alone: it
       * cannot outlive COMMIT or ROLLBACK, and no other session or concurrent
       * connection can observe it while it is set. See
       * `20260816100000_platform_user_deletion_guard_exception` for the
       * trigger-side half of this and the evidence that it does not weaken
       * `roles_no_delete` or any other path.
       */
      await sql`set local blueline.platform_user_delete = 'on'`.execute(transaction);

      // Deletion order follows the foreign keys inward: everything pointing at
      // the account first, the account last.
      await sql`delete from account_sessions where account_id = ${accountId}::uuid`.execute(
        transaction,
      );
      await sql`delete from password_reset_tokens where account_id = ${accountId}::uuid`.execute(
        transaction,
      );
      await sql`delete from account_roles where account_id = ${accountId}::uuid`.execute(
        transaction,
      );
      await sql`
        delete from company_users
         where account_id = ${accountId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      const removed = await sql`
        delete from accounts where id = ${accountId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);

      /**
       * Verified, not assumed. `numAffectedRows` from the DELETE itself is
       * the direct answer to "is the account gone" -- a concurrent second
       * attempt on the same account (see the concurrency test) would find
       * zero rows here rather than silently reporting success twice.
       */
      if ((removed.numAffectedRows ?? 0n) !== 1n) {
        throw new ApplicationException(
          "user_deletion_failed",
          "The account could not be deleted. It may have already been removed.",
          HttpStatus.CONFLICT,
        );
      }

      // The Company itself must remain untouched by this operation -- this
      // service deletes exactly one account and nothing that owns it.
      const companyIntact = (
        await sql<{ n: string }>`
          select count(*)::bigint as n from companies where id = ${companyId}::uuid
        `.execute(transaction)
      ).rows[0]?.n;
      if (companyIntact !== "1") {
        throw new Error("Company row unexpectedly missing after user deletion");
      }

      return { deleted: true, username: state.username };
    });
  }
}
