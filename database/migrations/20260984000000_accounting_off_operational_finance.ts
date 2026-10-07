import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Accounting-OFF operational finance -- the minimum schema support.
 *
 * Every statement here is additive or a relaxation that only matters for a
 * Company whose GL Accounting is OFF. No row is updated, inserted or deleted:
 * existing Companies, their configuration, events, journals, movements and
 * payments are exactly as they were.
 *
 * 1. `accounting_capture_enabled(company)` -- the capture gate, now taking a
 *    FOR KEY SHARE lock on the Company's configuration row when (and only
 *    when) Accounting is ON. KEY SHARE does not conflict with ordinary
 *    configuration UPDATEs or with other operations; it conflicts only with
 *    the explicit FOR UPDATE that the controlled enable/disable operation
 *    takes. So a disable WAITS for every in-flight operation that already
 *    captured an Event to commit or roll back, and every operation that
 *    captures after that sees the committed OFF state. That closes the
 *    disable race with a per-Company row lock -- never a global one.
 *
 * 2. `enqueue_operational_accounting_event` uses that gate. Its body is
 *    otherwise byte-for-byte the one created by
 *    20260804110000_operational_event_capture_without_area_gate.
 *
 * 3. `accounting_enabled_at(company, at)` -- was GL Accounting ON for the
 *    Company at that moment, read from the existing
 *    `accounting_configuration_history` (written by the configuration's own
 *    trigger since the table was created). Used so that operations recorded
 *    while Accounting was OFF are never treated as accounting failures later.
 *
 * 4. `company_cash_accounts.linked_gl_account_id` becomes nullable, with a
 *    trigger that still REQUIRES it whenever the Company's Accounting is ON.
 *    An Accounting-ON Company can therefore never gain a GL-less drawer; an
 *    OFF Company can operate drawers without a Chart of Accounts.
 *
 * 5. `general_expense_payment_rows_destination_check` accepts a cash row that
 *    names its Company cash drawer even when the drawer has no GL account.
 *    Every row the old check accepted is still accepted.
 *
 * 6. `cash_bank_movements.generated_by_source_type` -- marks a Movement
 *    written automatically as the cash trail of another operational record
 *    (collection, settlement, payroll or employee payment, expense payment).
 *    Balances already exclude those trails when they are linked to their
 *    owner's Accounting Event; with Accounting OFF there is no Event, so the
 *    marker is what keeps the trail from being counted twice. Null on every
 *    existing row, so no existing balance changes.
 */

const previousEnqueueBody = `
    declare
      original_event_id uuid;
      stable_key text;
      stable_hash text;
    begin
      if not exists (
        select 1 from accounting_configurations c
         where c.company_id=event_company_id
           and c.accounting_enabled
      ) then
        return;
      end if;
      if reversal_source_id is not null then
        select e.id into original_event_id
          from accounting_events e
         where e.company_id=event_company_id
           and e.source_entity_type=reversal_source_type
           and e.source_entity_id=reversal_source_id
           and e.event_type not like '%_reversed'
           and e.event_type <> 'order_recognition_reversed'
         order by e.event_version desc limit 1;
        if original_event_id is null then
          return;
        end if;
      end if;
      stable_key := event_type_value || ':' || source_id_value::text || ':v1';
      stable_hash := md5(
        event_company_id::text || '|' || stable_key || '|' ||
        coalesce(source_reference_value,'') || '|' || accounting_date_value::text
      );
      insert into accounting_events (
        company_id,event_type,event_version,source_entity_type,source_entity_id,
        source_reference,effective_accounting_date,currency,correlation_id,
        idempotency_key,event_hash,actor_id,actor_type,description,
        reversal_of_event_id,supplementary_metadata,processing_status,
        operational_area,source_operation_id,next_attempt_at
      ) values (
        event_company_id,event_type_value,1,source_type_value,source_id_value,
        source_reference_value,accounting_date_value,'AED',
        coalesce(operation_id_value,stable_key),stable_key,stable_hash,
        actor_id_value,case when actor_id_value is null then 'system' else 'company_user' end,
        event_type_value || ' for ' || coalesce(source_reference_value,source_id_value::text),
        original_event_id,'{}'::jsonb,'received',event_area,
        coalesce(operation_id_value,stable_key),now()
      )
      on conflict (company_id,event_type,source_entity_type,source_entity_id,event_version)
      do nothing;
    end;
`;

const previousGate = `      if not exists (
        select 1 from accounting_configurations c
         where c.company_id=event_company_id
           and c.accounting_enabled
      ) then
        return;
      end if;`;

