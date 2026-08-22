import { sql } from "kysely";
import type { Kysely } from "kysely";

type MigrationDatabase = Record<string, unknown>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_customer_quote_requests
      add column if not exists assigned_company_id uuid references companies(id) on delete restrict,
      add column if not exists converted_order_id uuid references orders(id) on delete restrict,
      add column if not exists delivery_fee_amount numeric(12,2),
      add column if not exists platform_fee_amount numeric(12,2),
      add column if not exists converted_by_account_id uuid references accounts(id) on delete set null,
      add column if not exists converted_at timestamptz;

    alter table platform_customer_quote_requests
      add constraint platform_customer_quote_delivery_fee_nonnegative
        check (delivery_fee_amount is null or delivery_fee_amount >= 0),
      add constraint platform_customer_quote_platform_fee_nonnegative
        check (platform_fee_amount is null or platform_fee_amount >= 0),
      add constraint platform_customer_quote_conversion_complete
        check (
          converted_order_id is null
          or (
            assigned_company_id is not null
            and delivery_fee_amount is not null
            and platform_fee_amount is not null
            and converted_at is not null
          )
        );

    create unique index if not exists platform_customer_quote_converted_order_unique
      on platform_customer_quote_requests(converted_order_id)
      where converted_order_id is not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists platform_customer_quote_converted_order_unique;
    alter table platform_customer_quote_requests
      drop constraint if exists platform_customer_quote_conversion_complete,
      drop constraint if exists platform_customer_quote_platform_fee_nonnegative,
      drop constraint if exists platform_customer_quote_delivery_fee_nonnegative,
      drop column if exists converted_at,
      drop column if exists converted_by_account_id,
      drop column if exists platform_fee_amount,
      drop column if exists delivery_fee_amount,
      drop column if exists converted_order_id,
      drop column if exists assigned_company_id;
  `.execute(database);
}
