import { Decimal } from "decimal.js";
import { type Kysely, type RawBuilder, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * TRADER RECEIVABLE FINANCIAL DEPENDENCIES -- the ONE definition.
 *
 * Every financial fact that can hang off a Trader Receivable. Used by:
 *   - Delete / Reset (`OrderMaintenanceService`): a Receivable may be
 *     PHYSICALLY deleted only when every count is zero;
 *   - the Repair Center (Phase 3 Prompt 3): a Receivable may be CANCELLED by
 *     the Platform (status only, row kept) only when it carries no financial
 *     dependency of the kinds its capability names.
 */
export interface TraderReceivableDependencies {
  /** `trader_collection_allocations` -- physical Trader Collections (any status). */
  readonly collectionCount: number;
  /** `trader_settlement_receivable_offsets` -- Settlement netting (any status). */
  readonly offsetCount: number;
  /** `accounting_events` whose source is this Receivable. */
  readonly accountingEventCount: number;
  /** Journals sourced from, or journal lines sub-ledgered to, this Receivable. */
  readonly journalCount: number;
  /** `trader_credits` that name this Receivable (any status). */
  readonly traderCreditCount: number;
  /** `amount_collected` > 0: money has been applied to it by any route. */
  readonly amountCollected: string;
}

/** Zero financial dependencies of any kind -- the ONLY case a DELETE is allowed. */
export function hasNoFinancialDependencies(row: TraderReceivableDependencies): boolean {
  return hasNoOperationalActivity(row) && row.accountingEventCount === 0 && row.journalCount === 0;
}

/**
 * No collection, offset or credit has ever touched the Receivable and no money
 * is applied to it. (Accounting recognition is judged separately.)
 */
export function hasNoOperationalActivity(row: TraderReceivableDependencies): boolean {
  return (
    row.collectionCount === 0 &&
    row.offsetCount === 0 &&
    row.traderCreditCount === 0 &&
    new Decimal(row.amountCollected).isZero()
  );
}

function ref(alias: string): RawBuilder<unknown> {
  if (!/^[a-z_][a-z0-9_]*$/u.test(alias)) throw new Error(`Unsafe SQL alias: ${alias}`);
  return sql.raw(alias);
}

/** The dependency counts of the receivable row aliased `alias`, as select-list columns. */
export function receivableDependencyColumnsSql(alias = "r"): RawBuilder<unknown> {
  const r = ref(alias);
  return sql`
             ${r}.amount_collected::text as "amountCollected",
             (select count(*)::int from trader_collection_allocations a
               where a.company_id=${r}.company_id and a.receivable_id=${r}.id) as "collectionCount",
             (select count(*)::int from trader_settlement_receivable_offsets x
               where x.company_id=${r}.company_id and x.receivable_id=${r}.id) as "offsetCount",
             (select count(*)::int from accounting_events e
               where e.company_id=${r}.company_id and e.source_entity_type='trader_receivable'
                 and e.source_entity_id=${r}.id) as "accountingEventCount",
             (select count(*)::int from journal_entries j
               where j.company_id=${r}.company_id
                 and ((j.source_entity_type='trader_receivable' and j.source_entity_id=${r}.id)
                   or exists(select 1 from journal_lines l
                              where l.company_id=j.company_id and l.journal_entry_id=j.id
                                and l.subledger_id=${r}.id))) as "journalCount",
             (select count(*)::int from trader_credits c
               where c.company_id=${r}.company_id and c.source_receivable_id=${r}.id) as "traderCreditCount"`;
}

/** Dependencies of the given receivables of ONE Company (one bounded statement). */
export async function loadReceivableDependencies(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  companyId: string,
  receivableIds: readonly string[],
): Promise<Map<string, TraderReceivableDependencies>> {
  if (receivableIds.length === 0) return new Map();
  const rows = (
    await sql<TraderReceivableDependencies & { id: string }>`
      select r.id::text as id, ${receivableDependencyColumnsSql("r")}
        from trader_receivables r
       where r.company_id=${companyId}::uuid
         and r.id in (${sql.join(receivableIds.map((id) => sql`${id}::uuid`))})
    `.execute(db)
  ).rows;
  return new Map(rows.map(({ id, ...dependencies }) => [id, dependencies]));
}
