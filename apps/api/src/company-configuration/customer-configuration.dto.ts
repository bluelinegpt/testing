import {
  IsBoolean,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

// Customer mobiles are stored as flexible text (aligned with the Create Order
// path and the `customers_mobile_safe` DB constraint). The service layer and the
// database enforce safe length and reject control characters; the UAE format is
// advisory in the UI only, never a backend gate.
const mobileRequiredOptions = {
  message: "Enter a mobile number.",
};
const mobileMaxLength = 32;

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

  @IsString()
  @MinLength(1, mobileRequiredOptions)
  @MaxLength(mobileMaxLength)
  public readonly mobileNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(mobileMaxLength)
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
  @IsString()
  @MinLength(1, mobileRequiredOptions)
  @MaxLength(mobileMaxLength)
  public readonly mobileNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(mobileMaxLength)
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
