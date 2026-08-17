import { Type } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
} from "class-validator";

export class DriverEarningsQueryDto {
  @IsOptional() @IsUUID() public readonly driverId?: string;
  @IsOptional() @IsIn(["employee", "outsourced"]) public readonly driverType?: string;
  @IsOptional() @IsDateString() public readonly dateFrom?: string;
  @IsOptional() @IsDateString() public readonly dateTo?: string;
  @IsOptional() @IsIn(["unpaid", "partially_paid", "paid"]) public readonly status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) public readonly page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) public readonly pageSize?: number;
}

export class ReconcileEmployeeDriverEarningsDto {
  @IsUUID() public readonly driverId!: string;
  @IsDateString() public readonly dateFrom!: string;
  @IsDateString() public readonly dateTo!: string;
}

export class CalculateEmployeeDriverEarningPeriodDto extends ReconcileEmployeeDriverEarningsDto {}

export class EmployeeMoneyPaymentDto {
  @IsUUID() public readonly employeeId!: string;
  @IsOptional() @IsUUID() public readonly earningPeriodId?: string;
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999999.99)
  public readonly amount!: number;
  @IsDateString() public readonly paymentDate!: string;
  @IsIn(["cash", "bank"]) public readonly paymentMethod!: "bank" | "cash";
  @IsUUID() public readonly accountId!: string;
  @IsOptional() @IsString() @MaxLength(200) public readonly reference?: string;
  @IsOptional() @IsString() @MaxLength(1000) public readonly notes?: string;
  @IsOptional() @IsString() @MaxLength(1000) public readonly balanceOverrideReason?: string;
}

export class SalaryAdvanceAvailabilityQueryDto {
  @IsUUID() public readonly employeeId!: string;
  @IsDateString() public readonly paymentDate!: string;
}

export class DriverMonthlyPaymentsQueryDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  public readonly month!: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;
}

export class EmployeeMoneyReasonDto {
  @IsString() @MaxLength(1000) public readonly reason!: string;
}

export class SaveOutsourcedCollectionRuleDto {
  @IsIn(["none", "per_collected_order"])
  public readonly collectionPaymentType!: "none" | "per_collected_order";
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999999.99)
  public readonly amount!: number;
  @IsDateString() public readonly effectiveFrom!: string;
  @IsOptional() @IsDateString() public readonly effectiveTo?: string;
}
