import { sql, type Kysely } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * WhatsApp Trader-group notifications — Prompt 1 (foundation only).
 *
 * Four new Company-scoped tables. No provider connectivity, no QR flow, no
 * message sending and no order-status hook exists yet — this migration is the
 * durable persistence those later prompts build on.
 *
 * `company_whatsapp_connections` — at most ONE row per Delivery Company (a
 * plain `unique (company_id)`): the Company's current WhatsApp connection
 * configuration and its lifecycle state. Deliberately NOT a history table —
 * connection lifecycle history belongs to `audit_events`, exactly like every
 * other configuration entity. `encrypted_session_state` holds provider
 * session/auth material encrypted by the application
 * (`WhatsAppSessionCipher`, AES-256-GCM, key from the environment, never from
 * this database) and is never exposed through any API response.
 *
 * `trader_whatsapp_settings` — at most one WhatsApp notification
 * configuration per (company, Trader). A group is identified by the
 * provider's internal id (`provider_group_id`, e.g. `1203...@g.us`), never by
 * its visible name; `group_name_snapshot` exists only for display and audit,
 * so a later group rename can never invalidate history. `destination_type` is
 * a closed CHECK of just `group` today, widened by a later migration when new
 * destination types are approved.
 *
 * `whatsapp_message_outbox` — the durable outbox future order-status events
 * write exactly one row into. This is deliberately a NEW table rather than a
 * widening of `notification_outbox_events` (push) or
 * `communication_notification_outbox`: both of those have tested contracts
 * and recipient models (an `accounts` row) that a WhatsApp group destination
 * does not fit. `idempotency_key` is the deterministic
 * `order:<orderId>:status-history:<historyId>:group:<providerGroupId>` string
 * enforced unique per Company at the database level — application checks are
 * an optimization on top, never the guarantee. The row references the exact
 * `order_status_history` event (not merely the Order's current status), which
 * is what makes "at most one message per status event per group" provable.
 *
 * `whatsapp_message_attempts` — append-only per-attempt delivery audit,
 * separate from the outbox row so retries never overwrite earlier provider
 * responses. Never stores credentials or session payloads.
 *
 * Three new permissions are seeded into the `permissions` catalog only — no
 * `role_permissions` grant — exactly like `trader_receivables.create` before
 * them: the bootstrap "Company Administrator" role reaches these screens via
 * the `users_roles.manage` fallback already used by every
 * `@RequireAnyPermission` guard, and granting the codes to further roles is a
 * Company administration action, not a migration.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table company_whatsapp_connections (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      status text not null default 'not_connected',
      provider_type text not null default 'unconfigured',
      connected_phone_number text,
      provider_account_reference text,
      encrypted_session_state text,
      connected_at timestamptz,
      last_connected_at timestamptz,
      last_disconnected_at timestamptz,
      disconnect_reason text,
      last_health_check_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id),
      constraint company_whatsapp_connections_status_check check (status in (
        'not_connected', 'waiting_for_qr_scan', 'connecting', 'connected',
        'disconnected', 'authentication_failed', 'requires_reconnect'
      )),
      constraint company_whatsapp_connections_provider_check check (provider_type in (
        'unconfigured', 'baileys'
      )),
      constraint company_whatsapp_connections_version_positive check (version > 0),
      constraint company_whatsapp_connections_connected_shape_check check (
        status <> 'connected'
        or (connected_phone_number is not null and last_connected_at is not null)
      )
    )
  `.execute(database);

  await sql`
    create table trader_whatsapp_settings (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      notifications_enabled boolean not null default false,
      destination_type text not null default 'group',
      provider_group_id text,
      group_name_snapshot text,
      message_language text not null default 'both',
      configured_at timestamptz not null default now(),
      configured_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, trader_id),
      constraint trader_whatsapp_settings_trader_fk foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint trader_whatsapp_settings_actor_fk foreign key (configured_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint trader_whatsapp_settings_destination_check check (destination_type in ('group')),
      constraint trader_whatsapp_settings_language_check check (message_language in ('both', 'ar', 'en')),
      constraint trader_whatsapp_settings_version_positive check (version > 0),
      -- Notifications cannot be enabled without a real provider group id: the
      -- visible group name alone is never an address.
      constraint trader_whatsapp_settings_enabled_shape_check check (
        notifications_enabled = false
        or (provider_group_id is not null and length(trim(provider_group_id)) > 0)
      )
    )
  `.execute(database);

  await sql`
    create table whatsapp_message_outbox (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      order_id uuid not null,
      order_status_history_id uuid not null,
      connection_id uuid not null,
      destination_type text not null default 'group',
      provider_group_id text not null,
      group_name_snapshot text,
      message_language text not null,
      message_body text not null,
      status text not null default 'pending',
      provider_message_id text,
      queued_at timestamptz not null default now(),
      processing_at timestamptz,
      sent_at timestamptz,
      failed_at timestamptz,
      failure_code text,
      failure_reason text,
      attempt_count int not null default 0,
      next_attempt_at timestamptz,
      idempotency_key text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, idempotency_key),
      constraint whatsapp_message_outbox_trader_fk foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint whatsapp_message_outbox_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint whatsapp_message_outbox_status_history_fk foreign key (order_status_history_id, company_id)
        references order_status_history(id, company_id) on delete restrict,
      constraint whatsapp_message_outbox_connection_fk foreign key (connection_id, company_id)
        references company_whatsapp_connections(id, company_id) on delete restrict,
      constraint whatsapp_message_outbox_destination_check check (destination_type in ('group')),
      constraint whatsapp_message_outbox_language_check check (message_language in ('both', 'ar', 'en')),
      constraint whatsapp_message_outbox_status_check check (status in (
        'pending', 'processing', 'sent', 'failed', 'requires_review', 'cancelled'
      )),
      constraint whatsapp_message_outbox_attempts_check check (attempt_count >= 0),
      constraint whatsapp_message_outbox_group_check check (length(trim(provider_group_id)) > 0),
      constraint whatsapp_message_outbox_sent_shape_check check (
        status <> 'sent' or sent_at is not null
      )
    )
  `.execute(database);

  await sql`
    create index whatsapp_message_outbox_company_status_index
      on whatsapp_message_outbox (company_id, status)
  `.execute(database);

  await sql`
    create index whatsapp_message_outbox_trader_index
      on whatsapp_message_outbox (company_id, trader_id, created_at desc)
  `.execute(database);

  await sql`
    create index whatsapp_message_outbox_order_index
      on whatsapp_message_outbox (company_id, order_id, created_at desc)
  `.execute(database);

  // The future dispatcher's claim query: pending work ordered by when it may
  // next be attempted. Partial, so the index stays tiny once messages settle
  // into terminal states.
  await sql`
    create index whatsapp_message_outbox_pending_index
      on whatsapp_message_outbox (status, next_attempt_at)
      where status = 'pending'
  `.execute(database);

  // Database-level protection, not just application discipline: a message
  // that reached 'sent' is terminal — a retried worker, replayed transaction
  // or buggy service can never silently re-queue an already-delivered
  // message. The identity/idempotency columns are immutable for the same
  // reason: rewriting them would forge a different logical event under an
  // already-recorded delivery.
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
    create trigger whatsapp_message_outbox_update_guard
      before update on whatsapp_message_outbox
      for each row execute function reject_whatsapp_outbox_unsafe_update()
  `.execute(database);

  await sql`
    create table whatsapp_message_attempts (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      message_id uuid not null,
      attempt_number int not null,
      started_at timestamptz not null default now(),
      completed_at timestamptz,
      result text,
      provider_response_code text,
      provider_response_summary text,
      failure_classification text,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (message_id, attempt_number),
      constraint whatsapp_message_attempts_message_fk foreign key (message_id, company_id)
        references whatsapp_message_outbox(id, company_id) on delete restrict,
      constraint whatsapp_message_attempts_number_check check (attempt_number > 0),
      constraint whatsapp_message_attempts_result_check check (
        result is null or result in ('sent', 'failed')
      ),
      constraint whatsapp_message_attempts_classification_check check (
        failure_classification is null
        or failure_classification in ('transient', 'permanent', 'authentication', 'rate_limited', 'unknown')
      )
    )
  `.execute(database);

  await sql`
    create index whatsapp_message_attempts_message_index
      on whatsapp_message_attempts (company_id, message_id, attempt_number)
  `.execute(database);

  await sql`
    insert into permissions (code, description) values
      ('whatsapp.connection.manage', 'Manage the Company WhatsApp connection'),
      ('whatsapp.trader_settings.manage', 'Manage Trader WhatsApp notification settings'),
      ('whatsapp.history.view', 'View WhatsApp notification history')
    on conflict (code) do update set description = excluded.description
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`delete from role_permissions where permission_code in ('whatsapp.connection.manage', 'whatsapp.trader_settings.manage', 'whatsapp.history.view')`.execute(
    database,
  );
  await sql`delete from permissions where code in ('whatsapp.connection.manage', 'whatsapp.trader_settings.manage', 'whatsapp.history.view')`.execute(
    database,
  );
  await sql`drop index if exists whatsapp_message_attempts_message_index`.execute(database);
  await sql`drop table if exists whatsapp_message_attempts`.execute(database);
  await sql`drop trigger if exists whatsapp_message_outbox_update_guard on whatsapp_message_outbox`.execute(
    database,
  );
  await sql`drop function if exists reject_whatsapp_outbox_unsafe_update()`.execute(database);
  await sql`drop index if exists whatsapp_message_outbox_pending_index`.execute(database);
  await sql`drop index if exists whatsapp_message_outbox_order_index`.execute(database);
  await sql`drop index if exists whatsapp_message_outbox_trader_index`.execute(database);
  await sql`drop index if exists whatsapp_message_outbox_company_status_index`.execute(database);
  await sql`drop table if exists whatsapp_message_outbox`.execute(database);
  await sql`drop table if exists trader_whatsapp_settings`.execute(database);
  await sql`drop table if exists company_whatsapp_connections`.execute(database);
}
