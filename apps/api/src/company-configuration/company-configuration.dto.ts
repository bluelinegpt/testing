import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateAreaDto {
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{2,32}$/)
  public readonly code?: string;

  @IsString()
  @MaxLength(160)
  public readonly nameEn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly nameAr?: string;
}

export class UpdateAreaStatusDto {
  @IsBoolean()
  public readonly isActive!: boolean;
}

export class UpdateCompanySettingsDto {
  @IsIn(["en", "ar"])
  public readonly defaultLanguage!: "en" | "ar";

  @IsString()
  @MaxLength(80)
  public readonly timezone!: string;

  @IsBoolean()
  public readonly vatEnabled!: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  public readonly vatRate?: number;

  @IsOptional()
  @IsIn(["inclusive", "exclusive"])
  public readonly vatPriceMode?: "inclusive" | "exclusive";
}

export class CreateBankAccountDto {
  @IsString()
  @MaxLength(160)
  public readonly bankName!: string;

  @IsString()
  @MaxLength(160)
  public readonly accountName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public readonly accountNumberMasked?: string;

  @IsOptional()
  @IsString()
  @MaxLength(34)
  public readonly iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  public readonly swiftCode?: string;
}
