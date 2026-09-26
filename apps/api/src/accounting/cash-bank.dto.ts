import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
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

import {
  bankAccountTypes,
  cashAccountTypes,
  cashBankClassificationMappingKeys,
  cashBankMovementStatuses,
  cashBankMovementTypes,
} from "./accounting.constants.js";

const attachmentTypes = [
  "deposit_slip",
  "withdrawal_slip",
  "transfer_instruction",
  "bank_confirmation",
  "cash_receipt",
  "payment_proof",
  "fee_evidence",
  "approval",
  "other",
] as const;

export class CashAccountMutationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  public readonly code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  public readonly name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly nameAr?: string;

  @IsIn(cashAccountTypes)
  public readonly type!: (typeof cashAccountTypes)[number];

  @IsOptional()
  @IsUUID()
  public readonly branchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public readonly locationOrCustodian?: string;

  @IsUUID()
  public readonly linkedGlAccountId!: string;

  @IsDateString()
  public readonly effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  public readonly effectiveTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  public readonly version?: number;
}

export class BankAccountMutationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  public readonly code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  public readonly accountName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  public readonly bankName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly branchName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly accountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  public readonly swiftCode?: string;

  @IsIn(bankAccountTypes)
  public readonly accountType!: (typeof bankAccountTypes)[number];

  @IsUUID()
  public readonly linkedGlAccountId!: string;

  @IsDateString()
  public readonly effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  public readonly effectiveTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  public readonly version?: number;
}

export class CashBankReasonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly reason!: string;
}

export class CashBankAttachmentDto {
  @IsUUID()
  public readonly fileObjectId!: string;

  @IsIn(attachmentTypes)
  public readonly attachmentType!: (typeof attachmentTypes)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly description?: string;
}

export class CashBankMovementMutationDto {
  @IsIn(cashBankMovementTypes)
  public readonly movementType!: (typeof cashBankMovementTypes)[number];

  @IsDateString()
  public readonly movementDate!: string;

  @IsDateString()
  public readonly accountingDate!: string;

  @IsOptional()
  @IsUUID()
  public readonly sourceCashAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly sourceBankAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly destinationCashAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly destinationBankAccountId?: string;

  @IsNumberString()
  public readonly amount!: string;

  @IsOptional()
  @IsNumberString()
  public readonly feeAmount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly feeDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly sourceClassification?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly destinationClassification?: string;

  @IsOptional()
  @IsIn(cashBankClassificationMappingKeys)
  public readonly classificationMappingKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly referenceNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly externalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CashBankAttachmentDto)
  public readonly attachments?: CashBankAttachmentDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  public readonly version?: number;
}

export class CashBankConfirmDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly note?: string;

  /**
   * Why this Movement may take its SOURCE account below the permitted floor.
   *
   * Only a Movement that takes money out of a Company account can need this: a
   * deposit has no source, and a transfer's destination only gains.
   *
   * Optional here and conditional in the backend, which is the only place the
   * condition can be evaluated: whether an override is needed depends on the
   * balance at confirmation and the Company policy in force.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly balanceOverrideReason?: string;
}

export class CashBankReverseDto extends CashBankReasonDto {
  @IsDateString()
  public readonly reversalDate!: string;
}

export class CashBankListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly search?: string;

  @IsOptional()
  @IsIn(cashBankMovementTypes)
  public readonly movementType?: string;

  @IsOptional()
  @IsIn(cashBankMovementStatuses)
  public readonly status?: string;

  @IsOptional()
  @IsDateString()
  public readonly dateFrom?: string;

  @IsOptional()
  @IsDateString()
  public readonly dateTo?: string;

  @IsOptional()
  @IsUUID()
  public readonly cashAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly bankAccountId?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  public readonly reversedOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  public readonly missingJournalOnly?: boolean;

  /** Business filters — the User never types an identifier. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  public readonly movementNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly referenceNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/)
  public readonly amountFrom?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/)
  public readonly amountTo?: string;

  /** Accounting Event state of the Movement: Pending / Posted / Failed. */
  @IsOptional()
  @IsIn(["pending", "posted", "failed"])
  public readonly accountingStatus?: string;

  /** Movement shape family, for the Cash / Bank / Transfer quick filters. */
  @IsOptional()
  @IsIn(["cash", "bank", "transfer", "fee"])
  public readonly movementFamily?: string;

  @IsOptional()
  @IsUUID()
  public readonly createdByAccountId?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  public readonly excludeReversed?: boolean;

  @IsOptional()
  @IsIn(["accountingDate", "movementDate", "movementNumber", "amount", "movementType"])
  public readonly sortBy?: string;

  @IsOptional()
  @IsIn(["asc", "desc"])
  public readonly sortDirection?: string;

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

/**
 * Read-only "what would confirmation post?" input for a Movement that may not
 * exist yet, so the User sees the Journal before anything is created. Mirrors
 * `CashBankMovementMutationDto` without the version and attachments.
 */
export class CashBankMovementPreviewQueryDto {
  @IsIn(cashBankMovementTypes)
  public readonly movementType!: (typeof cashBankMovementTypes)[number];

  @IsOptional()
  @IsDateString()
  public readonly accountingDate?: string;

  @IsOptional()
  @IsUUID()
  public readonly sourceCashAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly sourceBankAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly destinationCashAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly destinationBankAccountId?: string;

  @IsNumberString()
  public readonly amount!: string;

  @IsOptional()
  @IsNumberString()
  public readonly feeAmount?: string;

  @IsOptional()
  @IsIn(cashBankClassificationMappingKeys)
  public readonly classificationMappingKey?: string;
}

export class CashBankBackfillPreviewDto {
  @IsDateString()
  public readonly dateFrom!: string;

  @IsDateString()
  public readonly dateTo!: string;

  @IsOptional()
  @IsIn(["cash", "bank"])
  public readonly accountType?: "cash" | "bank";

  @IsOptional()
  @IsUUID()
  public readonly accountId?: string;

  @IsOptional()
  @IsArray()
  @IsIn(cashBankMovementTypes, { each: true })
  public readonly movementTypes?: string[];

  @IsOptional()
  @IsBoolean()
  public readonly includeReversals?: boolean;

  @IsOptional()
  @IsBoolean()
  public readonly includeFees?: boolean;
}
