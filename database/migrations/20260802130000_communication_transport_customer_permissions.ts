import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

const communicationPermissions = [
  ["communication.trader.read", "View Trader to Office conversations"],
  ["communication.trader.send", "Send messages in Trader to Office conversations"],
  ["communication.driver.read", "View Driver to Office conversations"],
  ["communication.driver.send", "Send messages in Driver to Office conversations"],
  ["communication.customer.read", "View Customer to Office conversations"],
  ["communication.customer.send", "Send messages in Customer to Office conversations"],
  ["communication.operator.read", "View Office communication queue"],
  ["communication.operator.send", "Send Office communication replies"],
  ["communication.operator.assign", "Assign Office conversations"],
  ["communication.operator.priority", "Change Office conversation priority"],
  ["communication.operator.resolve", "Resolve Office conversations"],
  ["communication.operator.reopen", "Reopen Office conversations"],
] as const;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values ${sql.join(
      communicationPermissions.map(([code, description]) => sql`(${code}, ${description})`),
    )}
    on conflict (code) do update set description = excluded.description;
  `.execute(database);

  await sql`
    insert into role_permissions (role_id, permission_code)
    select distinct rp.role_id, p.code
      from role_permissions rp
      join permissions p on p.code like 'communication.%'
     where rp.permission_code = 'users_roles.manage'
    on conflict (role_id, permission_code) do nothing;
  `.execute(database);

  await sql`
    create table customer_messaging_sessions (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      order_id uuid not null,
      customer_id uuid,
      tracking_token_id uuid not null,
      token_hash text not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      last_seen_at timestamptz,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, token_hash),
      constraint customer_messaging_sessions_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
      constraint customer_messaging_sessions_expiry_check check (expires_at > created_at),
      constraint customer_messaging_sessions_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint customer_messaging_sessions_customer_fk foreign key (customer_id, company_id)
        references customers(id, company_id) on delete restrict,
      constraint customer_messaging_sessions_tracking_fk foreign key (tracking_token_id, company_id)
        references tracking_tokens(id, company_id) on delete restrict
    );

    create index customer_messaging_sessions_order_index
      on customer_messaging_sessions (company_id, order_id, expires_at desc);
    create index customer_messaging_sessions_active_index
      on customer_messaging_sessions (company_id, token_hash)
      where revoked_at is null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table if exists customer_messaging_sessions;
    delete from role_permissions where permission_code like 'communication.%';
    delete from permissions where code like 'communication.%';
  `.execute(database);
}
