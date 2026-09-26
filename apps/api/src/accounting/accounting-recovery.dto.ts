import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

import { accountingBatchMaxItems } from "./accounting-batch.constants.js";

/**
 * Historical recovery preview — request contract.
 *
 * Enumerations are validated against the same constants the service uses,
 * imported rather than retyped, for the usual reason: a third copy of a list
 * eventually disagrees with the other two.
 */

export const recoverySourceTypes = ["order", "outsourced_driver_fee_accrual"] as const;
export type RecoverySourceType = (typeof recoverySourceTypes)[number];

export const recoveryClassifications = [
  "eligible",
  "already_posted",
  "duplicate",
  "blocked",
  "closed_period",
  "invalid_source_data",
  "no_accounting_required",
] as const;
export type RecoveryClassification = (typeof recoveryClassifications)[number];

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One selected preview row, as the CLIENT saw it.
 *
 * Everything beyond the id pair is a SNAPSHOT for audit comparison. The server
 * re-runs the authoritative classification before accepting anything and
 * stores its own current verdict, date and amount — the snapshot records what
 * the user believed they were selecting, never what the batch acts on.
 */
export class RecoveryBatchItemDto {
  @ApiProperty({ enum: recoverySourceTypes })
  @IsIn(recoverySourceTypes)
  public readonly sourceType!: RecoverySourceType;

  @ApiProperty()
  @IsUUID()
  public readonly sourceId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(60)
  public readonly sourceReference!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(60)
  public readonly expectedPostingType!: string;

  @ApiProperty({ enum: recoveryClassifications })
  @IsIn(recoveryClassifications)
  public readonly classification!: RecoveryClassification;

  @ApiProperty({ example: "2026-05-01" })
  @Matches(isoDate, { message: "accountingDate must be YYYY-MM-DD" })
  public readonly accountingDate!: string;

  @ApiProperty()
  @IsString()
  @Matches(/^\d{1,16}(\.\d{1,2})?$/, { message: "amount must be a decimal string" })
  public readonly amount!: string;
}

export class CreateRecoveryBatchDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  public readonly reason?: string;

  @ApiProperty({ type: [RecoveryBatchItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(accountingBatchMaxItems)
  @ValidateNested({ each: true })
  @Type(() => RecoveryBatchItemDto)
  public readonly items!: readonly RecoveryBatchItemDto[];
}

export class RecoveryPreviewQueryDto {
  @ApiPropertyOptional({ enum: recoverySourceTypes })
  @IsOptional()
  @IsIn(recoverySourceTypes)
  public readonly sourceType?: RecoverySourceType;

  @ApiPropertyOptional({ example: "2026-01-01" })
  @IsOptional()
  @Matches(isoDate, { message: "dateFrom must be YYYY-MM-DD" })
  public readonly dateFrom?: string;

  @ApiPropertyOptional({ example: "2026-01-31" })
  @IsOptional()
  @Matches(isoDate, { message: "dateTo must be YYYY-MM-DD" })
  public readonly dateTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  public readonly sourceReference?: string;

  @ApiPropertyOptional({ enum: recoveryClassifications })
  @IsOptional()
  @IsIn(recoveryClassifications)
  public readonly classification?: RecoveryClassification;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public readonly sortBy?: string;

  @ApiPropertyOptional({ enum: ["asc", "desc"] })
  @IsOptional()
  @IsIn(["asc", "desc"])
  public readonly sortDirection?: "asc" | "desc";

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public readonly pageSize?: number;
}
