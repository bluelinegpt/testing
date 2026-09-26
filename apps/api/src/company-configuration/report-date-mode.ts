import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  type BusinessDayWindowSegment,
  BusinessDayService,
} from "./business-day.service.js";
import {
  type ReportDateMode,
  dateModesFor,
  reportTimestampSource,
} from "./business-day-report-sources.js";

/** What the caller asked for. Boundaries are never among these fields. */
export interface ReportDateModeRequest {
  readonly businessDateFrom?: string | undefined;
  readonly businessDateTo?: string | undefined;
  readonly dateMode?: string | undefined;
}

/**
 * What was actually applied — returned with every report so the reader can see
 * the window rather than infer it.
 */
export interface AppliedReportDateMode {
  readonly authoritativeTimestamp: string | null;
  readonly businessDateFrom: string | null;
  readonly businessDateTo: string | null;
  readonly businessDayStart: string | null;
  readonly dateMode: ReportDateMode;
  readonly displayEnd: string | null;
  readonly endUtc: string | null;
  /** True when rows lacking an authoritative timestamp were left out. */
  readonly excludesHistoricalRows: boolean;
  readonly segments: readonly BusinessDayWindowSegment[];
  /** True when the range crossed a rule change and several rules were applied. */
  readonly spansRuleChange: boolean;
  readonly startUtc: string | null;
  readonly timezone: string | null;
}

/**
 * One Date Mode contract for every report that has one.
 *
 * Without this each report would grow its own notion of "business date", and the
 * first time two of them disagreed the argument would be about money. Reports
 * ask this service what mode they are in and get back both a predicate and the
 * description of the window that predicate implements — from the same
 * resolution, so the number on screen and the caption above it cannot drift.
 *
 * Boundaries are ALWAYS computed here. A UTC range supplied by a caller would be
 * built from that caller's own clock and zone, and nothing on the server could
 * distinguish a wrong one from a right one.
 */
@Injectable()
export class ReportDateModeService {
  public constructor(
    @Inject(BusinessDayService) private readonly businessDays: BusinessDayService,
  ) {}

  /**
   * Decide the mode for a report and resolve its window.
   *
   * A report that does not support the requested mode is refused rather than
   * quietly downgraded: silently serving Calendar Date results to somebody who
   * asked for Business Date is the failure this whole feature exists to prevent.
   */
  public async resolve(
    report: string,
    request: ReportDateModeRequest,
  ): Promise<AppliedReportDateMode> {
    const allowed = dateModesFor(report);
    const requested = (request.dateMode ?? allowed[0]) as ReportDateMode;
    if (!allowed.includes(requested)) {
      throw new ApplicationException(
        "report_date_mode_not_supported",
        `This report does not support ${this.label(requested)} mode`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (requested !== "business_date") {
      return this.plain(requested);
    }
    const source = reportTimestampSource(report);
    if (source === undefined || source.basis !== "business_day_capable") {
      throw new ApplicationException(
        "report_authoritative_timestamp_unavailable",
        "This report has no authoritative transaction timestamp, so Business Date mode is unavailable",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (request.businessDateFrom === undefined) {
      throw new ApplicationException(
        "business_date_range_invalid",
        "Business Date From is required in Business Date mode",
        HttpStatus.BAD_REQUEST,
      );
    }
    // Range validation, rule resolution and the half-open arithmetic all live in
    // BusinessDayService. Duplicating any of it here would create a second
    // opinion about where a day begins.
    const window = await this.businessDays.window(
      request.businessDateFrom,
      request.businessDateTo,
    );
    return {
      authoritativeTimestamp: `${source.table}.${source.column}`,
      businessDateFrom: window.businessDateFrom,
      businessDateTo: window.businessDateTo,
      businessDayStart: window.businessDayStart,
      dateMode: "business_date",
      displayEnd: window.displayEnd,
      endUtc: window.endUtc,
      excludesHistoricalRows: source.historicalNulls === true,
      segments: window.segments,
      spansRuleChange: window.spansRuleChange,
      startUtc: window.startUtc,
      timezone: window.timezone,
    };
  }

  /**
   * The `WHERE` fragment for a resolved Business Date window.
   *
   * Set-based, and deliberately so. Three shapes were available:
   *
   *   one query per Business Date   - multiplies a month-long report by thirty
   *   load everything, filter in JS - unbounded memory, breaks pagination and
   *                                   makes totals disagree with the page
   *   bounded OR over segments      - one query, index-usable
   *
   * The third is used. Segment count is bounded by the number of rule changes
   * the range crosses, which is one or two in practice and never large.
   *
   * The column is compared directly — never wrapped in `at time zone` or any
   * other function — so an index on it stays usable. Both bounds are already UTC
   * instants, computed once per request.
   *
   * Segments are contiguous and non-overlapping by construction (each ends where
   * the next begins), so no row can match twice and no `distinct` is needed.
   */
  public predicate(column: string, applied: AppliedReportDateMode): ReturnType<typeof sql> {
    if (applied.dateMode !== "business_date") return sql`true`;
    if (applied.segments.length === 0) {
      throw new ApplicationException(
        "business_day_rule_resolution_failed",
        "The Business Date range could not be resolved to a window",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const reference = sql.ref(column);
    return sql`(${sql.join(
      applied.segments.map(
        (segment) =>
          // Half-open: a timestamp exactly on the upper bound belongs to the
          // NEXT window. `<=` on a whole second would drop the final 999ms.
          sql`(${reference} >= ${segment.startUtc}::timestamptz and ${reference} < ${segment.endUtc}::timestamptz)`,
      ),
      sql` or `,
    )})`;
  }

  /**
   * The notice a report must show when historical rows were left out.
   *
   * Returned as a code rather than a sentence so the frontend localizes it; the
   * report must not present a total that silently omits rows.
   */
  public warningCodes(applied: AppliedReportDateMode): readonly string[] {
    if (applied.dateMode !== "business_date") return [];
    return [
      ...(applied.spansRuleChange ? ["business_day_multiple_rules_applied"] : []),
      ...(applied.excludesHistoricalRows
        ? ["business_day_historical_confirmation_unavailable"]
        : []),
    ];
  }

  private plain(dateMode: ReportDateMode): AppliedReportDateMode {
    return {
      authoritativeTimestamp: null,
      businessDateFrom: null,
      businessDateTo: null,
      businessDayStart: null,
      dateMode,
      displayEnd: null,
      endUtc: null,
      excludesHistoricalRows: false,
      segments: [],
      spansRuleChange: false,
      startUtc: null,
      timezone: null,
    };
  }

  private label(mode: ReportDateMode): string {
    return { accounting_date: "Accounting Date", business_date: "Business Date", calendar_date: "Calendar Date" }[
      mode
    ];
  }
}
