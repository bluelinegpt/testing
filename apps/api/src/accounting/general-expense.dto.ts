import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
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

const moneyPattern = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/;
const percentPattern = /^(?:0|[1-9]\d?|\d{1,2}\.\d{1,4}|100(?:\.0{1,4})?)$/;
const categoryCodePattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

export const generalExpenseVatTreatments = [
  "standard_rated",
  "zero_rated",
  "exempt",
  "out_of_scope",
  "non_recoverable",
  "partially_recoverable",
] as const;

export const generalExpensePayeeTypes = [
  "supplier",
  "employee",
  "driver",
  "trader",
  "government",
  "landlord",
  "service_provider",
  "other",
] as const;

export class GeneralExpenseReasonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly reason!: string;

  @IsOptional()
  @IsDateString()
  public readonly accountingDate?: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  public readonly version!: number;
}

export class CreateGeneralExpenseCategoryDto {
  @IsString()
  @Matches(categoryCodePattern)
  public readonly code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly nameEn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly description?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  public readonly defaultExpenseMappingKey!: string;

  @IsIn(generalExpenseVatTreatments)
  public readonly defaultVatTreatment!: string;

  @IsDateString()
  public readonly effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  public readonly effectiveTo?: string;
}

export class UpdateGeneralExpenseCategoryDto extends CreateGeneralExpenseCategoryDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  public readonly version!: number;
}

export class GeneralExpenseLineDto {
  @IsUUID()
  public readonly categoryId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly description!: string;

  @IsString()
  @Matches(moneyPattern)
  public readonly quantity!: string;

  @IsString()
  @Matches(moneyPattern)
  public readonly unitAmount!: string;

  @IsIn(generalExpenseVatTreatments)
  public readonly vatTreatment!: string;

  @IsString()
  @Matches(percentPattern)
  public readonly vatRate!: string;

  @IsOptional()
  @IsString()
  @Matches(percentPattern)
  public readonly recoverablePercentage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly expenseAccountMappingKey?: string;

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
}

export class CreateGeneralExpenseDto {
  @IsOptional()
  @IsDateString()
  public readonly expenseDate?: string;

  @IsOptional()
  @IsDateString()
  public readonly accountingDate?: string;

  @IsOptional()
  @IsUUID()
  public readonly categoryId?: string;

  @IsOptional()
  @IsIn(generalExpensePayeeTypes)
  public readonly payeeType?: string;

  @IsOptional()
  @IsUUID()
  public readonly payeeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly payeeName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public readonly payeeContact?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly referenceNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  public readonly externalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  public readonly vatRegistrationNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly taxInvoiceNumber?: string;

  @IsOptional()
  @IsDateString()
  public readonly taxInvoiceDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;

  @IsOptional()
  @IsIn(["manual_general_expense", "employee_reimbursement"])
  public readonly sourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly sourceEntityType?: string;

  @IsOptional()
  @IsUUID()
  public readonly sourceEntityId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GeneralExpenseLineDto)
  public readonly lines?: GeneralExpenseLineDto[];
}

export class UpdateGeneralExpenseDto extends CreateGeneralExpenseDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  public readonly version!: number;
}

export class GeneralExpenseAttachmentDto {
  @IsUUID()
  public readonly fileObjectId!: string;

  @IsIn([
    "invoice",
    "receipt",
    "tax_invoice",
    "quotation",
    "approval",
    "payment_evidence",
    "contract",
    "other",
  ])
  public readonly attachmentType!: string;

  @IsOptional()
  @IsUUID()
  public readonly paymentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly description?: string;
}

export class GeneralExpenseAttachmentUploadDto {
  @IsIn([
    "invoice",
    "receipt",
    "tax_invoice",
    "quotation",
    "approval",
    "payment_evidence",
    "contract",
    "other",
  ])
  public readonly attachmentType!: string;

  @IsOptional()
  @IsUUID()
  public readonly paymentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly description?: string;
}

export class GeneralExpensePaymentRowDto {
  @IsIn(["cash", "visa"])
  public readonly paymentMethod!: "cash" | "visa";

  @IsString()
  @Matches(moneyPattern)
  public readonly amount!: string;

