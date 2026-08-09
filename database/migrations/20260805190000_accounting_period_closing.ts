import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Accounting Period Closing — workflow foundation.
 *
 * ---------------------------------------------------------------------------
 * A WORKFLOW ABOUT CLOSING, NOT A CLOSING
 * ---------------------------------------------------------------------------
 *
 * Nothing here closes a period. `accounting_periods.status` is untouched, no
 * Journal is written, and no balance moves. These tables record the human
 * process -- who checked what, who reviewed it, who approved it, and when --
 * that PRECEDES a close.
 *
 * Keeping the two apart is what makes the eventual close auditable. If the
 * checklist lived on `accounting_periods`, reopening a period would either
 * destroy the evidence of how it was closed the first time or leave a second
 * set of half-truthful columns. A workflow is an event log; a period is a
 * state. They have different lifetimes and belong in different tables.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRANSITION LOG IS SEPARATE AND IMMUTABLE
 * ---------------------------------------------------------------------------
 *
 * `closing_workflows.status` answers "where is this now". It cannot answer "who
 * moved it, when, and why", and overwriting it loses that answer every time.
 *
 * `closing_workflow_transitions` is insert-only -- no `updated_at`, no
 * `version`, and a trigger rejecting UPDATE and DELETE. A period close is the
 * control an auditor examines first, and a transition history that can be
 * edited afterwards is not a history.
 *
 * ---------------------------------------------------------------------------
 * MAKER-CHECKER IS ENFORCED IN DATA, NOT ONLY IN CODE
 * ---------------------------------------------------------------------------
 *
 * `submitted_by_account_id`, `reviewed_by_account_id` and
 * `approved_by_account_id` are separate columns with CHECK constraints that
 * forbid the approver from being the submitter. A service can be bypassed by a
 * script or a future endpoint; a constraint cannot.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table closing_workflows (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      workflow_number text not null,

      workflow_type text not null,
      fiscal_year_id uuid not null,
      -- Null for year_end: a Year-End Closing spans the whole fiscal year and
      -- belongs to no single period. The uniqueness index below coalesces it so
      -- two active year-end workflows still cannot coexist.
      accounting_period_id uuid,

      status text not null default 'draft',
      priority text not null default 'normal',
      due_date date,

      -- Ownership. assigned_to_account_id is who is doing the work now;
      -- the three role columns below record who did each stage, and are what
      -- the maker-checker CHECKs compare.
      assigned_to_account_id uuid,
      submitted_by_account_id uuid,
      submitted_at timestamptz,
      reviewed_by_account_id uuid,
      reviewed_at timestamptz,
      approved_by_account_id uuid,
      approved_at timestamptz,
      closed_at timestamptz,
      cancelled_at timestamptz,
      cancellation_reason text,

      notes text,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_by_account_id uuid,
      updated_at timestamptz not null default now(),
      version integer not null default 1,

      unique (id, company_id),
      unique (company_id, workflow_number),

      constraint closing_workflows_fiscal_year_fk
        foreign key (fiscal_year_id, company_id)
        references fiscal_years(id, company_id) on delete restrict,
      constraint closing_workflows_period_fk
        foreign key (accounting_period_id, company_id)
        references accounting_periods(id, company_id) on delete restrict,
      constraint closing_workflows_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint closing_workflows_assignee_fk
        foreign key (assigned_to_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint closing_workflows_submitter_fk
        foreign key (submitted_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint closing_workflows_reviewer_fk
        foreign key (reviewed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint closing_workflows_approver_fk
        foreign key (approved_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,

      constraint closing_workflows_type_check
        check (workflow_type in ('monthly', 'year_end')),
      constraint closing_workflows_status_check check (status in (
        'draft', 'in_progress', 'blocked', 'ready_for_review', 'under_review',
        'changes_requested', 'ready_for_approval', 'approved', 'closed',
        'reopened', 'cancelled'
      )),
      constraint closing_workflows_priority_check
        check (priority in ('low', 'normal', 'high', 'critical')),

      -- A Monthly Closing without a period is meaningless; a Year-End Closing
      -- with one is a category error.
      constraint closing_workflows_period_shape_check check (
        (workflow_type = 'monthly' and accounting_period_id is not null)
        or (workflow_type = 'year_end' and accounting_period_id is null)
      ),

      -- MAKER-CHECKER, in the database. The approver may never be the person
      -- who submitted, and the reviewer may never be either. A service can be
      -- bypassed; a constraint cannot.
      constraint closing_workflows_approver_not_maker_check check (
        approved_by_account_id is null
        or submitted_by_account_id is null
        or approved_by_account_id <> submitted_by_account_id
      ),
      constraint closing_workflows_reviewer_not_maker_check check (
        reviewed_by_account_id is null
        or submitted_by_account_id is null
        or reviewed_by_account_id <> submitted_by_account_id
      ),

      -- Each stage stamps its actor and its instant together or not at all.
      constraint closing_workflows_submitted_shape_check
        check ((submitted_by_account_id is null) = (submitted_at is null)),
      constraint closing_workflows_reviewed_shape_check
        check ((reviewed_by_account_id is null) = (reviewed_at is null)),
      constraint closing_workflows_approved_shape_check
        check ((approved_by_account_id is null) = (approved_at is null)),
      constraint closing_workflows_cancelled_shape_check check (
        (status <> 'cancelled' and cancelled_at is null)
        or (status = 'cancelled' and cancelled_at is not null
            and btrim(coalesce(cancellation_reason, '')) <> '')
      ),
      constraint closing_workflows_version_positive check (version > 0)
    );

    -- One ACTIVE workflow per Company, fiscal year, period and type. Closed and
    -- cancelled workflows are excluded so a period can be closed again after a
    -- reopen without deleting the first attempt. coalesce because NULL never
    -- conflicts with itself, which would let two year-end workflows coexist.
    create unique index closing_workflows_active_unique
      on closing_workflows (
        company_id, fiscal_year_id,
        coalesce(accounting_period_id, '00000000-0000-0000-0000-000000000000'::uuid),
        workflow_type
      )
      where status not in ('closed', 'cancelled');

    create index closing_workflows_status_index
      on closing_workflows (company_id, status, due_date);
    create index closing_workflows_assignee_index
      on closing_workflows (company_id, assigned_to_account_id)
      where assigned_to_account_id is not null;

    comment on table closing_workflows is
      'The human process that precedes closing an accounting period. Closes nothing itself; accounting_periods.status is untouched by this table.';

    create table closing_workflow_tasks (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      closing_workflow_id uuid not null,

      -- Stable key from the template (see accounting-closing.templates.ts).
      -- The label is snapshotted alongside it so a renamed template does not
      -- rewrite what a completed checklist said at the time.
      task_key text not null,
      task_label_snapshot text not null,
      sequence integer not null,
      is_mandatory boolean not null default true,

      status text not null default 'pending',
      -- Reserved for the automated checks a later prompt will add. Null means
      -- "not evaluated"; it is deliberately distinct from a failed check.
      check_result jsonb,
      checked_at timestamptz,

      assigned_to_account_id uuid,
      assigned_by_account_id uuid,
      assigned_at timestamptz,
      completed_by_account_id uuid,
      completed_at timestamptz,
      notes text,

      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version integer not null default 1,

      unique (id, company_id),
      unique (company_id, closing_workflow_id, task_key),

      constraint closing_workflow_tasks_workflow_fk
        foreign key (closing_workflow_id, company_id)
        references closing_workflows(id, company_id) on delete restrict,
      constraint closing_workflow_tasks_assignee_fk
        foreign key (assigned_to_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint closing_workflow_tasks_assigner_fk
        foreign key (assigned_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint closing_workflow_tasks_completer_fk
        foreign key (completed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,

      constraint closing_workflow_tasks_status_check check (status in (
        'pending', 'in_progress', 'blocked', 'completed', 'not_applicable'
      )),
      constraint closing_workflow_tasks_completed_shape_check
        check ((completed_by_account_id is null) = (completed_at is null)),
      constraint closing_workflow_tasks_assigned_shape_check
        check ((assigned_to_account_id is null) = (assigned_at is null))
    );

    create index closing_workflow_tasks_workflow_index
      on closing_workflow_tasks (company_id, closing_workflow_id, sequence);
    create index closing_workflow_tasks_assignee_index
      on closing_workflow_tasks (company_id, assigned_to_account_id)
      where assigned_to_account_id is not null;

    create table closing_task_comments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      closing_workflow_id uuid not null,
      -- Null for a comment on the workflow as a whole rather than one task.
      closing_workflow_task_id uuid,
      body text not null,
      author_account_id uuid not null,
      created_at timestamptz not null default now(),

      unique (id, company_id),

      constraint closing_task_comments_workflow_fk
        foreign key (closing_workflow_id, company_id)
        references closing_workflows(id, company_id) on delete restrict,
      constraint closing_task_comments_task_fk
        foreign key (closing_workflow_task_id, company_id)
        references closing_workflow_tasks(id, company_id) on delete restrict,
      constraint closing_task_comments_author_fk
        foreign key (author_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint closing_task_comments_body_check check (btrim(body) <> '')
    );

    create index closing_task_comments_workflow_index
      on closing_task_comments (company_id, closing_workflow_id, created_at);

    -- METADATA ONLY. No bytes are stored here; storage_key points at whatever
    -- the Files module holds. Keeping the two apart means an attachment can be
    -- moved or re-hosted without rewriting closing evidence.
    create table closing_task_attachments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      closing_workflow_id uuid not null,
      closing_workflow_task_id uuid,
      file_name text not null,
      content_type text,
      byte_size bigint,
      storage_key text not null,
      uploaded_by_account_id uuid not null,
      created_at timestamptz not null default now(),

      unique (id, company_id),

      constraint closing_task_attachments_workflow_fk
        foreign key (closing_workflow_id, company_id)
        references closing_workflows(id, company_id) on delete restrict,
      constraint closing_task_attachments_task_fk
        foreign key (closing_workflow_task_id, company_id)
        references closing_workflow_tasks(id, company_id) on delete restrict,
      constraint closing_task_attachments_uploader_fk
        foreign key (uploaded_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint closing_task_attachments_name_check check (btrim(file_name) <> ''),
      constraint closing_task_attachments_size_check check (byte_size is null or byte_size >= 0)
    );

    create index closing_task_attachments_workflow_index
      on closing_task_attachments (company_id, closing_workflow_id, created_at);

    -- Review and approval decisions. One row per decision, never overwritten,
    -- so a workflow that went round the loop three times shows three rows.
    create table closing_workflow_reviews (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      closing_workflow_id uuid not null,
      review_stage text not null,
      decision text not null,
      comments text,
      decided_by_account_id uuid not null,
      decided_at timestamptz not null default now(),

      unique (id, company_id),

      constraint closing_workflow_reviews_workflow_fk
        foreign key (closing_workflow_id, company_id)
        references closing_workflows(id, company_id) on delete restrict,
      constraint closing_workflow_reviews_decider_fk
        foreign key (decided_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,

      constraint closing_workflow_reviews_stage_check
        check (review_stage in ('review', 'approval')),
      constraint closing_workflow_reviews_decision_check
        check (decision in ('approved', 'changes_requested', 'rejected')),
      -- Asking for changes without saying which is not a review.
      constraint closing_workflow_reviews_comment_check check (
        decision = 'approved' or btrim(coalesce(comments, '')) <> ''
      )
    );

    create index closing_workflow_reviews_workflow_index
      on closing_workflow_reviews (company_id, closing_workflow_id, decided_at);

    -- IMMUTABLE. Every status change, with actor, instant and reason.
    create table closing_workflow_transitions (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      closing_workflow_id uuid not null,
      from_status text,
      to_status text not null,
      reason text,
      actor_account_id uuid not null,
      correlation_id uuid,
      created_at timestamptz not null default now(),

      unique (id, company_id),

      constraint closing_workflow_transitions_workflow_fk
        foreign key (closing_workflow_id, company_id)
        references closing_workflows(id, company_id) on delete restrict,
      constraint closing_workflow_transitions_actor_fk
        foreign key (actor_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint closing_workflow_transitions_progress_check
        check (from_status is null or from_status <> to_status)
    );

    create index closing_workflow_transitions_workflow_index
      on closing_workflow_transitions (company_id, closing_workflow_id, created_at);

    comment on table closing_workflow_transitions is
      'Insert-only history of every closing status change. UPDATE and DELETE are rejected by trigger.';

    create or replace function closing_workflow_transitions_immutable()
      returns trigger language plpgsql as $$
      begin
        raise exception
          'closing_workflow_transitions is insert-only; history cannot be % ', lower(tg_op);
      end;
      $$;

    create trigger closing_workflow_transitions_no_change
      before update or delete on closing_workflow_transitions
      for each row execute function closing_workflow_transitions_immutable();

    -- NO DESTRUCTIVE DELETION once a workflow has activity. A workflow with a
    -- transition history is evidence; the lawful way to abandon one is to
    -- cancel it, which keeps the record and the reason.
    create or replace function closing_workflows_no_delete_with_activity()
      returns trigger language plpgsql as $$
      begin
        if exists (
          select 1 from closing_workflow_transitions t
           where t.closing_workflow_id = old.id and t.company_id = old.company_id
        ) then
          raise exception
            'closing workflow % has activity and cannot be deleted; cancel it instead', old.id;
        end if;
        return old;
      end;
      $$;

    create trigger closing_workflows_protect_delete
      before delete on closing_workflows
      for each row execute function closing_workflows_no_delete_with_activity();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists closing_workflows_protect_delete on closing_workflows;
    drop trigger if exists closing_workflow_transitions_no_change on closing_workflow_transitions;
    drop function if exists closing_workflows_no_delete_with_activity();
    drop function if exists closing_workflow_transitions_immutable();
    drop table if exists closing_workflow_transitions;
    drop table if exists closing_workflow_reviews;
    drop table if exists closing_task_attachments;
    drop table if exists closing_task_comments;
    drop table if exists closing_workflow_tasks;
    drop table if exists closing_workflows;
  `.execute(database);
}
