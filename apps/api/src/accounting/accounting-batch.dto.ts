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
} from "class-validator";

import {
  accountingBatchMaxItems,
  accountingBatchStatuses,
  accountingBatchTypes,
  accountingBatchValidationStatuses,
  type AccountingBatchStatus,
  type AccountingBatchType,
  type AccountingBatchValidationStatus,
} from "./accounting-batch.constants.js";

/**
 * Batch request contracts.
 *
 * Every enumerated field is validated against the SAME constant the service and
 * the database CHECK use, imported rather than retyped. A DTO with its own copy
 * of a status list is a third definition that will eventually disagree with the
 * other two, and the disagreement reaches the caller as a constraint violation
 * they cannot act on.
 */

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export class CreateAccountingBatchDto {
  @ApiProperty({ enum: accountingBatchTypes })
  @IsIn(accountingBatchTypes)
  public readonly batchType!: AccountingBatchType;

  /**
   * Why this batch exists.
   *
   * Required, and required to be substantive. A batch is a control record; one
   * created without a stated purpose is not reviewable later, and "why did 200
   * Events change" is the first question anyone asks.
   */
  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  public readonly reason!: string;

  /**
   * Optional initial items, so a batch can be created and populated in one
   * idempotent request rather than two.
   */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(accountingBatchMaxItems)
  @IsUUID(undefined, { each: true })
  public readonly sourceIds?: readonly string[];
}

export class AddAccountingBatchItemsDto {
  /**
   * Source record ids to enrol.
   *
   * The source TYPE is not accepted from the client: it is determined by the
   * batch type, which already names the single-item service. Letting a caller
   * pair an arbitrary type with a batch would allow a batch whose items no
   * service can act on.
   */
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(accountingBatchMaxItems)
  @IsUUID(undefined, { each: true })
  public readonly sourceIds!: readonly string[];
}

export class ExecuteAccountingBatchDto {
  /**
   * The batch version the caller last saw.
   *
   * Execution acts on hundreds of records, so it must act on the batch the
   * caller REVIEWED, not the batch as it happens to be now. A version that has
   * moved on means someone added items, revalidated or cancelled in between,
   * and the request is refused rather than run against a different plan.
   */
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly expectedVersion!: number;
}

/**
 * Operator recovery of a batch stuck in `processing`.
 *
 * The version pins the recovery to the state the operator REVIEWED, and the
 * reason is mandatory — releasing an interrupted control record without a
 * stated justification is not reviewable later.
 */
export class RecoverAccountingBatchDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly expectedVersion!: number;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  public readonly reason!: string;
}

export class CancelAccountingBatchDto {
  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  public readonly reason!: string;
}

export class AccountingBatchListQueryDto {
  @ApiPropertyOptional({ enum: accountingBatchStatuses })
  @IsOptional()
  @IsIn(accountingBatchStatuses)
  public readonly status?: AccountingBatchStatus;

  @ApiPropertyOptional({ enum: accountingBatchTypes })
  @IsOptional()
  @IsIn(accountingBatchTypes)
  public readonly batchType?: AccountingBatchType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public readonly requestedBy?: string;

  @ApiPropertyOptional({ example: "2026-08-01" })
  @IsOptional()
  @Matches(isoDate, { message: "dateFrom must be YYYY-MM-DD" })
  public readonly dateFrom?: string;

  @ApiPropertyOptional({ example: "2026-08-31" })
  @IsOptional()
  @Matches(isoDate, { message: "dateTo must be YYYY-MM-DD" })
  public readonly dateTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  public readonly reference?: string;

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

/** Item-level paging and filtering inside one batch's detail. */
export class AccountingBatchItemQueryDto {
  @ApiPropertyOptional({ enum: accountingBatchValidationStatuses })
  @IsOptional()
  @IsIn(accountingBatchValidationStatuses)
  public readonly validationStatus?: AccountingBatchValidationStatus;

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
