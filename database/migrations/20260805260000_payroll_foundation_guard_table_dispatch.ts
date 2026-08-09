import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Dispatch on the table BEFORE reading columns only some of those tables have.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 *
 * `protect_payroll_foundation_records()` guards six tables. Its UPDATE section
 * opened with:
 *
 *     if tg_table_name = 'payroll_periods' and old.status in (...)
 *
 * and its DELETE section with the equivalent test on `payroll_entries`.
 *
 * PL/pgSQL resolves record field references when it plans the expression, not
 * when the `and` short-circuits. So on a table whose row type has no `status`
 * column the whole statement fails with
 *
 *     record "old" has no field "status"
 *
 * before the table's own branch further down the function is ever reached.
 *
 * Two of the six guarded tables have no `status` column --
 * `payroll_payment_allocations` and `payroll_line_allowances` -- so every
 * UPDATE and DELETE on either of them raised that error instead of being
 * checked by the rule written for it.
 *
 * The visible consequence: `PayrollPaymentService.reverse()` marks allocations
 * reversed, so NO Payroll payment could be reversed at all. Reproduced by
 * updating any existing `payroll_payment_allocations` row.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 *
 * Only the CONTROL FLOW. Both sections now dispatch on `tg_table_name` first,
 * as an if/elsif chain, and every column reference sits inside the branch for
 * the table that has it. Each branch keeps its predicate, its permitted-column
 * list and its message character for character.
 *
 * The chain is equivalent to the old fall-through, not merely similar. In the
 * original, a `payroll_periods` row whose status was not finalized failed the
 * opening test and fell past every remaining `tg_table_name` test to the final
 * `return new`; in the rewrite it enters the periods branch, skips the inner
 * check and returns new. Same for `payroll_entries`. No rule is relaxed, no
 * table loses a guard, and nothing that was rejected before is accepted now --
 * except on the two tables that could not be evaluated at all.
 *
 * No dynamic SQL. The typing problem is solved by not referencing absent
 * columns, which is the actual fix; `execute` would only hide it.
 *
 * The function is REPLACED, not dropped. `create or replace` preserves the
 * function's identity, so all six trigger bindings stay attached and enabled
 * throughout -- there is no window in which Payroll history is unguarded.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function protect_payroll_foundation_records()
      returns trigger language plpgsql as $$
    declare
      parent_period_status text;
      parent_line_status text;
      parent_line_approved_at timestamptz;
    begin
      if tg_op = 'INSERT' then
        if tg_table_name = 'payroll_entries' then
          select p.status into parent_period_status
            from payroll_periods p
           where p.id = new.payroll_period_id and p.company_id = new.company_id;
          if parent_period_status not in ('draft','calculated') then
            raise exception 'Payroll lines cannot be added after period approval';
          end if;
        elsif tg_table_name = 'payroll_line_allowances' then
          select l.status, l.approved_at
            into parent_line_status, parent_line_approved_at
            from payroll_entries l
           where l.id = new.payroll_line_id and l.company_id = new.company_id;
          if parent_line_status not in ('draft','calculated','held')
            or parent_line_approved_at is not null then
            raise exception 'Approved Payroll allowance snapshots are immutable';
          end if;
        elsif tg_table_name = 'payroll_adjustments' then
          select p.status into parent_period_status
            from payroll_periods p
           where p.id = new.payroll_period_id and p.company_id = new.company_id;
          if parent_period_status not in ('draft','calculated') then
            raise exception 'Adjustments cannot be added after Payroll approval';
          end if;
        end if;
        return new;
      end if;

      -- DELETE: dispatch first. old.status / old.approved_at exist on
      -- payroll_entries only, so they are read only in that branch.
      if tg_op = 'DELETE' then
        if tg_table_name = 'payroll_entries' then
          if old.status in ('draft','calculated','held') and old.approved_at is null then
            return old;
          end if;
        elsif tg_table_name = 'payroll_line_allowances' then
          select l.status, l.approved_at
            into parent_line_status, parent_line_approved_at
            from payroll_entries l
           where l.id = old.payroll_line_id and l.company_id = old.company_id;
          if parent_line_status in ('draft','calculated','held')
            and parent_line_approved_at is null then
            return old;
          end if;
        end if;
        raise exception 'Payroll financial history cannot be deleted';
      end if;

      -- UPDATE: one branch per guarded table, in the same order as before.
      if tg_table_name = 'payroll_periods' then
        if old.status in ('approved','partially_paid','paid','closed','reversed') then
          if old.status = 'reversed'
            or new.status not in ('approved','partially_paid','paid','closed','reversed')
            or (
              to_jsonb(new) - array[
                'status','total_paid','total_outstanding','closed_by_account_id','closed_at',
                'reversed_by_account_id','reversed_at','reversal_reason','version','updated_at'
              ]::text[]
              is distinct from
              to_jsonb(old) - array[
                'status','total_paid','total_outstanding','closed_by_account_id','closed_at',
                'reversed_by_account_id','reversed_at','reversal_reason','version','updated_at'
              ]::text[]
            ) then
            raise exception 'Approved or finalized Payroll periods are immutable; use settlement or reversal';
          end if;
        end if;
        return new;
      elsif tg_table_name = 'payroll_entries' then
        if old.status in ('approved','partially_paid','paid','reversed')
          or (old.status = 'held' and old.approved_at is not null) then
          if old.status = 'reversed'
            or new.status not in ('approved','partially_paid','paid','held','reversed')
            or (
              to_jsonb(new) - array[
                'status','amount_paid','outstanding_amount','reversed_by_account_id',
                'reversed_at','reversal_reason','version','updated_at'
              ]::text[]
              is distinct from
              to_jsonb(old) - array[
                'status','amount_paid','outstanding_amount','reversed_by_account_id',
                'reversed_at','reversal_reason','version','updated_at'
              ]::text[]
            ) then
            raise exception 'Approved or finalized Payroll lines are immutable; use settlement or reversal';
          end if;
        end if;
        return new;
      elsif tg_table_name = 'payroll_line_allowances' then
        select l.status, l.approved_at
          into parent_line_status, parent_line_approved_at
          from payroll_entries l
         where l.id = old.payroll_line_id and l.company_id = old.company_id;
        if parent_line_status in ('draft','calculated','held')
          and parent_line_approved_at is null then
          return new;
        end if;
        raise exception 'Approved Payroll allowance snapshots are immutable';
      elsif tg_table_name = 'payroll_adjustments' then
        select p.status into parent_period_status
          from payroll_periods p
         where p.id = old.payroll_period_id and p.company_id = old.company_id;
        if old.status = 'reversed' then
          raise exception 'Reversed Payroll adjustments are immutable';
        end if;
        if parent_period_status in ('approved','partially_paid','paid','closed','reversed') then
          raise exception 'Adjustments in approved Payroll are immutable';
        end if;
        return new;
      elsif tg_table_name = 'payroll_payments' then
        if old.status <> 'confirmed' or new.status <> 'reversed'
          or (
            to_jsonb(new) - array[
              'status','reversed_by_account_id','reversed_at','reversal_reason',
              'reversal_of_payment_id','version','updated_at'
            ]::text[]
            is distinct from
            to_jsonb(old) - array[
              'status','reversed_by_account_id','reversed_at','reversal_reason',
              'reversal_of_payment_id','version','updated_at'
            ]::text[]
          ) then
          raise exception 'Confirmed Payroll payment history is immutable; use reversal';
        end if;
        return new;
      elsif tg_table_name = 'payroll_payment_allocations' then
        if old.reversed_at is not null or new.reversed_at is null
          or (
            to_jsonb(new) - array['reversed_at','reversal_allocation_id']::text[]
            is distinct from
            to_jsonb(old) - array['reversed_at','reversal_allocation_id']::text[]
          ) then
          raise exception 'Payroll payment allocations are immutable; use reversal';
        end if;
        return new;
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}

