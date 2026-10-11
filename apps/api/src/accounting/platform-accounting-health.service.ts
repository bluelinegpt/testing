import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { accountingEventTypes } from "./accounting.constants.js";
import { accountingSupportOf, CERTIFIED_SOURCE_TYPES, recoveryDecisionOf } from "./platform-accounting-repair.adapter.js";

/**
 * PLATFORM REPAIR CENTER -- ACCOUNTING HEALTH (Phase 2, Prompt 4). Read-only.
 *
 * One selected Company's accounting events, triaged SET-BASED in a single SQL
 * statement per request (summary: one; list: one, with the total from a window
 * count). No per-event query, no per-event precheck.
 *
 * The triage applies every condition that can be decided from stored state
 * (status, journal, Accounting Mode, supported type, ambiguous duplicates,
 * missing actor, automatic posting / area, open fiscal period). It can NOT
 * prove a mapping resolves or a Journal balances -- that needs the certified
 * posting dry run, which is per event. So the list never claims READY: an
 * event that passes every set-based condition is a READY_CANDIDATE, and only
 * the per-event preview (PlatformAccountingRepairAdapter.inspect, the full
 * certified precheck) can say READY.
 *
 * PHASE 4 PROMPT 1 -- ONE accounting-health model (HEALTHY / ISSUE / REVIEW):
 *   ISSUE   an unresolved supported event (failed / blocked), a REQUIRED event
 *           that is missing, or a Journal-integrity defect of a posted event
 *           (posted without Journal, unbalanced, wrong linkage, the same
 *           source posted twice);
 *   REVIEW  history only a person can judge (unsupported / out-of-scope /
 *           ambiguous events).
 * Missing events and integrity defects are detected set-based in the SAME
 * summary statement and listed by `integrity()` (one statement). None of them
 * is ever recovered automatically: no Journal is created blindly, no
 * balancing line is inserted, no history is deleted -- MANUAL_REVIEW.
 */

export type AccountingTriage = "NOT_REQUIRED" | "READY_CANDIDATE" | "BLOCKED" | "MANUAL_REVIEW";
export const ACCOUNTING_TRIAGES: readonly AccountingTriage[] = [
  "NOT_REQUIRED",
  "READY_CANDIDATE",
  "BLOCKED",
  "MANUAL_REVIEW",
];
export const ACCOUNTING_HEALTH_STATUSES = [
  "attention",
  "failed",
  "blocked_configuration",
  "received",
  "retry_pending",
  "processing",
  "posted",
  "ignored_duplicate",
  "ignored_no_accounting_required",
  "reversed",
  "all",
] as const;
export type AccountingHealthStatusFilter = (typeof ACCOUNTING_HEALTH_STATUSES)[number];
export const ACCOUNTING_HEALTH_MAX_PAGE_SIZE = 100;

export interface AccountingHealthSummary {
  readonly companyId: string;
  readonly accountingMode: { readonly enabled: boolean; readonly automaticPostingEnabled: boolean };
  /** OFF: GL recovery is not required for new operational activity. */
  readonly accountingHealth: "HEALTHY" | "ISSUE" | "REVIEW" | "NOT_APPLICABLE";
  readonly totalEvents: number;
  readonly failed: number;
  readonly blockedConfiguration: number;
  readonly pending: number;
  readonly processing: number;
  readonly stuck: number;
  readonly blocked: number;
  readonly readyCandidates: number;
  readonly manualReview: number;
  /** Unresolved events recorded while/now that GL Accounting is OFF. */
  readonly historicalWhileOff: number;
  readonly byEventType: readonly { readonly eventType: string; readonly unresolved: number }[];
  /** Phase 4 Prompt 1: Journal integrity of posted events (ISSUE, MANUAL_REVIEW). */
  readonly integrity: {
    readonly postedWithoutJournal: number;
    readonly unbalancedJournals: number;
    readonly linkageMismatches: number;
    readonly duplicateEffectivePostings: number;
    readonly total: number;
  };
  /** Phase 4 Prompt 1: required events that were never captured (ISSUE, MANUAL_REVIEW). */
  readonly missingRequiredEvents: {
    readonly total: number;
    readonly byEventType: readonly { readonly eventType: string; readonly missing: number }[];
  };
  /** The simple headline(s): details appear only after opening a finding. */
  readonly headlines: readonly string[];
  readonly note: string;
  /** Prompt 5, Part K: `readyCandidates` are candidates, never READY. */
  readonly readyCandidateNote: string;
  readonly generatedAt: string;
}

export interface AccountingHealthRow {
  readonly eventId: string;
  readonly businessReference: string | null;
  readonly sourceType: string;
  readonly eventType: string;
  readonly status: string;
  readonly triage: AccountingTriage;
  readonly triageCode: string;
  /**
   * Prompt 5, Part K: true for a READY_CANDIDATE -- the full certified
   * precheck has NOT run; only the per-event preview can say READY.
   */
  readonly previewRequired: boolean;
  readonly finding: string;
  readonly lastFailure: string | null;
  readonly failureCode: string | null;
  readonly attempts: number;
  readonly accountingDate: string;
  readonly failedAt: string | null;
}

export interface AccountingHealthPage {
  readonly items: readonly AccountingHealthRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly generatedAt: string;
}

export const ACCOUNTING_INTEGRITY_KINDS = ["JOURNAL_INTEGRITY", "MISSING_REQUIRED_EVENT"] as const;
export type AccountingIntegrityKind = (typeof ACCOUNTING_INTEGRITY_KINDS)[number];

