import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * `protect_opening_balance_history` — make the totals guard reachable only on
 * the table and operation it was written for.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 *
 * The function is shared by two triggers: one on `opening_balance_batches` and
 * one on `opening_balance_lines`, both `before update or delete`. Its last
 * block is a stale-totals check that belongs to Batch UPDATEs alone, and it
 * says so — but it says so inside a single boolean expression:
 *
 *   if tg_table_name = 'opening_balance_batches'
 *      and tg_op = 'UPDATE'
 *      and (new.total_debit is distinct from old.total_debit or ...)
 *
 * PL/pgSQL does not guarantee left-to-right short-circuiting of an expression
 * before resolving the record fields inside it. On a DELETE trigger `NEW` is
 * unset, so `new.total_debit` raises
 *
 *   record "new" has no field "total_debit"
 *
 * before the `tg_op = 'UPDATE'` conjunct can rule the block out. Every DELETE
 * on `opening_balance_lines` therefore fails, whatever the Batch status — the
 * guard that was supposed to protect Batch totals instead broke Line removal.
 *
 * That is not theoretical: `OpeningBalanceService.mutateLines` clears and
 * rewrites the Lines on every edit (`removeLine`, `replaceLines`, `addLine`,
 * `updateLine`), and `opening_balance_lines_batch_fk` is `on delete restrict`,
 * so a Draft Batch could not be deleted either.
 *
 * ---------------------------------------------------------------------------
 * THE FIX
 * ---------------------------------------------------------------------------
 *
 * Nest the conditions so `new.*` is only ever touched once `tg_op = 'UPDATE'`
 * has already been established by a separate statement. Nothing else changes:
 * the same three legal Batch transitions, the same Line immutability rule, the
 * same stale-totals rejection, the same `23514` error codes and messages. This
 * migration reorders evaluation, it does not relax a single rule.
 *
 * The `down` restores the previous body verbatim, defect included, so the
 * migration is reversible in the ordinary sense.
 */

const fixedFunction = sql`
  create or replace function protect_opening_balance_history()
    returns trigger language plpgsql as $$
  declare
    target_batch_id uuid;
    target_company_id uuid;
    batch_status text;
    computed_debit numeric(18,2);
    computed_credit numeric(18,2);
  begin
    if tg_table_name = 'opening_balance_batches' then
      if old.status in ('validated','approved','posted','reversed') then
        if not (
          tg_op = 'UPDATE'
          and (
            (
              old.status = 'validated' and new.status in ('draft','approved')
              and new.effective_date = old.effective_date
              and new.fiscal_year_id = old.fiscal_year_id
              and new.accounting_period_id = old.accounting_period_id
              and new.description = old.description
              and new.currency = old.currency
              and new.total_debit = old.total_debit
              and new.total_credit = old.total_credit
            )
            or (
              old.status = 'approved' and new.status = 'posted'
              and new.effective_date = old.effective_date
              and new.fiscal_year_id = old.fiscal_year_id
              and new.accounting_period_id = old.accounting_period_id
              and new.description = old.description
              and new.currency = old.currency
              and new.total_debit = old.total_debit
              and new.total_credit = old.total_credit
            )
            or (
              old.status = 'posted' and new.status = 'reversed'
              and new.reversal_journal_id is not null
              and new.reversed_by_account_id is not null
              and btrim(coalesce(new.reversal_reason, '')) <> ''
              and new.effective_date = old.effective_date
              and new.fiscal_year_id = old.fiscal_year_id
              and new.accounting_period_id = old.accounting_period_id
              and new.description = old.description
              and new.currency = old.currency
              and new.total_debit = old.total_debit
              and new.total_credit = old.total_credit
            )
          )
        ) then
          raise exception using errcode = '23514',
            message = 'accounting_opening_balance_immutable';
        end if;
      end if;
      -- Batch UPDATEs only. Established by its own statement, so no DELETE ever
      -- reaches an expression naming a NEW column.
      if tg_op = 'UPDATE' then
        if new.total_debit is distinct from old.total_debit
           or new.total_credit is distinct from old.total_credit then
          select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
            into computed_debit, computed_credit
            from opening_balance_lines
           where opening_balance_batch_id=new.id and company_id=new.company_id;
          if new.total_debit <> computed_debit or new.total_credit <> computed_credit then
            raise exception using errcode = '23514',
              message = 'accounting_opening_balance_totals_stale';
          end if;
        end if;
      end if;
    else
      target_batch_id := case when tg_op = 'DELETE' then old.opening_balance_batch_id else new.opening_balance_batch_id end;
      target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
      select status into batch_status from opening_balance_batches
       where id = target_batch_id and company_id = target_company_id;
      if batch_status in ('validated','approved','posted','reversed') then
        raise exception using errcode = '23514',
          message = 'accounting_opening_balance_immutable';
      end if;
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end;
  $$;
`;

