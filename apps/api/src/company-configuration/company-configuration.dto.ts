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

/**
 * Adopt a business-day rule from a future date.
 *
 * There is deliberately no Business Day End field. The end is always the next
 * day at the same start time, so storing it separately could only ever create a
 * gap or an overlap that nothing would notice.
 */
export class SaveBusinessDayConfigurationDto {
  /** IANA region name. Verified against the runtime's own timezone database. */
  @IsString()
  @MaxLength(80)
  public readonly timezone!: string;

  /** Local wall-clock start, `HH:mm` or `HH:mm:ss`. */
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/)
  public readonly businessDayStart!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly effectiveFrom!: string;

  @IsString()
  @MaxLength(500)
  public readonly changeReason!: string;
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