/**
 * One integrity / missing-event finding. Always MANUAL_REVIEW for the
 * Platform: the row carries what the administrator needs to investigate.
 */
export interface AccountingIntegrityRow {
  readonly kind: AccountingIntegrityKind;
  readonly code: string;
  readonly health: "ISSUE" | "REVIEW";
  readonly repairability: "MANUAL_REVIEW";
  readonly headline: string;
  readonly eventId: string | null;
  readonly eventType: string;
  readonly eventStatus: string | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly businessReference: string | null;
  readonly occurredOn: string | null;
  readonly journal: {
    readonly journalNumber: string | null;
    readonly status: string | null;
    readonly debit: string | null;
    readonly credit: string | null;
    readonly lines: number;
    readonly periodStatus: string | null;
  } | null;
  readonly actor: { readonly state: "VALID" | "MISSING" | "INVALID" };
  /** Missing events: the capture inputs (source state, date, actor) are deterministic. */
  readonly reconstructable: boolean | null;
  /** Missing events: the certified capture path that may record it, or null. */
  readonly certifiedCapture: "COMPANY_HISTORICAL_RECOVERY" | null;
  readonly reason: string;
  readonly whyNotAutomatic: string;
  readonly recommendedInvestigation: string;
  /** The audited Platform recovery decision for the event type. */
  readonly decision: string | null;
}

export interface AccountingIntegrityPage {
  readonly items: readonly AccountingIntegrityRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly generatedAt: string;
}

