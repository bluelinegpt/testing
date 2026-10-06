import { type RawBuilder, sql } from "kysely";

/**
 * HISTORICAL vs EFFECTIVE Trader Settlement receivable offsets.
 *
 * `trader_settlement_receivable_offsets` is an append-only history. A row is
 * never deleted -- not when its Settlement is reversed, and not when one of
 * its Receivables is reversed on its own (`ReceivableOffsetReversalService`).
 * So a Receivable can legitimately carry several offset rows:
 *
 *   SET-A          confirmed   offsets RCV-1 by 20   <- HISTORICAL (reversed)
 *   SET-A-REV      confirmed   reversal_of_id = SET-A (writes no offset row)
 *   SET-B          confirmed   offsets RCV-1 by 20   <- EFFECTIVE
 *
 * That is ONE effective settlement of RCV-1, not two. Any reader that sums
 * every offset row double-counts it.
 *
 * An offset is EFFECTIVE when its Settlement:
 *   - is `confirmed`;
 *   - is not itself a reversal (`reversal_of_id is null`); and
 *   - has not been reversed (no Settlement points at it with `reversal_of_id`).
 *
 * Reading only. Nothing here writes, deletes or reinterprets a stored row: the
 * historical offsets stay exactly where they are and remain listed (flagged
 * `effective = false`) wherever the history is shown.
 */

function ref(alias: string): RawBuilder<unknown> {
  if (!/^[a-z_][a-z0-9_]*$/u.test(alias)) throw new Error(`Unsafe SQL alias: ${alias}`);
  return sql.raw(alias);
}

/** Is the Settlement aliased `settlementAlias` effective (see above)? */
export function effectiveSettlement(settlementAlias = "s"): RawBuilder<boolean> {
  const s = ref(settlementAlias);
  return sql<boolean>`(
    ${s}.status = 'confirmed'
    and ${s}.reversal_of_id is null
    and not exists (
      select 1 from trader_settlements effective_reversal
       where effective_reversal.company_id = ${s}.company_id
         and effective_reversal.reversal_of_id = ${s}.id
    )
  )`;
}

/**
 * Is the offset row aliased `offsetAlias` effective? Looks its Settlement up
 * itself, so a reader that has not joined `trader_settlements` can use it.
 */
export function effectiveOffset(offsetAlias = "x"): RawBuilder<boolean> {
  const x = ref(offsetAlias);
  return sql<boolean>`exists (
    select 1 from trader_settlements effective_settlement
     where effective_settlement.company_id = ${x}.company_id
       and effective_settlement.id = ${x}.settlement_id
       and ${effectiveSettlement("effective_settlement")}
  )`;
}

/**
 * The effective offset total of the Receivable aliased `receivableAlias`
 * (numeric, 0 when none).
 */
export function effectiveOffsetTotal(receivableAlias = "r"): RawBuilder<string> {
  const r = ref(receivableAlias);
  return sql<string>`coalesce((
    select sum(effective_total_offset.amount_allocated)
      from trader_settlement_receivable_offsets effective_total_offset
     where effective_total_offset.company_id = ${r}.company_id
       and effective_total_offset.receivable_id = ${r}.id
       and ${effectiveOffset("effective_total_offset")}
  ), 0)`;
}

/**
 * How many DISTINCT effective Settlements offset the Receivable aliased
 * `receivableAlias`. More than one is an integrity failure; a reversed
 * Settlement followed by a new one is not.
 */
export function effectiveSettlementCount(receivableAlias = "r"): RawBuilder<number> {
  const r = ref(receivableAlias);
  return sql<number>`(
    select count(distinct effective_count_offset.settlement_id)::int
      from trader_settlement_receivable_offsets effective_count_offset
     where effective_count_offset.company_id = ${r}.company_id
       and effective_count_offset.receivable_id = ${r}.id
       and ${effectiveOffset("effective_count_offset")}
  )`;
}
