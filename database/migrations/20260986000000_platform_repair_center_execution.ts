import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Platform Repair Center -- controlled repair EXECUTION (Phase 2, Prompt 3).
 *
 * Additive only. Three changes:
 *
 * 1. Permission `platform.companies.repair_center.execute`, granted to the
 *    Platform super administrator role ONLY. It is separate from
 *    `platform.companies.repair_center.read`: reading health / previews never
 *    grants execution. Company roles can never hold it (`platform.` prefix).
 *
 * 2. `trader_receivables.created_by_account_id` becomes NULLABLE. A Platform
 *    administrator is not a Company account (accounts.company_id is NULL), so
 *    the Company-scoped composite FK (created_by_account_id, company_id) can
 *    never point at one. Same convention as the Platform accounting-mode
 *    switch (`accounting_configurations.updated_by_account_id = NULL`, actor
 *    recorded in the audit row): a receivable created by a Platform repair
 *    records NO Company creator, and the Platform actor is recorded in
 *    `platform_repair_executions`. The FK itself is kept (MATCH SIMPLE: a NULL
 *    creator is simply unchecked). No existing row is touched; readers already
 *    show a missing creator as "Legacy/Unknown" (left joins), and the
 *    accounting capture records a NULL actor as `system`.
 *
 * 3. `platform_repair_executions`: the immutable audit of every SUCCESSFUL
 *    Repair Center execution, written in the same transaction as the repair
 *    (a failed or refused execution rolls back and leaves nothing). It is also
 *    the idempotency ledger: (company, capability, entity, idempotency key) is
 *    unique. Append-only: UPDATE and DELETE are rejected by trigger. It has
 *    no FK to orders, so it never blocks an Order or Company test-data reset;
 *    the reset manifest must classify it (see the Prompt 3 report).
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values ('platform.companies.repair_center.execute',
            'Execute a certified, READY Repair Center repair for a selected Company')
    on conflict (code) do update set description = excluded.description;

    insert into role_permissions (role_id, permission_code)
    select r.id, 'platform.companies.repair_center.execute' from roles r
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;

    alter table trader_receivables alter column created_by_account_id drop not null;

    create table if not exists platform_repair_executions (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      entity_type text not null check (entity_type in ('order', 'trader_receivable')),
      entity_id uuid not null,
      entity_number text not null check (btrim(entity_number) <> ''),
      finding_id text not null check (btrim(finding_id) <> ''),
      reason_code text not null check (btrim(reason_code) <> ''),
      capability_code text not null check (btrim(capability_code) <> ''),
      preview_version text not null check (btrim(preview_version) <> ''),
      actor_account_id uuid not null references accounts(id) on delete restrict,
      actor_authority text not null check (btrim(actor_authority) <> ''),
      reason text not null check (btrim(reason) <> '' and length(reason) <= 1000),
      requested_inputs jsonb not null default '{}'::jsonb,
      before_state_fingerprint text not null,
      after_state_fingerprint text not null,
      before_health text not null,
      after_health text not null,
      before_classification text not null,
      after_classification text not null,
      result text not null check (result = 'succeeded'),
      result_summary jsonb not null default '{}'::jsonb,
      idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
      request_hash text not null check (btrim(request_hash) <> ''),
      correlation_id text,
      created_at timestamptz not null default now(),
      -- Deliberately NO foreign key to orders: an audit record must outlive
      -- the Order it describes (e.g. a Company test-data reset), and must
      -- never block such a deletion. order_id is verified in-transaction by
      -- the execution service, which locks the Order by (Company, id).
      constraint platform_repair_executions_idempotency_unique
        unique (company_id, capability_code, entity_id, idempotency_key)
    );

    create index if not exists platform_repair_executions_company_order_idx
      on platform_repair_executions (company_id, order_id, created_at desc);

    create or replace function reject_platform_repair_execution_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception 'platform_repair_executions is append-only'
        using errcode = 'check_violation';
    end;
    $$;

    drop trigger if exists platform_repair_executions_append_only on platform_repair_executions;
    create trigger platform_repair_executions_append_only
      before update or delete on platform_repair_executions
      for each row execute function reject_platform_repair_execution_mutation();
  `.execute(database);
}

/**
 * Forward-only in practice. The permission can be withdrawn; the audit table
 * is NOT dropped (it is audit history), and the creator column is NOT made
 * NOT NULL again (receivables created by Platform repairs legitimately have
 * no Company creator).
 */
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'platform.companies.repair_center.execute';
    delete from permissions where code = 'platform.companies.repair_center.execute';
  `.execute(database);
}
