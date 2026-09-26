import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, type RawBuilder, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import {
  orderAccountingImpactTotalExpression,
  orderAccountingRequiredExpression,
} from "../operations/order-accounting-classification.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import type { RecoveryPreviewQueryDto } from "./accounting-recovery.dto.js";

/**
 * Historical Accounting recovery — read-only preview.
 *
 * ===========================================================================
 * A PREDICTION, NOT A POSTING
 * ===========================================================================
 *
 * This service writes nothing. It looks at the two known historical gaps --
 * delivered Orders without an `order_delivered` Accounting Event, and
 * Outsourced Driver fee accruals without an `outsourced_driver_fee_accrued`
 * Event or Journal -- and classifies each source record by what would happen
 * if recovery were attempted. No Event, Journal, batch or financial record is
 * created, and no historical source record is touched.
 *
 * Everything here is a prediction of what the authoritative machinery would
 * do, in the same sense as `order-accounting-classification.ts` (whose words
 * apply verbatim): a screen that claims a record is eligible is really
 * predicting what the capture trigger, the mapping resolver and the period
 * guard will decide. The predictions therefore restate none of those rules:
 *
 *  - "does this Order touch the ledger" is the imported
 *    `orderAccountingRequiredPredicate` -- the ONE shared definition, whose
 *    owner is the capture trigger;
 *  - "is this period postable" mirrors `assert_period_open_for_posting`'s own
 *    test (`open` or `reopened`), which remains the enforcer;
 *  - "are the mappings there" asks `account_mappings` the same
 *    effective-dated, exactly-one-active question `AccountMappingResolver`
 *    asks, per required mapping key, conditioned on the same source columns
 *    the operational loader reads. The resolver stays authoritative; a row
 *    this preview calls eligible can still be refused at posting time, and
 *    that asymmetry is correct -- the preview must never be MORE permissive
 *    than the poster, and never quietly becomes the poster.
 *
 * Amounts shown are the source records' own stored figures (the Order impact
 * components, the accrual's immutable `earned_amount`). Nothing is
 * recalculated from current rules: an accrual's fee is what was accrued, not
 * what today's rate card would say.
 *
 * ===========================================================================
 * BATCH COMPATIBILITY
 * ===========================================================================
 *
 * Rows carry stable, Company-scoped identity -- source type, source id,
 * source reference, expected posting type, classification and reasons -- in
 * exactly the shape `accounting_batch_items` enrols. Eligible rows are meant
 * to feed a future recovery batch type; none of the CURRENT batch types can
 * run them, because those reprocess existing Events and these rows have none.
 * `recommendedAction` says which path applies:
 *
 *  - `create_missing_event`  -- eligible; needs the future recovery batch type;
 *  - `reprocess_event`       -- an Event exists but is stuck; the existing
 *                               Event-reprocessing batch handles it today;
 *  - `review_manually`       -- reversed/duplicate/invalid states no automated
 *                               path should touch;
 *  - `none`                  -- nothing to do (already posted, no accounting
 *                               required, closed period until reopened).
 *
 * ===========================================================================
 * SHAPE
 * ===========================================================================
 *
 * One statement per request cycle: each source branch is a set-based SELECT
 * with LATERAL lookups (events, journal, period, mapping coverage), UNION'd,
 * then filtered, counted and paged. There is no per-row application loop and
 * no full-history aggregation in memory; the page, the total and the
 * classification totals are all computed by the database.
 */

/** Mapping keys each posting type needs, conditioned on its amount columns. */
const orderMappingCoverage = `
  (not exists (
    select 1 from (values
      ('order_cod_receivable', (o.customer_amount_due > 0)),
      ('trader_payable', (o.trader_net_payable > 0)),
      ('service_fee_revenue', ((case when o.financial_model_version is null
          then o.company_revenue
          else coalesce(o.service_fee_net_amount, 0) + coalesce(o.additional_fees, 0)
        end) > 0)),
      ('output_vat', (o.vat_amount > 0))
    ) as needs(mapping_key, required)
    where needs.required
      and not exists (
        select 1 from account_mappings m
         where m.company_id = o.company_id and m.mapping_key = needs.mapping_key
           and m.is_active
           and m.effective_from <= (o.delivered_at at time zone 'Asia/Dubai')::date
           and coalesce(m.effective_to, 'infinity'::date)
               >= (o.delivered_at at time zone 'Asia/Dubai')::date
      )
  ))`;

