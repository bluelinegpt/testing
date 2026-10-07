import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Platform Repair Center -- durable repair ATTEMPT audit (Phase 2, Prompt 5).
 *
 * `platform_repair_executions` (20260986000000) remains the authoritative,
 * atomically-written record of every SUCCESSFUL repair. A refused or failed
 * execution rolls its business transaction back -- including anything written
 * inside it -- so it previously left no Repair Center record. This additive
 * table records those attempts, written OUTSIDE (after) the business
 * transaction:
 *
 *   REFUSED   the request reached Repair Center execution and was refused
 *             before any domain operation started (stale preview, finding not
 *             current, not READY, capability not applicable, invalid input,
 *             idempotency conflict, entity not in the Company);
 *   FAILED    the certified domain operation (or its verification, or the
 *             success audit) started and then failed: everything rolled back;
 *   REPLAYED  an idempotent replay of an earlier success: it repaired
 *             NOTHING and links the one authoritative execution.
 *
 * SUCCEEDED is deliberately not duplicated here: the success row lives in
 * `platform_repair_executions`, and the History view merges both tables.
 *
 * Append-only (UPDATE / DELETE rejected by trigger). No foreign key to orders
 * or accounting events: an audit row must outlive the business record and
 * must never block a Company test-data reset (classified PRESERVE). No
 * customer data, payloads, raw idempotency keys (only their sha256) or stack
 * traces are stored.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table if not exists platform_repair_attempts (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      entity_type text not null check (entity_type in ('order', 'trader_receivable', 'accounting_event')),
      entity_id uuid not null,
      entity_number text,
      finding_id text,
      reason_code text,
      capability_code text,
      actor_account_id uuid not null references accounts(id) on delete restrict,
      actor_authority text not null check (btrim(actor_authority) <> ''),
      reason text check (reason is null or length(reason) <= 1000),
      preview_version text,
      idempotency_key_sha256 text check (idempotency_key_sha256 is null or idempotency_key_sha256 ~ '^[0-9a-f]{64}$'),
      result text not null check (result in ('REFUSED', 'FAILED', 'REPLAYED')),
      error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{1,80}$'),
      safe_error_summary text check (safe_error_summary is null or length(safe_error_summary) <= 500),
      repair_execution_id uuid references platform_repair_executions(id) on delete restrict,
      correlation_id text,
      created_at timestamptz not null default now(),
      constraint platform_repair_attempts_replay_links_execution
        check ((result = 'REPLAYED') = (repair_execution_id is not null))
    );

    create index if not exists platform_repair_attempts_company_created_idx
      on platform_repair_attempts (company_id, created_at desc, id desc);
    create index if not exists platform_repair_executions_company_created_idx
      on platform_repair_executions (company_id, created_at desc, id desc);

    create or replace function reject_platform_repair_attempt_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception 'platform_repair_attempts is append-only'
        using errcode = 'check_violation';
    end;
    $$;

    drop trigger if exists platform_repair_attempts_append_only on platform_repair_attempts;
    create trigger platform_repair_attempts_append_only
      before update or delete on platform_repair_attempts
      for each row execute function reject_platform_repair_attempt_mutation();
  `.execute(database);
}

/** Forward-only: repair attempt history is audit evidence and is never dropped. */
export async function down(): Promise<void> {
  // Intentionally empty.
}
