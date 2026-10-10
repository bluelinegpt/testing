import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

const ACTIONS_BEFORE = [
  "plan",
  "replan",
  "reverse",
  "defer",
  "manual_reorder",
  "area_entered",
  "area_left",
  "stop_done",
];
const ACTIONS_AFTER = [...ACTIONS_BEFORE, "trip_started", "no_answer"];

function actionCheck(actions: readonly string[]) {
  return sql.raw(`check (action in (${actions.map((action) => `'${action}'`).join(", ")}))`);
}

/**
 * Route trip mode (Aiman, 10 Oct 2026).
 *
 * - The Driver may put his Areas, and the Orders inside them, in his own
 *   order before he sets out. `order_sequence` holds his Order order;
 *   `manual_order` tells a later Replan that it replaces his choice.
 * - `started_at` is when he tapped Start trip. Starting moves his Assigned
 *   Orders to Out for Delivery through the normal Order status change (one
 *   audited change per Order); nothing in this migration touches `orders`.
 * - Two route actions are added: `trip_started`, and `no_answer`, which only
 *   records the attempt. A no-answer never changes the Order or its place in
 *   the route; the Driver can come back to it whenever he wants.
 *
 * Additive only: new nullable or defaulted columns and a wider action list.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table driver_route_runs
      add column if not exists started_at timestamptz,
      add column if not exists manual_order boolean not null default false,
      add column if not exists order_sequence jsonb not null default '[]'::jsonb
  `.execute(database);
  await sql`
    alter table driver_route_runs
      drop constraint if exists driver_route_runs_order_sequence_check
  `.execute(database);
  await sql`
    alter table driver_route_runs
      add constraint driver_route_runs_order_sequence_check
      check (jsonb_typeof(order_sequence) = 'array')
  `.execute(database);
  await sql`
    alter table driver_route_actions drop constraint if exists driver_route_actions_action_check
  `.execute(database);
  await sql`
    alter table driver_route_actions
      add constraint driver_route_actions_action_check ${actionCheck(ACTIONS_AFTER)}
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from driver_route_actions where action in ('trip_started', 'no_answer')
  `.execute(database);
  await sql`
    alter table driver_route_actions drop constraint if exists driver_route_actions_action_check
  `.execute(database);
  await sql`
    alter table driver_route_actions
      add constraint driver_route_actions_action_check ${actionCheck(ACTIONS_BEFORE)}
  `.execute(database);
  await sql`
    alter table driver_route_runs
      drop constraint if exists driver_route_runs_order_sequence_check,
      drop column if exists order_sequence,
      drop column if exists manual_order,
      drop column if exists started_at
  `.execute(database);
}
