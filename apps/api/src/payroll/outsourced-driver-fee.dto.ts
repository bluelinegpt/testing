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
  MinLength,
  ValidateNested,
} from "class-validator";

export class OutsourcedDriverFeeAllocationDto {
  @IsUUID()
  public readonly accrualId!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  public readonly amount!: number;
}

export class OutsourcedDriverFeeReconcileDto {
  @IsDateString()
  public readonly businessDate!: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;
}

export class OutsourcedDriverFeeBackfillDto {
  @IsDateString()
  public readonly fromDate!: string;

  @IsDateString()
  public readonly toDate!: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;

  @IsOptional()
  @IsBoolean()
  public readonly preview?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  public readonly notes?: string;
}

export class OutsourcedDriverFeeReasonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  public readonly reason!: string;
}

export class OutsourcedDriverFeeAccrualListQueryDto {
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
  @IsUUID()
  public readonly driverId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  public readonly driver?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  public readonly driverCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly orderNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly serialNumber?: string;

  @IsOptional()
  @IsDateString()
  public readonly deliveryDateFrom?: string;

  @IsOptional()
  @IsDateString()
  public readonly deliveryDateTo?: string;

  @IsOptional()
  @IsDateString()
  public readonly accrualDateFrom?: string;

  @IsOptional()
  @IsDateString()
  public readonly accrualDateTo?: string;

  @IsOptional()
  @IsIn(["accrued", "partially_paid", "paid", "reversed", "recovery_required"])
  public readonly status?: string;

  @IsOptional()
  @IsIn(["delivery", "daily_reconciliation", "authorized_backfill"])
  public readonly source?: string;

  @IsOptional()
  @IsBoolean()
  public readonly outstandingOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  public readonly recoveryRequiredOnly?: boolean;
}

export class OutsourcedDriverFeePaymentProposalDto {
  @IsUUID()
  public readonly driverId!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  public readonly amount!: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OutsourcedDriverFeeAllocationDto)
  public readonly allocations?: readonly OutsourcedDriverFeeAllocationDto[];
}

export class ConfirmOutsourcedDriverFeePaymentDto extends OutsourcedDriverFeePaymentProposalDto {
  @IsDateString()
  public readonly paymentDate!: string;

  /**
   * The Company CASH account funding this payment.
   *
   * Optional on the decorator, REQUIRED in the service. The rule is
   * conditional -- a collection offset must supply none -- and a decorator
   * cannot express a condition that depends on which endpoint was called,
   * so the service is the only honest place to enforce it.
   */
  @IsOptional()
  @IsUUID()
  public readonly accountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly cashVoucherReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly externalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;

  /**
   * Why this payment may take the Cash account below its permitted floor.
   *
   * Cash payments only. A collection offset moves no Company funds and is never
   * balance-checked, so it has no use for this and its internal input does not
   * carry it.
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

export class OutsourcedDriverFeePaymentListQueryDto {
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
  @IsUUID()
  public readonly driverId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly driver?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly driverCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly paymentNumber?: string;

  @IsOptional()
  @IsDateString()
  public readonly paymentDateFrom?: string;

  @IsOptional()
  @IsDateString()
  public readonly paymentDateTo?: string;

  @IsOptional()
  @IsIn(["cash", "collection_offset"])
  public readonly paymentMethod?: string;

  @IsOptional()
  @IsIn(["separate_payment", "driver_collection"])
  public readonly paymentSource?: string;

  @IsOptional()
  @IsIn(["confirmed", "reversed"])
  public readonly status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly voucherReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly externalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly reconciliation?: string;

  @IsOptional()
  @IsUUID()
  public readonly paidBy?: string;
}

export class OutsourcedDriverFeeStatementQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/)
  public readonly month?: string;

  @IsOptional()
  @IsDateString()
  public readonly from?: string;

  @IsOptional()
  @IsDateString()
  public readonly to?: string;

  @IsOptional()
  @IsIn(["accrued", "partially_paid", "paid", "reversed", "recovery_required"])
  public readonly status?: string;

  @IsOptional()
  @IsIn(["en", "ar"])
  public readonly language?: "en" | "ar";
}

export class OutstandingDriverFeesReportQueryDto {
  @IsDateString()
  public readonly asOf!: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0)
  public readonly minimumOutstanding?: number;

  @IsOptional()
  @IsDateString()
  public readonly oldestUnpaidDate?: string;

  @IsOptional()
  @IsIn(["accrued", "partially_paid"])
  public readonly status?: string;

  @IsOptional()
  @IsIn(["en", "ar"])
  public readonly language?: "en" | "ar";
}

export class DailyDriverFeeAccrualReportQueryDto {
  @IsDateString()
  public readonly from!: string;

  @IsDateString()
  public readonly to!: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;

  @IsOptional()
  @IsIn(["delivery", "daily_reconciliation", "authorized_backfill"])
  public readonly source?: string;

  @IsOptional()
  @IsIn(["accrued", "partially_paid", "paid", "reversed", "recovery_required"])
  public readonly status?: string;

  @IsOptional()
  @IsIn(["en", "ar"])
  public readonly language?: "en" | "ar";
}
