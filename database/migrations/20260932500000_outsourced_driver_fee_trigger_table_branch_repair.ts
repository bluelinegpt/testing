import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function protect_outsourced_driver_fee_foundations()
    returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        raise exception 'Outsourced Driver fee history cannot be deleted';
      end if;

      if tg_table_name = 'outsourced_driver_fee_versions' then
        if exists (
          select 1
          from outsourced_driver_fee_accruals a
          where a.company_id = old.company_id
            and a.fee_rate_version_id = old.id
        ) and (
          new.fee_per_order is distinct from old.fee_per_order
          or new.driver_id is distinct from old.driver_id
          or new.effective_from is distinct from old.effective_from
        ) then
          raise exception 'Fee-rate versions used by an accrual are immutable';
        end if;

        if new.effective_to is distinct from old.effective_to and exists (
          select 1
          from outsourced_driver_fee_accruals a
          where a.company_id = old.company_id
            and a.fee_rate_version_id = old.id
            and a.status not in ('reversed', 'recovery_required')
            and a.accrual_business_date > coalesce(new.effective_to, 'infinity'::date)
        ) then
          raise exception 'Narrowing this fee-rate version would leave an existing accrual without a valid rate for its business date';
        end if;

        return new;
      end if;

      if tg_table_name = 'outsourced_driver_fee_accruals' then
        if (
          new.company_id is distinct from old.company_id
          or new.driver_id is distinct from old.driver_id
          or new.order_id is distinct from old.order_id
          or new.reconciliation_id is distinct from old.reconciliation_id
          or new.earning_type is distinct from old.earning_type
          or new.fee_rate_version_id is distinct from old.fee_rate_version_id
          or new.collection_rule_id is distinct from old.collection_rule_id
          or new.fee_rate_snapshot is distinct from old.fee_rate_snapshot
          or new.unit_count is distinct from old.unit_count
          or new.earned_amount is distinct from old.earned_amount
        ) then
          raise exception 'Fee accrual source and earned snapshots are immutable';
        end if;

        if old.status in ('reversed', 'recovery_required') then
          raise exception 'Reversed or recovery-required fee accruals are immutable';
        end if;

        return new;
      end if;

      return new;
    end;
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function protect_outsourced_driver_fee_foundations()
    returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        raise exception 'Outsourced Driver fee history cannot be deleted';
      end if;
      if tg_table_name = 'outsourced_driver_fee_versions' and exists (
        select 1 from outsourced_driver_fee_accruals a
        where a.company_id = old.company_id and a.fee_rate_version_id = old.id
      ) and (
        new.fee_per_order is distinct from old.fee_per_order
        or new.driver_id is distinct from old.driver_id
        or new.effective_from is distinct from old.effective_from
      ) then
        raise exception 'Fee-rate versions used by an accrual are immutable';
      end if;
      if tg_table_name = 'outsourced_driver_fee_accruals' and (
        new.company_id is distinct from old.company_id
        or new.driver_id is distinct from old.driver_id
        or new.order_id is distinct from old.order_id
        or new.reconciliation_id is distinct from old.reconciliation_id
        or new.earning_type is distinct from old.earning_type
        or new.fee_rate_version_id is distinct from old.fee_rate_version_id
        or new.collection_rule_id is distinct from old.collection_rule_id
        or new.fee_rate_snapshot is distinct from old.fee_rate_snapshot
        or new.unit_count is distinct from old.unit_count
        or new.earned_amount is distinct from old.earned_amount
      ) then
        raise exception 'Fee accrual source and earned snapshots are immutable';
      end if;
      if tg_table_name = 'outsourced_driver_fee_accruals'
        and old.status in ('reversed', 'recovery_required') then
        raise exception 'Reversed or recovery-required fee accruals are immutable';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}
