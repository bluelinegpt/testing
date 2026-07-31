import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  MinLength,
  Min,
} from "class-validator";

import { accountingOperationalAreas } from "./accounting-ownership.matrix.js";

export class AutomaticPostingChangeDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(accountingOperationalAreas, { each: true })
  public readonly areas!: string[];

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly reason!: string;
}

export class AutomaticPostingDisableDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly reason!: string;
}

export class AccountingEventListQueryDto {
  @IsOptional()
  @IsIn(["received","processing","validated","posted","failed","retry_pending","blocked_configuration","reversed","ignored_duplicate"])
  public readonly status?: string;

  @IsOptional()
  @IsIn(accountingOperationalAreas)
  public readonly area?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  public readonly eventType?: string;

  @IsOptional()
  @IsDateString()
  public readonly dateFrom?: string;

  @IsOptional()
  @IsDateString()
  public readonly dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public readonly pageSize?: number;
}

export class AccountingEventReprocessDto {
  @IsString()
  @MaxLength(500)
  public readonly reason!: string;
}

export class AccountingEventBulkReprocessDto extends AccountingEventReprocessDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID("4", { each: true })
  public readonly eventIds!: string[];
}

export class AccountingReconciliationQueryDto extends AccountingEventListQueryDto {
  @IsOptional()
  @IsIn(["missing","mismatch","failed","posted","reversed","queued"])
  public readonly result?: string;
}

export class AccountingBackfillPreviewDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(accountingOperationalAreas, { each: true })
  public readonly areas!: string[];

  @IsDateString()
  public readonly dateFrom!: string;

  @IsDateString()
  public readonly dateTo!: string;
}
