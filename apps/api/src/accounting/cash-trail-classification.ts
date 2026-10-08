import { type RawBuilder, sql } from "kysely";

/**
 * How a `cash_bank_movements` row affects the operational cash balance.
 *
 * ===========================================================================
 * THE PROBLEM THIS SOLVES
 * ===========================================================================
 *
 * Several operations write a confirmed Movement automatically, as the cash
 * trail of another operational record. Two kinds exist and they must be
 * treated differently:
 *
 *   DUPLICATE TRAILS -- Trader Settlement payments, Payroll payments,
 *   Employee (advance / interim) payments, outsourced Driver fee payments and
 *   General Expense payments. The balance ALREADY counts the payment row
 *   itself (`CashBankQueryService.balances`), so the trail must not be
 *   counted again.
 *
 *   INFLOW TRAILS -- Trader Collections and Driver Cash reconciliations. No
 *   other leg of the balance counts this cash, so the trail IS the record of
 *   money arriving in the drawer: it counts once, and stops counting once its
 *   source is reversed (neither reversal writes a counter-Movement).
 *
 * With GL Accounting ON every trail is linked to its owner's Accounting
 * Event, and the long-standing rule -- a Movement linked to a non-Cash/Bank
 * Event is not counted -- applies. That rule, and therefore every
 * Accounting-ON balance, is left exactly as it was.
 *
 * With GL Accounting OFF there is no Event. Trails written by this codebase
 * since Phase 1 Prompt 2 carry `generated_by_source_type`. Trails written
 * EARLIER by Companies already running OFF carry nothing; they are
 * recognised here, at query time, from immutable source relationships --
 * the trail's `correlation_id` is its source record's id (payment numbers for
 * General Expenses) -- without rewriting a single historical row.
 *
 * ===========================================================================
 * SCOPE GUARD
 * ===========================================================================
 *
 * The derived classification applies only to a Movement that has no
 * Accounting Event AND was confirmed while the Company's GL Accounting was
 * OFF (`accounting_enabled_at`, from the configuration history). A Movement
 * confirmed while ON is judged by the original rule alone, so no
 * Accounting-ON balance can move because of this module.
 */

/*
 * Every predicate below is two-valued (never SQL NULL): a NULL inside a
 * `not (...)` would silently drop a row from the balance.
 */
function ref(alias: string): RawBuilder<unknown> {
  if (!/^[a-z_][a-z0-9_]*$/u.test(alias)) throw new Error(`Unsafe SQL alias: ${alias}`);
  return sql.raw(alias);
}

/** The original rule: linked to a non-Cash/Bank Accounting Event. */
export function linkedToOwnerEvent(alias = "m"): RawBuilder<boolean> {
  const m = ref(alias);
  return sql<boolean>`exists (
    select 1 from accounting_events e
     where e.id = ${m}.accounting_event_id and e.company_id = ${m}.company_id
       and e.source_entity_type <> 'cash_bank_movement'
  )`;
}

/** Event-less and confirmed while GL Accounting was OFF. */
function offEraUnlinked(alias: string): RawBuilder<boolean> {
  const m = ref(alias);
  return sql<boolean>`(
    ${m}.accounting_event_id is null
    and not coalesce(accounting_enabled_at(${m}.company_id, coalesce(${m}.confirmed_at, ${m}.created_at)), false)
  )`;
}

/** A trail of a payment the balance already counts from its own table. */
export function duplicatePaymentTrail(alias = "m"): RawBuilder<boolean> {
  const m = ref(alias);
  return sql<boolean>`(
    coalesce(${m}.generated_by_source_type in (
      'trader_settlement','payroll_payment','employee_payment','general_expense_payment'
    ), false)
    or exists (select 1 from trader_settlements s
                where s.company_id = ${m}.company_id and s.id::text = ${m}.correlation_id)
    or exists (select 1 from payroll_payments p
                where p.company_id = ${m}.company_id and p.id::text = ${m}.correlation_id)
    or exists (select 1 from employee_salary_advances a
                where a.company_id = ${m}.company_id and a.id::text = ${m}.correlation_id)
    or exists (select 1 from employee_variable_earning_payments v
                where v.company_id = ${m}.company_id and v.id::text = ${m}.correlation_id)
    or exists (select 1 from outsourced_driver_fee_payments f
                where f.company_id = ${m}.company_id and f.id::text = ${m}.correlation_id)
    or (${m}.idempotency_identity like 'general\\_expense\\_payment:%'
        and exists (select 1 from general_expense_payments g
                     where g.company_id = ${m}.company_id
                       and g.payment_number = split_part(${m}.idempotency_identity, ':', 2)))
  )`;
}

/** A trail that is the only record of cash ARRIVING in the drawer. */
export function inflowTrail(alias = "m"): RawBuilder<boolean> {
  const m = ref(alias);
  return sql<boolean>`(
    coalesce(${m}.generated_by_source_type = 'trader_collection', false)
    or exists (select 1 from trader_collections c
                where c.company_id = ${m}.company_id and c.id::text = ${m}.correlation_id)
    or exists (select 1 from driver_reconciliations r
                where r.company_id = ${m}.company_id and r.id::text = ${m}.correlation_id)
  )`;
}

/** The inflow's source has been reversed (no counter-Movement is ever written). */
function inflowSourceReversed(alias: string): RawBuilder<boolean> {
  const m = ref(alias);
  return sql<boolean>`(
    exists (select 1 from trader_collections c
             where c.company_id = ${m}.company_id and c.id::text = ${m}.correlation_id
               and c.status = 'reversed')
    or exists (select 1 from driver_reconciliations r
                where r.company_id = ${m}.company_id and r.id::text = ${m}.correlation_id
                  and exists (select 1 from driver_reconciliations rv
                               where rv.company_id = r.company_id and rv.reversal_of_id = r.id))
  )`;
}

/**
 * Does this Movement count in the operational cash balance?
 *
 * Accounting-ON rows: exactly the original rule. Accounting-OFF rows:
 * duplicate trails never count; inflow trails count until their source is
 * reversed; everything else counts.
 */
export function countsInOperationalBalance(alias = "m"): RawBuilder<boolean> {
  return sql<boolean>`(
    not ${linkedToOwnerEvent(alias)}
    and (
      not ${offEraUnlinked(alias)}
      or (
        not ${duplicatePaymentTrail(alias)}
        and not (${inflowTrail(alias)} and ${inflowSourceReversed(alias)})
      )
    )
  )`;
}

/**
 * Does the manual REVERSAL of the Movement aliased `originalAlias` move the
 * operational balance back? Only if the original itself counted. Applied to
 * Accounting-OFF-era originals only: for every other original the reversal
 * leg is kept exactly as it was, so no Accounting-ON balance moves.
 */
export function reversalCountsInOperationalBalance(originalAlias = "o"): RawBuilder<boolean> {
  return sql<boolean>`(
    not ${offEraUnlinked(originalAlias)} or ${countsInOperationalBalance(originalAlias)}
  )`;
}

/**
 * Should this Movement be LISTED as its own cash activity, next to the source
 * tables (Collections, reconciliations, payments) that activity feeds already
 * list? Accounting-ON rows: the original rule. Accounting-OFF rows: no
 * generated trail of either kind is listed twice.
 */
export function listedAsOwnActivity(alias = "m"): RawBuilder<boolean> {
  const m = ref(alias);
  return sql<boolean>`(
    not ${linkedToOwnerEvent(alias)}
    and ${m}.generated_by_source_type is null
    and not (
      ${offEraUnlinked(alias)}
      and (${duplicatePaymentTrail(alias)} or ${inflowTrail(alias)})
    )
  )`;
}
