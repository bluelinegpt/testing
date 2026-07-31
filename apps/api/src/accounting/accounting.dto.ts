import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
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
  accountingAccountTypes,
  accountingFiscalPeriodStatuses,
  accountingFiscalYearStatuses,
  accountingJournalSources,
  accountingJournalStatuses,
  accountingJournalTypes,
  accountingNormalBalances,
} from "./accounting.constants.js";

const datePattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const accountCodePattern = /^[\p{L}\p{N}._/-]+(?: [\p{L}\p{N}._/-]+)*$/u;

export class AccountingConfigurationDto {
  @IsOptional()
  @IsBoolean()
  public readonly accountingEnabled?: boolean;

  @IsOptional()
  @IsIn(["AED"])
  public readonly baseCurrency?: "AED";

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  public readonly fiscalYearStartMonth?: number;

  @IsOptional()
  @IsIn(["accrual", "cash"])
  public readonly defaultAccountingMethod?: "accrual" | "cash";

  @IsOptional()
  @IsUUID()
  public readonly retainedEarningsAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly currentYearEarningsAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultRoundingAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultSuspenseAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultCashAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultBankAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultVatOutputAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultVatInputAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultAccountsReceivableAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultAccountsPayableAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultPayrollPayableAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultOutsourcedDriverPayableAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultTraderPayableAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultServiceFeeRevenueAccountId?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly defaultDeliveryRevenueAccountId?: string | null;
}

export class AccountMutationDto {
  @IsString()
  @Matches(accountCodePattern)
  @MaxLength(60)
  public readonly code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  public readonly nameEn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly nameAr?: string;

  @IsIn(accountingAccountTypes)
  public readonly accountType!: string;

  @IsString()
  @MaxLength(80)
  public readonly accountClass!: string;

  @IsOptional()
  @IsUUID()
  public readonly parentAccountId?: string | null;

  @IsBoolean()
  public readonly isPostingAccount!: boolean;

  @IsOptional()
  @IsBoolean()
  public readonly isControlAccount?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly controlAccountType?: string | null;

  @IsOptional()
  @IsBoolean()
  public readonly isSystemAccount?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly systemPurpose?: string | null;

  @IsIn(accountingNormalBalances)
  public readonly normalBalance!: "credit" | "debit";

  @IsOptional()
  @IsBoolean()
  public readonly isContraAccount?: boolean;

  @IsIn(["AED"])
  public readonly currency!: "AED";

  @Matches(datePattern)
  public readonly effectiveFrom!: string;

  @IsOptional()
  @Matches(datePattern)
  public readonly effectiveTo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly description?: string;
}

export class AccountUpdateDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly nameEn?: string;
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly nameAr?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly description?: string | null;
  @IsOptional()
  @IsUUID()
  public readonly parentAccountId?: string | null;
  @IsOptional()
  @IsString()
  public readonly accountClass?: string;
  @IsOptional()
  @IsIn(accountingNormalBalances)
  public readonly normalBalance?: "credit" | "debit";
  @IsOptional()
  @IsBoolean()
  public readonly isPostingAccount?: boolean;
  @IsOptional()
  @IsBoolean()
  public readonly isControlAccount?: boolean;
  @IsOptional()
  @IsString()
  public readonly controlAccountType?: string | null;
  @IsOptional()
  @IsBoolean()
  public readonly isSystemAccount?: boolean;
  @IsOptional()
  @IsString()
  public readonly systemPurpose?: string | null;
  @IsOptional()
  @IsBoolean()
  public readonly isContraAccount?: boolean;
  @IsOptional()
  @Matches(datePattern)
  public readonly effectiveFrom?: string;
  @IsOptional()
  @Matches(datePattern)
  public readonly effectiveTo?: string | null;
}

export class AccountingReasonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  public readonly reason!: string;
}

export class CreateAccountMappingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  public readonly mappingKey!: string;

  @IsOptional() @IsUUID() public readonly debitAccountId?: string;
  @IsOptional() @IsUUID() public readonly creditAccountId?: string;
  @IsOptional() @IsUUID() public readonly vatAccountId?: string;
  @IsOptional() @IsUUID() public readonly feeAccountId?: string;
  @IsOptional() @IsUUID() public readonly expenseAccountId?: string;
  @IsOptional() @IsUUID() public readonly payableAccountId?: string;

  @Matches(datePattern)
  public readonly effectiveFrom!: string;

  @IsOptional()
  @Matches(datePattern)
  public readonly effectiveTo?: string;
}