const accrualMappingCoverage = `
  (not exists (
    select 1 from (values
      ('outsourced_driver_fee_expense', (f.earned_amount > 0)),
      ('outsourced_driver_payable', (f.earned_amount > 0))
    ) as needs(mapping_key, required)
    where needs.required
      and not exists (
        select 1 from account_mappings m
         where m.company_id = f.company_id and m.mapping_key = needs.mapping_key
           and m.is_active
           and m.effective_from <= f.accrual_business_date
           and coalesce(m.effective_to, 'infinity'::date) >= f.accrual_business_date
      )
  ))`;

/**
 * Shared per-source classification, from pre-joined lateral columns.
 *
 * Precedence, top to bottom, so every row lands in exactly one class:
 * substance -> duplication -> success -> stuckness -> period -> mappings ->
 * eligible. Duplication outranks success because two posted results for one
 * source is the worse fact.
 */
function classificationCase(requiredExpression: string, mappingOk: string): string {
  return `
    case
      when not (${requiredExpression}) then 'no_accounting_required'
      when ev.active_count > 1 then 'duplicate'
      when ev.latest_status = 'ignored_duplicate' then 'duplicate'
      when ev.posted_count >= 1 then 'already_posted'
      when ev.latest_status = 'reversed' then 'blocked'
      when ev.active_count = 1 then 'blocked'
      when p.id is null then 'blocked'
      when p.status not in ('open', 'reopened') then 'closed_period'
      when not (${mappingOk}) then 'invalid_source_data'
      else 'eligible'
    end`;
}

/** Human-facing code for whatever made the row non-eligible. */
function blockingCase(requiredExpression: string, mappingOk: string): string {
  return `
    case
      when not (${requiredExpression}) then null
      when ev.active_count > 1 then 'accounting_event_duplicate'
      when ev.latest_status = 'ignored_duplicate' then 'accounting_event_duplicate'
      when ev.posted_count >= 1 then null
      when ev.latest_status = 'reversed' then 'accounting_event_reversed'
      when ev.active_count = 1 then 'accounting_event_not_posted'
      when p.id is null then 'accounting_period_missing'
      when p.status not in ('open', 'reopened') then 'accounting_period_not_open'
      when not (${mappingOk}) then 'accounting_event_mapping_missing'
      else null
    end`;
}

/** What a person (or a future batch) should do about the row. */
function actionCase(requiredExpression: string, mappingOk: string): string {
  return `
    case
      when not (${requiredExpression}) then 'none'
      when ev.active_count > 1 then 'review_manually'
      when ev.latest_status = 'ignored_duplicate' then 'review_manually'
      when ev.posted_count >= 1 then 'none'
      when ev.latest_status = 'reversed' then 'review_manually'
      when ev.active_count = 1 then 'reprocess_event'
      when p.id is null then 'review_manually'
      when p.status not in ('open', 'reopened') then 'none'
      when not (${mappingOk}) then 'review_manually'
      else 'create_missing_event'
    end`;
}

/**
 * Latest-event lateral, per source row.
 *
 * `active_count` excludes `reversed` and `ignored_duplicate` -- a reversed
 * posting is not a live claim on the source, and an ignored duplicate never
 * was. The latest event (by version, then recency) supplies the reference the
 * row links to.
 */
function eventLateral(sourceType: string, eventType: string, alias: string): string {
  return `
    left join lateral (
      select count(*) filter (where e.processing_status not in ('reversed', 'ignored_duplicate'))
               ::int as active_count,
             count(*) filter (where e.processing_status = 'posted')::int as posted_count,
             (array_agg(e.id order by e.event_version desc, e.created_at desc))[1] as event_id,
             (array_agg(e.processing_status
                order by e.event_version desc, e.created_at desc))[1] as latest_status,
             (array_agg(e.source_reference
                order by e.event_version desc, e.created_at desc))[1] as event_reference,
             (array_agg(e.journal_id order by e.event_version desc, e.created_at desc))[1]
               as journal_id
        from accounting_events e
       where e.company_id = ${alias}.company_id and e.source_entity_type = '${sourceType}'
         and e.source_entity_id = ${alias}.id and e.event_type = '${eventType}'
    ) ev on true`;
}

