import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Trader settlement is only money payable to a Trader. If an Order's Trader-paid
 * fees exceed COD, the Trader owes the Company money; that belongs in Trader
 * Receivables, linked back to the Order, never as a negative settlement row.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders drop constraint if exists orders_prospective_financial_model_check;
    alter table orders add constraint orders_prospective_financial_model_check check (
      financial_model_version is null or (
        financial_model_version = 'trader_deduction_v1'
        and serial_number is not null and btrim(serial_number) <> ''
        and serial_number_normalized is not null and btrim(serial_number_normalized) <> ''
        and (
          (reference_number is null and reference_number_normalized is null)
          or (
            reference_number is not null and btrim(reference_number) <> ''
            and reference_number_normalized is not null and btrim(reference_number_normalized) <> ''
          )
        )
        and service_fee_net_amount >= 0 and service_fee_vat_amount >= 0
        and additional_fees >= 0 and additional_fee_vat_amount >= 0
        and vat_amount = service_fee_vat_amount + additional_fee_vat_amount
        and (
          (
            payment_condition = 'customer_pays_cod_trader_pays_fee'
            and total_deductions = service_fee_net_amount + service_fee_vat_amount + additional_fees + additional_fee_vat_amount
            and customer_amount_due = cod_amount
            and trader_gross_payable = cod_amount
            and trader_paid_service_fee = service_fee_net_amount + service_fee_vat_amount
            and trader_deductions = additional_fees + additional_fee_vat_amount
            and trader_net_payable = greatest(cod_amount - total_deductions, 0)
          )
          or (
            payment_condition = 'customer_pays_cod_and_fee'
            and customer_amount_due = case
              when cod_amount > 0 then cod_amount
              else service_fee_net_amount + service_fee_vat_amount + additional_fees + additional_fee_vat_amount
            end
            and trader_gross_payable = cod_amount
            and trader_paid_service_fee = case
              when cod_amount > 0 then service_fee_net_amount + service_fee_vat_amount
              else 0
            end
            and trader_deductions = case
              when cod_amount > 0 then additional_fees + additional_fee_vat_amount
              else 0
            end
            and total_deductions = case
              when cod_amount > 0 then service_fee_net_amount + service_fee_vat_amount + additional_fees + additional_fee_vat_amount
              else 0
            end
            and trader_net_payable = greatest(cod_amount - total_deductions, 0)
          )
        )
        and vat_enabled_snapshot is not null
        and vat_rate_snapshot between 0 and 100
        and (
          (vat_enabled_snapshot and vat_price_mode_snapshot in ('inclusive', 'exclusive'))
          or (not vat_enabled_snapshot and vat_price_mode_snapshot is null)
        )
        and (area_name_fallback_used is not null or customer_provenance_status = 'not_applicable')
      )
    ) not valid;

    alter table orders drop constraint if exists orders_nonnegative_amounts;
    alter table orders add constraint orders_nonnegative_amounts check (
      cod_amount >= 0 and service_fee >= 0
      and customer_charges >= 0 and customer_credits_refunds >= 0 and customer_amount_due >= 0
      and amount_collected >= 0 and trader_gross_payable >= 0 and trader_paid_service_fee >= 0
      and trader_deductions >= 0 and trader_charges >= 0 and trader_net_payable >= 0
      and driver_cost >= 0 and return_driver_fee >= 0 and order_expenses_total >= 0
      and company_other_charges >= 0 and vat_amount >= 0
    ) not valid;

    alter table orders drop constraint if exists orders_trader_paid_amount_range;
    alter table orders add constraint orders_trader_paid_amount_range check (
      trader_paid_amount >= 0 and trader_paid_amount <= trader_net_payable
    ) not valid;

    insert into company_reference_counters (company_id, reference_type, next_value, prefix)
    select distinct company_id, 'trader_receivable', 1, 'RCV'
      from orders
     where trader_net_payable < 0
    on conflict (company_id, reference_type) do nothing;

    with negative_orders as (
      select o.id, o.company_id, o.order_number, o.order_date, o.trader_id,
             o.created_by_account_id, abs(o.trader_net_payable) as amount_due,
             row_number() over (partition by o.company_id order by o.order_date, o.order_number, o.id) as rn
        from orders o
       where o.trader_net_payable < 0
         and not exists (
           select 1
             from trader_receivables r
            where r.company_id = o.company_id
              and r.source_type = 'service_charge'
              and r.source_reference = o.order_number
              and r.reason = 'Order service fee owed by Trader'
         )
    ), counters as (
      select company_id, next_value, prefix
        from company_reference_counters
       where reference_type = 'trader_receivable'
    ), inserted as (
      insert into trader_receivables (
        company_id, receivable_number, trader_id, source_type, source_reference,
        business_date, original_amount_due, amount_collected, status, reason, notes,
        created_by_account_id
      )
      select n.company_id,
             c.prefix || '-' || lpad((c.next_value + n.rn - 1)::text, 6, '0'),
             n.trader_id,
             'service_charge',
             n.order_number,
             n.order_date,
             n.amount_due,
             0,
             'outstanding',
             'Order service fee owed by Trader',
             'Created automatically while moving negative Trader settlement balances into Trader Receivables.',
             n.created_by_account_id
        from negative_orders n
        join counters c on c.company_id = n.company_id
      returning company_id
    ), inserted_counts as (
      select company_id, count(*)::int as count_inserted
        from inserted
       group by company_id
    )
    update company_reference_counters c
       set next_value = c.next_value + ic.count_inserted,
           updated_at = now()
      from inserted_counts ic
     where c.company_id = ic.company_id
       and c.reference_type = 'trader_receivable';

    update orders
       set trader_net_payable = 0,
           trader_settlement_status = 'not_eligible',
           updated_at = now(),
           version = version + 1
     where trader_net_payable < 0;

    -- The update above fires orders_assignment_consistency, a deferred
    -- constraint trigger on orders (deferrable initially deferred). Kysely
    -- runs every pending migration in one transaction, so without flushing
    -- it here, the next migration's ALTER TABLE on orders fails with
    -- "cannot ALTER TABLE because it has pending trigger events" (55006).
    set constraints all immediate;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders drop constraint if exists orders_prospective_financial_model_check;
    alter table orders drop constraint if exists orders_trader_paid_amount_range;
    alter table orders drop constraint if exists orders_nonnegative_amounts;
  `.execute(database);
}