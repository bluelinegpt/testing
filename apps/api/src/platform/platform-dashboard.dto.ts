import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from "class-validator";

/**
 * Platform Dashboard request contracts.
 *
 * ---------------------------------------------------------------------------
 * WHY CALENDAR-DATE STRINGS, NOT TIMESTAMPS
 * ---------------------------------------------------------------------------
 *
 * `from`/`to` are plain `YYYY-MM-DD` calendar dates, matching the existing
 * `<input type="date">` convention already used by `AuditPage.tsx` and the
 * Accounting Dashboard. They are interpreted as `Asia/Dubai` calendar days by
 * `PlatformDashboardService` — see that file's header comment for the exact
 * timezone rule this Dashboard uses.
 *
 * `companyId`, when present, scopes every applicable metric to one Company.
 * Its absence means "All Companies" everywhere in this module.
 */

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

export class PlatformDashboardQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "from must be a calendar date, YYYY-MM-DD" })
  public from?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "to must be a calendar date, YYYY-MM-DD" })
  public to?: string;

  @IsOptional()
  @IsUUID()
  public companyId?: string;

  @IsOptional()
  @IsIn(["daily", "weekly", "monthly"])
  public groupBy?: "daily" | "weekly" | "monthly";
}

export class CompanyRankingQueryDto extends PlatformDashboardQueryDto {
  @IsOptional()
  @IsIn(["orders", "delivered", "cod", "serviceFees", "traders", "customers"])
  public metric?: "orders" | "delivered" | "cod" | "serviceFees" | "traders" | "customers";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  public limit?: number;
}

const overviewSortColumns = [
  "name",
  "orders",
  "delivered",
  "traders",
  "customers",
  "drivers",
  "cod",
  "lastOrder",
] as const;

export class CompanyOverviewQueryDto extends PlatformDashboardQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  public search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // Capped so a caller cannot turn the table into a full-Platform export.
  @Max(100)
  public pageSize?: number;

  @IsOptional()
  @IsIn(overviewSortColumns)
  public sort?: (typeof overviewSortColumns)[number];

  @IsOptional()
  @IsIn(["asc", "desc"])
  public direction?: "asc" | "desc";
}
