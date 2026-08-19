import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create sequence if not exists commerce_integration_connection_reference_seq;

    create table commerce_integration_connections (
      id uuid primary key default gen_random_uuid(),
      reference_number text not null unique,
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      trader_commerce_id uuid not null references trader_commerce_profiles(id) on delete restrict,
      provider text not null,
      external_store_id text not null,
      external_store_name text not null,
      status text not null default 'pending',
      connection_mode text not null default 'inbound_only',
      health_status text not null default 'unknown',
      capabilities jsonb not null default '{}'::jsonb,
      sync_cursor jsonb not null default '{}'::jsonb,
      last_health_check_at timestamptz,
      last_webhook_at timestamptz,
      last_success_at timestamptz,
      last_error_at timestamptz,
      last_error_code text,
      last_error_message_safe text,
      connected_at timestamptz,
      disconnected_at timestamptz,
      disconnected_by_account_id uuid,
      disconnect_reason text,
      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      constraint commerce_integration_connections_trader_fk
        foreign key (trader_id, company_id) references traders(id, company_id) on delete restrict,
      constraint commerce_integration_connections_creator_fk
        foreign key (created_by_account_id) references accounts(id) on delete set null,
      constraint commerce_integration_connections_disconnector_fk
        foreign key (disconnected_by_account_id) references accounts(id) on delete set null,
      constraint commerce_integration_connections_provider_check
        check (provider in ('mock_commerce','salla','shopify','woocommerce')),
      constraint commerce_integration_connections_status_check
        check (status in ('pending','connected','degraded','disconnected','revoked','error')),
      constraint commerce_integration_connections_mode_check
        check (connection_mode in ('inbound_only','bidirectional')),
      constraint commerce_integration_connections_health_check
        check (health_status in ('unknown','healthy','degraded','unauthorized','error')),
      constraint commerce_integration_connections_store_nonempty
        check (btrim(external_store_id) <> '' and btrim(external_store_name) <> '')
    );
    create unique index commerce_integration_connections_store_unique
      on commerce_integration_connections(provider, external_store_id)
      where status not in ('disconnected','revoked');
    create index commerce_integration_connections_company_trader_idx
      on commerce_integration_connections(company_id, trader_id, status);
    create index commerce_integration_connections_activity_idx
      on commerce_integration_connections(updated_at desc);

    create table commerce_integration_credentials (
      id uuid primary key default gen_random_uuid(),
      connection_id uuid not null references commerce_integration_connections(id) on delete restrict,
      credential_kind text not null,
      secret_reference text not null,
      status text not null default 'configured',
      created_by_account_id uuid references accounts(id) on delete set null,
      created_at timestamptz not null default now(),
      revoked_at timestamptz,
      unique (connection_id, credential_kind),
      constraint commerce_integration_credentials_kind_check
        check (credential_kind in ('access_token','refresh_token','api_key','consumer_key','consumer_secret','webhook_secret','mock_signature')),
      constraint commerce_integration_credentials_status_check
        check (status in ('configured','revoked','expired'))
    );

    create table commerce_integration_events (
      id uuid primary key default gen_random_uuid(),
      connection_id uuid not null references commerce_integration_connections(id) on delete restrict,
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      provider text not null,
      external_event_id text not null,
      event_type text not null,
      status text not null default 'received',
      attempt_count integer not null default 0,
      received_at timestamptz not null default now(),
      processed_at timestamptz,
      next_retry_at timestamptz,
      external_reference text,
      external_order_id text,
      tawseelhub_order_id uuid,
      error_code text,
      error_message_safe text,
      sanitized_payload jsonb not null default '{}'::jsonb,
      result_summary text,
      unique (connection_id, external_event_id),
      constraint commerce_integration_events_connection_company_fk
        foreign key (connection_id, company_id) references commerce_integration_connections(id, company_id) on delete restrict,
      constraint commerce_integration_events_trader_fk
        foreign key (trader_id, company_id) references traders(id, company_id) on delete restrict,
      constraint commerce_integration_events_order_fk
        foreign key (tawseelhub_order_id, company_id) references orders(id, company_id) on delete restrict,
      constraint commerce_integration_events_provider_check
        check (provider in ('mock_commerce','salla','shopify','woocommerce')),
      constraint commerce_integration_events_type_check
        check (event_type in ('order.created','order.updated','order.cancelled','fulfillment.updated','connection.revoked','sync.requested')),
      constraint commerce_integration_events_status_check
        check (status in ('received','processing','succeeded','duplicate','failed','retrying','rejected'))
    );
    create index commerce_integration_events_connection_time_idx
      on commerce_integration_events(connection_id, received_at desc);
    create index commerce_integration_events_status_idx
      on commerce_integration_events(status, next_retry_at, received_at);
    create index commerce_integration_events_external_order_idx
      on commerce_integration_events(connection_id, external_order_id);

    create table commerce_integration_order_links (
      id uuid primary key default gen_random_uuid(),
      connection_id uuid not null references commerce_integration_connections(id) on delete restrict,
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      order_id uuid not null,
      provider text not null,
      external_order_id text not null,
      external_order_number text not null,
      external_order_number_normalized text not null,
      external_updated_at timestamptz,
      last_inbound_event_id uuid references commerce_integration_events(id) on delete set null,
      last_outbound_status text,
      last_outbound_synced_at timestamptz,
      product_snapshot jsonb not null default '[]'::jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (connection_id, external_order_id),
      unique (order_id),
      constraint commerce_integration_order_links_connection_company_fk
        foreign key (connection_id, company_id) references commerce_integration_connections(id, company_id) on delete restrict,
      constraint commerce_integration_order_links_order_fk
        foreign key (order_id, company_id) references orders(id, company_id) on delete restrict,
      constraint commerce_integration_order_links_trader_fk
        foreign key (trader_id, company_id) references traders(id, company_id) on delete restrict
    );
    create index commerce_integration_order_links_company_ref_idx
      on commerce_integration_order_links(company_id, external_order_number_normalized);

    create table commerce_integration_area_mappings (
      id uuid primary key default gen_random_uuid(),
      connection_id uuid references commerce_integration_connections(id) on delete cascade,
      company_id uuid not null references companies(id) on delete restrict,
      provider text not null,
      external_value text not null,
      normalized_external_value text not null,
      area_id uuid not null,
      status text not null default 'active',
      created_by_account_id uuid references accounts(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (connection_id, provider, normalized_external_value),
      constraint commerce_integration_area_mappings_area_fk
        foreign key (area_id, company_id) references areas(id, company_id) on delete restrict,
      constraint commerce_integration_area_mappings_status_check
        check (status in ('active','disabled'))
    );
    create index commerce_integration_area_mappings_company_idx
      on commerce_integration_area_mappings(company_id, provider, normalized_external_value);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table if exists commerce_integration_area_mappings;
    drop table if exists commerce_integration_order_links;
    drop table if exists commerce_integration_events;
    drop table if exists commerce_integration_credentials;
    drop table if exists commerce_integration_connections;
    drop sequence if exists commerce_integration_connection_reference_seq;
  `.execute(database);
}
