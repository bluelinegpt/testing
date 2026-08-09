import { sql } from "kysely";

import type { AppliedReportDateMode } from "../company-configuration/report-date-mode.js";
import type { BusinessDayService } from "../company-configuration/business-day.service.js";
import type { ReportDateModeService } from "../company-configuration/report-date-mode.js";

/**
 * Neutral Business Day dependencies for services constructed by hand.
 *
 * `DriverCashReconciliationService`, `TraderSettlementService` and
 * `OperationsService` each take `ReportDateModeService` and `BusinessDayService`.
 * Nest supplies them in production; the concurrency harness and the database
 * tests build these services directly and need something real to pass.
 *
 * These are NOT inert placeholders. Both dependencies are called on every
 * `list()` — `resolve()` once per request and `businessDatesFor()` once per page
 * — so an empty object would compile and then throw the moment a list runs,
 * turning a compile error into a silent test failure.
 *
 * The behaviour here is the behaviour those suites saw BEFORE Business Date
 * existed: Calendar Date mode, a predicate that matches everything, and no row
 * enrichment. Nothing is filtered, no financial row changes, and no Business
 * Date is invented.
 */

/** Exactly what `ReportDateModeService.plain("calendar_date")` returns. */
const calendarDateMode: AppliedReportDateMode = {
  authoritativeTimestamp: null,
  businessDateFrom: null,
  businessDateTo: null,
  businessDayStart: null,
  dateMode: "calendar_date",
  displayEnd: null,
  endUtc: null,
  excludesHistoricalRows: false,
  segments: [],
  spansRuleChange: false,
  startUtc: null,
  timezone: null,
};

/**
 * Resolves every report to Calendar Date mode.
 *
 * `predicate()` returns a match-everything fragment, which is what the real
 * service returns outside Business Date mode — so the surrounding query is
 * unchanged and no result is filtered out.
 */
export function createCalendarDateReportModeServiceStub(): ReportDateModeService {
  return {
    predicate: () => sql`true`,
    resolve: async () => calendarDateMode,
    warningCodes: () => [],
  } as unknown as ReportDateModeService;
}

/**
 * Resolves no Business Dates.
 *
 * An empty map is safe here because every consumer reads it as
 * `map.get(timestamp) ?? null` — the documented "no authoritative timestamp"
 * path. Rows are still returned; only the derived Business Date is null, which
 * is exactly the state these suites asserted before the field existed.
 */
export function createBusinessDayServiceStub(): BusinessDayService {
  return {
    businessDatesFor: async () => new Map<string, string>(),
  } as unknown as BusinessDayService;
}
