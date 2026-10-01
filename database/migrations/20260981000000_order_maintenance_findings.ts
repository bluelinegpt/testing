import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * The Order Maintenance findings log.
 *
 * Order Maintenance diagnoses an Order, records what it found, and -- later --
 * records what was done about each finding. The log is the point: a problem
 * found today has to still be findable next week, with who resolved it and
 * why, so a book of Orders can be worked through one at a time instead of
 * rediscovered on every visit.
 *
 * One row per (Order, check). Re-running a check UPDATES that row rather than
 * appending, so the table stays a current worklist; `last_seen_at` and
 * `detection_count` carry the history of how long a problem has persisted.
 * `evidence` holds the actual numbers the check compared, so a finding can be
 * understood months later without re-deriving it from Orders that have since
 * moved on.
 *
 * Deliberately NOT an audit table: the fix itself still writes `audit_events`
 * and `order_events` like every other operational change. This records the
 * diagnosis, not the money.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table order_maintenance_findings (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      -- Denormalised so a finding still reads sensibly in a list without
      -- joining Orders, and still names its subject if the Order is purged.
      order_number text not null,
      check_code text not null,
      severity text not null,
      -- What the check actually compared: expected vs found, amounts, the
      -- related record numbers. Shape varies per check, hence jsonb.
      evidence jsonb not null default '{}'::jsonb,
      status text not null default 'open',
      -- Whether a safe automatic repair exists for this finding TODAY. Stored
      -- per finding rather than inferred from check_code at read time: whether
      -- a repair is safe depends on the Order's own numbers, not only on which
      -- check produced the row.
      fixable boolean not null default false,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      detection_count integer not null default 1,
      resolved_at timestamptz,
      resolved_by_account_id uuid,
      resolution text,
      resolution_reason text,
      unique(id,company_id),
      -- One live row per Order per check. A re-run updates it.
      unique(company_id,order_id,check_code),
      foreign key(order_id,company_id)
        references orders(id,company_id) on delete cascade,
      foreign key(resolved_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      check(severity in ('error','warning','info')),
      check(status in ('open','fixed','dismissed','cleared')),
      check(detection_count > 0),
      -- A resolved finding must say who resolved it and how; an open one must
      -- claim none of that. Without this the log degrades into findings that
      -- are "fixed" with no accountable actor, which is the exact failure the
      -- log exists to prevent.
      check(
        case when status in ('open','cleared')
          then resolved_at is null and resolved_by_account_id is null
               and resolution is null
          else resolved_at is not null and resolved_by_account_id is not null
               and resolution is not null
        end
      ),
      -- 'cleared' means a re-check no longer reproduces it. That is not the
      -- same as someone fixing it, and the two must never be conflated.
      check(status <> 'dismissed' or resolution_reason is not null)
    );
    create index order_maintenance_findings_worklist_idx
      on order_maintenance_findings(company_id, status, severity, last_seen_at desc);
    create index order_maintenance_findings_order_idx
      on order_maintenance_findings(company_id, order_id);
    create index order_maintenance_findings_check_idx
      on order_maintenance_findings(company_id, check_code, status);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists order_maintenance_findings`.execute(database);
}
