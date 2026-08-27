import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Approved geography, Collect Orders, immutable earning sources and serial history. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into emirates(code,name_en,name_ar,display_order) values
      ('WST','Western Region','الغربيه',8),
      ('OAA','Outskirts of Al Ain','اطراف العين',9),
      ('EST','Eastern Regions','المناطق الشرقيه',10)
    on conflict(code) do nothing;

    insert into areas(company_id,code,name_en,name_ar,emirate_id,is_active)
    select c.id, e.code||'-ALL','All Areas','جميع المناطق',e.id,true
      from companies c cross join emirates e
     where e.code in('WST','OAA','EST')
       and not exists(select 1 from areas a where a.company_id=c.id and a.emirate_id=e.id
         and lower(btrim(a.name_en))='all areas');

    alter table orders add column order_type text not null default 'delivery';
    alter table orders add constraint orders_order_type_check check(order_type in('delivery','collect_order'));
    alter table orders add constraint orders_collect_order_financial_check check(
      order_type<>'collect_order' or (
        cod_amount=0 and service_fee=0 and service_fee_net_amount=0 and service_fee_vat_amount=0
        and additional_fees=0 and additional_fee_vat_amount=0 and total_deductions=0
        and customer_amount_due=0 and trader_gross_payable=0 and trader_paid_service_fee=0
        and trader_deductions=0 and trader_net_payable=0 and driver_cost=0 and vat_amount=0
        and company_revenue=0 and order_profit=0 and driver_reconciliation_status='not_applicable'
        and trader_settlement_status='not_eligible' and not is_free_order
      )
    );
    create index orders_company_type_status_index on orders(company_id,order_type,delivery_status);

    alter table orders drop constraint orders_delivery_status_check;
    alter table orders add constraint orders_delivery_status_check check(delivery_status in(
      'new','in_branch','assigned_to_driver','out_for_delivery','hold','delivered',
      'returned_to_branch','returned_to_trader','cancelled','closed','collect_order'));
    create or replace function is_valid_order_status_value(status_dimension_value text,status_value text)
      returns boolean language sql immutable strict parallel safe as $$
      select case status_dimension_value
        when 'delivery' then status_value in('new','processing','assigned','returned','in_branch',
          'assigned_to_driver','out_for_delivery','hold','delivered','returned_to_branch',
          'returned_to_trader','cancelled','closed','collect_order')
        when 'driver_reconciliation' then status_value in('not_applicable','pending','reconciled','reversed')
        when 'trader_settlement' then status_value in('not_eligible','unsettled','partially_settled','settled',
          'money_sent_to_trader','money_received_by_trader','reversed')
        when 'return' then status_value in('not_applicable','returned_to_branch','returned_to_trader')
        when 'accounting' then status_value in('unposted','posted','reversed') else false end
    $$;

    create table employee_collect_order_earnings(
      id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete restrict,
      employee_id uuid not null, driver_id uuid not null, order_id uuid not null, rule_id uuid,
      closed_at timestamptz not null, rate_snapshot numeric(18,2) not null,
      earned_amount numeric(18,2) not null, earning_period_id uuid,
      created_at timestamptz not null default now(), unique(id,company_id),unique(company_id,order_id),
      foreign key(employee_id,company_id) references employees(id,company_id) on delete restrict,
      foreign key(driver_id,company_id) references drivers(id,company_id) on delete restrict,
      foreign key(order_id,company_id) references orders(id,company_id) on delete restrict,
      foreign key(rule_id,company_id) references employee_collection_earning_rules(id,company_id) on delete restrict,
      foreign key(earning_period_id,company_id) references employee_driver_earning_periods(id,company_id) on delete restrict,
      check(rate_snapshot>=0 and earned_amount=rate_snapshot)
    );
    create index employee_collect_order_earnings_period_index
      on employee_collect_order_earnings(company_id,employee_id,closed_at) where earning_period_id is null;

    create function capture_employee_collect_order_earning() returns trigger language plpgsql as $$
    begin
      if new.order_type='collect_order' and new.delivery_status='closed'
         and old.delivery_status='collect_order' and new.assigned_driver_id is not null then
        insert into employee_collect_order_earnings(
          company_id,employee_id,driver_id,order_id,rule_id,closed_at,rate_snapshot,earned_amount)
        select new.company_id,d.employee_id,d.id,new.id,r.id,new.closed_at,r.amount,r.amount
          from drivers d
          join company_settings cs on cs.company_id=d.company_id
          join lateral(select x.id,x.amount from employee_collection_earning_rules x
            where x.company_id=d.company_id and x.employee_id=d.employee_id and x.is_active
              and x.collection_payment_type in('per_collected_order','flat_per_confirmed_collection')
              and x.effective_from<=(new.closed_at at time zone coalesce(cs.timezone,'Asia/Dubai'))::date
              and (x.effective_to is null or (new.closed_at at time zone coalesce(cs.timezone,'Asia/Dubai'))::date<x.effective_to)
            order by x.effective_from desc limit 1) r on true
         where d.id=new.assigned_driver_id and d.company_id=new.company_id
           and d.driver_type='employee' and d.employee_id is not null
        on conflict(company_id,order_id) where order_id is not null do nothing;
      end if;
      return new;
    end $$;
    create trigger orders_collect_order_earning_capture after update of delivery_status on orders
      for each row execute function capture_employee_collect_order_earning();

    create table order_serial_history(
      id uuid primary key default gen_random_uuid(),company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,old_serial_number text,old_serial_date date not null,new_serial_number text not null,
      new_serial_date date not null,old_status text not null,new_status text not null,reason text not null,
      changed_by_account_id uuid not null,changed_at timestamptz not null default now(),unique(id,company_id),
      foreign key(order_id,company_id) references orders(id,company_id) on delete restrict,
      foreign key(changed_by_account_id,company_id) references accounts(id,company_id) on delete restrict,
      check(btrim(new_serial_number)<>'' and btrim(reason)<>'')
    );
    create index order_serial_history_order_index on order_serial_history(company_id,order_id,changed_at);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists orders_collect_order_earning_capture on orders;
    drop function if exists capture_employee_collect_order_earning();
    drop table if exists order_serial_history;
    drop table if exists employee_collect_order_earnings;
    drop index if exists orders_company_type_status_index;
    alter table orders drop constraint if exists orders_collect_order_financial_check;
    alter table orders drop constraint if exists orders_order_type_check;
    alter table orders drop column if exists order_type;
  `.execute(database);
}
