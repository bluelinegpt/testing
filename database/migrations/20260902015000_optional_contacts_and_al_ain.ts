import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Optional Order/Trader contacts plus the approved Al Ain operational geography. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table emirates disable trigger emirates_immutable;

    update emirates set display_order=109 where code='OAA';
    update emirates set display_order=110 where code='EST';

    update emirates
       set name_en = 'Out of Al Ain', updated_at = now()
     where code = 'OAA';

    insert into emirates(code,name_en,name_ar,display_order,is_active)
    values('AAN','AL Ain','العين',9,true)
    on conflict(code) do update set name_en=excluded.name_en,name_ar=excluded.name_ar,is_active=true;

    update emirates set display_order=10 where code='OAA';
    update emirates set display_order=11 where code='EST';

    alter table emirates enable trigger emirates_immutable;

    insert into areas(company_id,code,name_en,name_ar,emirate_id,is_active)
    select c.id,'AAN-ALL','All Areas','جميع المناطق',e.id,true
      from companies c join emirates e on e.code='AAN'
     where not exists(select 1 from areas a where a.company_id=c.id and a.emirate_id=e.id
       and lower(btrim(a.name_en))='all areas');

    alter table traders drop constraint traders_mobile_nonempty;
    alter table traders alter column mobile_number drop not null;

    create or replace function validate_trader_mobile_change() returns trigger language plpgsql as $$
    begin
      if new.mobile_number is not null
         and (tg_op = 'INSERT' or new.mobile_number is distinct from old.mobile_number)
         and new.mobile_number !~ '^9715[0-9]{8}$' then
        raise exception using errcode = '23514',
          message = 'Enter the mobile number in the format 9715XXXXXXXX.';
      end if;
      if new.second_mobile_number is not null
         and (tg_op = 'INSERT' or new.second_mobile_number is distinct from old.second_mobile_number)
         and new.second_mobile_number !~ '^9715[0-9]{8}$' then
        raise exception using errcode = '23514',
          message = 'Enter the second mobile number in the format 9715XXXXXXXX.';
      end if;
      return new;
    end $$;

    alter table orders drop constraint orders_customer_provenance_check;
    alter table orders add constraint orders_customer_provenance_check check (
      (customer_provenance_status='legacy_unattributed' and customer_id is null
        and customer_address_id is null and customer_code_snapshot is null
        and customer_reference_snapshot is null and customer_area_code_snapshot is null
        and customer_area_name_snapshot is null and customer_location_link_snapshot is null
        and customer_delivery_notes_snapshot is null)
      or
      (customer_provenance_status='resolved' and customer_id is not null
        and customer_address_id is not null and customer_code_snapshot is not null
        and customer_area_code_snapshot is not null and customer_area_name_snapshot is not null
        and btrim(customer_code_snapshot)<>'' and btrim(customer_area_code_snapshot)<>''
        and btrim(customer_area_name_snapshot)<>'')
      or
      (customer_provenance_status='not_applicable' and customer_id is null
        and customer_address_id is null and customer_code_snapshot is null
        and customer_reference_snapshot is null and customer_area_code_snapshot is null
        and customer_area_name_snapshot is null and customer_area_name_ar_snapshot is null
        and area_name_fallback_used is null and customer_location_link_snapshot is null
        and customer_delivery_notes_snapshot is null)
    );

    alter table orders drop constraint orders_prospective_financial_model_check;
    alter table orders add constraint orders_prospective_financial_model_check check(
      financial_model_version is null or(
        financial_model_version='trader_deduction_v1' and serial_number is not null and btrim(serial_number)<>''
        and serial_number_normalized is not null and btrim(serial_number_normalized)<>''
        and ((reference_number is null and reference_number_normalized is null) or(reference_number is not null
          and btrim(reference_number)<>'' and reference_number_normalized is not null and btrim(reference_number_normalized)<>''))
        and service_fee_net_amount>=0 and service_fee_vat_amount>=0 and additional_fees>=0 and additional_fee_vat_amount>=0
        and total_deductions=service_fee_net_amount+service_fee_vat_amount+additional_fees+additional_fee_vat_amount
        and customer_amount_due=cod_amount and trader_gross_payable=cod_amount
        and trader_paid_service_fee=service_fee_net_amount+service_fee_vat_amount
        and trader_deductions=additional_fees+additional_fee_vat_amount and trader_net_payable=cod_amount-total_deductions
        and vat_amount=service_fee_vat_amount+additional_fee_vat_amount
        and payment_condition='customer_pays_cod_trader_pays_fee' and vat_enabled_snapshot is not null
        and vat_rate_snapshot between 0 and 100 and ((vat_enabled_snapshot and vat_price_mode_snapshot in('inclusive','exclusive'))
          or(not vat_enabled_snapshot and vat_price_mode_snapshot is null))
        and (area_name_fallback_used is not null or customer_provenance_status='not_applicable')
      )
    );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$ begin
      if exists(select 1 from traders where mobile_number is null) then
        raise exception 'Cannot restore mandatory Trader mobile while mobile-free Traders exist';
      end if;
      if exists(select 1 from orders where customer_provenance_status='not_applicable' and order_type<>'collect_order') then
        raise exception 'Cannot restore mandatory delivery Customers while customer-free Orders exist';
      end if;
    end $$;
    alter table traders alter column mobile_number set not null;
    alter table traders add constraint traders_mobile_nonempty check(btrim(mobile_number)<>'');
    alter table emirates disable trigger emirates_immutable;
    update emirates set is_active=false,display_order=109 where code='AAN';
    update emirates set name_en='Outskirts of Al Ain',display_order=9,updated_at=now() where code='OAA';
    update emirates set display_order=10 where code='EST';
    alter table emirates enable trigger emirates_immutable;
  `.execute(database);
}