export class CloseAccountMappingDto {
  @Matches(datePattern)
  public readonly effectiveTo!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  public readonly reason!: string;
}

export class CreateFiscalYearDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  public readonly fiscalYearCode!: string;
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly name!: string;
  @Matches(datePattern)
  public readonly startDate!: string;
  @Matches(datePattern)
  public readonly endDate!: string;
  @IsOptional()
  @IsBoolean()
  public readonly generatePeriods?: boolean;
  @IsOptional()
  @IsString()
  @MaxLength(40)
  public readonly periodCodePrefix?: string;
}

export class CreateFiscalPeriodDto {
  @IsUUID()
  public readonly fiscalYearId!: string;
  @IsInt()
  @Min(1)
  @Max(99)
  public readonly periodNumber!: number;
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  public readonly periodCode!: string;
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly name!: string;
  @Matches(datePattern)
  public readonly startDate!: string;
  @Matches(datePattern)
  public readonly endDate!: string;
  @IsOptional()
  @IsBoolean()
  public readonly isAdjustmentPeriod?: boolean;
}

export class GenerateFiscalPeriodsDto {
  @IsUUID()
  public readonly fiscalYearId!: string;
  @IsOptional()
  @IsString()
  @MaxLength(40)
  public readonly periodCodePrefix?: string;
}

export class JournalLineDto {
  @IsInt()
  @Min(1)
  @Max(9999)
  public readonly lineNumber!: number;
  @IsUUID()
  public readonly accountId!: string;
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999999999.99)
  public readonly debit!: number;
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999999999.99)
  public readonly credit!: number;
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly description?: string;
  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly subledgerType?: string;
  @IsOptional()
  @IsUUID()
  public readonly subledgerId?: string;
  @IsOptional()
  @IsUUID()
  public readonly traderId?: string;
  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;
  @IsOptional()
  @IsUUID()
  public readonly employeeId?: string;
  @IsOptional()
  @IsUUID()
  public readonly orderId?: string;
  @IsOptional()
  @IsUUID()
  public readonly traderSettlementId?: string;
  @IsOptional()
  @IsUUID()
  public readonly driverCollectionId?: string;
  @IsOptional()
  @IsUUID()
  public readonly payrollPeriodId?: string;
  @IsOptional()
  @IsUUID()
  public readonly payrollPaymentId?: string;
  @IsOptional()
  @IsUUID()
  public readonly outsourcedDriverFeeAccrualId?: string;
  @IsOptional()
  @IsUUID()
  public readonly outsourcedDriverFeePaymentId?: string;
  @IsOptional()
  @IsUUID()
  public readonly companyBankAccountId?: string;
  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly sourceEntityType?: string;
  @IsOptional()
  @IsUUID()
  public readonly sourceEntityId?: string;
}

export class CreateJournalDto {
  @Matches(datePattern)
  public readonly journalDate!: string;
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  public readonly description!: string;
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly sourceReference?: string;
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly correlationReference?: string;
  @IsIn(["AED"])
  public readonly currency!: "AED";
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public readonly notes?: string;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  public readonly lines?: readonly JournalLineDto[];
}

export class UpdateJournalDto {
  @IsOptional()
  @Matches(datePattern)
  public readonly journalDate?: string;
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  public readonly description?: string;
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly sourceReference?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly correlationReference?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public readonly notes?: string | null;
}

export class ReplaceJournalLinesDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  public readonly lines!: readonly JournalLineDto[];
}

export class AccountingNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly note?: string;
}

export class CancelJournalDto extends AccountingReasonDto {}

export class ReverseJournalDto extends AccountingReasonDto {
  @Matches(datePattern)
  public readonly reversalDate!: string;
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly description?: string;
}

