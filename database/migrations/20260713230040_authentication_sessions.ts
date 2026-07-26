import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table account_sessions (
      id uuid primary key default gen_random_uuid(),
      company_id uuid references companies(id) on delete restrict,
      account_id uuid not null references accounts(id) on delete restrict,
      token_hash text not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      last_seen_at timestamptz,
      created_ip inet,
      user_agent text,
      created_at timestamptz not null default now(),
      unique nulls not distinct (id, company_id),
      unique (token_hash),
      constraint account_sessions_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
      constraint account_sessions_expiry_check check (expires_at > created_at)
    );
    create index account_sessions_account_active_index
      on account_sessions (account_id, expires_at) where revoked_at is null;
    create index account_sessions_expiry_index on account_sessions (expires_at);

    create table password_reset_tokens (
      id uuid primary key default gen_random_uuid(),
      company_id uuid references companies(id) on delete restrict,
      account_id uuid not null references accounts(id) on delete restrict,
      token_hash text not null,
      expires_at timestamptz not null,
      used_at timestamptz,
      created_at timestamptz not null default now(),
      unique nulls not distinct (id, company_id),
      unique (token_hash),
      constraint password_reset_tokens_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
      constraint password_reset_tokens_expiry_check check (expires_at > created_at)
    );
    create index password_reset_tokens_account_active_index
      on password_reset_tokens (account_id, expires_at) where used_at is null;

    create function enforce_account_security_scope() returns trigger language plpgsql as $$
    declare
      account_company_id uuid;
    begin
      select company_id into account_company_id from accounts where id = new.account_id;
      if new.company_id is distinct from account_company_id then
        raise exception 'security token scope must match the authenticated account Company';
      end if;
      return new;
    end;
    $$;
    create trigger account_sessions_scope_guard
      before insert or update of account_id, company_id on account_sessions
      for each row execute function enforce_account_security_scope();
    create trigger password_reset_tokens_scope_guard
      before insert or update of account_id, company_id on password_reset_tokens
      for each row execute function enforce_account_security_scope();

    insert into permissions (code, description) values
      ('orders.create', 'Create an Order'),
      ('orders.edit_before_processing', 'Edit an Order before processing begins'),
      ('orders.assign_driver', 'Assign or reassign an Order Driver'),
      ('orders.update_delivery_status', 'Update an Order delivery status'),
      ('orders.override_service_fee', 'Enter or override an Order service fee with audit reason'),
      ('reconciliations.create', 'Create a Driver reconciliation'),
      ('reconciliations.reverse', 'Reverse a confirmed Driver reconciliation'),
      ('settlements.create', 'Create a Trader settlement'),
      ('settlements.reverse', 'Reverse a confirmed Trader settlement'),
      ('journals.create_manual', 'Create a manual journal'),
      ('financial_transactions.reverse', 'Reverse a confirmed financial transaction'),
      ('reports.financial.view', 'View profit and loss and trial balance reports'),
      ('users_roles.manage', 'Manage Company users and roles'),
      ('reports.export', 'Export authorized reports')
    on conflict (code) do nothing;
  `.execute(database);
}
