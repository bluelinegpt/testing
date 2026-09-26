import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min } from "class-validator";

import type {
  PaymentPositionDirection,
  PaymentPositionPartyType,
} from "./payment-position.service.js";

export const paymentPositionPartyTypes = ["driver", "employee", "supplier", "trader"] as const;
export const paymentPositionDirections = ["payable", "receivable"] as const;
const partySortKeys = [
  "originalAmount",
  "outstandingAmount",
  "overdueAmount",
  "partyName",
  "transactionCount",
  "transactionDate",
] as const;

/** Query strings arrive as text; `"false"` must not read as truthy. */
const toBoolean = () =>
  Transform(({ value }: { value: unknown }) => value === true || value === "true");

export class PaymentPositionQueryDto {
  /** Label language for the export. Ignored by the JSON endpoints. */
  @ApiPropertyOptional({ enum: ["ar", "en"] })
  @IsOptional()
  @IsIn(["ar", "en"])
  public language?: "ar" | "en";

  @ApiPropertyOptional({ enum: paymentPositionPartyTypes })
  @IsOptional()
  @IsIn(paymentPositionPartyTypes)
  public partyType?: PaymentPositionPartyType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public partyId?: string;

  @ApiPropertyOptional({ enum: paymentPositionDirections })
  @IsOptional()
  @IsIn(paymentPositionDirections)
  public direction?: PaymentPositionDirection;

  @ApiPropertyOptional({ example: "2026-08-01" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateFrom must be YYYY-MM-DD" })
  public dateFrom?: string;

  @ApiPropertyOptional({ example: "2026-08-31" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateTo must be YYYY-MM-DD" })
  public dateTo?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  public outstandingOnly?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  public overdueOnly?: boolean;

  /**
   * Ageing threshold in days.
   *
   * Exposed because no source stores a due date, so "overdue" is a policy this
   * report defines rather than a fact it reads. A caller can see and change it.
   */
  @ApiPropertyOptional({ default: 30, maximum: 3650, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  public overdueAfterDays?: number;

  @ApiPropertyOptional({ enum: partySortKeys })
  @IsOptional()
  @IsIn(partySortKeys)
  public sortBy?: string;

  @ApiPropertyOptional({ enum: ["asc", "desc"] })
  @IsOptional()
  @IsIn(["asc", "desc"])
  public sortDirection?: string;

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
