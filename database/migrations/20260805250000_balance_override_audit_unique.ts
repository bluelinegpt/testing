import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * One override audit per account, per payment.
 *
 * ---------------------------------------------------------------------------
 * WHY AN APPLICATION CHECK WAS NOT ENOUGH
 * ---------------------------------------------------------------------------
 *
 * `BalanceEnforcementCoordinator.recordOverrides()` already looks for an
 * existing audit before inserting one, inside the transaction that holds the
 * account lock. That is a real check for the case it was written for -- one
 * caller finalising the same payment twice -- and it is not a guarantee.
 *
 * A guarantee has to survive a caller that forgets the check, a second service
 * added later that writes the same record its own way, and a concurrent
 * transaction that has not yet committed the row the other is looking for. Only
 * the database can make that promise, and an override audit is exactly the kind
 * of record where a duplicate is worse than an error: two rows saying the same
 * payment was authorised twice, with no way afterwards to tell whether it was
 * one decision recorded twice or two decisions taken.
 *
 * ---------------------------------------------------------------------------
 * THE IDENTITY, AND WHY IT IS TWO INDEXES
 * ---------------------------------------------------------------------------
 *
 * An audit is identified by the Company, what was being paid (`source_type` +
 * `source_entity_id`), and which account the decision was about.
 *
 * "Which account" is stored as two mutually exclusive columns rather than one
 * polymorphic id -- `balance_override_audits_account_check` enforces that
 * exactly one is set -- so a single unique index cannot express it. Two partial
 * indexes, one per kind, say the same thing without an expression index that
 * would obscure which column is being constrained.
 *
 * `source_reference` is deliberately NOT part of the identity. It is a
 * human-facing number carried for legibility; two records of the same decision
 * would still be two records if one of them spelled the reference differently.
 * The entity id is what identifies the thing paid.
 *
 * ---------------------------------------------------------------------------
 * PARTIAL, BECAUSE THE IDENTITY FIELDS ARE NULLABLE
 * ---------------------------------------------------------------------------
 *
 * `source_entity_id` is nullable: the column was designed to allow a record for
 * a decision about something with no row of its own yet.
 *
 * In PostgreSQL two nulls are never equal, so a plain unique index would silently
 * permit unlimited duplicates among null-entity rows while appearing to forbid
 * them -- the worst of both, a constraint that reads as protection and is not.
 *
 * The `where` clauses therefore restrict each index to rows that HAVE the
 * identity: a non-null entity id and a non-null account of that kind. Rows
 * without an entity id are left unconstrained and honestly so -- they carry no
 * identity to be unique on, and inventing one for them would merge unrelated
 * decisions. The coordinator already requires `sourceEntityId`, so every audit
 * it writes falls inside the guarded set.
 *
 * Verified read-only before writing this migration: `balance_override_audits`
 * holds zero rows, so nothing existing can violate either index.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create unique index balance_override_audits_cash_source_unique
      on balance_override_audits (
        company_id, source_type, source_entity_id, account_kind, company_cash_account_id
      )
      where source_entity_id is not null and company_cash_account_id is not null;

    create unique index balance_override_audits_bank_source_unique
      on balance_override_audits (
        company_id, source_type, source_entity_id, account_kind, company_bank_account_id
      )
      where source_entity_id is not null and company_bank_account_id is not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists balance_override_audits_bank_source_unique;
    drop index if exists balance_override_audits_cash_source_unique;
  `.execute(database);
}
