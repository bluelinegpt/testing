import { Transform } from "class-transformer";
import { IsEmail, IsIn, IsOptional, IsString, Length, MaxLength, MinLength } from "class-validator";

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

export class RegisterCommerceCustomerDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public name!: string;

  /**
   * Stored exactly as entered (trimmed), mirroring the rest of this codebase's
   * "flexible text" convention for a customer-facing mobile field
   * (`operations.dto.ts`'s `customerMobileNumber`) -- normalization for
   * matching/uniqueness happens server-side via `normalizeUaeMobile`, so a
   * display value like `050 646 8442` is preserved rather than rewritten.
   */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  public mobile!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  public email?: string;

  // Same policy as `ChangePasswordDto`: length only. No new complexity rule
  // is invented here (§63: "according to current policy").
  @IsString()
  @Length(8, 256)
  public password!: string;

  @IsOptional()
  @IsIn(["en", "ar"])
  public preferredLanguage?: "en" | "ar";

  /**
   * Terms/privacy acknowledgement foundation (§18): the registration form
   * must have the Customer explicitly opt in before an account is created.
   * No terms/version tracking table exists yet -- this is the acknowledgement
   * gate itself, not a record of which document version was shown.
   */
  @IsIn([true])
  public acceptedTerms!: true;
}

export class LoginCommerceCustomerDto {
  @Transform(trim)
  @IsString()
  @Length(1, 320)
  public identifier!: string;

  @IsString()
  @Length(1, 256)
  public password!: string;
}

export class RequestCommerceCustomerPasswordResetDto {
  @Transform(trim)
  @IsString()
  @Length(1, 320)
  public identifier!: string;
}

export class CompleteCommerceCustomerPasswordResetDto {
  @IsString()
  @Length(1, 512)
  public token!: string;

  @IsString()
  @Length(8, 256)
  public newPassword!: string;
}

export class UpdateCommerceCustomerProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public name?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  public email?: string;

  @IsOptional()
  @IsIn(["en", "ar"])
  public preferredLanguage?: "en" | "ar";
}

export class CommerceCustomerAddressDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  public label?: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public recipientName!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  public mobile!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public emirate!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  public area?: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public address!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  public locationLink?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  public deliveryInstructions?: string;

  @IsOptional()
  public isDefault?: boolean;
}

export class UpdateCommerceCustomerAddressDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  public label?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public recipientName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  public mobile?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public emirate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  public area?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public address?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  public locationLink?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  public deliveryInstructions?: string;

  @IsOptional()
  public isDefault?: boolean;
}