export class JournalListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) public readonly page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  public readonly pageSize?: number;
  @IsOptional() @IsString() @MaxLength(100) public readonly journalNumber?: string;
  @IsOptional() @Matches(datePattern) public readonly dateFrom?: string;
  @IsOptional() @Matches(datePattern) public readonly dateTo?: string;
  @IsOptional() @IsUUID() public readonly fiscalYearId?: string;
  @IsOptional() @IsUUID() public readonly fiscalPeriodId?: string;
  @IsOptional() @IsIn(accountingJournalTypes) public readonly journalType?: string;
  @IsOptional() @IsIn(accountingJournalSources) public readonly journalSource?: string;
  @IsOptional() @IsIn(accountingJournalStatuses) public readonly status?: string;
  @IsOptional() @IsUUID() public readonly accountId?: string;
  @IsOptional() @IsUUID() public readonly traderId?: string;
  @IsOptional() @IsUUID() public readonly driverId?: string;
  @IsOptional() @IsUUID() public readonly employeeId?: string;
  @IsOptional() @IsUUID() public readonly orderId?: string;
  @IsOptional() @IsUUID() public readonly settlementId?: string;
  @IsOptional() @IsUUID() public readonly driverCollectionId?: string;
  @IsOptional() @IsUUID() public readonly payrollPeriodId?: string;
  @IsOptional() @IsUUID() public readonly createdBy?: string;
  @IsOptional() @IsUUID() public readonly approvedBy?: string;
  @IsOptional() @IsUUID() public readonly postedBy?: string;
  @IsOptional() @IsBoolean() public readonly reversedOnly?: boolean;
  @IsOptional() @IsBoolean() public readonly cancelledOnly?: boolean;
}

export class OpeningBalanceLineDto {
  @IsInt() @Min(1) @Max(9999) public readonly lineNumber!: number;
  @IsUUID() public readonly accountId!: string;
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0) @Max(9999999999999999.99) public readonly debit!: number;
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0) @Max(9999999999999999.99) public readonly credit!: number;
  @IsOptional() @IsString() @MaxLength(1000) public readonly description?: string;
  @IsOptional() @IsString() @MaxLength(80) public readonly subledgerType?: string;
  @IsOptional() @IsUUID() public readonly subledgerId?: string;
  @IsOptional() @IsUUID() public readonly traderId?: string;
  @IsOptional() @IsUUID() public readonly driverId?: string;
  @IsOptional() @IsUUID() public readonly employeeId?: string;
}

export class CreateOpeningBalanceDto {
  @Matches(datePattern) public readonly effectiveDate!: string;
  @IsString() @MinLength(1) @MaxLength(1000) public readonly description!: string;
  @IsIn(["AED"]) public readonly currency!: "AED";
  @IsOptional() @IsString() @MaxLength(2000) public readonly notes?: string;
  @IsOptional()
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => OpeningBalanceLineDto)
  public readonly lines?: readonly OpeningBalanceLineDto[];
}

export class UpdateOpeningBalanceDto {
  @IsOptional() @Matches(datePattern) public readonly effectiveDate?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(1000)
  public readonly description?: string;
  @IsOptional() @IsString() @MaxLength(2000) public readonly notes?: string | null;
}

export class ReplaceOpeningBalanceLinesDto {
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => OpeningBalanceLineDto)
  public readonly lines!: readonly OpeningBalanceLineDto[];
}

export class ReverseOpeningBalanceDto extends AccountingReasonDto {
  @Matches(datePattern)
  public readonly reversalDate!: string;
}

export class OpeningBalanceListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) public readonly page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  public readonly pageSize?: number;
  @IsOptional() @IsString() @MaxLength(100) public readonly batchNumber?: string;
  @IsOptional() @Matches(datePattern) public readonly dateFrom?: string;
  @IsOptional() @Matches(datePattern) public readonly dateTo?: string;
  @IsOptional() @IsUUID() public readonly fiscalYearId?: string;
  @IsOptional() @IsUUID() public readonly fiscalPeriodId?: string;
  @IsOptional() @IsIn(["draft","validated","approved","posted","reversed"])
  public readonly status?: string;
  @IsOptional() @IsUUID() public readonly accountId?: string;
  @IsOptional() @IsUUID() public readonly traderId?: string;
  @IsOptional() @IsUUID() public readonly driverId?: string;
  @IsOptional() @IsUUID() public readonly employeeId?: string;
  @IsOptional() @IsUUID() public readonly createdBy?: string;
  @IsOptional() @IsUUID() public readonly approvedBy?: string;
  @IsOptional() @IsUUID() public readonly postedBy?: string;
  @IsOptional() @IsBoolean() public readonly reversedOnly?: boolean;
}

export class FiscalCalendarListQueryDto {
  @IsOptional() @IsUUID() public readonly fiscalYearId?: string;
  @IsOptional() @IsIn(accountingFiscalYearStatuses) public readonly yearStatus?: string;
  @IsOptional() @IsIn(accountingFiscalPeriodStatuses) public readonly periodStatus?: string;
}
