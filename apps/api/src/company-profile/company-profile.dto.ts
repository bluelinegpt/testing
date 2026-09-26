import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";

// A value that contains at least one non-whitespace character. Used to reject
// whitespace-only names/telephone while still allowing English, Arabic or
// mixed text (trimming happens in the service).
const NON_BLANK = /\S/;

// A permissive telephone shape: at least one digit, and only digits, spaces and
// the punctuation valid in landline/switchboard/international numbers. It is NOT
// a UAE-mobile check — the Company number may be a landline or switchboard, and
// leading zeros and the "+" prefix are preserved verbatim.
const TELEPHONE = /^(?=.*\d)[\d\s()+-]{4,32}$/;

export class UpdateCompanyProfileDto {
  @IsString()
  @Matches(NON_BLANK, { message: "nameEn must not be blank" })
  @MaxLength(160)
  public readonly nameEn!: string;

  @IsString()
  @Matches(NON_BLANK, { message: "nameAr must not be blank" })
  @MaxLength(160)
  public readonly nameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly subtitleEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly subtitleAr?: string;

  @IsString()
  @Matches(TELEPHONE, { message: "telephone must be a valid telephone number" })
  public readonly telephone!: string;
}

export class UpdateTextLanguageDto {
  @IsIn(["en", "ar"])
  public readonly textLanguage!: "en" | "ar";
}

export class UpdateThemeDto {
  @IsIn(["light", "dark", "system"])
  public readonly theme!: "light" | "dark" | "system";
}