export interface AccountingIntegrityQuery {
  readonly kind?: AccountingIntegrityKind | undefined;
  readonly eventType?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

export const ACCOUNTING_HEALTH_HEADLINES = {
  failed: "ISSUE — Accounting event failed.",
  missing: "ISSUE — Required accounting event is missing.",
  integrity: "ISSUE — Accounting journal does not match its event.",
  review: "REVIEW — Accounting history requires manual review.",
} as const;

const INTEGRITY_TEXT: Readonly<Record<string, { reason: string; why: string; investigate: string }>> = {
  ACCOUNTING_POSTED_WITHOUT_JOURNAL: {
    investigate:
      "Compare the event timeline with the Journal register for this source; establish whether the posting happened under another event or was removed.",
    reason: "The event is recorded as posted but has no posted Journal.",
    why: "A Journal is never created blindly: whether the original posting happened must be proven first.",
  },
  ACCOUNTING_JOURNAL_UNBALANCED: {
    investigate: "Compare the Journal lines with the source's financial components to find the missing or altered line.",
    reason: "The event's Journal is not balanced (or has fewer than two lines).",
    why: "A balancing line is never inserted. Only a certified reversal and repost, decided by a person, corrects it.",
  },
  ACCOUNTING_JOURNAL_LINKAGE_MISMATCH: {
    investigate: "Identify which event owns the Journal and which source it posts; confirm the source was not posted twice.",
    reason: "The Journal and the event do not point at each other / the same source, or a Journal exists for an event that is not posted.",
    why: "Re-linking or reprocessing could create a second effective Journal; the intended posting is not provable.",
  },
  ACCOUNTING_DUPLICATE_EFFECTIVE_POSTING: {
    investigate: "List every posted event and Journal for this source and decide which is the intended posting.",
    reason: "More than one posted event of the same type covers the same source: it is posted more than once.",
    why: "History is never deleted automatically; the duplicate is reversed through the Company's certified Journal reversal.",
  },
  ACCOUNTING_REQUIRED_EVENT_MISSING: {
    investigate:
      "Confirm the source still stands as recorded and GL Accounting was ON when it happened; then capture the event through the certified Company path.",
    reason: "The operation happened while GL Accounting was ON, but its accounting event was never captured.",
    why:
      "The Platform does not capture accounting events: a new event would be attributed to a Company user on a Platform decision. Orders have a certified Company-side capture (Historical Recovery); other types have none.",
  },
};

export interface AccountingHealthQuery {
  readonly status?: AccountingHealthStatusFilter | undefined;
  readonly eventType?: string | undefined;
  readonly repairability?: AccountingTriage | undefined;
  readonly reference?: string | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

const FINDING: Readonly<Record<string, string>> = {
  ACCOUNTING_EVENT_POSTED: "Posted -- nothing to recover.",
  ACCOUNTING_EVENT_RESOLVED: "Resolved (ignored / reversed / journal exists).",
  ACCOUNTING_EVENT_QUEUED: "Queued for the normal posting processor.",
  ACCOUNTING_EVENT_PROCESSING: "Being processed right now.",
  ACCOUNTING_EVENT_STUCK: "Processing for more than 5 minutes (stale lock).",
  ACCOUNTING_EVENT_STATUS_UNKNOWN: "Status is not a recoverable state.",
  ACCOUNTING_OFF_HISTORICAL: "Historical event while GL Accounting is OFF -- no GL recovery required.",
  ACCOUNTING_EVENT_OUT_OF_SCOPE: "Event type outside Platform recovery scope.",
  ACCOUNTING_EVENT_UNSUPPORTED: "No certified recovery for this event type.",
  ACCOUNTING_HISTORY_AMBIGUOUS: "Another posted event or journal already covers this source.",
  ACCOUNTING_ACTOR_MISSING: "Event has no accountable actor; posting refuses it.",
  ACCOUNTING_ACTOR_INVALID: "The event's original actor is not a Company user of this Company; no other actor is substituted.",
  ACCOUNTING_JOURNAL_LINKAGE_MISMATCH: "A Journal is linked to this unresolved event; reprocessing could post twice.",
  TRADER_CREDIT_SETTLEMENT_NOT_POSTED: "The Credit's source Settlement has no posted accounting event.",
  AUTOMATIC_POSTING_DISABLED: "Automatic posting is disabled for the Company.",
  OPERATIONAL_AREA_DISABLED: "The event's operational area is not enabled for posting.",
  FISCAL_PERIOD_NOT_OPEN: "The accounting date's fiscal period is not open.",
  PRECHECK_REQUIRED: "Ready candidate -- preview required: the full certified precheck has not run yet.",
};

/** The supported-type inventory as SQL VALUES (from the adapter's classification). */
function supportValues() {
  return sql.join(
    accountingEventTypes.map((type) => sql`(${type}, ${accountingSupportOf(type).support})`),
  );
}

/** Phase 5 Prompt 1: the certified source type of each promoted Payroll event, as SQL VALUES. */
function certifiedSourceValues() {
  return sql.join(Object.entries(CERTIFIED_SOURCE_TYPES).map(([type, source]) => sql`(${type}, ${source})`));
}

/**
 * The Accounting mode timeline of ONE Company as CTEs ending in `on_iv`
 * (rows: from_ts inclusive, to_ts exclusive or NULL = open): exactly the
 * intervals in which `accounting_enabled_at(company, t)` (migration
 * 20260989000000) answers ON, computed once instead of once per source:
 *
 *   - each history snapshot is in force from its created_at until the next
 *     version's created_at;
 *   - a snapshot reading ON is an ON interval;
 *   - the LAST snapshot's open interval counts only while the CURRENT
 *     configuration row exists and is ON (a missing row is OFF, and stale
 *     history never makes the Company ON).
 *
 * Pinned against the SQL function by the Phase 4 Prompt 2 contract test.
 */
export function accountingOnIntervalsSql(companyId: string) {
  return sql`
      hist as (
        select coalesce((h.configuration_snapshot->>'accounting_enabled')::boolean, false) as on_,
               h.created_at as from_ts,
               lead(h.created_at) over (order by h.configuration_version) as to_ts
          from accounting_configuration_history h
         where h.company_id = ${companyId}::uuid
      ),
      on_iv as materialized (
        select from_ts, to_ts from hist
         where on_ and (to_ts is null or to_ts > from_ts)
           and (to_ts is not null
                or coalesce((select c.accounting_enabled from accounting_configurations c
                              where c.company_id = ${companyId}::uuid), false))
      )`;
}

@Injectable()
export class PlatformAccountingHealthService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  /** The shared triage, as CTEs ending in `cls` (one row per Company event). */
  private triage(companyId: string) {
    return sql`
      cfg as (
        select coalesce(c.accounting_enabled, false) as ae,
               coalesce(c.automatic_posting_enabled, false) as ape,
               coalesce(c.automatic_posting_areas, array[]::text[]) as areas
          from (select 1) as one
          left join accounting_configurations c on c.company_id = ${companyId}::uuid
      ),
      sup(event_type, support) as (values ${supportValues()}),
      csrc(event_type, source_type) as (values ${certifiedSourceValues()}),
      ev as materialized (
        select e.id, e.event_type, e.processing_status, e.source_entity_type, e.source_entity_id,
               e.source_reference, e.journal_id, e.actor_id is null as actor_missing,
               e.actor_id is not null and (a.id is null or a.account_kind <> 'company_user'
                                           or a.company_id is distinct from e.company_id) as actor_invalid,
               e.operational_area, e.safe_error_summary, e.error_code, e.attempt_count,
               e.failed_at, e.created_at,
               coalesce(e.effective_accounting_date, (e.created_at at time zone 'Asia/Dubai')::date) as acc_date,
               e.processing_status = 'processing'
                 and e.processing_locked_at < now() - interval '5 minutes' as stuck,
               case when cs.source_type is not null and e.source_entity_type <> cs.source_type then 'MANUAL_REVIEW'
                    else coalesce(s.support, 'UNSUPPORTED') end as support
          from accounting_events e
          left join sup s on s.event_type = e.event_type
          left join csrc cs on cs.event_type = e.event_type
          left join accounts a on a.id = e.actor_id
         where e.company_id = ${companyId}::uuid
      ),
      cls as (
        select ev.*, code,
               case
                 when code in ('ACCOUNTING_EVENT_POSTED', 'ACCOUNTING_EVENT_RESOLVED', 'ACCOUNTING_EVENT_QUEUED',
                               'ACCOUNTING_OFF_HISTORICAL') then 'NOT_REQUIRED'
                 when code in ('ACCOUNTING_EVENT_STATUS_UNKNOWN', 'ACCOUNTING_EVENT_OUT_OF_SCOPE',
                               'ACCOUNTING_EVENT_UNSUPPORTED', 'ACCOUNTING_HISTORY_AMBIGUOUS',
                               'ACCOUNTING_JOURNAL_LINKAGE_MISMATCH') then 'MANUAL_REVIEW'
                 when code = 'PRECHECK_REQUIRED' then 'READY_CANDIDATE'
                 else 'BLOCKED'
               end as triage
          from ev
          cross join lateral (select case
            when ev.processing_status = 'posted' then 'ACCOUNTING_EVENT_POSTED'
            when ev.processing_status in ('ignored_duplicate', 'ignored_no_accounting_required', 'reversed')
              then 'ACCOUNTING_EVENT_RESOLVED'
            -- Phase 4 Prompt 1: a Journal linked to an UNRESOLVED event is a
            -- linkage defect, never "resolved" (reprocessing could post twice).
            when ev.processing_status in ('failed', 'blocked_configuration')
                 and (ev.journal_id is not null
                      or exists (select 1 from journal_entries jx
                                  where jx.company_id = ${companyId}::uuid and jx.accounting_event_id = ev.id))
              then 'ACCOUNTING_JOURNAL_LINKAGE_MISMATCH'
            when ev.journal_id is not null then 'ACCOUNTING_EVENT_RESOLVED'
            when ev.processing_status in ('received', 'retry_pending') then 'ACCOUNTING_EVENT_QUEUED'
            when ev.processing_status = 'processing' and ev.stuck then 'ACCOUNTING_EVENT_STUCK'
            when ev.processing_status = 'processing' then 'ACCOUNTING_EVENT_PROCESSING'
            when ev.processing_status not in ('failed', 'blocked_configuration') then 'ACCOUNTING_EVENT_STATUS_UNKNOWN'
            when not (select ae from cfg) then 'ACCOUNTING_OFF_HISTORICAL'
            when ev.support = 'UNSUPPORTED' then 'ACCOUNTING_EVENT_UNSUPPORTED'
            when ev.support <> 'SUPPORTED' then 'ACCOUNTING_EVENT_OUT_OF_SCOPE'
            when exists (select 1 from accounting_events o
                          where o.company_id = ${companyId}::uuid and o.id <> ev.id
                            and o.source_entity_type = ev.source_entity_type
                            and o.source_entity_id = ev.source_entity_id
                            and o.event_type = ev.event_type and o.processing_status = 'posted')
              or exists (select 1 from journal_entries j
                          where j.company_id = ${companyId}::uuid
                            and j.source_entity_type = ev.source_entity_type
                            and j.source_entity_id = ev.source_entity_id and j.status = 'posted')
              then 'ACCOUNTING_HISTORY_AMBIGUOUS'
            when ev.actor_missing then 'ACCOUNTING_ACTOR_MISSING'
            when ev.actor_invalid then 'ACCOUNTING_ACTOR_INVALID'
            when ev.event_type = 'trader_credit_issued'
                 and not exists (select 1 from trader_credits tc
                                   join accounting_events se on se.company_id = tc.company_id
                                    and se.source_entity_type = 'trader_settlement'
                                    and se.source_entity_id = tc.source_settlement_id
                                    and se.event_type = 'trader_settlement_confirmed'
                                    and se.processing_status = 'posted'
                                  where tc.company_id = ${companyId}::uuid and tc.id = ev.source_entity_id)
              then 'TRADER_CREDIT_SETTLEMENT_NOT_POSTED'
            when not (select ape from cfg) then 'AUTOMATIC_POSTING_DISABLED'
            when ev.operational_area is null or not (select ev.operational_area = any(cfg.areas) from cfg)
              then 'OPERATIONAL_AREA_DISABLED'
            when not exists (select 1 from accounting_periods p
                               join fiscal_years y on y.id = p.fiscal_year_id and y.company_id = p.company_id
                              where p.company_id = ${companyId}::uuid
                                and ev.acc_date between p.period_start and p.period_end
                                and p.status in ('open', 'reopened') and y.status in ('open', 'reopened'))
              then 'FISCAL_PERIOD_NOT_OPEN'
            else 'PRECHECK_REQUIRED' end as code) c
      )
    `;
  }

