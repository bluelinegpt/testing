import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Make operational Accounting Event CAPTURE durable and independent of
 * Automatic Posting enablement.
 *
 * `enqueue_operational_accounting_event` is the helper every operational
 * capture trigger delegates to (Orders, Trader Settlements, Trader
 * Receivables, Trader Collections, Driver Collections, Payroll Periods,
 * Payroll Payments, Outsourced Driver Fee accruals and payments). It opened
 * with a gate that required the area to ALREADY be enabled for Automatic
 * Posting, and returned silently otherwise — no Event, no error, no log.
 *
 * That conflated two different decisions:
 *
 *   - WHETHER THE BUSINESS FACT IS RECORDED  (must always happen)
 *   - WHETHER IT IS POSTED TO THE LEDGER     (a Company control)
 *
 * The consequence was permanent, silent loss. ORD-000016 was delivered
 * correctly through the authoritative transition and its trigger fired, but
 * because `orders` was absent from `automatic_posting_areas` no
 * `order_delivered` Event was ever written. Enabling the area later recovers
 * nothing, because the transition has already passed. At the time of this
 * migration 13 delivered Orders had no Accounting Event for this reason.
 *
 * The correct gate already exists downstream: `AccountingEventRepository.next()`
 * refuses to CLAIM an Event unless `accounting_enabled` and
 * `automatic_posting_enabled` are true and the Event's `operational_area` is in
 * `automatic_posting_areas`. Events therefore accumulate as `received` and are
 * turned into Journals only when the Company enables that area — so removing
 * the capture-time gate changes when facts are recorded, never when they post.
 * No Journal can be produced for a disabled area by this change.
 *
 * This also makes the trigger path consistent with the application path:
 * `GeneralExpenseAccountingEventWriter.enqueue` and
 * `CashBankManagementService.enqueueEvent` already insert unconditionally.
 *
 * `accounting_enabled` is deliberately RETAINED: a Company that has not
 * activated Accounting at all should still record nothing.
 *
 * Everything below the gate is byte-identical to the definition installed by
 * `20260801120000_accounting_operational_integration.ts` — the reversal
 * lookup, the stable key and hash, the insert column list and values, and the
 * `on conflict … do nothing` idempotency guard are all unchanged. Only the
 * five lines of the opening gate differ.
 *
 * Additive and reversible: `create or replace function` touches no table, no
 * row and no constraint. `down()` restores the previous body exactly.
 */

const body = (gate: string) => `
    declare
      original_event_id uuid;
      stable_key text;
      stable_hash text;
    begin
${gate}
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

/** Capture depends only on Accounting being activated for the Company. */
const durableGate = `      if not exists (
        select 1 from accounting_configurations c
         where c.company_id=event_company_id
           and c.accounting_enabled
      ) then
        return;
      end if;`;

/** The previous gate, which also required the area to be enabled for posting. */
const areaGatedGate = `      if not exists (
        select 1 from accounting_configurations c
         where c.company_id=event_company_id
           and c.accounting_enabled and c.automatic_posting_enabled
           and event_area=any(c.automatic_posting_areas)
      ) then
        return;
      end if;`;

const declaration = `create or replace function enqueue_operational_accounting_event(
    event_company_id uuid,
    event_area text,
    event_type_value text,
    source_type_value text,
    source_id_value uuid,
    source_reference_value text,
    accounting_date_value date,
    actor_id_value uuid,
    operation_id_value text,
    reversal_source_type text default null,
    reversal_source_id uuid default null
  ) returns void language plpgsql as $function$`;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql.raw(`${declaration}${body(durableGate)}$function$;`).execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql.raw(`${declaration}${body(areaGatedGate)}$function$;`).execute(database);
}