/** Non-adjustment accounting period covering the row's accounting date. */
function periodLateral(alias: string, dateExpression: string): string {
  return `
    left join lateral (
      select ap.id, ap.status
        from accounting_periods ap
       where ap.company_id = ${alias}.company_id
         and ${dateExpression} between ap.period_start and ap.period_end
       order by ap.is_adjustment_period, ap.period_start
       limit 1
    ) p on true`;
}

const sortColumns = {
  accountingDate: `"accountingDate"`,
  amount: `"amount"::numeric`,
  classification: `"classification"`,
  sourceDate: `"sourceDate"`,
  sourceReference: `"sourceReference"`,
} as const;

@Injectable()
export class AccountingRecoveryService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(AccountingOperationSupport) private readonly support: AccountingOperationSupport,
  ) {}

  public async preview(query: RecoveryPreviewQueryDto) {
    this.support.assertAnyPermission("accounting.post", "accounting.manage");
    const { companyId } = this.support.context();
    const { limit, offset, page, pageSize } = this.support.pagination(query);
    const { column, direction, sortBy, sortDirection } = this.support.sorting(
      query,
      sortColumns,
      "accountingDate",
    );
    const sourceType = query.sourceType ?? null;
    const classification = query.classification ?? null;
    const dateFrom = query.dateFrom ?? null;
    const dateTo = query.dateTo ?? null;
    const reference = query.sourceReference?.trim() ?? "";

    const rows = this.rowsFragment(companyId);
    const filters = sql`
      (${sourceType}::text is null or "sourceType" = ${sourceType})
      and (${classification}::text is null or "classification" = ${classification})
      and (${dateFrom}::date is null or "accountingDate" >= ${dateFrom}::date)
      and (${dateTo}::date is null or "accountingDate" <= ${dateTo}::date)
      and (${reference} = '' or "sourceReference" ilike '%' || ${reference} || '%')
    `;

    const [items, classificationTotals] = await Promise.all([
      sql<Record<string, unknown>>`
        with recovery_rows as (${rows})
        select *, count(*) over ()::int as "filteredTotal"
          from recovery_rows
         where ${filters}
         order by ${sql.raw(sortColumns[sortBy])} ${sql.raw(direction)}, "sourceId"
         limit ${limit} offset ${offset}
      `.execute(this.database),
      // Classification totals are for the WHOLE gap surface (source-type and
      // date filters applied, classification filter not), so the screen can
      // show "eligible: N of M" without a second scan per class.
      sql<{ classification: string; count: number; sourceType: string }>`
        with recovery_rows as (${rows})
        select "sourceType", "classification", count(*)::int as count
          from recovery_rows
         where (${sourceType}::text is null or "sourceType" = ${sourceType})
           and (${dateFrom}::date is null or "accountingDate" >= ${dateFrom}::date)
           and (${dateTo}::date is null or "accountingDate" <= ${dateTo}::date)
           and (${reference} = '' or "sourceReference" ilike '%' || ${reference} || '%')
         group by "sourceType", "classification"
      `.execute(this.database),
    ]);

    const total =
      items.rows.length > 0
        ? Number(items.rows[0]!.filteredTotal)
        : classification === null
          ? classificationTotals.rows.reduce((sum, row) => sum + row.count, 0)
          : classificationTotals.rows
              .filter((row) => row.classification === classification)
              .reduce((sum, row) => sum + row.count, 0);

    return {
      items: items.rows.map(({ filteredTotal: _ignored, ...row }) => row),
      metadata: {
        // The preview never creates anything; saying so in the payload keeps a
        // future consumer from assuming otherwise.
        executionAvailable: false,
        note: "Read-only preview. Eligible rows require a future recovery batch type; rows with a stuck Event use the existing Event-reprocessing batch.",
        supportedSources: ["order", "outsourced_driver_fee_accrual"],
      },
      page,
      pageSize,
      sortBy,
      sortDirection,
      total,
      totals: classificationTotals.rows,
    };
  }

  /**
   * Authoritative classification for SPECIFIC sources, for batch creation and
   * revalidation. The same fragment the preview renders — one classifier, two
   * consumers — restricted to the requested ids. A source that does not exist
   * or belongs to another Company is simply absent from the result, so the
   * caller reports "not found" without revealing anything.
   */
  public async classifySources(sourceIds: readonly string[]) {
    if (sourceIds.length === 0) return [];
    const { companyId } = this.support.context();
    const ids = [...new Set(sourceIds)];
    const result = await sql<Record<string, unknown>>`
      with recovery_rows as (${this.rowsFragment(companyId, ids)})
      select * from recovery_rows
    `.execute(this.database);
    return result.rows;
  }

  /**
   * The unioned source rows, as one reusable fragment so the page query, the
   * totals query and the batch revalidation cannot drift apart. `sourceIds`
   * narrows both branches to the requested records.
   */
  private rowsFragment(companyId: string, sourceIds?: readonly string[]): RawBuilder<unknown> {
    // The ONE shared "does this Order touch the ledger" definition, imported --
    // never restated here. See order-accounting-classification.ts.
    const orderRequired = orderAccountingRequiredExpression;
    const accrualRequired = `f.earned_amount <> 0`;
    return sql`
      select 'order' as "sourceType", o.id as "sourceId",
             o.order_number as "sourceReference", o.order_date as "sourceDate",
             (o.delivered_at at time zone 'Asia/Dubai')::date as "accountingDate",
             ${sql.raw(orderAccountingImpactTotalExpression)}::numeric(18,2)::text as "amount",
             'order_delivered' as "expectedPostingType",
             ${sql.raw(classificationCase(orderRequired, orderMappingCoverage))}
               as "classification",
             ev.event_id as "accountingEventId", ev.event_reference as "accountingEventReference",
             ev.journal_id as "journalId", j.journal_number as "journalNumber",
             p.id as "fiscalPeriodId", p.status as "fiscalPeriodStatus",
             ${sql.raw(blockingCase(orderRequired, orderMappingCoverage))} as "blockingCode",
             ${sql.raw(actionCase(orderRequired, orderMappingCoverage))} as "recommendedAction"
        from orders o
        ${sql.raw(eventLateral("order", "order_delivered", "o"))}
        left join journal_entries j on j.id = ev.journal_id and j.company_id = o.company_id
        ${sql.raw(periodLateral("o", `(o.delivered_at at time zone 'Asia/Dubai')::date`))}
       where o.company_id = ${companyId}::uuid
         -- Only Orders with an AUTHORITATIVE delivery moment. Delivery status
         -- alone is not evidence, and a missing timestamp is never guessed.
         and o.delivered_at is not null
         and (${sourceIds === undefined}::boolean or o.id = any(${sourceIds ?? []}::uuid[]))
      union all
      select 'outsourced_driver_fee_accrual', f.id, f.source_reference,
             f.delivery_date::date, f.accrual_business_date,
             -- The IMMUTABLE accrued figure, never recalculated from current
             -- fee rules.
             f.earned_amount::numeric(18,2)::text,
             'outsourced_driver_fee_accrued',
             ${sql.raw(classificationCase(accrualRequired, accrualMappingCoverage))},
             ev.event_id, ev.event_reference, ev.journal_id, j.journal_number,
             p.id, p.status,
             ${sql.raw(blockingCase(accrualRequired, accrualMappingCoverage))},
             ${sql.raw(actionCase(accrualRequired, accrualMappingCoverage))}
        from outsourced_driver_fee_accruals f
        ${sql.raw(
          eventLateral("outsourced_driver_fee_accrual", "outsourced_driver_fee_accrued", "f"),
        )}
        left join journal_entries j on j.id = ev.journal_id and j.company_id = f.company_id
        ${sql.raw(periodLateral("f", "f.accrual_business_date"))}
       where f.company_id = ${companyId}::uuid
         -- A reversed accrual withdrew its claim; recovery must not repost it.
         and f.status <> 'reversed'
         and (${sourceIds === undefined}::boolean or f.id = any(${sourceIds ?? []}::uuid[]))
    `;
  }
}
