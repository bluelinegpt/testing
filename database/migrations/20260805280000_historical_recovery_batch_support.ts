import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Historical Accounting Recovery — batch support.
 *
 * The smallest change that lets the existing Accounting Batch framework carry
 * a `historical_accounting_recovery` batch. Nothing here posts, recovers, or
 * touches a source record; it only widens what the batch tables may DESCRIBE.
 *
 * Why each piece is strictly required:
 *
 *  - the jobs `batch_type` CHECK did not permit the new type, so a recovery
 *    batch could not exist at all;
 *  - the items `source_type` CHECK permitted only `accounting_event`, and a
 *    recovery item points at an Order or a Driver fee accrual -- records that
 *    have NO Event yet, which is the entire reason the type exists;
 *  - recovery items must carry the facts the preview classified them on
 *    (expected posting type, accounting date, the source's own stored amount,
 *    and the classification snapshot), so the batch is a reviewable record of
 *    what was agreed to, not a bare list of ids;
 *  - the items `validation_status` CHECK gains the three recovery-only
 *    verdicts (`closed_period`, `invalid_source_data`,
 *    `no_accounting_required`) so a revalidation can store the authoritative
 *    classification VERBATIM instead of collapsing three distinct facts into
 *    `blocked` and losing the reason a person would act on.
 *
 * The `amount` column is a SNAPSHOT of the source's stored figure for review
 * display -- never an input to posting. Execution, when it exists, reads the
 * source record through the authoritative loader like every other posting.
 *
 * Duplicate prevention is unchanged: the existing
 * `(batch_job_id, source_type, source_id)` unique index already prevents the
 * same source twice in one batch, and cross-batch exclusivity is a service
 * rule over ACTIVE batches only -- a status-dependent condition a static
 * unique index cannot express without also blocking legitimate re-enrolment
 * after a cancelled batch.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounting_batch_jobs
      drop constraint accounting_batch_jobs_type_check,
      add constraint accounting_batch_jobs_type_check check (
        batch_type in (
          'accounting_event_reprocess', 'operational_posting_retry',
          'historical_accounting_recovery'
        )
      );

    alter table accounting_batch_items
      drop constraint accounting_batch_items_source_type_check,
      add constraint accounting_batch_items_source_type_check check (
        source_type in ('accounting_event', 'order', 'outsourced_driver_fee_accrual')
      ),
      drop constraint accounting_batch_items_validation_check,
      add constraint accounting_batch_items_validation_check check (validation_status in (
        'pending', 'eligible', 'blocked', 'duplicate', 'invalid', 'already_processed',
        'closed_period', 'invalid_source_data', 'no_accounting_required'
      )),
      add column expected_posting_type text,
      add column accounting_date date,
      add column amount numeric(18,2),
      add column classification_snapshot jsonb;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounting_batch_items
      drop column classification_snapshot,
      drop column amount,
      drop column accounting_date,
      drop column expected_posting_type,
      drop constraint accounting_batch_items_validation_check,
      add constraint accounting_batch_items_validation_check check (validation_status in (
        'pending', 'eligible', 'blocked', 'duplicate', 'invalid', 'already_processed'
      )),
      drop constraint accounting_batch_items_source_type_check,
      add constraint accounting_batch_items_source_type_check check (
        source_type in ('accounting_event')
      );

    alter table accounting_batch_jobs
      drop constraint accounting_batch_jobs_type_check,
      add constraint accounting_batch_jobs_type_check check (
        batch_type in ('accounting_event_reprocess', 'operational_posting_retry')
      );
  `.execute(database);
}
