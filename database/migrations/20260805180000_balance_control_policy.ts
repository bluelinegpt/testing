import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Company policy for negative Cash and Bank balances, and the audit of every
 * override of it.
 *
 * ---------------------------------------------------------------------------
 * WHY EFFECTIVE-DATED AND NOT A FLAG
 * ---------------------------------------------------------------------------
 *
 * A Company changes its mind about overdraft. If the policy were a column on
 * `companies`, raising the limit in March would retroactively make February's
 * blocked payment look like it should have been allowed, and every past
 * override would be judged against a rule that did not exist at the time.
 *
 * Effective dating makes "what was the rule when this happened" answerable,
 * which is the only version of this question an auditor asks. Same reasoning,
 * and the same `exclude using gist` shape, as the Company Business Day rule.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AUDIT IS A SEPARATE, IMMUTABLE TABLE
 * ---------------------------------------------------------------------------
 *
 * An override is a person deciding to go past a control the Company set. That
 * decision is evidence, and evidence that can be edited afterwards is not
 * evidence. The table has no `updated_at` and no `version`, and a trigger
 * rejects UPDATE and DELETE outright, so the only lawful operation is INSERT.
 *
 * It also stores a SNAPSHOT of the policy and the balances at the moment of the
 * decision. Re-deriving them later from the current rule would answer a
 * different question, and would quietly change what the record says every time
 * the policy changed.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS ENFORCED BY THIS MIGRATION
 * ---------------------------------------------------------------------------
 *
 * No trigger blocks a payment, no balance is recomputed, and no existing table
 * is altered. This creates the policy and the evidence log only; the decision
 * is made by `BalanceControlService`, and wiring it into the payment workflows
 * is deliberately a later step.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table company_balance_policies (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,

      -- Cash has no 'allow_within_overdraft': a drawer cannot hold less than
      -- nothing, so a negative Cash balance is a counting error rather than a
      -- financing arrangement. Offering the option would invite the wrong fix.
      cash_policy text not null default 'block',

      -- Bank can legitimately go negative up to an agreed facility, which is
      -- why it gets the extra option Cash does not.
      bank_policy text not null default 'allow_within_overdraft',

      -- Positive magnitude: how far below zero a Bank account may go. Stored
      -- unsigned so nobody has to remember which direction the sign points.
      bank_overdraft_limit numeric(18, 2) not null default 0,

      -- Which permission lets someone override. Stored rather than hardcoded so
      -- a Company can tighten it without a deployment.
      override_permission text not null default 'accounting.manage',

      effective_from date not null,
      effective_to date,
      is_active boolean not null default true,

      change_reason text not null,
      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version integer not null default 1,

      unique (id, company_id),

      constraint company_balance_policies_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,

      constraint company_balance_policies_cash_check
        check (cash_policy in ('block', 'allow', 'allow_with_override')),
      constraint company_balance_policies_bank_check
        check (bank_policy in
          ('block', 'allow', 'allow_with_override', 'allow_within_overdraft')),
      constraint company_balance_policies_overdraft_check
        check (bank_overdraft_limit >= 0),
      -- An overdraft limit only means something under the one policy that reads
      -- it. A limit sitting beside 'block' would read as permission that is not
      -- actually granted.
      constraint company_balance_policies_overdraft_policy_check check (
        bank_overdraft_limit = 0 or bank_policy = 'allow_within_overdraft'
      ),
      constraint company_balance_policies_period_check
        check (effective_to is null or effective_to > effective_from),
      constraint company_balance_policies_reason_check
        check (btrim(change_reason) <> ''),

      -- One active policy per Company at any instant. '[)' so adjacent periods
      -- touch without overlapping and without leaving a day uncovered.
      constraint company_balance_policies_no_overlap exclude using gist (
        company_id with =,
        daterange(effective_from, effective_to, '[)') with &&
      ) where (is_active)
    );

    create index company_balance_policies_lookup_index
      on company_balance_policies (company_id, effective_from, effective_to)
      where is_active;

    comment on table company_balance_policies is
      'Effective-dated Company policy for negative Cash and Bank balances. Enforced by BalanceControlService, not by triggers.';

    -- Seed one policy per Company at the recommended default, open-ended from
    -- the beginning of time so no historical date is left uncovered.
    insert into company_balance_policies (
      company_id, cash_policy, bank_policy, bank_overdraft_limit,
      effective_from, change_reason
    )
    select c.id, 'block', 'allow_within_overdraft', 0, '-infinity'::date,
           'Initial default: Cash cannot go negative; Bank only within a configured overdraft.'
      from companies c;

    create table balance_override_audits (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,

      -- Which account the decision was about. Exactly one is set; the CHECK
      -- below enforces that rather than trusting the caller.
      company_cash_account_id uuid,
      company_bank_account_id uuid,
      account_kind text not null,

      -- What the workflow was doing. source_reference is the human-facing
      -- number (Payment number, Movement number) so the record is legible
      -- without joining back to a table that may since have changed.
      source_type text not null,
      source_reference text,
      source_entity_id uuid,

      -- SNAPSHOT of the moment. Deliberately duplicated from the policy and the
      -- account: re-deriving these later would answer a different question.
      direction text not null,
      transaction_amount numeric(18, 2) not null,
      current_balance numeric(18, 2) not null,
      projected_balance numeric(18, 2) not null,
      applied_policy text not null,
      overdraft_limit_snapshot numeric(18, 2) not null,
      policy_id uuid,

      override_reason text not null,
      override_by_account_id uuid not null,
      created_at timestamptz not null default now(),

      unique (id, company_id),

      constraint balance_override_audits_cash_fk
        foreign key (company_cash_account_id, company_id)
        references company_cash_accounts(id, company_id) on delete restrict,
      constraint balance_override_audits_bank_fk
        foreign key (company_bank_account_id, company_id)
        references company_bank_accounts(id, company_id) on delete restrict,
      constraint balance_override_audits_actor_fk
        foreign key (override_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint balance_override_audits_policy_fk
        foreign key (policy_id, company_id)
        references company_balance_policies(id, company_id) on delete restrict,

      constraint balance_override_audits_kind_check
        check (account_kind in ('bank', 'cash')),
      constraint balance_override_audits_account_check check (
        (account_kind = 'cash'
          and company_cash_account_id is not null and company_bank_account_id is null)
        or (account_kind = 'bank'
          and company_bank_account_id is not null and company_cash_account_id is null)
      ),
      constraint balance_override_audits_direction_check
        check (direction in ('inbound', 'outbound')),
      constraint balance_override_audits_amount_check
        check (transaction_amount > 0),
      -- A blank reason is the same as no reason. The whole point of an override
      -- record is that somebody explained themselves.
      constraint balance_override_audits_reason_check
        check (btrim(override_reason) <> '')
    );

    create index balance_override_audits_company_time_index
      on balance_override_audits (company_id, created_at desc);
    create index balance_override_audits_source_index
      on balance_override_audits (company_id, source_type, source_entity_id);
    create index balance_override_audits_actor_index
      on balance_override_audits (company_id, override_by_account_id, created_at desc);

    comment on table balance_override_audits is
      'Immutable record of every authorised override of the negative-balance policy. Insert-only; UPDATE and DELETE are rejected by trigger.';

    create or replace function balance_override_audits_immutable()
      returns trigger language plpgsql as $$
      begin
        raise exception
          'balance_override_audits is insert-only; override records cannot be % ',
          lower(tg_op);
      end;
      $$;

    create trigger balance_override_audits_no_update
      before update or delete on balance_override_audits
      for each row execute function balance_override_audits_immutable();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists balance_override_audits_no_update on balance_override_audits;
    drop function if exists balance_override_audits_immutable();
    drop table if exists balance_override_audits;
    drop table if exists company_balance_policies;
  `.execute(database);
}