/**
 * Restores the prior definition verbatim, as read from `pg_proc.prosrc` before
 * the change -- including the defect. A `down()` that quietly kept the fix
 * would make the migration irreversible in fact while claiming otherwise.
 */
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function protect_payroll_foundation_records()
      returns trigger language plpgsql as $$
    declare
      parent_period_status text;
      parent_line_status text;
      parent_line_approved_at timestamptz;
    begin
      if tg_op = 'INSERT' then
        if tg_table_name = 'payroll_entries' then
          select p.status into parent_period_status
            from payroll_periods p
           where p.id = new.payroll_period_id and p.company_id = new.company_id;
          if parent_period_status not in ('draft','calculated') then
            raise exception 'Payroll lines cannot be added after period approval';
          end if;
        elsif tg_table_name = 'payroll_line_allowances' then
          select l.status, l.approved_at
            into parent_line_status, parent_line_approved_at
            from payroll_entries l
           where l.id = new.payroll_line_id and l.company_id = new.company_id;
          if parent_line_status not in ('draft','calculated','held')
            or parent_line_approved_at is not null then
            raise exception 'Approved Payroll allowance snapshots are immutable';
          end if;
        elsif tg_table_name = 'payroll_adjustments' then
          select p.status into parent_period_status
            from payroll_periods p
           where p.id = new.payroll_period_id and p.company_id = new.company_id;
          if parent_period_status not in ('draft','calculated') then
            raise exception 'Adjustments cannot be added after Payroll approval';
          end if;
        end if;
        return new;
      end if;

      if tg_op = 'DELETE' then
        if tg_table_name = 'payroll_entries'
          and old.status in ('draft','calculated','held')
          and old.approved_at is null then
          return old;
        end if;
        if tg_table_name = 'payroll_line_allowances' then
          select l.status, l.approved_at
            into parent_line_status, parent_line_approved_at
            from payroll_entries l
           where l.id = old.payroll_line_id and l.company_id = old.company_id;
          if parent_line_status in ('draft','calculated','held')
            and parent_line_approved_at is null then
            return old;
          end if;
        end if;
        raise exception 'Payroll financial history cannot be deleted';
      end if;

      if tg_table_name = 'payroll_periods' and old.status in
        ('approved','partially_paid','paid','closed','reversed') then
        if old.status = 'reversed'
          or new.status not in ('approved','partially_paid','paid','closed','reversed')
          or (
            to_jsonb(new) - array[
              'status','total_paid','total_outstanding','closed_by_account_id','closed_at',
              'reversed_by_account_id','reversed_at','reversal_reason','version','updated_at'
            ]::text[]
            is distinct from
            to_jsonb(old) - array[
              'status','total_paid','total_outstanding','closed_by_account_id','closed_at',
              'reversed_by_account_id','reversed_at','reversal_reason','version','updated_at'
            ]::text[]
          ) then
          raise exception 'Approved or finalized Payroll periods are immutable; use settlement or reversal';
        end if;
        return new;
      end if;

      if tg_table_name = 'payroll_entries' and (
        old.status in ('approved','partially_paid','paid','reversed')
        or (old.status = 'held' and old.approved_at is not null)
      ) then
        if old.status = 'reversed'
          or new.status not in ('approved','partially_paid','paid','held','reversed')
          or (
            to_jsonb(new) - array[
              'status','amount_paid','outstanding_amount','reversed_by_account_id',
              'reversed_at','reversal_reason','version','updated_at'
            ]::text[]
            is distinct from
            to_jsonb(old) - array[
              'status','amount_paid','outstanding_amount','reversed_by_account_id',
              'reversed_at','reversal_reason','version','updated_at'
            ]::text[]
          ) then
          raise exception 'Approved or finalized Payroll lines are immutable; use settlement or reversal';
        end if;
        return new;
      end if;

      if tg_table_name = 'payroll_line_allowances' then
        select l.status, l.approved_at
          into parent_line_status, parent_line_approved_at
          from payroll_entries l
         where l.id = old.payroll_line_id and l.company_id = old.company_id;
        if parent_line_status in ('draft','calculated','held')
          and parent_line_approved_at is null then
          return new;
        end if;
        raise exception 'Approved Payroll allowance snapshots are immutable';
      end if;

      if tg_table_name = 'payroll_adjustments' then
        select p.status into parent_period_status
          from payroll_periods p
         where p.id = old.payroll_period_id and p.company_id = old.company_id;
        if old.status = 'reversed' then
          raise exception 'Reversed Payroll adjustments are immutable';
        end if;
        if parent_period_status in ('approved','partially_paid','paid','closed','reversed') then
          raise exception 'Adjustments in approved Payroll are immutable';
        end if;
        return new;
      end if;

      if tg_table_name = 'payroll_payments' then
        if old.status <> 'confirmed' or new.status <> 'reversed'
          or (
            to_jsonb(new) - array[
              'status','reversed_by_account_id','reversed_at','reversal_reason',
              'reversal_of_payment_id','version','updated_at'
            ]::text[]
            is distinct from
            to_jsonb(old) - array[
              'status','reversed_by_account_id','reversed_at','reversal_reason',
              'reversal_of_payment_id','version','updated_at'
            ]::text[]
          ) then
          raise exception 'Confirmed Payroll payment history is immutable; use reversal';
        end if;
        return new;
      end if;

      if tg_table_name = 'payroll_payment_allocations' then
        if old.reversed_at is not null or new.reversed_at is null
          or (
            to_jsonb(new) - array['reversed_at','reversal_allocation_id']::text[]
            is distinct from
            to_jsonb(old) - array['reversed_at','reversal_allocation_id']::text[]
          ) then
          raise exception 'Payroll payment allocations are immutable; use reversal';
        end if;
        return new;
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}