  /**
   * Phase 4 Prompt 1 -- Journal integrity of posted / reversed events, as CTEs
   * ending in `integ` (one row per defective event: event_id, code). Only the
   * events that HAVE (or claim) a Journal are examined; line totals are read
   * once, grouped, for exactly those Journals.
   */
  private integrity(companyId: string) {
    return sql`
      ej as materialized (
        select e.id as event_id, e.event_type, e.processing_status, e.source_entity_type,
               e.source_entity_id, e.source_reference, e.journal_id, e.actor_id,
               coalesce(e.effective_accounting_date, (e.created_at at time zone 'Asia/Dubai')::date) as acc_date,
               j.status as jstatus, j.journal_number, j.accounting_event_id as jev,
               j.source_entity_type as jst, j.source_entity_id as jsid, j.accounting_period_id as jperiod
          from accounting_events e
          left join journal_entries j on j.id = e.journal_id and j.company_id = e.company_id
         where e.company_id = ${companyId}::uuid
           and (e.processing_status in ('posted', 'reversed') or e.journal_id is not null)
      ),
      jl as (
        select l.journal_entry_id as id, sum(l.debit) as d, sum(l.credit) as c, count(*)::int as n
          from journal_lines l
         where l.company_id = ${companyId}::uuid
           and l.journal_entry_id in (select journal_id from ej where journal_id is not null)
         group by l.journal_entry_id
      ),
      dup as (
        select event_type, source_entity_type, source_entity_id
          from accounting_events
         where company_id = ${companyId}::uuid and processing_status = 'posted'
         group by event_type, source_entity_type, source_entity_id
        having count(*) > 1
      ),
      integ as (
        select ej.*, jl.d, jl.c, coalesce(jl.n, 0) as n, k.code
          from ej
          left join jl on jl.id = ej.journal_id
          cross join lateral (select case
            when ej.processing_status in ('posted', 'reversed')
                 and (ej.journal_id is null or ej.jstatus is null or ej.jstatus not in ('posted', 'reversed'))
              then 'ACCOUNTING_POSTED_WITHOUT_JOURNAL'
            when ej.journal_id is not null
                 and (ej.processing_status not in ('posted', 'reversed')
                      or ej.jev is distinct from ej.event_id
                      or ej.jst is distinct from ej.source_entity_type
                      or ej.jsid is distinct from ej.source_entity_id)
              then 'ACCOUNTING_JOURNAL_LINKAGE_MISMATCH'
            when ej.jstatus in ('posted', 'reversed')
                 and (coalesce(jl.n, 0) < 2 or coalesce(jl.d, 0) <= 0 or jl.d <> jl.c)
              then 'ACCOUNTING_JOURNAL_UNBALANCED'
            when ej.processing_status = 'posted'
                 and exists (select 1 from dup
                              where dup.event_type = ej.event_type
                                and dup.source_entity_type = ej.source_entity_type
                                and dup.source_entity_id = ej.source_entity_id)
              then 'ACCOUNTING_DUPLICATE_EFFECTIVE_POSTING'
            end as code) k
         where k.code is not null
        union all
        -- A Journal pointing at an event that does not own it (and is not
        -- already examined above as that event's own Journal).
        select e.id, e.event_type, e.processing_status, e.source_entity_type, e.source_entity_id,
               e.source_reference, j.id, e.actor_id,
               coalesce(e.effective_accounting_date, (e.created_at at time zone 'Asia/Dubai')::date),
               j.status, j.journal_number, j.accounting_event_id, j.source_entity_type, j.source_entity_id,
               j.accounting_period_id, null::numeric, null::numeric, 0, 'ACCOUNTING_JOURNAL_LINKAGE_MISMATCH'
          from journal_entries j
          join accounting_events e on e.id = j.accounting_event_id and e.company_id = j.company_id
         where j.company_id = ${companyId}::uuid
           and e.journal_id is null
           and e.processing_status not in ('posted', 'reversed')
      )
    `;
  }

