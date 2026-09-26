import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

const declaration = `create or replace function capture_order_accounting_event() returns trigger language plpgsql as $function$`;

const customerFundedOrderCapture = `
declare
  accounting_impact numeric(18,2);
begin
  if new.delivery_status='delivered'
     and old.delivery_status is distinct from 'delivered' then
    accounting_impact :=
      abs(coalesce(new.customer_amount_due, 0))
      + abs(coalesce(new.trader_net_payable, 0));
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
`;

/**
 * Order-delivered events should only cover money that balances inside the
 * Order itself: Customer receivable and Trader payable. Service fees owed by
 * the Trader when COD is zero are posted by Trader Receivables instead.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql.raw(`${declaration}${customerFundedOrderCapture}$function$;`).execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql.raw(`${declaration}
declare
  accounting_impact numeric(18,2);
begin
  if new.delivery_status='delivered'
     and old.delivery_status is distinct from 'delivered' then
    accounting_impact :=
      abs(coalesce(new.cod_amount, 0))
      + abs(coalesce(new.service_fee, 0))
      + abs(coalesce(new.additional_fees, 0))
      + abs(coalesce(new.vat_amount, 0));
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
$function$;`).execute(database);
}
