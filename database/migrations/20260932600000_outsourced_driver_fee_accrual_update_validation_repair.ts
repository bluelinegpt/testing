import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function validate_outsourced_driver_fee_accrual()
    returns trigger language plpgsql as $$
    declare
      order_driver_id uuid; order_delivery_status text; order_delivered_at timestamptz;
      reconciliation_driver_id uuid; reconciliation_status text; reconciliation_date date;
    begin
      if tg_op = 'UPDATE' then
        return new;
      end if;
      if not exists(select 1 from drivers d where d.id=new.driver_id and d.company_id=new.company_id
        and d.driver_type='outsourced') then
        raise exception 'Fee accruals require an Outsourced Driver in the same Company';
      end if;
      if new.earning_type='delivery' then
        select o.assigned_driver_id,o.delivery_status,o.delivered_at
          into order_driver_id,order_delivery_status,order_delivered_at
          from orders o where o.id=new.order_id and o.company_id=new.company_id;
        if order_driver_id is null or order_driver_id<>new.driver_id
          or order_delivery_status<>'delivered' or order_delivered_at is null
          or order_delivered_at<>new.delivery_date then
          raise exception 'Delivery fee accrual source does not match the delivered Order';
        end if;
        if not exists(select 1 from outsourced_driver_fee_versions v
          where v.id=new.fee_rate_version_id and v.company_id=new.company_id
            and v.driver_id=new.driver_id and v.status in('active','superseded')
            and v.effective_from<=new.accrual_business_date
            and coalesce(v.effective_to,'infinity'::date)>=new.accrual_business_date
            and v.fee_per_order=new.fee_rate_snapshot) then
          raise exception 'Fee-rate snapshot must be effective for the Driver and accrual business date';
        end if;
      else
        select r.driver_id,r.status,r.business_date into reconciliation_driver_id,reconciliation_status,reconciliation_date
          from driver_reconciliations r where r.id=new.reconciliation_id and r.company_id=new.company_id;
        if reconciliation_driver_id is null or reconciliation_driver_id<>new.driver_id
          or reconciliation_status<>'confirmed' or reconciliation_date<>new.accrual_business_date then
          raise exception 'Collection earning accrual source does not match the confirmed reconciliation';
        end if;
        if not exists(select 1 from outsourced_driver_collection_earning_rules r
          where r.id=new.collection_rule_id and r.company_id=new.company_id and r.driver_id=new.driver_id
            and r.is_active and r.collection_payment_type<>'none'
            and r.effective_from<=new.accrual_business_date
            and (r.effective_to is null or new.accrual_business_date<r.effective_to)
            and r.amount=new.fee_rate_snapshot) then
          raise exception 'Collection-rate snapshot must be effective for the Driver and business date';
        end if;
      end if;
      return new;
    end $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  void database;
  throw new Error(
    "This financial trigger repair is forward-only; restore the verified pre-migration backup instead",
  );
}