  /**
   * Phase 4 Prompt 1 -- REQUIRED accounting events that were never captured,
   * as CTEs ending in `miss`. Mirrors the capture conditions exactly (the
   * same triggers / service, `enqueue_operational_accounting_event`): a
   * source is required ONLY when GL Accounting was ON at the moment of the
   * operation (configuration history -- `accounting_enabled_at`, evaluated as
   * intervals so it costs one pass). Activity while Accounting was OFF is
   * never required (no backfill contract), so OFF -> ON and ON -> OFF -> ON
   * require only what happened inside ON intervals. The Order rule is the
   * Company Health rule (ORDER_MISSING_ACCOUNTING_EVENT) verbatim.
   */
  private missing(companyId: string) {
    return sql`
      ${accountingOnIntervalsSql(companyId)},
      src as (
        select 'order_delivered'::text as event_type, 'order'::text as source_type, o.id as source_id,
               o.order_number as reference, coalesce(o.delivered_at, o.updated_at) as at_ts,
               o.created_by_account_id as actor_id
          from orders o
         where o.company_id = ${companyId}::uuid and exists (select 1 from on_iv)
           and o.delivery_status in ('delivered', 'closed') and not o.is_free_order and o.trader_net_payable > 0
           and not exists (select 1 from accounting_events e
                            where e.company_id = o.company_id and e.source_entity_type = 'order'
                              and e.source_entity_id = o.id and e.event_type = 'order_delivered')
        union all
        select 'trader_receivable_recognized', 'trader_receivable', r.id, r.receivable_number, r.created_at,
               r.created_by_account_id
          from trader_receivables r
         where r.company_id = ${companyId}::uuid and exists (select 1 from on_iv)
           and r.status not in ('cancelled', 'reversed')
           and not exists (select 1 from accounting_events e
                            where e.company_id = r.company_id and e.source_entity_type = 'trader_receivable'
                              and e.source_entity_id = r.id and e.event_type = 'trader_receivable_recognized')
        union all
        select 'trader_receivable_payment_received', 'trader_collection', c.id, c.collection_number, c.created_at,
               c.received_by_account_id
          from trader_collections c
         where c.company_id = ${companyId}::uuid and exists (select 1 from on_iv)
           and c.status = 'confirmed'
           and not exists (select 1 from accounting_events e
                            where e.company_id = c.company_id and e.source_entity_type = 'trader_collection'
                              and e.source_entity_id = c.id and e.event_type = 'trader_receivable_payment_received')
        union all
        select 'trader_settlement_confirmed', 'trader_settlement', s.id, s.settlement_number,
               coalesce(s.confirmed_at, s.created_at), coalesce(s.confirmed_by_account_id, s.created_by_account_id)
          from trader_settlements s
         where s.company_id = ${companyId}::uuid and exists (select 1 from on_iv)
           and s.status = 'confirmed' and s.reversal_of_id is null
           and not exists (select 1 from trader_settlements x
                            where x.company_id = s.company_id and x.reversal_of_id = s.id and x.status = 'confirmed')
           and not exists (select 1 from accounting_events e
                            where e.company_id = s.company_id and e.source_entity_type = 'trader_settlement'
                              and e.source_entity_id = s.id and e.event_type = 'trader_settlement_confirmed')
        union all
        select 'driver_collection_confirmed', 'driver_reconciliation', d.id, d.reconciliation_number,
               coalesce(d.confirmed_at, d.created_at), coalesce(d.confirmed_by_account_id, d.created_by_account_id)
          from driver_reconciliations d
         where d.company_id = ${companyId}::uuid and exists (select 1 from on_iv)
           and d.status = 'confirmed' and d.reversal_of_id is null
           and not exists (select 1 from driver_reconciliations x
                            where x.company_id = d.company_id and x.reversal_of_id = d.id and x.status = 'confirmed')
           and not exists (select 1 from accounting_events e
                            where e.company_id = d.company_id and e.source_entity_type = 'driver_reconciliation'
                              and e.source_entity_id = d.id and e.event_type = 'driver_collection_confirmed')
        union all
        -- The Credit is captured only when its Settlement had GL involvement
        -- (ReceivableOffsetReversalService.settlementAccountingRequired).
        select 'trader_credit_issued', 'trader_credit', tc.id, tc.credit_number, tc.created_at,
               tc.created_by_account_id
          from trader_credits tc
          join trader_settlements s on s.id = tc.source_settlement_id and s.company_id = tc.company_id
         where tc.company_id = ${companyId}::uuid and exists (select 1 from on_iv)
           and tc.source_type = 'receivable_offset_reversal' and tc.status <> 'cancelled'
           and (exists (select 1 from accounting_events se
                         where se.company_id = s.company_id and se.source_entity_type = 'trader_settlement'
                           and se.source_entity_id = s.id and se.event_type = 'trader_settlement_confirmed')
                or exists (select 1 from on_iv
                            where coalesce(s.confirmed_at, s.created_at) >= on_iv.from_ts
                              and (on_iv.to_ts is null or coalesce(s.confirmed_at, s.created_at) < on_iv.to_ts)))
           and not exists (select 1 from accounting_events e
                            where e.company_id = tc.company_id and e.source_entity_type = 'trader_credit'
                              and e.source_entity_id = tc.id and e.event_type = 'trader_credit_issued')
        union all
        -- Payroll (Phase 5): approval of a period that is not reversed, and a
        -- confirmed Payroll payment (capture_payroll_period / _payment).
        select 'employee_payroll_approved', 'payroll_period', pp.id, pp.period_reference, pp.approved_at,
               pp.approved_by_account_id
          from payroll_periods pp
         where pp.company_id = ${companyId}::uuid and exists (select 1 from on_iv)
           and pp.approved_at is not null and pp.status in ('approved', 'partially_paid', 'paid', 'closed')
           and not exists (select 1 from accounting_events e
                            where e.company_id = pp.company_id and e.source_entity_type = 'payroll_period'
                              and e.source_entity_id = pp.id and e.event_type = 'employee_payroll_approved')
        union all
        select 'employee_payroll_paid', 'payroll_payment', pm.id, pm.payment_number, pm.created_at,
               pm.paid_by_account_id
          from payroll_payments pm
         where pm.company_id = ${companyId}::uuid and exists (select 1 from on_iv)
           and pm.status = 'confirmed'
           and not exists (select 1 from accounting_events e
                            where e.company_id = pm.company_id and e.source_entity_type = 'payroll_payment'
                              and e.source_entity_id = pm.id and e.event_type = 'employee_payroll_paid')
      ),
      miss as (
        select src.*,
               src.actor_id is not null and a.account_kind = 'company_user'
                 and a.company_id is not distinct from ${companyId}::uuid as actor_valid
          from src
          left join accounts a on a.id = src.actor_id
         where exists (select 1 from on_iv
                        where src.at_ts >= on_iv.from_ts and (on_iv.to_ts is null or src.at_ts < on_iv.to_ts))
      )
    `;
  }

