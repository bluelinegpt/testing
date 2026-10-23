import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Order corrections (Aiman, 23 Oct 2026).
 *
 * An Order marked Delivered by mistake (Lahthza ORD-000212, ref 4353) can sit
 * inside a confirmed Driver collection and a posted Trader settlement together
 * with many other Orders. Both are immutable, and reversing them whole would
 * undo every other Order on them. A correction instead takes ONE Order out:
 *
 *   - `order_corrections` (numbered DCX-000001 per Company) records what was
 *     done, why, by whom, the amounts and a snapshot of the Order before;
 *   - `order_correction_lines` points at each collection / settlement /
 *     0-due line the Order was removed from. The original line is never
 *     changed or deleted: every reader treats a line named here as removed,
 *     and the original document can still be printed exactly as it was.
 *
 * Money:
 *   - collection part: the cash the collection recorded for the Order was
 *     never received, so a `driver_collection_corrected` Accounting Event
 *     (Dr COD Receivable / Cr Cash or Bank) undoes that Order's share; the
 *     Cash/Bank Movement written by the API mirrors it;
 *   - settlement part: the Trader was already paid for the Order, so the API
 *     opens an `overpayment_recovery` Trader receivable. Its own recognition
 *     event credits Trader Payable (not revenue) when it belongs to a
 *     correction (see the source loader).
 *
 * Additive: two new tables, an append-only guard, a new reference type, a new
 * Accounting Event type and its capture trigger, and the single-active-link
 * guard learns that a removed collection line is no longer active. No
 * existing row is changed.
 */
const eventTypesBefore = [
  "bank_deposit_confirmed",
  "bank_to_bank_transfer_confirmed",
  "bank_to_cash_transfer_confirmed",
  "bank_transfer_confirmed",
  "bank_transfer_reversed",
  "bank_withdrawal_confirmed",
  "cash_bank_movement_reversed",
  "cash_deposit_confirmed",
  "cash_to_bank_transfer_confirmed",
  "cash_to_cash_transfer_confirmed",
  "cash_withdrawal_confirmed",
  "driver_collection_confirmed",
  "driver_collection_reversed",
  "driver_expense_confirmed",
  "employee_payroll_approved",
  "employee_payroll_paid",
  "employee_payroll_payment_reversed",
  "employee_payroll_reversed",
  "employee_salary_advance_paid",
  "employee_salary_advance_reversed",
  "employee_variable_earnings_interim_paid",
  "employee_variable_earnings_interim_payment_reversed",
  "general_expense_approved",
  "general_expense_payment_completed",
  "general_expense_payment_reversed",
  "general_expense_reversed",
  "order_delivered",
  "order_recognition_reversed",
  "outsourced_driver_fee_accrual_reversed",
  "outsourced_driver_fee_accrued",
  "outsourced_driver_fee_paid",
  "outsourced_driver_fee_payment_reversed",
  "trader_receivable_payment_received",
  "trader_receivable_payment_reversed",
  "trader_receivable_recognized",
  "trader_receivable_reversed",
  "trader_settlement_confirmed",
  "trader_settlement_reversed",
  "trader_credit_issued",
];
const eventTypesAfter = [...eventTypesBefore, "driver_collection_corrected"];

const referenceTypesBefore = [
  "accounting_opening_balance", "area", "cash_bank_movement", "customer", "driver", "employee",
  "employee_salary_advance", "employee_variable_earning_payment", "general_expense",
  "general_expense_payment", "import", "journal", "order", "outsourced_driver_fee_payment",
  "payment", "payroll", "payroll_payment", "reconciliation", "settlement", "trader",
  "trader_collection", "trader_receivable", "trader_credit", "route_run", "trader_zero_invoice",
];
const referenceTypesAfter = [...referenceTypesBefore, "order_correction"];

const textArray = (values: readonly string[]) =>
  sql.raw(`array[${values.map((value) => `'${value}'`).join(", ")}]::text[]`);

