import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

import { accountingOperationalAreas } from "./accounting-ownership.matrix.js";

const datePattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

export class AccountingSetupDateQueryDto {
  @IsOptional() @Matches(datePattern) public readonly effectiveOn?: string;
}

export class AccountingPayrollSupportRepairDto {
  @Matches(datePattern) public readonly effectiveFrom!: string;
  @IsBoolean() public readonly confirmation!: boolean;
  @IsString() @MinLength(1) @MaxLength(1000) public readonly reason!: string;
}

export class AccountingMappingDecisionDto {
  @IsIn(["accept", "change", "reject", "unresolved", "not_applicable"])
  public readonly decision!: "accept" | "change" | "reject" | "unresolved" | "not_applicable";
  @IsOptional() @IsUUID() public readonly accountId?: string;
  @Matches(datePattern) public readonly effectiveFrom!: string;
  @IsOptional() @Matches(datePattern) public readonly effectiveTo?: string;
  @IsString() @MinLength(1) @MaxLength(1000) public readonly reason!: string;
}

export class AccountingZeroOpeningDto {
  @Matches(datePattern) public readonly effectiveDate!: string;
  @IsUUID() public readonly fiscalYearId!: string;
  @IsUUID() public readonly fiscalPeriodId!: string;
  @IsString() @MinLength(20) @MaxLength(2000) public readonly confirmationStatement!: string;
  @IsString() @MinLength(1) @MaxLength(1000) public readonly reason!: string;
  @IsBoolean() public readonly administratorAcknowledged!: boolean;
}

export class AccountingActivationPreviewDto {
  @Matches(datePattern) public readonly activationDate!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  public readonly acknowledgedWarningCodes?: string[];
}

export class AccountingActivationDto extends AccountingActivationPreviewDto {
  @IsBoolean() public readonly confirmation!: boolean;
}

export class AccountingAreaChangeDto {
  @IsIn(accountingOperationalAreas) public readonly area!: string;
  @IsBoolean() public readonly confirmation!: boolean;
  @IsString() @MinLength(1) @MaxLength(500) public readonly reason!: string;
}