  private async readOnly<T>(work: (db: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`set transaction read only`.execute(transaction);
      await sql`select set_config('statement_timeout', '30s', true), set_config('jit', 'off', true)`.execute(
        transaction,
      );
      return work(transaction);
    });
  }

  public summary(companyId: string): Promise<AccountingHealthSummary> {
    return this.readOnly(async (db) => {
      const result = await sql<{
        ae: boolean;
        ape: boolean;
        total: number;
        failed: number;
        blockedConfiguration: number;
        pending: number;
        processing: number;
        stuck: number;
        blocked: number;
        readyCandidates: number;
        manualReview: number;
        historicalWhileOff: number;
        byEventType: { eventType: string; unresolved: number }[] | null;
        integrity: AccountingHealthSummary["integrity"];
        missingTotal: number;
        missingByType: { eventType: string; missing: number }[] | null;
      }>`
        with ${this.triage(companyId)}, ${this.integrity(companyId)}, ${this.missing(companyId)}
        select (select ae from cfg) as ae, (select ape from cfg) as ape,
               count(*)::int as total,
               count(*) filter (where processing_status = 'failed')::int as failed,
               count(*) filter (where processing_status = 'blocked_configuration')::int as "blockedConfiguration",
               count(*) filter (where processing_status in ('received', 'retry_pending'))::int as pending,
               count(*) filter (where processing_status = 'processing')::int as processing,
               count(*) filter (where stuck)::int as stuck,
               count(*) filter (where triage = 'BLOCKED')::int as blocked,
               count(*) filter (where triage = 'READY_CANDIDATE')::int as "readyCandidates",
               count(*) filter (where triage = 'MANUAL_REVIEW')::int as "manualReview",
               count(*) filter (where code = 'ACCOUNTING_OFF_HISTORICAL')::int as "historicalWhileOff",
               (select json_agg(json_build_object('eventType', t.event_type, 'unresolved', t.n) order by t.n desc, t.event_type)
                  from (select event_type, count(*)::int as n from cls
                         where processing_status in ('failed', 'blocked_configuration')
                         group by event_type) t) as "byEventType",
               (select json_build_object(
                  'postedWithoutJournal', count(*) filter (where code = 'ACCOUNTING_POSTED_WITHOUT_JOURNAL'),
                  'unbalancedJournals', count(*) filter (where code = 'ACCOUNTING_JOURNAL_UNBALANCED'),
                  'linkageMismatches', count(*) filter (where code = 'ACCOUNTING_JOURNAL_LINKAGE_MISMATCH'),
                  'duplicateEffectivePostings', count(*) filter (where code = 'ACCOUNTING_DUPLICATE_EFFECTIVE_POSTING'),
                  'total', count(*)) from integ) as integrity,
               (select count(*)::int from miss) as "missingTotal",
               (select json_agg(json_build_object('eventType', m.event_type, 'missing', m.n) order by m.n desc, m.event_type)
                  from (select event_type, count(*)::int as n from miss group by event_type) m) as "missingByType"
          from cls
      `.execute(db);
      const row = result.rows[0]!;
      const unresolvedOn = row.ae ? row.blocked + row.readyCandidates + row.stuck : 0;
      const integrityIssues = row.integrity.total;
      const missing = row.missingTotal;
      // ONE model. While Accounting is OFF nothing is a REQUIRED repair and
      // nothing makes the Company unhealthy (Phase 2 contract, unchanged):
      // the counts of earlier ON-period history stay visible for review.
      const headlines: string[] = [];
      if (row.ae) {
        if (unresolvedOn > 0) headlines.push(ACCOUNTING_HEALTH_HEADLINES.failed);
        if (missing > 0) headlines.push(ACCOUNTING_HEALTH_HEADLINES.missing);
        if (integrityIssues > 0) headlines.push(ACCOUNTING_HEALTH_HEADLINES.integrity);
        if (row.manualReview > 0) headlines.push(ACCOUNTING_HEALTH_HEADLINES.review);
      }
      return {
        accountingHealth: !row.ae
          ? "NOT_APPLICABLE"
          : unresolvedOn > 0 || missing > 0 || integrityIssues > 0
            ? "ISSUE"
            : row.manualReview > 0
              ? "REVIEW"
              : "HEALTHY",
        headlines,
        integrity: row.integrity,
        missingRequiredEvents: { byEventType: row.missingByType ?? [], total: missing },
        accountingMode: { automaticPostingEnabled: row.ape, enabled: row.ae },
        blocked: row.blocked,
        blockedConfiguration: row.blockedConfiguration,
        byEventType: row.byEventType ?? [],
        companyId,
        failed: row.failed,
        generatedAt: new Date().toISOString(),
        historicalWhileOff: row.historicalWhileOff,
        manualReview: row.manualReview,
        note: row.ae
          ? "GL Accounting is ON: unresolved events keep the General Ledger incomplete until recovered."
          : "GL Accounting is OFF: GL recovery is not required for new operational activity. Historical unresolved events, and any journal-integrity or missing-event findings from earlier ON periods, are listed separately for review and do not make the Company unhealthy.",
        pending: row.pending,
        processing: row.processing,
        readyCandidateNote:
          "Ready candidates pass every stored-state check. READY is decided only by Preview Recovery, which runs the full certified accounting precheck.",
        readyCandidates: row.readyCandidates,
        stuck: row.stuck,
        totalEvents: row.total,
      };
    });
  }

