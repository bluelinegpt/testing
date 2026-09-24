import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql
    .raw(
      `
    create or replace function capture_order_accounting_event() returns trigger language plpgsql as $function$
    declare accounting_impact numeric(18,2);
    begin
      if new.delivery_status='delivered' and old.delivery_status is distinct from 'delivered' then
        accounting_impact := abs(coalesce(new.customer_amount_due,0))+abs(coalesce(new.trader_net_payable,0));
        if accounting_impact <> 0 then
          perform enqueue_operational_accounting_event(
            new.company_id,'orders','order_delivered','order',new.id,new.order_number,
            coalesce((new.delivered_at at time zone 'Asia/Dubai')::date,new.order_date),
            new.created_by_account_id,'order-delivery:'||new.id::text
          );
        end if;
      elsif old.delivery_status='delivered'
        and new.delivery_status in ('out_for_delivery','returned_to_trader','cancelled') then
        perform enqueue_operational_accounting_event(
          new.company_id,'orders','order_recognition_reversed','order',new.id,new.order_number,
          (now() at time zone 'Asia/Dubai')::date,new.created_by_account_id,
          'order-reversal:'||new.id::text,'order',new.id
        );
      end if;
      return new;
    end;
    $function$;
  `,
    )
    .execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql
    .raw(
      `
    create or replace function capture_order_accounting_event() returns trigger language plpgsql as $function$
    declare accounting_impact numeric(18,2);
    begin
      if new.delivery_status='delivered' and old.delivery_status is distinct from 'delivered' then
        accounting_impact := abs(coalesce(new.customer_amount_due,0))+abs(coalesce(new.trader_net_payable,0));
        if accounting_impact <> 0 then
          perform enqueue_operational_accounting_event(
            new.company_id,'orders','order_delivered','order',new.id,new.order_number,
            coalesce((new.delivered_at at time zone 'Asia/Dubai')::date,new.order_date),
            new.created_by_account_id,'order-delivery:'||new.id::text
          );
        end if;
      elsif old.delivery_status='delivered'
        and new.delivery_status in ('returned_to_trader','cancelled') then
        perform enqueue_operational_accounting_event(
          new.company_id,'orders','order_recognition_reversed','order',new.id,new.order_number,
          (now() at time zone 'Asia/Dubai')::date,new.created_by_account_id,
          'order-reversal:'||new.id::text,'order',new.id
        );
      end if;
      return new;
    end;
    $function$;
  `,
    )
    .execute(database);
}