const lockingGate = `      if not accounting_capture_enabled(event_company_id) then
        return;
      end if;`;

function enqueueFunction(body: string) {
  return sql.raw(`
    create or replace function enqueue_operational_accounting_event(
      event_company_id uuid, event_area text, event_type_value text, source_type_value text,
      source_id_value uuid, source_reference_value text, accounting_date_value date,
      actor_id_value uuid, operation_id_value text,
      reversal_source_type text default null::text, reversal_source_id uuid default null::uuid
    ) returns void language plpgsql as $function$${body}$function$;
  `);
}

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  if (!previousEnqueueBody.includes(previousGate)) {
    throw new Error("enqueue_operational_accounting_event gate text not found");
  }

  await sql`
    create or replace function accounting_capture_enabled(target_company_id uuid)
      returns boolean language plpgsql as $$
    begin
      -- FOR KEY SHARE is taken only when the row is ON; see the migration header.
      perform 1 from accounting_configurations c
        where c.company_id = target_company_id and c.accounting_enabled
        for key share;
      return found;
    end;
    $$;

    create or replace function accounting_enabled_at(target_company_id uuid, at_time timestamptz)
      returns boolean language sql stable as $$
      select coalesce((
        select (h.configuration_snapshot->>'accounting_enabled')::boolean
          from accounting_configuration_history h
         where h.company_id = target_company_id and h.created_at <= at_time
         order by h.configuration_version desc
         limit 1
      ), false);
    $$;
  `.execute(database);

  await enqueueFunction(previousEnqueueBody.replace(previousGate, lockingGate)).execute(database);

  await sql`
    alter table company_cash_accounts alter column linked_gl_account_id drop not null;

    create or replace function require_cash_account_gl_when_accounting() returns trigger
      language plpgsql as $$
    begin
      if new.linked_gl_account_id is null and exists (
        select 1 from accounting_configurations c
         where c.company_id = new.company_id and c.accounting_enabled
      ) then
        raise exception using errcode = '23514',
          message = 'accounting_cash_account_gl_required';
      end if;
      return new;
    end;
    $$;
    create trigger company_cash_accounts_gl_required_when_accounting
      before insert or update of linked_gl_account_id on company_cash_accounts
      for each row execute function require_cash_account_gl_when_accounting();

    alter table general_expense_payment_rows
      drop constraint general_expense_payment_rows_destination_check,
      add constraint general_expense_payment_rows_destination_check check (
        (payment_method = 'cash'
          and (cash_account_id is not null or company_cash_account_id is not null)
          and company_bank_account_id is null)
        or (payment_method = 'visa' and company_bank_account_id is not null
          and cash_account_id is null)
      );

    -- Idempotent: the column and its constraint were added by hand on
    -- production on 2026-10-06 to unblock Trader settlement confirmation,
    -- which the deployed build already required. Guarded so this migration
    -- still applies cleanly there and on every environment that lacks them.
    alter table cash_bank_movements
      drop constraint if exists cash_bank_movements_generated_source_check;

    alter table cash_bank_movements
      add column if not exists generated_by_source_type text,
      add constraint cash_bank_movements_generated_source_check check (
        generated_by_source_type is null or generated_by_source_type in (
          'trader_collection','trader_settlement','payroll_payment',
          'employee_payment','general_expense_payment'
        )
      );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (select 1 from company_cash_accounts where linked_gl_account_id is null) then
        raise exception 'Cannot roll back: Cash accounts without a GL account exist';
      end if;
      if exists (
        select 1 from general_expense_payment_rows
         where payment_method = 'cash' and cash_account_id is null
      ) then
        raise exception 'Cannot roll back: cash expense payment rows without a GL account exist';
      end if;
    end;
    $$;

    alter table cash_bank_movements
      drop constraint cash_bank_movements_generated_source_check,
      drop column generated_by_source_type;

    alter table general_expense_payment_rows
      drop constraint general_expense_payment_rows_destination_check,
      add constraint general_expense_payment_rows_destination_check check (
        ((payment_method = 'cash') and (cash_account_id is not null)
          and (company_bank_account_id is null))
        or ((payment_method = 'visa') and (company_bank_account_id is not null)
          and (cash_account_id is null))
      );

    drop trigger company_cash_accounts_gl_required_when_accounting on company_cash_accounts;
    drop function require_cash_account_gl_when_accounting();
    alter table company_cash_accounts alter column linked_gl_account_id set not null;
  `.execute(database);

  await enqueueFunction(previousEnqueueBody).execute(database);

  await sql`
    drop function accounting_enabled_at(uuid, timestamptz);
    drop function accounting_capture_enabled(uuid);
  `.execute(database);
}
