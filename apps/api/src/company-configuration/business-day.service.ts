import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import type { SaveBusinessDayConfigurationDto } from "./company-configuration.dto.js";

/** The rule in force for some stretch of time. */
export interface BusinessDayConfiguration {
  readonly businessDayStart: string;
  readonly changeReason: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly id: string;
  readonly isCurrent: boolean;
  readonly timezone: string;
}

/**
 * A resolved query window.
 *
 * `endUtc` is EXCLUSIVE and `displayEnd` is the same instant less one
 * millisecond. They describe the same window; the first is for querying and the
 * second is for reading. Never filter with `displayEnd`.
 */
export interface BusinessDayWindowSegment {
  readonly businessDateFrom: string;
  readonly businessDateTo: string;
  readonly businessDayStart: string;
  /** Which rule produced this segment. */
  readonly configurationId: string;
  readonly displayEnd: string;
  readonly endUtc: string;
  readonly startUtc: string;
  readonly timezone: string;
}

export interface BusinessDayWindow {
  readonly businessDateFrom: string;
  readonly businessDateTo: string;
  readonly businessDayStart: string;
  readonly displayEnd: string;
  readonly endUtc: string;
  /** The windows that actually define the range. Filter on these. */
  readonly segments: readonly BusinessDayWindowSegment[];
  /** True when the range crosses a rule change, so the outer span is not filterable. */
  readonly spansRuleChange: boolean;
  readonly startUtc: string;
  readonly timezone: string;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const localTime = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
const dayMs = 86_400_000;

/**
 * The Company business day: one rule, one place.
 *
 * Everything downstream — reports, daily grouping, transaction detail — asks
 * this service rather than doing its own timezone arithmetic. Two screens that
 * each compute "which day does 02:00 belong to" will eventually disagree, and
 * the disagreement will be about money.
 *
 * ---------------------------------------------------------------------------
 * DERIVED, NOT STORED
 * ---------------------------------------------------------------------------
 *
 * No transaction carries a Business Date column. It is computed from the
 * transaction's own authoritative timestamp and the rule effective at that
 * timestamp. That avoids a duplicated value that can drift out of agreement
 * with the timestamp it was derived from, and it means nothing has to be
 * backfilled.
 *
 * The cost is that the rule must be effective-dated, which it is — see
 * `20260805120000_company_business_day_configuration`.
 */
@Injectable()
export class BusinessDayService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  /** Every rule this Company has ever adopted, newest first. */
  public async configurations(): Promise<readonly BusinessDayConfiguration[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<BusinessDayConfiguration>`
      select c.id,
             c.timezone,
             to_char(c.business_day_start, 'HH24:MI') as "businessDayStart",
             case when c.effective_from = '-infinity'::date then null
                  else c.effective_from::text end as "effectiveFrom",
             c.effective_to::text as "effectiveTo",
             c.change_reason as "changeReason",
             c.created_at::text as "createdAt",
             a.username as "createdBy",
             (current_date >= c.effective_from
              and (c.effective_to is null or current_date < c.effective_to)) as "isCurrent"
        from company_business_day_configurations c
        left join accounts a
          on a.id = c.created_by_account_id and a.company_id = c.company_id
       where c.company_id = ${companyId}::uuid and c.is_active
       order by c.effective_from desc
    `.execute(this.database);
    return result.rows;
  }

