import {
  IsBoolean,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

import { NormalizeUaeMobile } from "../shared/uae-mobile.js";

const mobileOptions = {
  message: "Enter a UAE mobile number, for example 0506468442 or 9715XXXXXXXX.",
};

export class CreateConfiguredTraderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly name!: string;

  @IsOptional()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, mobileOptions)
  public readonly mobileNumber?: string;

  @IsOptional()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, mobileOptions)
  public readonly secondMobileNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly contactPerson?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  public readonly email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly commercialNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly taxRegistrationNumber?: string;

  @IsOptional()
  @IsUUID()
  public readonly pickupAreaId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly pickupAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly locationLink?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  public readonly latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  public readonly longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;
}

export class UpdateConfiguredTraderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly name?: string;

  // Legacy values are validated only when changed by the service.
  @IsOptional()
  @IsString()
  @MaxLength(32)
  public readonly mobileNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  public readonly secondMobileNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly contactPerson?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  public readonly email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly commercialNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly taxRegistrationNumber?: string | null;

  @IsOptional()
  @IsUUID()
  public readonly pickupAreaId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly pickupAddress?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly locationLink?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  public readonly latitude?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  public readonly longitude?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string | null;
}

export class ChangeTraderStatusDto {
  @IsBoolean()
  public readonly isActive!: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly reason!: string;
}

/**
 * A price rule scoped by (Emirate, Area):
 *   emirateId + areaId  -> a specific Area
 *   emirateId only      -> that Emirate's default (All Areas)
 *   neither             -> the global price (All Emirates), which is flat pricing
 */
export class CreateTraderPricingDto {
  @IsOptional()
  @IsUUID()
  public readonly emirateId?: string;

  @IsOptional()
  @IsUUID()
  public readonly areaId?: string;

  @IsNumber()
  @Min(0)
  public readonly serviceFee!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly reason?: string;
}

/** Edits a rule's fee and reason; the scope is fixed once created. */
export class UpdateTraderPricingDto {
  @IsNumber()
  @Min(0)
  public readonly serviceFee!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly reason?: string;
}

export class SaveTraderBankAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly bankName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly accountName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public readonly accountNumber!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(34)
  public readonly iban!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  public readonly swiftCode?: string;

  @IsOptional()
  @IsBoolean()
  public readonly isDefault?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly notes?: string;
}

export class ChangeTraderBankStatusDto {
  @IsBoolean()
  public readonly isActive!: boolean;

  @IsOptional()
  @IsBoolean()
  public readonly isDefault?: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly reason!: string;
}
