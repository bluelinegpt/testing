import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Immutable Employee Driver earning calculation envelopes. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`create extension if not exists btree_gist;
    create table employee_driver_earning_periods(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      employee_id uuid not null,
      driver_id uuid not null,
      date_from date not null,
      date_to date not null,
      status text not null default 'locked',
      delivered_order_count integer not null,
      collected_order_count integer not null,
      delivery_earnings numeric(18,2) not null,
      collection_rate_snapshot numeric(18,2) not null,
      collection_earnings numeric(18,2) not null,
      total_earnings numeric(18,2) not null,
      total_paid numeric(18,2) not null default 0,
      calculated_by_account_id uuid not null references accounts(id) on delete restrict,
      calculated_at timestamptz not null default now(),
      locked_at timestamptz not null default now(),
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version integer not null default 1,
      unique(id,company_id),
      foreign key(employee_id,company_id) references employees(id,company_id) on delete restrict,
      foreign key(driver_id,company_id) references drivers(id,company_id) on delete restrict,
      check(date_to>=date_from),
      check(status in('locked','partially_paid','paid','reversed')),
      check(delivered_order_count>=0 and collected_order_count>=0),
      check(delivery_earnings>=0 and collection_rate_snapshot>=0 and collection_earnings>=0),
      check(total_earnings=delivery_earnings+collection_earnings),
      check(total_paid>=0 and total_paid<=total_earnings)
    );
    alter table employee_driver_earning_periods add constraint employee_driver_earning_periods_no_overlap
      exclude using gist(company_id with =,employee_id with =,daterange(date_from,date_to,'[]') with &&)
      where(status<>'reversed');
    create index employee_driver_earning_periods_history_idx
      on employee_driver_earning_periods(company_id,employee_id,date_from desc,date_to desc);

    create table employee_driver_earning_period_delivery_sources(
      company_id uuid not null references companies(id) on delete restrict,
      period_id uuid not null,
      employee_order_earning_id uuid not null,
      earning_amount_snapshot numeric(18,2) not null,
      primary key(company_id,period_id,employee_order_earning_id),
      unique(company_id,employee_order_earning_id),
      foreign key(period_id,company_id) references employee_driver_earning_periods(id,company_id) on delete restrict,
      foreign key(employee_order_earning_id,company_id) references employee_order_earnings(id,company_id) on delete restrict,
      check(earning_amount_snapshot>0)
    );
    create index employee_driver_earning_period_sources_earning_idx
      on employee_driver_earning_period_delivery_sources(company_id,employee_order_earning_id);

    create function employee_driver_earning_period_immutable() returns trigger language plpgsql as $$
    begin
      if old.date_from<>new.date_from or old.date_to<>new.date_to
        or old.delivered_order_count<>new.delivered_order_count
        or old.collected_order_count<>new.collected_order_count
        or old.delivery_earnings<>new.delivery_earnings
        or old.collection_rate_snapshot<>new.collection_rate_snapshot
        or old.collection_earnings<>new.collection_earnings
        or old.total_earnings<>new.total_earnings then
        raise exception using errcode='23514',message='employee_driver_earning_period_locked';
      end if;
      return new;
    end $$;
    create trigger employee_driver_earning_period_immutable_guard before update on employee_driver_earning_periods
      for each row execute function employee_driver_earning_period_immutable();`.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop trigger if exists employee_driver_earning_period_immutable_guard on employee_driver_earning_periods;
    drop function if exists employee_driver_earning_period_immutable();
    drop table if exists employee_driver_earning_period_delivery_sources;
    drop table if exists employee_driver_earning_periods;`.execute(database);
}
