import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * A single, narrow, transaction-scoped exception to `company_user_accounts_no_delete`.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD BEING MODIFIED
 * ---------------------------------------------------------------------------
 *
 * `reject_administration_delete()` (added by
 * `20260718010000_user_role_administration`) protects two tables:
 * `accounts` via `company_user_accounts_no_delete`, and `roles` via
 * `roles_no_delete`. Its rule today is unconditional: a `company_user`
 * account can never be deleted, by anyone, through any path — the product
 * answer to "how do I get rid of a user" has always been Deactivate.
 *
 * The Platform Delete User feature needs a real, physical exception to that
 * rule for ONE narrow case: a Platform Administrator, after the deletion
 * eligibility engine has proven an account carries no historical or business
 * dependency, permanently removing that specific account. Every other path —
 * the Company portal, a generic repository delete, a script, a bare SQL
 * session — must keep hitting exactly the same wall it hits today.
 *
 * ---------------------------------------------------------------------------
 * WHY A TRANSACTION-LOCAL SETTING, AND NOT A DTO FLAG OR A NEW FUNCTION
 * ---------------------------------------------------------------------------
 *
 * `SET LOCAL blueline.platform_user_delete = 'on'` is scoped by PostgreSQL
 * itself to the CURRENT transaction: it is guaranteed to stop applying at
 * COMMIT and at ROLLBACK, and it is never visible to a different session or
 * connection while set, even a concurrent one on the same pool. Nothing in
 * the application has to remember to unset it — there is no cleanup step to
 * forget, because there is nothing durable to clean up. That is a stronger
 * guarantee than anything an application-level flag, header, or DTO field
 * could offer, and it is the standard PostgreSQL pattern for exactly this
 * shape of problem: "let this one already-authorised operation past a guard,
 * for the length of its own transaction, and no further."
 *
 * It is set in exactly one place in the codebase:
 * `PlatformUserDeletionService.delete()`, immediately before the `DELETE FROM
 * accounts` statement, after every business check (permission, target
 * resolution, eligibility, last-administrator, confirmation) has already
 * passed. No DTO, query parameter, or header maps to it — a caller cannot
 * request or influence it, and no other service sets it, so it can never
 * apply to a request this one service did not itself authorise.
 *
 * ---------------------------------------------------------------------------
 * WHY `roles` IS UNTOUCHED
 * ---------------------------------------------------------------------------
 *
 * The new branch below is nested INSIDE `if tg_table_name = 'accounts'`,
 * using PL/pgSQL control flow rather than a compound boolean expression.
 * That is deliberate, not stylistic: a compound `... and old.account_kind =
 * ...` condition was tried first and failed at runtime with "record OLD has
 * no field account_kind" when the trigger fired for `roles` — `roles` has no
 * such column, and the boolean short-circuit that would avoid evaluating it
 * cannot be relied on here. Nested `if` blocks make it structurally
 * impossible to reference `OLD.account_kind` at all while handling a `roles`
 * delete, and `roles_no_delete` keeps rejecting every delete unconditionally,
 * flag or no flag — proved live before this migration was written.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT THE ELIGIBILITY SYSTEM
 * ---------------------------------------------------------------------------
 *
 * The flag is the final technical permission to execute a delete that has
 * already been fully approved in application code. It carries no business
 * logic of its own — it does not know what "eligible" means, does not check
 * history, does not check the last-administrator rule. If the service ever
 * set it without having genuinely completed those checks, this trigger would
 * not catch that mistake. The safety property this migration adds is narrow
 * on purpose: "only this one code path, only for its own transaction."
 * Everything about WHETHER a given account should be deleted remains the
 * service's responsibility, re-verified transactionally immediately before
 * the flag is set.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function reject_administration_delete() returns trigger
    language plpgsql as $$
    begin
      if tg_table_name = 'accounts' then
        if old.account_kind <> 'company_user' then
          return old;
        end if;
        if current_setting('blueline.platform_user_delete', true) = 'on' then
          return old;
        end if;
      end if;
      raise exception using errcode = '23514',
        message = 'Administrative identities and Roles cannot be deleted';
    end;
    $$;
  `.execute(database);
}

/**
 * Restores the original, unconditional function body from
 * `20260718010000_user_role_administration` exactly, so `down` genuinely
 * reverses this migration rather than leaving a different function behind
 * that merely behaves the same for tables other than `accounts`.
 */
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function reject_administration_delete() returns trigger
    language plpgsql as $$
    begin
      if tg_table_name = 'accounts' and old.account_kind <> 'company_user' then
        return old;
      end if;
      raise exception using errcode = '23514',
        message = 'Administrative identities and Roles cannot be deleted';
    end;
    $$;
  `.execute(database);
}