const singleActiveLinkFunction = (excludeRemoved: boolean) =>
  sql.raw(`
    create or replace function enforce_single_active_reconciliation_link() returns trigger
      language plpgsql as $function$
    declare
      conflicting_count integer;
    begin
      select count(*) into conflicting_count
        from driver_reconciliation_orders existing
        join driver_reconciliations existing_reconciliation
          on existing_reconciliation.id = existing.reconciliation_id
         and existing_reconciliation.company_id = existing.company_id
       where existing.company_id = new.company_id
         and existing.order_id = new.order_id
         and existing.id <> new.id
         and not exists (
           select 1 from driver_reconciliations reversal
            where reversal.company_id = existing_reconciliation.company_id
              and reversal.reversal_of_id = existing_reconciliation.id
         )${
           excludeRemoved
             ? `
         and not exists (
           select 1 from order_correction_lines removed
            where removed.company_id = existing.company_id
              and removed.driver_reconciliation_order_id = existing.id
         )`
             : ""
         };
      if conflicting_count > 0 then
        raise exception using errcode = '23514',
          message = 'Order is already linked to an active (non-reversed) Driver collection';
      end if;
      return new;
    end;
    $function$;
  `);

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  // Tenant-scoped target for the 0-due line FK below (id is already the PK,
  // so every existing row satisfies it).
  await sql`
    alter table trader_settlement_zero_due_orders
      drop constraint if exists trader_settlement_zero_due_orders_id_company_unique,
      add constraint trader_settlement_zero_due_orders_id_company_unique unique (id, company_id)
  `.execute(database);
  await sql`
    create table if not exists order_corrections (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      correction_number text not null,
      order_id uuid not null,
      correction_type text not null,
      reason text not null,
      business_date date not null default ((now() at time zone 'Asia/Dubai')::date),
      trader_id uuid not null,
      driver_id uuid,
      reconciliation_id uuid,
      collection_amount numeric(18,2) not null default 0,
      collection_payment_method text,
      -- The Bank account the Visa money went to (the same one the
      -- withdrawal Movement and the Journal use); null for cash.
      collection_bank_account_id uuid,
      recovered_amount numeric(18,2) not null default 0,
      previous_delivery_status text not null,
      order_snapshot jsonb not null,
      correlation_id text,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      constraint order_corrections_number_unique unique (company_id, correction_number),
      constraint order_corrections_id_company_unique unique (id, company_id),
      constraint order_corrections_type_check check (correction_type in ('wrong_delivery')),
      constraint order_corrections_reason_nonempty check (btrim(reason) <> ''),
      constraint order_corrections_amounts_check check (collection_amount >= 0 and recovered_amount >= 0),
      constraint order_corrections_collection_shape check (
        (collection_amount = 0 or reconciliation_id is not null)
        and (collection_payment_method is null or collection_payment_method in ('cash', 'visa'))
        and ((collection_amount > 0) = (collection_payment_method is not null))
      ),
      constraint order_corrections_order_fk
        foreign key (order_id, company_id) references orders(id, company_id) on delete restrict,
      constraint order_corrections_trader_fk
        foreign key (trader_id, company_id) references traders(id, company_id) on delete restrict,
      constraint order_corrections_driver_fk
        foreign key (driver_id, company_id) references drivers(id, company_id) on delete restrict,
      constraint order_corrections_reconciliation_fk
        foreign key (reconciliation_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      constraint order_corrections_bank_account_fk
        foreign key (collection_bank_account_id, company_id)
        references company_bank_accounts(id, company_id) on delete restrict,
      constraint order_corrections_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict
    )
  `.execute(database);
  await sql`
    create index if not exists order_corrections_order_idx
      on order_corrections(company_id, order_id)
  `.execute(database);
  await sql`
    comment on table order_corrections is
      'DCX corrections: one Order taken out of its Driver collection / Trader settlement. Append-only.'
  `.execute(database);

  await sql`
    create table if not exists order_correction_lines (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      correction_id uuid not null,
      order_id uuid not null,
      line_kind text not null,
      driver_reconciliation_order_id uuid,
      reconciliation_id uuid,
      trader_settlement_order_id uuid,
      settlement_id uuid,
      zero_due_order_id uuid,
      zero_invoice_id uuid,
      amount numeric(18,2) not null default 0,
      trader_receivable_id uuid,
      snapshot jsonb not null,
      created_at timestamptz not null default now(),
      constraint order_correction_lines_kind_check check (
        (line_kind = 'driver_collection' and driver_reconciliation_order_id is not null
           and reconciliation_id is not null
           and num_nonnulls(trader_settlement_order_id, zero_due_order_id,
                            settlement_id, zero_invoice_id) = 0)
        or (line_kind = 'trader_settlement' and trader_settlement_order_id is not null
           and settlement_id is not null
           and num_nonnulls(driver_reconciliation_order_id, zero_due_order_id,
                            reconciliation_id, zero_invoice_id) = 0)
        or (line_kind = 'zero_due' and zero_due_order_id is not null
           and num_nonnulls(settlement_id, zero_invoice_id) = 1
           and num_nonnulls(driver_reconciliation_order_id, trader_settlement_order_id,
                            reconciliation_id) = 0)
      ),
      constraint order_correction_lines_amount_check check (amount >= 0),
      -- A settlement line whose money already reached the Trader is recovered
      -- through its own receivable, one per line, so reversing that one
      -- Settlement later can cancel exactly its own recovery.
      constraint order_correction_lines_recovery_shape check (
        trader_receivable_id is null or (line_kind = 'trader_settlement' and amount > 0)
      ),
      constraint order_correction_lines_receivable_fk
        foreign key (trader_receivable_id, company_id)
        references trader_receivables(id, company_id) on delete restrict,
      constraint order_correction_lines_correction_fk
        foreign key (correction_id, company_id)
        references order_corrections(id, company_id) on delete restrict,
      constraint order_correction_lines_order_fk
        foreign key (order_id, company_id) references orders(id, company_id) on delete restrict,
      constraint order_correction_lines_collection_line_fk
        foreign key (driver_reconciliation_order_id, company_id)
        references driver_reconciliation_orders(id, company_id) on delete restrict,
      constraint order_correction_lines_reconciliation_fk
        foreign key (reconciliation_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      constraint order_correction_lines_settlement_line_fk
        foreign key (trader_settlement_order_id, company_id)
        references trader_settlement_orders(id, company_id) on delete restrict,
      constraint order_correction_lines_settlement_fk
        foreign key (settlement_id, company_id)
        references trader_settlements(id, company_id) on delete restrict,
      constraint order_correction_lines_zero_due_fk
        foreign key (zero_due_order_id, company_id)
        references trader_settlement_zero_due_orders(id, company_id) on delete restrict,
      constraint order_correction_lines_zero_invoice_fk
        foreign key (zero_invoice_id, company_id)
        references trader_zero_invoices(id, company_id) on delete restrict
    )
  `.execute(database);
  // One removal per original line: a line can be taken out only once.
  await sql`
    create unique index if not exists order_correction_lines_collection_unique
      on order_correction_lines(driver_reconciliation_order_id)
      where driver_reconciliation_order_id is not null
  `.execute(database);
  await sql`
    create unique index if not exists order_correction_lines_settlement_unique
      on order_correction_lines(trader_settlement_order_id)
      where trader_settlement_order_id is not null
  `.execute(database);
  await sql`
    create unique index if not exists order_correction_lines_zero_due_unique
      on order_correction_lines(zero_due_order_id)
      where zero_due_order_id is not null
  `.execute(database);
  await sql`
    create unique index if not exists order_correction_lines_receivable_unique
      on order_correction_lines(trader_receivable_id)
      where trader_receivable_id is not null
  `.execute(database);
  await sql`
    create index if not exists order_correction_lines_settlement_idx
      on order_correction_lines(company_id, settlement_id) where settlement_id is not null
  `.execute(database);
  await sql`
    create index if not exists order_correction_lines_reconciliation_idx
      on order_correction_lines(company_id, reconciliation_id) where reconciliation_id is not null
  `.execute(database);

  // The document columns must be the ones the original line really belongs
  // to (same Company, same Order, same collection / settlement / invoice):
  // readers filter removals by them, so a mismatch would hide the wrong line.
  await sql`
    create or replace function validate_order_correction_line() returns trigger
      language plpgsql as $function$
    begin
      if new.line_kind = 'driver_collection' and not exists (
        select 1 from driver_reconciliation_orders l
         where l.id = new.driver_reconciliation_order_id and l.company_id = new.company_id
           and l.order_id = new.order_id and l.reconciliation_id = new.reconciliation_id
      ) then
        raise exception using errcode = '23514',
          message = 'order_correction_line_collection_mismatch';
      elsif new.line_kind = 'trader_settlement' and not exists (
        select 1 from trader_settlement_orders l
         where l.id = new.trader_settlement_order_id and l.company_id = new.company_id
           and l.order_id = new.order_id and l.settlement_id = new.settlement_id
      ) then
        raise exception using errcode = '23514',
          message = 'order_correction_line_settlement_mismatch';
      elsif new.line_kind = 'zero_due' and not exists (
        select 1 from trader_settlement_zero_due_orders z
         where z.id = new.zero_due_order_id and z.company_id = new.company_id
           and z.order_id = new.order_id
           and z.settlement_id is not distinct from new.settlement_id
           and z.zero_invoice_id is not distinct from new.zero_invoice_id
      ) then
        raise exception using errcode = '23514',
          message = 'order_correction_line_zero_due_mismatch';
      end if;
      if not exists (
        select 1 from order_corrections c
         where c.id = new.correction_id and c.company_id = new.company_id
           and c.order_id = new.order_id
      ) then
        raise exception using errcode = '23514',
          message = 'order_correction_line_order_mismatch';
      end if;
      return new;
    end;
    $function$
  `.execute(database);
  await sql`
    drop trigger if exists order_correction_lines_parent_guard on order_correction_lines;
    create trigger order_correction_lines_parent_guard
      before insert on order_correction_lines
      for each row execute function validate_order_correction_line();
  `.execute(database);
  await sql`
    create or replace function reject_order_correction_mutation() returns trigger
      language plpgsql as $function$
    begin
      raise exception using errcode = '23514',
        message = 'Order corrections are append-only';
    end;
    $function$
  `.execute(database);
  await sql`
    drop trigger if exists order_corrections_append_only on order_corrections;
    create trigger order_corrections_append_only
      before update or delete on order_corrections
      for each row execute function reject_order_correction_mutation();
    drop trigger if exists order_correction_lines_append_only on order_correction_lines;
    create trigger order_correction_lines_append_only
      before update or delete on order_correction_lines
      for each row execute function reject_order_correction_mutation();
  `.execute(database);

  await sql`
    alter table company_reference_counters
      drop constraint if exists company_reference_counters_type_check,
      add constraint company_reference_counters_type_check
        check (reference_type = any (${textArray(referenceTypesAfter)}))
  `.execute(database);

  await sql`
    alter table accounting_events
      drop constraint if exists accounting_events_type_check,
      add constraint accounting_events_type_check
        check (event_type = any (${textArray(eventTypesAfter)}))
  `.execute(database);

  await sql`
    create or replace function capture_order_correction_accounting_event() returns trigger
      language plpgsql as $function$
    begin
      if new.collection_amount > 0 then
        perform enqueue_operational_accounting_event(
          new.company_id, 'driver_collections', 'driver_collection_corrected',
          'order_correction', new.id, new.correction_number, new.business_date,
          new.created_by_account_id, 'order-correction:' || new.id::text
        );
      end if;
      return new;
    end;
    $function$
  `.execute(database);
  await sql`
    drop trigger if exists order_corrections_accounting_event_capture on order_corrections;
    create trigger order_corrections_accounting_event_capture
      after insert on order_corrections
      for each row execute function capture_order_correction_accounting_event();
  `.execute(database);

  await singleActiveLinkFunction(true).execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await singleActiveLinkFunction(false).execute(database);
  await sql`
    drop trigger if exists order_corrections_accounting_event_capture on order_corrections;
    drop function if exists capture_order_correction_accounting_event();
  `.execute(database);
  await sql`
    alter table accounting_events
      drop constraint if exists accounting_events_type_check,
      add constraint accounting_events_type_check
        check (event_type = any (${textArray(eventTypesBefore)}))
  `.execute(database);
  await sql`delete from company_reference_counters where reference_type = 'order_correction'`.execute(database);
  await sql`
    alter table company_reference_counters
      drop constraint if exists company_reference_counters_type_check,
      add constraint company_reference_counters_type_check
        check (reference_type = any (${textArray(referenceTypesBefore)}))
  `.execute(database);
  await sql`drop table if exists order_correction_lines`.execute(database);
  await sql`drop table if exists order_corrections`.execute(database);
  await sql`drop function if exists reject_order_correction_mutation()`.execute(database);
  await sql`drop function if exists validate_order_correction_line()`.execute(database);
  await sql`
    alter table trader_settlement_zero_due_orders
      drop constraint if exists trader_settlement_zero_due_orders_id_company_unique
  `.execute(database);
}
