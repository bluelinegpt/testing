import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Make Segregation of Duties a Company decision instead of a build-time
 * constant.
 *
 * Every Accounting segregation rule — approve, post, pay, confirm a Cash/Bank
 * Movement, reverse — asks `AccountingOperationSupport.hasAlternateAuthorizedActor`
 * whether a second authorized user must take over. That question was answered
 * by a single hardcoded flag, which cannot serve both a small Company staffed
 * by one accountant and a larger Company that requires maker-checker.
 *
 * Three policies:
 *
 * - `strict`       — dual control is always required, whether or not a second
 *                    authorized user currently exists. A Company that chooses
 *                    this accepts that a record can wait for a second person.
 * - `conditional`  — dual control is required only while a second authorized
 *                    user is actually available, so a Company never deadlocks
 *                    on a person who does not exist. This is the behaviour the
 *                    rules were originally written for.
 * - `single_user`  — one authorized accountant may perform every step.
 *
 * `single_user` is the default so the decision already taken for the current
 * Company is preserved exactly; no existing behaviour changes on migration.
 *
 * Accountability is unaffected by any policy: `created_by`, `approved_by`,
 * `posted_by`, `confirmed_by` and `reversed_by` are always recorded, and every
 * action is always written to `audit_events`. The policy only decides whether
 * those columns must hold DIFFERENT accounts.
 *
 * Additive and reversible: one nullable-free column with a default and a CHECK.
 * No existing row can violate it, and no data is rewritten.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounting_configurations
      add column if not exists segregation_policy text not null default 'single_user';

    alter table accounting_configurations
      drop constraint if exists accounting_configurations_segregation_policy_check;

    alter table accounting_configurations
      add constraint accounting_configurations_segregation_policy_check
        check (segregation_policy in ('strict', 'conditional', 'single_user'));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounting_configurations
      drop constraint if exists accounting_configurations_segregation_policy_check;

    alter table accounting_configurations
      drop column if exists segregation_policy;
  `.execute(database);
}
