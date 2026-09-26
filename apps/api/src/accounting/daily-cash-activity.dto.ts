import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min } from "class-validator";
import { Type } from "class-transformer";

import type {
  DailyCashDateBasis,
  DailyCashMethod,
  DailyCashPartyType,
} from "./daily-cash-activity.service.js";

export const dailyCashDateBases = ["calendar", "business"] as const;
export const dailyCashPaymentMethods = ["bank", "cash"] as const;
export const dailyCashPartyTypes = [
  "driver",
  "employee",
  "expense",
  "internal",
  "trader",
  "unknown",
] as const;

/**
 * One Business Date, plus optional narrowing.
 *
 * `businessDate` is required and singular: this is a DAILY report, and letting
 * it accept a range would quietly turn it into a different report whose opening
 * and closing balances mean something else.
 */
export class DailyCashActivityQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "businessDate must be YYYY-MM-DD" })
  public businessDate!: string;

  @ApiPropertyOptional({ default: "calendar", enum: dailyCashDateBases })
  @IsOptional()
  @IsIn(dailyCashDateBases)
  public dateBasis?: DailyCashDateBasis;

  /** Cash or Bank account id. Sources with no account are excluded when set. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public accountId?: string;

  @ApiPropertyOptional({ enum: dailyCashPaymentMethods })
  @IsOptional()
  @IsIn(dailyCashPaymentMethods)
  public paymentMethod?: DailyCashMethod;

  @ApiPropertyOptional({ enum: dailyCashPartyTypes })
  @IsOptional()
  @IsIn(dailyCashPartyTypes)
  public partyType?: DailyCashPartyType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public partyId?: string;
}

/** Export takes the screen's filters plus a language for the labels. */
export class DailyCashActivityExportQueryDto extends DailyCashActivityQueryDto {
  @ApiPropertyOptional({ enum: ["ar", "en"] })
  @IsOptional()
  @IsIn(["ar", "en"])
  public language?: "ar" | "en";
}

/** Drill-down paging. Bounded in the service as well; this is the first gate. */
export class DailyCashActivityRowsQueryDto extends DailyCashActivityQueryDto {
  @ApiPropertyOptional({ default: 50, maximum: 200, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public offset?: number;
}
