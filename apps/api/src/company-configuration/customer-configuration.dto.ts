import {
  IsBoolean,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
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

export class CustomerAddressDto {
  @IsUUID()
  public readonly areaId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly label?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly address!: string;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ["http", "https"] })
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
  public readonly deliveryInstructions?: string | null;

  @IsOptional()
  @IsBoolean()
  public readonly isDefault?: boolean;
}

export class CreateCustomerDto extends CustomerAddressDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly name!: string;

  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, mobileOptions)
  public readonly mobileNumber!: string;

  @IsOptional()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, mobileOptions)
  public readonly secondMobileNumber?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  public readonly email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly customerReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly deliveryNotes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public readonly internalNotes?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly duplicateOverrideReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  public readonly source?: string;
}

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly name?: string;

  @IsOptional()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, mobileOptions)
  public readonly mobileNumber?: string;

  @IsOptional()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, mobileOptions)
  public readonly secondMobileNumber?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  public readonly email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly customerReference?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly deliveryNotes?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public readonly internalNotes?: string | null;
}

export class ChangeCustomerStatusDto {
  @IsBoolean()
  public readonly isActive!: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly reason!: string;
}

export class UpdateCustomerAddressDto extends CustomerAddressDto {
  @IsOptional()
  @IsBoolean()
  public readonly isActive?: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly reason!: string;
}

export class ChangeCustomerAddressStatusDto {
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