  /**
   * The rule that governs a given Business Date.
   *
   * Resolved by date rather than by "latest row" on purpose: that is what makes
   * a report of 04 Aug 2026 reproducible after the rule changes in 2027.
   */
  public async configurationFor(businessDate: string): Promise<BusinessDayConfiguration> {
    const date = this.assertDate(businessDate, "businessDate");
    const { companyId } = this.tenants.current();
    const result = await sql<BusinessDayConfiguration>`
      select c.id,
             c.timezone,
             to_char(c.business_day_start, 'HH24:MI') as "businessDayStart",
             case when c.effective_from = '-infinity'::date then null
                  else c.effective_from::text end as "effectiveFrom",
             c.effective_to::text as "effectiveTo",
             c.change_reason as "changeReason",
             c.created_at::text as "createdAt",
             a.username as "createdBy",
             true as "isCurrent"
        from company_business_day_configurations c
        left join accounts a
          on a.id = c.created_by_account_id and a.company_id = c.company_id
       where c.company_id = ${companyId}::uuid
         and c.is_active
         and c.effective_from <= ${date}::date
         and (c.effective_to is null or ${date}::date < c.effective_to)
       limit 1
    `.execute(this.database);
    const configuration = result.rows[0];
    if (configuration === undefined) {
      throw new ApplicationException(
        "business_day_not_configured",
        "No business-day rule is configured for that date",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return configuration;
  }

  /**
   * Resolve a Business Date range to its UTC window, segment by segment.
   *
   * A range that straddles a rule change cannot be one window. If the day
   * starts at 08:00 until 14 Aug and 06:00 from 15 Aug, then applying one rule
   * across 14–16 Aug is wrong however it is chosen: the old rule misplaces two
   * hours of every later night, and the new rule misplaces two hours of the
   * first one.
   *
   * So the range is cut into segments, one per rule, and the caller filters on
   * all of them. Each segment is still a single continuous range — a per-DAY
   * loop would multiply every report by the number of days requested, which is
   * a different and worse mistake.
   *
   * ---------------------------------------------------------------------------
   * THE TRANSITION BOUNDARY
   * ---------------------------------------------------------------------------
   *
   * The interesting part is where two rules meet. Computed naively:
   *
   *   14 Aug under the 08:00 rule ends   15 Aug 08:00
   *   15 Aug under the 06:00 rule starts 15 Aug 06:00
   *
   * Those two hours belong to both days. Had the new rule started LATER instead
   * of earlier, they would belong to neither.
   *
   * Segments are therefore CHAINED: each one ends exactly where the next
   * begins. The transition day is correspondingly shorter or longer than 24
   * hours, which is unavoidable and honest — the same thing a daylight-saving
   * change does to a calendar day. Every other day keeps its full 24 hours, and
   * across the whole range every instant still belongs to exactly one segment.
   */
  public async segments(
    businessDateFrom: string,
    businessDateTo?: string,
  ): Promise<readonly BusinessDayWindowSegment[]> {
    return this.resolveSegments(businessDateFrom, businessDateTo, undefined);
  }

  /**
   * Calendar Date boundaries: plain Company-local midnight-to-midnight, in the
   * SAME effective-dated timezone Business Date mode uses -- but never shifted
   * by the Business Day start. "Asia/Dubai calendar date" means Asia/Dubai
   * midnight-to-midnight, nothing else.
   *
   * This is the one other lens callers may use on a date range; it shares
   * every piece of the engine below (effective-dated rule resolution, the
   * DST-safe local-instant computation) with Business Date mode, so the two
   * can never independently drift on what "Company local time" means. Only
   * the boundary instant itself differs -- 00:00 instead of the configured
   * cutoff.
   */
  public async calendarSegments(
    dateFrom: string,
    dateTo?: string,
  ): Promise<readonly BusinessDayWindowSegment[]> {
    return this.resolveSegments(dateFrom, dateTo, "00:00");
  }

  /**
   * The shared engine behind `segments()` and `calendarSegments()`.
   *
   * `boundaryStartOverride` is the only thing that differs between the two
   * modes: undefined uses each rule's own configured Business Day start;
   * "00:00" forces plain midnight. Rule resolution, effective-dating and the
   * DST-safe local-instant arithmetic are identical either way.
   */
  private async resolveSegments(
    dateFrom: string,
    dateTo: string | undefined,
    boundaryStartOverride: string | undefined,
  ): Promise<readonly BusinessDayWindowSegment[]> {
    const from = this.assertDate(dateFrom, "dateFrom");
    const to = this.assertDate(dateTo ?? dateFrom, "dateTo");
    if (to < from) {
      throw new ApplicationException(
        "business_date_range_invalid",
        "Date From cannot be after Date To",
        HttpStatus.BAD_REQUEST,
      );
    }
    // Every rule fetched once. Resolving each day with its own query would turn
    // a month-long report into thirty round trips to answer a question the
    // first row already contained.
    const rules = await this.activeConfigurations();

    // Group consecutive dates that share a rule. Most ranges produce exactly
    // one group; a rule change produces two. (In Calendar Date mode this can
    // split a range where only the Business Day start changed and the
    // timezone did not -- harmless: the segments below still union to the
    // exact right window, just as one extra OR term.)
    const groups: { configuration: BusinessDayConfiguration; first: string; last: string }[] = [];
    for (let date = from; date <= to; date = this.addDays(date, 1)) {
      const configuration = this.ruleFor(rules, date);
      const open = groups[groups.length - 1];
      if (open !== undefined && open.configuration.id === configuration.id) {
        open.last = date;
        continue;
      }
      groups.push({ configuration, first: date, last: date });
    }

    const boundaryConfig = (configuration: BusinessDayConfiguration) =>
      boundaryStartOverride === undefined
        ? configuration
        : { ...configuration, businessDayStart: boundaryStartOverride };

    return groups.map((group, index) => {
      const next = groups[index + 1];
      const startUtc = this.localInstant(group.first, boundaryConfig(group.configuration));
      // Chained: hand over exactly where the next rule opens, so the boundary
      // can be neither double-counted nor lost.
      const endUtc =
        next === undefined
          ? this.localInstant(this.addDays(group.last, 1), boundaryConfig(group.configuration))
          : this.localInstant(next.first, boundaryConfig(next.configuration));
      return {
        businessDateFrom: group.first,
        businessDateTo: group.last,
        businessDayStart: boundaryConfig(group.configuration).businessDayStart,
        configurationId: group.configuration.id,
        displayEnd: new Date(Date.parse(endUtc) - 1).toISOString(),
        endUtc,
        startUtc,
        timezone: group.configuration.timezone,
      };
    });
  }

  /**
   * The whole range as one envelope, plus the segments that actually define it.
   *
   * `startUtc`/`endUtc` describe the outer span and are correct to display. They
   * are safe to FILTER on only when `spansRuleChange` is false; otherwise the
   * span includes the transition slack and the caller must filter per segment.
   * The flag is returned rather than left for the reader to infer.
   */
  public async window(
    businessDateFrom: string,
    businessDateTo?: string,
  ): Promise<BusinessDayWindow> {
    return this.foldSegments(await this.segments(businessDateFrom, businessDateTo));
  }

  /** The Calendar Date analog of `window()` -- same envelope shape, boundaries
   *  from `calendarSegments()` instead. */
  public async calendarWindow(dateFrom: string, dateTo?: string): Promise<BusinessDayWindow> {
    return this.foldSegments(await this.calendarSegments(dateFrom, dateTo));
  }

  private foldSegments(segments: readonly BusinessDayWindowSegment[]): BusinessDayWindow {
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (first === undefined || last === undefined) {
      throw new ApplicationException(
        "business_date_range_invalid",
        "The Date range resolved to no window",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return {
      businessDateFrom: first.businessDateFrom,
      businessDateTo: last.businessDateTo,
      businessDayStart: first.businessDayStart,
      displayEnd: last.displayEnd,
      endUtc: last.endUtc,
      segments,
      spansRuleChange: segments.length > 1,
      startUtc: first.startUtc,
      timezone: first.timezone,
    };
  }

  /**
   * Business Dates for a page of rows, in ONE configuration query.
   *
   * The obvious implementation — call `businessDateOf` per row — issues a
   * configuration query for every row on the page. That is the N+1 this method
   * exists to avoid.
   *
   * Equally rejected: deriving the date in SQL with a lateral join over
   * `company_business_day_configurations`. It would be set-based and fast, but
   * it would restate the business-day arithmetic in a second language, and the
   * two would drift. The rule lives in one place; this reads the rules once and
   * resolves the page in memory against that single source.
   *
   * Nulls map to nothing. A row without an authoritative timestamp has no
   * Business Date, and inventing one from `created_at` or a date-only column is
   * precisely what the whole design refuses to do.
   *
   * Keyed by the timestamp string as supplied, so callers can look up by the
   * same value they passed in.
   */
  public async businessDatesFor(
    timestamps: readonly (string | null | undefined)[],
  ): Promise<ReadonlyMap<string, string>> {
    const distinct = [...new Set(timestamps.filter((value): value is string => !!value))];
    const resolved = new Map<string, string>();
    if (distinct.length === 0) return resolved;
    const rules = await this.activeConfigurations();
    for (const timestamp of distinct) {
      const parsed = Date.parse(timestamp);
      // A malformed timestamp is skipped rather than guessed at. The row simply
      // reports no Business Date, which is the truthful answer.
      if (Number.isNaN(parsed)) continue;
      const instant = new Date(parsed);
      // Two-step for the same reason as `businessDateOf`: the rule is selected
      // by date, but the date depends on the rule's timezone.
      const utcDate = instant.toISOString().slice(0, 10);
      let rule;
      try {
        rule = this.ruleFor(rules, utcDate);
        const localDate = this.localDate(instant, rule.timezone);
        if (localDate !== utcDate) rule = this.ruleFor(rules, localDate);
      } catch {
        // No rule covers that date. Report nothing rather than a wrong date.
        continue;
      }
      resolved.set(timestamp, this.businessDateWith(instant, rule));
    }
    return resolved;
  }

  /** The Calendar Date analog of `businessDatesFor()` -- the instant's own
   *  local calendar date in the effective-dated Company timezone, with no
   *  Business Day cutoff shift. */
  public async calendarDatesFor(
    timestamps: readonly (string | null | undefined)[],
  ): Promise<ReadonlyMap<string, string>> {
    const distinct = [...new Set(timestamps.filter((value): value is string => !!value))];
    const resolved = new Map<string, string>();
    if (distinct.length === 0) return resolved;
    const rules = await this.activeConfigurations();
    for (const timestamp of distinct) {
      const parsed = Date.parse(timestamp);
      if (Number.isNaN(parsed)) continue;
      const instant = new Date(parsed);
      const utcDate = instant.toISOString().slice(0, 10);
      let localDate: string;
      try {
        const provisional = this.ruleFor(rules, utcDate);
        localDate = this.localDate(instant, provisional.timezone);
        // The timezone itself is effective-dated; re-resolve only if crossing
        // to a different local date could mean a different rule applies.
        if (localDate !== utcDate) {
          const confirmed = this.ruleFor(rules, localDate);
          localDate = this.localDate(instant, confirmed.timezone);
        }
      } catch {
        continue;
      }
      resolved.set(timestamp, localDate);
    }
    return resolved;
  }

  /** Every rule this Company has in force, oldest first. */
  private async activeConfigurations(): Promise<readonly BusinessDayConfiguration[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<BusinessDayConfiguration>`
      select c.id,
             c.timezone,
             to_char(c.business_day_start, 'HH24:MI') as "businessDayStart",
             case when c.effective_from = '-infinity'::date then null
                  else c.effective_from::text end as "effectiveFrom",
             c.effective_to::text as "effectiveTo",
             c.change_reason as "changeReason",
             c.created_at::text as "createdAt",
             a.username as "createdBy",
             false as "isCurrent"
        from company_business_day_configurations c
        left join accounts a
          on a.id = c.created_by_account_id and a.company_id = c.company_id
       where c.company_id = ${companyId}::uuid and c.is_active
       order by c.effective_from
    `.execute(this.database);
    return result.rows;
  }

  /**
   * Pick the rule governing one Business Date, in memory.
   *
   * Mirrors `configurationFor` exactly — `effective_from <= date < effective_to`
   * — so a range resolved here and a single date resolved against the database
   * can never disagree.
   */
  private ruleFor(
    rules: readonly BusinessDayConfiguration[],
    date: string,
  ): BusinessDayConfiguration {
    const match = rules.find(
      (rule) =>
        (rule.effectiveFrom ?? "0001-01-01") <= date &&
        (rule.effectiveTo === null || date < rule.effectiveTo),
    );
    if (match === undefined) {
      throw new ApplicationException(
        "business_day_not_configured",
        "No business-day rule is configured for that date",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return match;
  }

  /**
   * Which Business Date an instant belongs to.
   *
   * The instant is converted to Company-local time FIRST. Deriving the date
   * from the UTC calendar would put 03:00 Dubai on the previous day for four
   * hours every night — the exact error this feature exists to remove.
   */
  public async businessDateOf(timestamp: string): Promise<string> {
    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed)) {
      throw new ApplicationException(
        "business_day_instant_invalid",
        "A valid timestamp is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    // Chicken and egg: the rule is selected by date, but the date depends on the
    // rule's timezone. Resolved in two steps rather than by assuming a zone.
    //
    // Step one uses the UTC calendar date, which is at most one day away from
    // the answer. Step two re-resolves only if that timezone moves the instant
    // onto a different local date — otherwise the first lookup already had the
    // right rule, because a rule cannot change within a single day.
    const instant = new Date(parsed);
    const utcDate = instant.toISOString().slice(0, 10);
    const provisional = await this.configurationFor(utcDate);
    const localDate = this.localDate(instant, provisional.timezone);
    const configuration =
      localDate === utcDate ? provisional : await this.configurationFor(localDate);
    return this.businessDateWith(instant, configuration);
  }

  /** Pure form of `businessDateOf`, for callers that already hold the rule. */
  public businessDateWith(
    instant: Date,
    configuration: Pick<BusinessDayConfiguration, "businessDayStart" | "timezone">,
  ): string {
    const local = this.localDate(instant, configuration.timezone);
    const localMinutes = this.localMinutes(instant, configuration.timezone);
    const startMinutes = this.startMinutes(configuration.businessDayStart);
    // Before the day has begun, the instant still belongs to yesterday.
    return localMinutes < startMinutes ? this.addDays(local, -1) : local;
  }

  /** The Calendar Date analog of `businessDateOf()` -- the instant's own
   *  local calendar date, with no Business Day cutoff shift. Used to resolve
   *  "Today" in Calendar Date mode. */
  public async calendarDateOf(timestamp: string): Promise<string> {
    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed)) {
      throw new ApplicationException(
        "business_day_instant_invalid",
        "A valid timestamp is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const instant = new Date(parsed);
    const utcDate = instant.toISOString().slice(0, 10);
    const provisional = await this.configurationFor(utcDate);
    const localDate = this.localDate(instant, provisional.timezone);
    if (localDate === utcDate) return localDate;
    const configuration = await this.configurationFor(localDate);
    return this.localDate(instant, configuration.timezone);
  }

  public nextBusinessDate(businessDate: string): string {
    return this.addDays(this.assertDate(businessDate, "businessDate"), 1);
  }

  public previousBusinessDate(businessDate: string): string {
    return this.addDays(this.assertDate(businessDate, "businessDate"), -1);
  }

  /**
   * Adopt a new rule from a chosen date.
   *
   * The previous open period is closed at exactly the new start, so the two are
   * adjacent with no gap and no overlap — the database exclusion constraint
   * rejects anything else.
   *
   * Only forward changes are allowed. Re-cutting a period that has already
   * elapsed would retroactively change reports that have already been read and
   * acted on, which is precisely what effective dating is here to prevent.
   */
  public async saveConfiguration(
    input: SaveBusinessDayConfigurationDto,
    correlationId: string,
  ): Promise<BusinessDayConfiguration> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const timezone = this.assertTimezone(input.timezone);
    const startTime = this.assertStartTime(input.businessDayStart);
    const effectiveFrom = this.assertDate(input.effectiveFrom, "effectiveFrom");
    const reason = input.changeReason.trim();
    if (reason === "") {
      throw new ApplicationException(
        "business_day_reason_required",
        "A reason is required when changing the business day",
        HttpStatus.BAD_REQUEST,
      );
    }
    const today = this.localDate(new Date(), timezone);
    if (effectiveFrom <= today) {
      throw new ApplicationException(
        "business_day_effective_from_not_future",
        "A business-day change must take effect on a future date so past reports stay reproducible",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return this.transactions.execute(async (transaction) => {
      // Close the open period at the new start. `[)` ranges make these
      // adjacent, not overlapping.
      await sql`
        update company_business_day_configurations
           set effective_to = ${effectiveFrom}::date,
               updated_at = now(),
               version = version + 1
         where company_id = ${companyId}::uuid
           and is_active
           and effective_to is null
           and effective_from < ${effectiveFrom}::date
      `.execute(transaction);
      // A future period adopted earlier and not yet reached is replaced rather
      // than stacked, so "change my mind before it starts" does not leave two
      // competing future rules.
      await sql`
        delete from company_business_day_configurations
         where company_id = ${companyId}::uuid
           and effective_from >= ${effectiveFrom}::date
           and effective_from > ${today}::date
      `.execute(transaction);
      const inserted = await sql<{ id: string }>`
        insert into company_business_day_configurations (
          company_id, timezone, business_day_start, effective_from, change_reason,
          created_by_account_id
        ) values (
          ${companyId}::uuid, ${timezone}, ${startTime}::time, ${effectiveFrom}::date,
          ${reason}, ${identity.identityId}::uuid
        )
        returning id
      `.execute(transaction);
      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        throw new Error("Business day configuration insert did not return an identifier");
      }
      await sql`
        insert into audit_events (
          company_id, actor_account_id, action, subject_type, subject_id,
          after_data, correlation_id
        ) values (
          ${companyId}::uuid, ${identity.identityId}::uuid, 'business_day.configure',
          'company_business_day_configuration', ${id}::uuid,
          ${JSON.stringify({ businessDayStart: startTime, changeReason: reason, effectiveFrom, timezone })}::jsonb,
          ${correlationId}
        )
      `.execute(transaction);
      const saved = await sql<BusinessDayConfiguration>`
        select c.id,
               c.timezone,
               to_char(c.business_day_start, 'HH24:MI') as "businessDayStart",
               c.effective_from::text as "effectiveFrom",
               c.effective_to::text as "effectiveTo",
               c.change_reason as "changeReason",
               c.created_at::text as "createdAt",
               a.username as "createdBy",
               false as "isCurrent"
          from company_business_day_configurations c
          left join accounts a
            on a.id = c.created_by_account_id and a.company_id = c.company_id
         where c.id = ${id}::uuid and c.company_id = ${companyId}::uuid
      `.execute(transaction);
      const row = saved.rows[0];
      if (row === undefined) {
        throw new Error("Business day configuration was not readable after insert");
      }
      return row;
    });
  }

  // ---------------------------------------------------------------------------
  // Local-time arithmetic
  //
  // `Intl.DateTimeFormat` with an IANA `timeZone` is the only mechanism here
  // that knows about DST and historical offset changes. Fixed offsets are
  // deliberately never used: `Asia/Dubai` has no DST today, but the Company
  // list is not restricted to it and a hardcoded +04 would be wrong the moment
  // it is.
  // ---------------------------------------------------------------------------

  /** The UTC instant of a local wall-clock date at the rule's start time. */
  private localInstant(
    date: string,
    configuration: Pick<BusinessDayConfiguration, "businessDayStart" | "timezone">,
  ): string {
    const startMinutes = this.startMinutes(configuration.businessDayStart);
    // Start from the naive reading of the wall clock as if it were UTC, then
    // correct by the zone's offset at that moment. One correction pass is
    // re-checked because the offset itself can differ either side of a DST
    // boundary; the second pass settles it.
    const naive = Date.parse(`${date}T00:00:00Z`) + startMinutes * 60_000;
    let instant = naive - this.offsetMs(new Date(naive), configuration.timezone);
    instant = naive - this.offsetMs(new Date(instant), configuration.timezone);
    return new Date(instant).toISOString();
  }

  /** How far ahead of UTC the zone is at this instant, in milliseconds. */
  private offsetMs(instant: Date, timezone: string): number {
    const parts = this.parts(instant, timezone);
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return asUtc - instant.getTime();
  }

  private localDate(instant: Date, timezone: string): string {
    const parts = this.parts(instant, timezone);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  private localMinutes(instant: Date, timezone: string): number {
    const parts = this.parts(instant, timezone);
    return Number(parts.hour) * 60 + Number(parts.minute);
  }

  private parts(instant: Date, timezone: string): Record<string, string> {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      year: "numeric",
    })
      .formatToParts(instant)
      .reduce<Record<string, string>>((result, part) => {
        // `hourCycle` can render midnight as 24; normalise so arithmetic on the
        // value cannot land a day out.
        result[part.type] = part.type === "hour" && part.value === "24" ? "00" : part.value;
        return result;
      }, {});
  }

  private startMinutes(businessDayStart: string): number {
    const match = localTime.exec(businessDayStart);
    if (match === null) {
      throw new ApplicationException(
        "business_day_start_invalid",
        "The configured business day start is not a valid local time",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return Number(match[1]) * 60 + Number(match[2]);
  }

  private addDays(date: string, days: number): string {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
  }

  private assertDate(value: string, field: string): string {
    const trimmed = value.trim();
    if (!isoDate.test(trimmed) || Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`))) {
      throw new ApplicationException(
        "business_date_invalid",
        `${field} must be a calendar date`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return trimmed;
  }

  private assertStartTime(value: string): string {
    const match = localTime.exec(value.trim());
    if (match === null) {
      throw new ApplicationException(
        "business_day_start_invalid",
        "Business Day Start must be a valid local time such as 08:00",
        HttpStatus.BAD_REQUEST,
      );
    }
    return `${match[1]}:${match[2]}:00`;
  }

  /**
   * Accept only a timezone the runtime itself recognises.
   *
   * Asking `Intl` is better than any allowlist this file could carry: the list
   * is the runtime's own IANA database, so it cannot go stale, and an offset
   * string such as `+04:00` is rejected because it carries no DST history.
   */
  private assertTimezone(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.includes("/")) {
      throw new ApplicationException(
        "business_day_timezone_invalid",
        "Select a region timezone such as Asia/Dubai",
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: trimmed }).format(new Date());
    } catch {
      throw new ApplicationException(
        "business_day_timezone_invalid",
        "That timezone is not recognised",
        HttpStatus.BAD_REQUEST,
      );
    }
    return trimmed;
  }
}
