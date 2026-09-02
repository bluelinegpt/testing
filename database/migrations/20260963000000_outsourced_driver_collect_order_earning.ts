import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * A Collect Order never reaches `delivered` -- its only path to completion
 * is `collect_order -> closed` -- so it was invisible to every existing
 * Outsourced Driver earning mechanism: `evaluateOrder()`'s delivery-fee
 * accrual hard-filters on `delivery_status='delivered'`, and
 * `createForConfirmedCollection()` fires only from a confirmed Driver Cash
 * Reconciliation. An Employee assigned to a Collect Order already earns on
 * close, via `capture_employee_collect_order_earning` -- an Outsourced
 * Driver assigned to the identical Collect Order earned nothing at all.
 *
 * This adds the missing third `earning_type` to the existing accrual
 * ledger (`outsourced_driver_fee_accruals`), reusing
 * `outsourced_driver_collection_earning_rules` for the rate -- the same
 * design choice the Employee side already makes: one "collection earning"
 * rate governs both a confirmed cash reconciliation AND a closed Collect
 * Order, rather than a second, parallel rate table.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table outsourced_driver_fee_accruals
      drop constraint outsourced_driver_fee_accruals_earning_type_check;
    alter table outsourced_driver_fee_accruals
      add constraint outsourced_driver_fee_accruals_earning_type_check
      check (earning_type = any(array['delivery','collection','collect_order']));

    alter table outsourced_driver_fee_accruals
      drop constraint outsourced_driver_fee_accruals_source_shape_check;
    alter table outsourced_driver_fee_accruals
      add constraint outsourced_driver_fee_accruals_source_shape_check check (
        (earning_type='delivery' and order_id is not null and delivery_date is not null
          and fee_rate_version_id is not null and reconciliation_id is null
          and collection_rule_id is null and unit_count=1)
        or (earning_type='collection' and order_id is null and delivery_date is null
          and fee_rate_version_id is null and reconciliation_id is not null
          and collection_rule_id is not null and unit_count>0)
        or (earning_type='collect_order' and order_id is not null and delivery_date is null
          and fee_rate_version_id is null and reconciliation_id is null
          and collection_rule_id is not null and unit_count=1)
      );

    alter table outsourced_driver_fee_accruals
      drop constraint outsourced_driver_fee_accruals_source_check;
    alter table outsourced_driver_fee_accruals
      add constraint outsourced_driver_fee_accruals_source_check
      check (accrual_source = any(array['delivery','daily_reconciliation','authorized_backfill','collect_order']));

    create or replace function validate_outsourced_driver_fee_accrual() returns trigger language plpgsql as $$
    declare
      order_driver_id uuid; order_delivery_status text; order_delivered_at timestamptz;
      order_type_value text;
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
      elsif new.earning_type='collect_order' then
        select o.assigned_driver_id,o.delivery_status,o.order_type
          into order_driver_id,order_delivery_status,order_type_value
          from orders o where o.id=new.order_id and o.company_id=new.company_id;
        if order_driver_id is null or order_driver_id<>new.driver_id
          or order_delivery_status<>'closed' or order_type_value<>'collect_order' then
          raise exception 'Collect Order earning accrual source does not match a closed Collect Order';
        end if;
        if not exists(select 1 from outsourced_driver_collection_earning_rules r
          where r.id=new.collection_rule_id and r.company_id=new.company_id and r.driver_id=new.driver_id
            and r.is_active and r.collection_payment_type<>'none'
            and r.effective_from<=new.accrual_business_date
            and (r.effective_to is null or new.accrual_business_date<r.effective_to)
            and r.amount=new.fee_rate_snapshot) then
          raise exception 'Collection-rate snapshot must be effective for the Driver and business date';
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

    create function capture_outsourced_collect_order_earning() returns trigger language plpgsql as $$
    declare
      matched_driver_id uuid; matched_rule_id uuid; matched_amount numeric(18,2); matched_date date;
    begin
      if new.order_type='collect_order' and new.delivery_status='closed'
         and old.delivery_status='collect_order' and new.assigned_driver_id is not null then
        select d.id into matched_driver_id from drivers d
         where d.id=new.assigned_driver_id and d.company_id=new.company_id and d.driver_type='outsourced';
        if matched_driver_id is not null then
          select (new.closed_at at time zone coalesce(cs.timezone,'Asia/Dubai'))::date
            into matched_date
            from company_settings cs where cs.company_id=new.company_id;
          matched_date := coalesce(matched_date, (new.closed_at at time zone 'Asia/Dubai')::date);
          select r.id,r.amount into matched_rule_id,matched_amount
            from outsourced_driver_collection_earning_rules r
           where r.company_id=new.company_id and r.driver_id=matched_driver_id and r.is_active
             and r.collection_payment_type<>'none'
             and r.effective_from<=matched_date
             and (r.effective_to is null or matched_date<r.effective_to)
           order by r.effective_from desc limit 1;
          if matched_rule_id is not null then
            insert into outsourced_driver_fee_accruals(
              company_id,driver_id,order_id,accrual_business_date,fee_rate_snapshot,earned_amount,
              paid_amount,outstanding_amount,status,accrual_source,earning_type,collection_rule_id,unit_count
            ) values(
              new.company_id,matched_driver_id,new.id,matched_date,matched_amount,matched_amount,
              0,matched_amount,'accrued','collect_order','collect_order',matched_rule_id,1
            )
            on conflict(company_id,order_id) where order_id is not null do nothing;
          end if;
        end if;
      end if;
      return new;
    end $$;
    create trigger orders_outsourced_collect_order_earning_capture after update of delivery_status on orders
      for each row execute function capture_outsourced_collect_order_earning();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (select 1 from outsourced_driver_fee_accruals where earning_type='collect_order') then
        raise exception 'Cannot restore the narrower accrual shape while a Collect Order earning accrual exists';
      end if;
    end $$;

    drop trigger if exists orders_outsourced_collect_order_earning_capture on orders;
    drop function if exists capture_outsourced_collect_order_earning();

    alter table outsourced_driver_fee_accruals
      drop constraint outsourced_driver_fee_accruals_source_check;
    alter table outsourced_driver_fee_accruals
      add constraint outsourced_driver_fee_accruals_source_check
      check (accrual_source = any(array['delivery','daily_reconciliation','authorized_backfill']));

    alter table outsourced_driver_fee_accruals
      drop constraint outsourced_driver_fee_accruals_source_shape_check;
    alter table outsourced_driver_fee_accruals
      add constraint outsourced_driver_fee_accruals_source_shape_check check (
        (earning_type='delivery' and order_id is not null and delivery_date is not null
          and fee_rate_version_id is not null and reconciliation_id is null
          and collection_rule_id is null and unit_count=1)
        or (earning_type='collection' and order_id is null and delivery_date is null
          and fee_rate_version_id is null and reconciliation_id is not null
          and collection_rule_id is not null and unit_count>0)
      );

    alter table outsourced_driver_fee_accruals
      drop constraint outsourced_driver_fee_accruals_earning_type_check;
    alter table outsourced_driver_fee_accruals
      add constraint outsourced_driver_fee_accruals_earning_type_check
      check (earning_type = any(array['delivery','collection']));

    create or replace function validate_outsourced_driver_fee_accrual() returns trigger language plpgsql as $$
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