const previousFunction = sql`
  create or replace function protect_opening_balance_history()
    returns trigger language plpgsql as $$
  declare
    target_batch_id uuid;
    target_company_id uuid;
    batch_status text;
    computed_debit numeric(18,2);
    computed_credit numeric(18,2);
  begin
    if tg_table_name = 'opening_balance_batches' then
      if old.status in ('validated','approved','posted','reversed') then
        if not (
          tg_op = 'UPDATE'
          and (
            (
              old.status = 'validated' and new.status in ('draft','approved')
              and new.effective_date = old.effective_date
              and new.fiscal_year_id = old.fiscal_year_id
              and new.accounting_period_id = old.accounting_period_id
              and new.description = old.description
              and new.currency = old.currency
              and new.total_debit = old.total_debit
              and new.total_credit = old.total_credit
            )
            or (
              old.status = 'approved' and new.status = 'posted'
              and new.effective_date = old.effective_date
              and new.fiscal_year_id = old.fiscal_year_id
              and new.accounting_period_id = old.accounting_period_id
              and new.description = old.description
              and new.currency = old.currency
              and new.total_debit = old.total_debit
              and new.total_credit = old.total_credit
            )
            or (
              old.status = 'posted' and new.status = 'reversed'
              and new.reversal_journal_id is not null
              and new.reversed_by_account_id is not null
              and btrim(coalesce(new.reversal_reason, '')) <> ''
              and new.effective_date = old.effective_date
              and new.fiscal_year_id = old.fiscal_year_id
              and new.accounting_period_id = old.accounting_period_id
              and new.description = old.description
              and new.currency = old.currency
              and new.total_debit = old.total_debit
              and new.total_credit = old.total_credit
            )
          )
        ) then
          raise exception using errcode = '23514',
            message = 'accounting_opening_balance_immutable';
        end if;
      end if;
    else
      target_batch_id := case when tg_op = 'DELETE' then old.opening_balance_batch_id else new.opening_balance_batch_id end;
      target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
      select status into batch_status from opening_balance_batches
       where id = target_batch_id and company_id = target_company_id;
      if batch_status in ('validated','approved','posted','reversed') then
        raise exception using errcode = '23514',
          message = 'accounting_opening_balance_immutable';
      end if;
    end if;
    if tg_table_name = 'opening_balance_batches'
       and tg_op = 'UPDATE'
       and (
         new.total_debit is distinct from old.total_debit
         or new.total_credit is distinct from old.total_credit
       ) then
      select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
        into computed_debit, computed_credit
        from opening_balance_lines
       where opening_balance_batch_id=new.id and company_id=new.company_id;
      if new.total_debit <> computed_debit or new.total_credit <> computed_credit then
        raise exception using errcode = '23514',
          message = 'accounting_opening_balance_totals_stale';
      end if;
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end;
  $$;
`;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await fixedFunction.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await previousFunction.execute(database);
}
