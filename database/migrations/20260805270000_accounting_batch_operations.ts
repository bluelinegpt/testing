import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Accounting Batch Operations — foundation.
 *
 * ---------------------------------------------------------------------------
 * A BATCH IS A PLAN, NOT A POSTING
 * ---------------------------------------------------------------------------
 *
 * Nothing here posts, reprocesses, or moves a balance. These tables record an
 * intention -- which existing records a User wants an existing single-item
 * action applied to, what the read-only validation concluded about each one,
 * and who asked. Execution is a later, separate decision.
 *
 * That separation is the whole safety property. A batch that validated and
 * executed in one step would have no reviewable state between "I selected 200
 * Events" and "200 Events changed". The `ready` status exists precisely so a
 * person can look at the classification before anything happens.
 *
 * ---------------------------------------------------------------------------
 * THE BATCH OWNS NO ACCOUNTING RULE
 * ---------------------------------------------------------------------------
 *
 * `accounting_batch_items.validation_status` stores an ANSWER, never a rule.
 * The answer comes from the authoritative single-item readiness service, and
 * `validation_reasons` stores that service's own blocker codes verbatim. No
 * eligibility rule, posting map or accounting calculation is expressed in this
 * schema or in the batch module, and none may be added there later: a second
 * copy of a rule is a second answer that will eventually disagree with the
 * first, silently, at scale.
 *
 * ---------------------------------------------------------------------------
 * WHY ITEM IDENTITY IS IMMUTABLE AND THE HISTORY IS INSERT-ONLY
 * ---------------------------------------------------------------------------
 *
 * An item's `(source_type, source_id)` is what the batch will act on. If that
 * could be edited after validation, a batch could be validated against one set
 * of records and executed against another. A trigger freezes those columns at
 * insert; the classification columns stay writable because validation is meant
 * to be rerunnable.
 *
 * `accounting_batch_transitions` has no `updated_at`, no `version`, and a
 * trigger rejecting UPDATE and DELETE. A batch that changed real records is the
 * control an auditor examines, and a history that can be edited afterwards is
 * not a history. A batch with any transition cannot be deleted at all; the
 * lawful way to abandon one is to cancel it, which keeps the record and the
 * reason.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table accounting_batch_jobs (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      batch_reference text not null,

      -- Only batch types backed by an authoritative single-item service. A
      -- type with no such service has no lawful execution path and must not be
      -- creatable, so the list lives in a CHECK and not only in code.
      batch_type text not null,
      status text not null default 'draft',

      requested_by_account_id uuid not null,
      reason text,

      -- Counters. These describe EXECUTION and stay at zero until a batch is
      -- executed; validation classification is read from the items, not
      -- duplicated here, so the two can never disagree.
      total_items integer not null default 0,
      succeeded_count integer not null default 0,
      failed_count integer not null default 0,
      skipped_count integer not null default 0,
      duplicate_count integer not null default 0,

      correlation_id uuid not null default gen_random_uuid(),

      created_at timestamptz not null default now(),
      started_at timestamptz,
      completed_at timestamptz,
      cancelled_at timestamptz,
      cancellation_reason text,
      last_validated_at timestamptz,

      created_by_account_id uuid not null,
      updated_by_account_id uuid,
      updated_at timestamptz not null default now(),
      version bigint not null default 1,

      unique (id, company_id),
      unique (company_id, batch_reference),

      constraint accounting_batch_jobs_requester_fk
        foreign key (requested_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint accounting_batch_jobs_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint accounting_batch_jobs_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,

      constraint accounting_batch_jobs_type_check check (
        batch_type in ('accounting_event_reprocess', 'operational_posting_retry')
      ),
      constraint accounting_batch_jobs_status_check check (status in (
        'draft', 'validating', 'ready', 'processing',
        'partially_completed', 'completed', 'failed', 'cancelled'
      )),
      constraint accounting_batch_jobs_counts_check check (
        total_items >= 0 and succeeded_count >= 0 and failed_count >= 0
        and skipped_count >= 0 and duplicate_count >= 0
        and succeeded_count + failed_count + skipped_count + duplicate_count <= total_items
      ),
      -- A cancellation without a reason is an unexplained change to a control
      -- record, so the two columns are required together in both directions.
      constraint accounting_batch_jobs_cancellation_check check (
        (status = 'cancelled' and cancelled_at is not null and cancellation_reason is not null)
        or (status <> 'cancelled' and cancelled_at is null and cancellation_reason is null)
      )
    );

    create index accounting_batch_jobs_company_status_idx
      on accounting_batch_jobs (company_id, status, created_at desc);
    create index accounting_batch_jobs_company_type_idx
      on accounting_batch_jobs (company_id, batch_type, created_at desc);

    create table accounting_batch_items (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      batch_job_id uuid not null,

      -- What the batch will act on. Frozen after insert by the trigger below.
      source_type text not null,
      source_id uuid not null,
      source_reference text,

      validation_status text not null default 'pending',
      execution_status text not null default 'pending',

      -- The single-item service's OWN blocker codes, stored verbatim. Not a
      -- summary, and not reinterpreted: the reason a person acts on must be
      -- the reason the authoritative service actually gave.
      validation_reasons jsonb not null default '[]'::jsonb,
      error_code text,
      error_message text,

      -- Filled only by execution, which does not exist yet.
      resulting_accounting_event_id uuid,
      resulting_journal_id uuid,

      correlation_id uuid not null default gen_random_uuid(),
      created_at timestamptz not null default now(),
      validated_at timestamptz,
      executed_at timestamptz,
      updated_at timestamptz not null default now(),
      version bigint not null default 1,

      unique (id, company_id),
      -- DUPLICATE PREVENTION, in the database. The same source record cannot be
      -- enrolled twice in one batch, so a batch can never act on it twice.
      unique (batch_job_id, source_type, source_id),

      constraint accounting_batch_items_job_fk
        foreign key (batch_job_id, company_id)
        references accounting_batch_jobs(id, company_id) on delete cascade,
      constraint accounting_batch_items_event_fk
        foreign key (resulting_accounting_event_id, company_id)
        references accounting_events(id, company_id) on delete restrict,
      constraint accounting_batch_items_journal_fk
        foreign key (resulting_journal_id, company_id)
        references journal_entries(id, company_id) on delete restrict,

      constraint accounting_batch_items_source_type_check
        check (source_type in ('accounting_event')),
      constraint accounting_batch_items_validation_check check (validation_status in (
        'pending', 'eligible', 'blocked', 'duplicate', 'invalid', 'already_processed'
      )),
      constraint accounting_batch_items_execution_check check (execution_status in (
        'pending', 'succeeded', 'failed', 'skipped', 'cancelled'
      )),
      -- A result can only exist once the item actually ran.
      constraint accounting_batch_items_result_check check (
        execution_status <> 'pending'
        or (resulting_accounting_event_id is null and resulting_journal_id is null
            and executed_at is null)
      )
    );

    create index accounting_batch_items_job_idx
      on accounting_batch_items (batch_job_id, validation_status, created_at);
    create index accounting_batch_items_company_source_idx
      on accounting_batch_items (company_id, source_type, source_id);

    create table accounting_batch_transitions (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      batch_job_id uuid not null,
      from_status text,
      to_status text not null,
      actor_account_id uuid not null,
      note text,
      correlation_id uuid not null,
      occurred_at timestamptz not null default now(),

      constraint accounting_batch_transitions_job_fk
        foreign key (batch_job_id, company_id)
        references accounting_batch_jobs(id, company_id) on delete restrict,
      constraint accounting_batch_transitions_actor_fk
        foreign key (actor_account_id, company_id)
        references accounts(id, company_id) on delete restrict
    );

    create index accounting_batch_transitions_job_idx
      on accounting_batch_transitions (batch_job_id, occurred_at);

    -- IDENTITY IS FROZEN. Classification stays writable because validation is
    -- meant to be rerunnable; what the item POINTS AT is not.
    create function accounting_batch_items_freeze_identity() returns trigger
      language plpgsql as $$
    begin
      if new.company_id <> old.company_id
         or new.batch_job_id <> old.batch_job_id
         or new.source_type <> old.source_type
         or new.source_id <> old.source_id then
        raise exception
          'accounting batch item identity is immutable; remove the item and add the correct one';
      end if;
      return new;
    end;
    $$;

    create trigger accounting_batch_items_identity_frozen
      before update on accounting_batch_items
      for each row execute function accounting_batch_items_freeze_identity();

    create function accounting_batch_transitions_immutable() returns trigger
      language plpgsql as $$
    begin
      raise exception
        'accounting_batch_transitions is insert-only; history cannot be % ', lower(tg_op);
    end;
    $$;

    create trigger accounting_batch_transitions_no_change
      before update or delete on accounting_batch_transitions
      for each row execute function accounting_batch_transitions_immutable();

    -- NO DESTRUCTIVE DELETION once a batch has activity. A batch with a
    -- transition history is evidence; the lawful way to abandon one is to
    -- cancel it, which keeps the record and the reason.
    create function accounting_batch_jobs_no_delete_with_activity() returns trigger
      language plpgsql as $$
    begin
      if exists (select 1 from accounting_batch_transitions where batch_job_id = old.id) then
        raise exception
          'accounting batch % has activity and cannot be deleted; cancel it instead', old.id;
      end if;
      return old;
    end;
    $$;

    create trigger accounting_batch_jobs_protect_delete
      before delete on accounting_batch_jobs
      for each row execute function accounting_batch_jobs_no_delete_with_activity();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists accounting_batch_jobs_protect_delete on accounting_batch_jobs;
    drop trigger if exists accounting_batch_transitions_no_change on accounting_batch_transitions;
    drop trigger if exists accounting_batch_items_identity_frozen on accounting_batch_items;
    drop function if exists accounting_batch_jobs_no_delete_with_activity();
    drop function if exists accounting_batch_transitions_immutable();
    drop function if exists accounting_batch_items_freeze_identity();
    drop table if exists accounting_batch_transitions;
    drop table if exists accounting_batch_items;
    drop table if exists accounting_batch_jobs;
  `.execute(database);
}
