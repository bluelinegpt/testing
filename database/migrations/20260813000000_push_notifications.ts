import { sql, type Kysely } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Prompt 15 — Push Notifications foundation.
 *
 * Two new tables:
 *
 * `device_registrations` — one durable row per (provider, push_token). The
 * token is the uniqueness key, not the account: an FCM/APNs token identifies
 * one physical install, and an install can only ever be usefully bound to one
 * authenticated account at a time. Re-registering the same token under a
 * different account (the "device logs out, a different person logs in"
 * scenario) intentionally rebinds the row via `on conflict (provider,
 * push_token) do update` rather than creating a second row — the previous
 * account's earlier binding is gone the moment that happens, which is exactly
 * the security property Prompt 15 requires ("previous account association
 * must no longer receive private pushes"). Company/account identity on this
 * table is always backend-derived at write time (`DeviceRegistrationService`,
 * never trusts a client-supplied accountId/companyId).
 *
 * `notification_outbox_events` — the durable "business event -> dispatcher ->
 * device registrations -> push provider -> result state" record Prompt 15's
 * dispatcher drains, and simultaneously the durable Notification Inbox record
 * (`read_at`) a mobile client lists. This is deliberately a NEW, generic
 * table rather than widening `communication_notification_outbox`
 * (2026-08-02): that table's schema is communication-specific (NOT NULL
 * conversation_id/message_id, FK'd straight to messages) and already has a
 * tested contract (`communication.replay-outbox.database.test.ts`, G1-G5)
 * this migration must not touch. `communication_notification_outbox` is left
 * completely unmodified; `CommunicationService` additively writes a second,
 * generic row here alongside its existing write, so Prompt 14's guaranteed
 * behaviour is provably unaffected. Order events have no prior outbox at all,
 * so this table is also where Order push notifications originate.
 *
 * `dedupe_key` is what makes delivery idempotent: a deterministic key per
 * logical (event, recipient) pair (e.g. `message:<messageId>:<accountId>`,
 * `order-assign:<orderId>:<driverId>:<correlationId>`) means a retried write
 * — worker restart, retried HTTP request, replayed transaction — can never
 * produce a second logical notification, via `on conflict (company_id,
 * dedupe_key) do nothing`.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table device_registrations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      account_id uuid not null,
      platform text not null,
      provider text not null default 'fcm',
      push_token text not null,
      app_version text,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      revoked_at timestamptz,
      revoked_reason text,
      constraint device_registrations_account_fk foreign key (account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint device_registrations_platform_check check (platform in ('android', 'ios')),
      constraint device_registrations_provider_check check (provider in ('fcm')),
      constraint device_registrations_status_check check (status in ('active', 'revoked')),
      constraint device_registrations_revoked_shape_check check (
        (status = 'active' and revoked_at is null and revoked_reason is null)
        or (status = 'revoked' and revoked_at is not null)
      )
    )
  `.execute(database);

  // The token IS the identity of one install. This unique index is the
  // mechanism that makes registration idempotent (same install + same token
  // -> update) and makes cross-account rebinding safe (same token, new
  // account -> the row moves, it never duplicates).
  await sql`
    create unique index device_registrations_token_unique
      on device_registrations (provider, push_token)
  `.execute(database);

  await sql`
    create index device_registrations_active_recipient_index
      on device_registrations (company_id, account_id)
      where status = 'active'
  `.execute(database);

  await sql`
    create table notification_outbox_events (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      recipient_account_id uuid not null,
      notification_type text not null,
      target_type text not null,
      target_id uuid,
      title_key text not null,
      body_key text,
      body_params jsonb not null default '{}'::jsonb,
      dedupe_key text not null,
      status text not null default 'pending',
      attempts int not null default 0,
      last_attempted_at timestamptz,
      next_retry_at timestamptz,
      sent_at timestamptz,
      error_category text,
      read_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint notification_outbox_events_recipient_fk foreign key (recipient_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint notification_outbox_events_type_check check (notification_type in (
        'communication.message.created',
        'order.assigned',
        'order.reassigned',
        'order.status_changed'
      )),
      constraint notification_outbox_events_target_check check (target_type in ('conversation', 'order')),
      constraint notification_outbox_events_status_check check (status in (
        'pending', 'processing', 'sent', 'retryable_failure', 'permanent_failure', 'skipped'
      )),
      constraint notification_outbox_events_attempts_check check (attempts >= 0),
      unique (company_id, dedupe_key)
    )
  `.execute(database);

  await sql`
    create index notification_outbox_events_pending_index
      on notification_outbox_events (status, next_retry_at)
      where status in ('pending', 'retryable_failure')
  `.execute(database);

  // The Notification Inbox listing query: "this account's notifications,
  // newest first". Company-scoped first so the composite matches the WHERE
  // clause every inbox/recipient query will actually use.
  await sql`
    create index notification_outbox_events_inbox_index
      on notification_outbox_events (company_id, recipient_account_id, created_at desc)
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop index if exists notification_outbox_events_inbox_index`.execute(database);
  await sql`drop index if exists notification_outbox_events_pending_index`.execute(database);
  await sql`drop table if exists notification_outbox_events`.execute(database);
  await sql`drop index if exists device_registrations_active_recipient_index`.execute(database);
  await sql`drop index if exists device_registrations_token_unique`.execute(database);
  await sql`drop table if exists device_registrations`.execute(database);
}
