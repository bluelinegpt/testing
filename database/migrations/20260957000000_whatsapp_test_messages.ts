import { sql, type Kysely } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * WhatsApp test messages — Prompt 3's minimal schema adjustment.
 *
 * Prompt 1's `whatsapp_message_outbox` was designed around Order status
 * events: `order_id` and `order_status_history_id` were NOT NULL, which is
 * exactly right for Order notifications but leaves nowhere truthful to
 * record the explicit user-triggered Test Message Prompt 3 introduces —
 * fabricating Order references for a test would corrupt the audit meaning of
 * the table.
 *
 * The adjustment is deliberately the smallest that preserves Prompt 1's
 * integrity guarantees:
 *
 *  - `message_type` (`order_status` | `test`, default `order_status` so
 *    every existing row and every existing writer keeps its exact meaning);
 *  - the two Order references become nullable ONLY in shape — a paired CHECK
 *    (`whatsapp_message_outbox_type_shape_check`) makes them mandatory for
 *    `order_status` rows (the original guarantee, unchanged) and FORBIDS
 *    them on `test` rows, so a test can never masquerade as an Order event;
 *  - `message_type` joins the immutable-identity column set in the update
 *    guard trigger — a recorded test can never be rewritten into an Order
 *    notification or vice versa.
 *
 * Idempotency: Order-status rows keep their deterministic event-derived
 * key. Test rows use a per-request key (`test:<client request id>`), so each
 * deliberate click is its own message while a retried/double-submitted
 * request still collapses onto one row.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table whatsapp_message_outbox
      add column message_type text not null default 'order_status'
  `.execute(database);

  await sql`
    alter table whatsapp_message_outbox
      alter column order_id drop not null,
      alter column order_status_history_id drop not null
  `.execute(database);

  await sql`
    alter table whatsapp_message_outbox
      add constraint whatsapp_message_outbox_message_type_check
        check (message_type in ('order_status', 'test'))
  `.execute(database);

  await sql`
    alter table whatsapp_message_outbox
      add constraint whatsapp_message_outbox_type_shape_check
        check (
          (message_type = 'order_status'
            and order_id is not null and order_status_history_id is not null)
          or
          (message_type = 'test'
            and order_id is null and order_status_history_id is null)
        )
  `.execute(database);

  await sql`
    create or replace function reject_whatsapp_outbox_unsafe_update() returns trigger
    language plpgsql as $$
    begin
      if old.idempotency_key is distinct from new.idempotency_key
        or old.company_id is distinct from new.company_id
        or old.trader_id is distinct from new.trader_id
        or old.order_id is distinct from new.order_id
        or old.order_status_history_id is distinct from new.order_status_history_id
        or old.provider_group_id is distinct from new.provider_group_id
        or old.message_type is distinct from new.message_type then
        raise exception 'whatsapp_outbox_identity_immutable';
      end if;
      if old.status = 'sent' and new.status is distinct from 'sent' then
        raise exception 'whatsapp_outbox_sent_is_terminal';
      end if;
      return new;
    end;
    $$
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function reject_whatsapp_outbox_unsafe_update() returns trigger
    language plpgsql as $$
    begin
      if old.idempotency_key is distinct from new.idempotency_key
        or old.company_id is distinct from new.company_id
        or old.trader_id is distinct from new.trader_id
        or old.order_id is distinct from new.order_id
        or old.order_status_history_id is distinct from new.order_status_history_id
        or old.provider_group_id is distinct from new.provider_group_id then
        raise exception 'whatsapp_outbox_identity_immutable';
      end if;
      if old.status = 'sent' and new.status is distinct from 'sent' then
        raise exception 'whatsapp_outbox_sent_is_terminal';
      end if;
      return new;
    end;
    $$
  `.execute(database);
  await sql`
    alter table whatsapp_message_outbox
      drop constraint if exists whatsapp_message_outbox_type_shape_check
  `.execute(database);
  await sql`
    alter table whatsapp_message_outbox
      drop constraint if exists whatsapp_message_outbox_message_type_check
  `.execute(database);
  // Rolling back requires removing test rows first — they cannot satisfy the
  // restored NOT NULL Order references. Development-only, like every down().
  await sql`delete from whatsapp_message_attempts where message_id in (select id from whatsapp_message_outbox where message_type = 'test')`.execute(
    database,
  );
  await sql`delete from whatsapp_message_outbox where message_type = 'test'`.execute(database);
  await sql`
    alter table whatsapp_message_outbox
      alter column order_id set not null,
      alter column order_status_history_id set not null
  `.execute(database);
  await sql`alter table whatsapp_message_outbox drop column if exists message_type`.execute(
    database,
  );
}