  /**
   * The Company Cash Account the money left -- a `company_cash_accounts` id,
   * symmetrical with `companyBankAccountId`.
   *
   * It replaces the GL account id this field used to carry. A GL id identifies
   * what the payment credits, not which drawer paid it, and two Cash Accounts
   * may share one GL code. The GL account is now derived server-side from this
   * Cash Account's own link and is never accepted from the client.
   */
  @IsOptional()
  @IsUUID()
  public readonly companyCashAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly companyBankAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly referenceNumber?: string;
}

export class CreateGeneralExpensePaymentDto {
  /**
   * Why this payment may take one of its funding accounts below the permitted
   * floor.
   *
   * One reason covers the whole payment, not one per row: a split payment is
   * confirmed or refused as a single act, and the person authorising it is
   * explaining that act. Which accounts actually needed the override is
   * recorded per account in the audit, from the decision itself.
   *
   * Optional here and conditional in the backend, which is the only place the
   * condition can be evaluated: whether an override is needed depends on the
   * balances at confirmation and the Company policy in force.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly balanceOverrideReason?: string;

  @IsDateString()
  public readonly paymentDate!: string;

  @IsOptional()
  @IsDateString()
  public readonly accountingDate?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => GeneralExpensePaymentRowDto)
  public readonly rows!: GeneralExpensePaymentRowDto[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly referenceNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  public readonly expenseVersion!: number;
}

export class GeneralExpenseListQueryDto {
  @IsOptional()
  @IsIn([
    "draft",
    "submitted",
    "approved",
    "partially_paid",
    "paid",
    "rejected",
    "cancelled",
    "reversed",
  ])
  public readonly status?: string;

  @IsOptional()
  @IsIn(["unpaid", "partially_paid", "paid", "reversed"])
  public readonly paymentStatus?: string;

  @IsOptional()
  @IsUUID()
  public readonly categoryId?: string;

  @IsOptional()
  @IsDateString()
  public readonly dateFrom?: string;

  @IsOptional()
  @IsDateString()
  public readonly dateTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  public readonly search?: string;

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

export class GeneralExpensePaymentListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  public readonly search?: string;
  @IsOptional()
  @IsIn(["cash", "visa"])
  public readonly paymentMethod?: string;
  @IsOptional()
  @IsIn(["confirmed", "reversed"])
  public readonly status?: string;
  @IsOptional()
  @IsDateString()
  public readonly dateFrom?: string;
  @IsOptional()
  @IsDateString()
  public readonly dateTo?: string;
  /** Business reference filters — no identifier is ever typed by the User. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  public readonly expenseNumber?: string;
  @IsOptional()
  @IsString()
  @MaxLength(50)
  public readonly paymentNumber?: string;
  @IsOptional()
  @IsString()
  @MaxLength(150)
  public readonly payee?: string;
  @IsOptional()
  @IsString()
  @Matches(moneyPattern)
  public readonly amountFrom?: string;
  @IsOptional()
  @IsString()
  @Matches(moneyPattern)
  public readonly amountTo?: string;
  /** Accounting Event state of the Payment, shown as Pending/Posted/Failed. */
  @IsOptional()
  @IsIn(["pending", "posted", "failed"])
  public readonly accountingStatus?: string;
  @IsOptional()
  @IsIn(["paymentDate", "paymentNumber", "amount", "expenseNumber", "payee"])
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

/** Searchable selector source for "Expense to Pay" — eligible Expenses only. */
export class PayableGeneralExpenseQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  public readonly search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public readonly limit?: number;

  /**
   * Keeps an already-selected Expense in the option list even when it falls
   * outside the search text, so a preselected Expense never disappears.
   */
  @IsOptional()
  @IsUUID()
  public readonly includeExpenseId?: string;
}

/**
 * Read-only Payment preview input. Mirrors the confirmation payload without
 * the version, because a preview never writes.
 */
export class GeneralExpensePaymentPreviewQueryDto {
  @IsString()
  @Matches(moneyPattern)
  public readonly amount!: string;

  @IsIn(["cash", "visa"])
  public readonly paymentMethod!: "cash" | "visa";

  /** A `company_cash_accounts` id, matching the confirmation contract. */
  @IsOptional()
  @IsUUID()
  public readonly companyCashAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly companyBankAccountId?: string;

  @IsOptional()
  @IsDateString()
  public readonly accountingDate?: string;
}

export class GeneralExpenseBackfillPreviewDto {
  @IsDateString()
  public readonly dateFrom!: string;

  @IsDateString()
  public readonly dateTo!: string;

  @IsOptional()
  @IsBoolean()
  public readonly includeLegacyOperatingExpenses?: boolean;
}