  public list(companyId: string, query: AccountingHealthQuery): Promise<AccountingHealthPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(ACCOUNTING_HEALTH_MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 25));
    const status = query.status ?? "attention";
    return this.readOnly(async (db) => {
      const statusFilter =
        status === "all"
          ? sql`true`
          : status === "attention"
            ? sql`(processing_status in ('failed', 'blocked_configuration') or stuck)`
            : sql`processing_status = ${status}`;
      const reference = query.reference?.trim();
      const result = await sql<AccountingHealthRow & { total: number }>`
        with ${this.triage(companyId)}
        select id as "eventId", source_reference as "businessReference", source_entity_type as "sourceType",
               event_type as "eventType", processing_status as status, triage, code as "triageCode",
               safe_error_summary as "lastFailure", error_code as "failureCode",
               attempt_count as attempts, acc_date::text as "accountingDate", failed_at::text as "failedAt",
               count(*) over ()::int as total
          from cls
         where ${statusFilter}
           and (${query.eventType ?? null}::text is null or event_type = ${query.eventType ?? null})
           and (${query.repairability ?? null}::text is null or triage = ${query.repairability ?? null})
           and (${reference === undefined || reference === "" ? null : reference}::text is null
                or source_reference ilike ${`${reference ?? ""}%`})
           and (${query.dateFrom ?? null}::date is null or acc_date >= ${query.dateFrom ?? null}::date)
           and (${query.dateTo ?? null}::date is null or acc_date <= ${query.dateTo ?? null}::date)
         order by case triage when 'READY_CANDIDATE' then 0 when 'BLOCKED' then 1 when 'MANUAL_REVIEW' then 2 else 3 end,
                  failed_at desc nulls last, created_at desc, id
         limit ${pageSize} offset ${(page - 1) * pageSize}
      `.execute(db);
      return {
        generatedAt: new Date().toISOString(),
        items: result.rows.map(({ total, ...row }) => {
          void total;
          return {
            ...row,
            finding: FINDING[row.triageCode] ?? row.triageCode,
            previewRequired: row.triage === "READY_CANDIDATE",
          };
        }),
        page,
        pageSize,
        total: result.rows[0]?.total ?? 0,
      };
    });
  }
  /**
   * Phase 4 Prompt 1 -- Journal-integrity defects and missing required
   * events, ONE statement (window count). Every row is MANUAL_REVIEW and
   * carries the facts a person needs: event / source, Journal state and
   * balance, fiscal period, original actor, why it is not automatic and what
   * to investigate.
   */
  public integrityFindings(companyId: string, query: AccountingIntegrityQuery = {}): Promise<AccountingIntegrityPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(ACCOUNTING_HEALTH_MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 25));
    return this.readOnly(async (db) => {
      const result = await sql<{
        kind: AccountingIntegrityKind;
        code: string;
        eventId: string | null;
        eventType: string;
        eventStatus: string | null;
        sourceType: string;
        sourceId: string;
        businessReference: string | null;
        occurredOn: string | null;
        journalNumber: string | null;
        journalStatus: string | null;
        debit: string | null;
        credit: string | null;
        lines: number;
        periodStatus: string | null;
        actorState: "VALID" | "MISSING" | "INVALID";
        reconstructable: boolean | null;
        total: number;
      }>`
        with ${this.integrity(companyId)}, ${this.missing(companyId)},
        found as (
          select 'JOURNAL_INTEGRITY'::text as kind, i.code, i.event_id::text as "eventId", i.event_type as "eventType",
                 i.processing_status as "eventStatus", i.source_entity_type as "sourceType",
                 i.source_entity_id::text as "sourceId", i.source_reference as "businessReference",
                 i.acc_date::text as "occurredOn", i.journal_number as "journalNumber", i.jstatus as "journalStatus",
                 i.d::text as debit, i.c::text as credit, i.n as lines,
                 (select ap.status from accounting_periods ap
                   where ap.id = i.jperiod and ap.company_id = ${companyId}::uuid) as "periodStatus",
                 case when i.actor_id is null then 'MISSING'
                      when exists (select 1 from accounts a where a.id = i.actor_id and a.account_kind = 'company_user'
                                      and a.company_id = ${companyId}::uuid) then 'VALID'
                      else 'INVALID' end as "actorState",
                 null::boolean as reconstructable
            from integ i
           where (${query.kind ?? null}::text is null or ${query.kind ?? null}::text = 'JOURNAL_INTEGRITY')
          union all
          select 'MISSING_REQUIRED_EVENT', 'ACCOUNTING_REQUIRED_EVENT_MISSING', null, m.event_type, null,
                 m.source_type, m.source_id::text, m.reference,
                 ((m.at_ts at time zone 'Asia/Dubai')::date)::text, null, null, null, null, 0, null,
                 case when m.actor_id is null then 'MISSING' when m.actor_valid then 'VALID' else 'INVALID' end,
                 m.actor_valid
            from miss m
           where (${query.kind ?? null}::text is null or ${query.kind ?? null}::text = 'MISSING_REQUIRED_EVENT')
        )
        select found.*, count(*) over ()::int as total
          from found
         where (${query.eventType ?? null}::text is null or "eventType" = ${query.eventType ?? null})
         order by kind, "occurredOn" desc nulls last, "sourceId", "eventId"
         limit ${pageSize} offset ${(page - 1) * pageSize}
      `.execute(db);
      return {
        generatedAt: new Date().toISOString(),
        items: result.rows.map((row) => {
          const text = INTEGRITY_TEXT[row.code] ?? INTEGRITY_TEXT.ACCOUNTING_REQUIRED_EVENT_MISSING!;
          const missing = row.kind === "MISSING_REQUIRED_EVENT";
          const certified = missing && row.eventType === "order_delivered" && row.reconstructable === true;
          return {
            actor: { state: row.actorState },
            businessReference: row.businessReference,
            certifiedCapture: certified ? ("COMPANY_HISTORICAL_RECOVERY" as const) : null,
            code: row.code,
            eventId: row.eventId,
            eventStatus: row.eventStatus,
            eventType: row.eventType,
            headline: missing ? ACCOUNTING_HEALTH_HEADLINES.missing : ACCOUNTING_HEALTH_HEADLINES.integrity,
            health: "ISSUE" as const,
            journal: missing
              ? null
              : {
                  credit: row.credit,
                  debit: row.debit,
                  journalNumber: row.journalNumber,
                  lines: row.lines,
                  periodStatus: row.periodStatus,
                  status: row.journalStatus,
                },
            kind: row.kind,
            occurredOn: row.occurredOn,
            reason: text.reason,
            reconstructable: missing ? row.reconstructable === true : null,
            recommendedInvestigation: certified
              ? `${text.investigate} For an Order, the Company's Accounting -> Historical Recovery captures it with the trigger's exact inputs.`
              : text.investigate,
            repairability: "MANUAL_REVIEW" as const,
            sourceId: row.sourceId,
            sourceType: row.sourceType,
            whyNotAutomatic: text.why,
            decision: recoveryDecisionOf(row.eventType)?.decision ?? null,
          };
        }),
        page,
        pageSize,
        total: result.rows[0]?.total ?? 0,
      };
    });
  }
}
