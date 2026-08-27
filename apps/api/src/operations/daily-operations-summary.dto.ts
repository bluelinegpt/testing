import { Transform } from "class-transformer";
import { IsBoolean, IsDateString, IsIn, IsOptional, IsUUID } from "class-validator";

/** Allowed values only; unknown strings are rejected by `@IsIn` rather than
 *  silently falling back to a mode nobody asked for. */
export type DailyOperationsSummaryDateMode = "business_day" | "calendar_day";
export const dailyOperationsSummaryDateModes: readonly DailyOperationsSummaryDateMode[] = [
  "business_day",
  "calendar_day",
];

/**
 * Daily Operations Summary — read-only management report.
 *
 * `dateMode` selects which lens `dateFrom`/`dateTo` are read through --
 * Business Day (the Company Business Calendar, cutoff-shifted) or Calendar
 * Day (plain Company-local midnight-to-midnight). Both resolve through
 * `BusinessDayService` (`.window()` / `.calendarWindow()`), never a second
 * timezone implementation; see `daily-operations-summary.service.ts`. One
 * day is expressed as `dateFrom === dateTo`, matching the existing
 * convention elsewhere in this codebase. Default: Business Day, matching
 * every other Business-Date report already in this codebase.
 */
export class DailyOperationsSummaryQueryDto {
  @IsDateString()
  public readonly dateFrom!: string;

  @IsOptional()
  @IsIn(dailyOperationsSummaryDateModes)
  public readonly dateMode?: DailyOperationsSummaryDateMode;

  @IsDateString()
  public readonly dateTo!: string;

  @IsOptional()
  @IsUUID("4")
  public readonly driverId?: string;

  @IsOptional()
  @IsIn(["employee", "outsourced"])
  public readonly driverType?: "employee" | "outsourced";

  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  public readonly includeTraderPayments?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  public readonly includeTraderReceivables?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  public readonly includeTraderPayables?: boolean;
}

export class DailyOperationsSummaryExportQueryDto extends DailyOperationsSummaryQueryDto {
  @IsOptional()
  @IsIn(["en", "ar"])
  public readonly language?: "en" | "ar";
}

/** What "Today" means -- the caller states the Date Mode explicitly; it is
 *  never inferred from any other parameter. */
export class DailyOperationsSummaryTodayQueryDto {
  @IsOptional()
  @IsIn(dailyOperationsSummaryDateModes)
  public readonly dateMode?: DailyOperationsSummaryDateMode;
}

/**
 * Order-level drill-down for one Driver's contributing Orders within a
 * date range. `driverId` is required -- this never loads every Order in the
 * range across every Driver, matching the report's own
 * server-side-aggregation posture; a Driver row's "View Orders" action is
 * the only caller. `dateMode` must match the parent report's request, or the
 * drill-down could include Orders the summary it was opened from never
 * counted.
 */
export class DailyOperationsSummaryOrdersQueryDto {
  @IsDateString()
  public readonly dateFrom!: string;

  @IsOptional()
  @IsIn(dailyOperationsSummaryDateModes)
  public readonly dateMode?: DailyOperationsSummaryDateMode;

  @IsDateString()
  public readonly dateTo!: string;

  @IsUUID("4")
  public readonly driverId!: string;
}


