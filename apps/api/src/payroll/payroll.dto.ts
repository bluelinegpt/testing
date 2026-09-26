import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
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
  ValidateNested,
} from "class-validator";

export class CreatePayrollPeriodDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  public readonly payrollMonth!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;
}

export class PayrollReasonDto {
  @IsString()
  @MaxLength(1000)
  public readonly reason!: string;
}

export class CalculatePayrollPeriodDto {
  // Optional and defaults to true (both calculate and recalculate already
  // included every configured Delivery/Collection Earning automatically
  // before this existed) -- explicitly false is the only way to opt out for
  // this one run.
  @IsOptional()
  @IsBoolean()
  public readonly includeDriverEarnings?: boolean;
}

export class CreatePayrollAdjustmentDto {
  @IsOptional()
  @IsUUID()
  public readonly employeeId?: string;

  @IsIn(["bonus", "penalty", "unpaid_leave", "advance_recovery", "correction", "other"])
  public readonly adjustmentType!: string;

  @IsIn(["earning", "deduction"])
  public readonly direction!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Max(9999999999999.99)
  @Min(0.01)
  public readonly amount!: number;

  @IsString()
  @MaxLength(1000)
  public readonly reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly sourceReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;
}

export class PayrollPaymentAllocationDto {
  @IsUUID()
  public readonly lineId!: string;

  @IsUUID()
  public readonly employeeId!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Max(9999999999999.99)
  @Min(0.01)
  public readonly amount!: number;
}

export class PayrollPaymentProposalDto {
  @IsUUID()
  public readonly periodId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  public readonly lineIds!: readonly string[];

  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Max(9999999999999.99)
  @Min(0.01)
  public readonly totalAmount?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PayrollPaymentAllocationDto)
  public readonly allocations?: readonly PayrollPaymentAllocationDto[];
}

export class ConfirmPayrollPaymentDto {
  @IsUUID()
  public readonly periodId!: string;

  /**
   * The Company CASH account funding this payment.
   *
   * Required, and required to be a Cash account: payroll is cash-only, so
   * there is no bank alternative to offer and no payment method to choose.
   * Validated server-side against the Company before the payment is written.
   */
  @IsUUID()
  public readonly accountId!: string;

  @IsDateString()
  public readonly paymentDate!: string;

  @IsString()
  @MaxLength(100)
  public readonly cashVoucherReference!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly externalReference?: string;

  @IsIn(["checkbox", "typed_name", "physical_signature"])
  public readonly acknowledgementType!: "checkbox" | "physical_signature" | "typed_name";

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public readonly acknowledgementValue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;

  /**
   * Why this payment may take the Cash account below its permitted floor.
   *
   * Optional here and mandatory in the backend, which is the only place the
   * answer can be known: whether an override is needed depends on the balance
   * at confirmation time and the Company policy in force, neither of which the
   * client can evaluate. A payment that passes normally never needs this; one
   * that does not is rejected without it, by BalanceControlService's own rule.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly balanceOverrideReason?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PayrollPaymentAllocationDto)
  public readonly allocations!: readonly PayrollPaymentAllocationDto[];
}

export class PayrollPeriodListQueryDto {
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

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  public readonly payrollMonth?: string;

  @IsOptional()
  @IsString()
  public readonly status?: string;

  @IsOptional()
  @IsDateString()
  public readonly dateFrom?: string;

  @IsOptional()
  @IsDateString()
  public readonly dateTo?: string;

  @IsOptional()
  @IsBoolean()
  public readonly outstandingOnly?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly search?: string;
}

export class PayrollLineListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public readonly pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly employee?: string;

  @IsOptional()
  @IsString()
  public readonly status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly department?: string;

  @IsOptional()
  @IsString()
  public readonly employeeType?: string;

  @IsOptional()
  @IsBoolean()
  public readonly outstandingOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  public readonly heldOnly?: boolean;
}

export class PayrollPaymentListQueryDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly paymentNumber?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  public readonly payrollMonth?: string;

  @IsOptional()
  @IsDateString()
  public readonly paymentDateFrom?: string;

  @IsOptional()
  @IsDateString()
  public readonly paymentDateTo?: string;

  @IsOptional()
  @IsUUID()
  public readonly employeeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly employee?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly voucherReference?: string;

  @IsOptional()
  @IsString()
  public readonly status?: string;

  @IsOptional()
  @IsUUID()
  public readonly paidBy?: string;
}
