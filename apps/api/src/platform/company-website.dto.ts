import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator";
import type { CompanyWebsiteSettings } from "./company-website-settings.js";

import {
  COMPANY_WEBSITE_TEMPLATE_KEYS,
  type CompanyWebsiteTemplateKey,
} from "./company-website-templates.js";

export class ConfigureCompanyWebsiteDto {
  @IsInt()
  @Min(0)
  public expectedVersion!: number;

  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
  public slug!: string;

  @IsOptional()
  @IsIn(["en", "ar"])
  public primaryLanguage?: "en" | "ar";

  @IsOptional()
  @IsIn(["en", "ar"])
  public defaultLocale?: "en" | "ar";

  @IsOptional()
  @IsIn(COMPANY_WEBSITE_TEMPLATE_KEYS)
  public templateKey?: CompanyWebsiteTemplateKey;

  @IsOptional()
  @IsObject()
  public settings?: CompanyWebsiteSettings;
}

export class MutateCompanyWebsiteDto {
  @IsInt()
  @Min(1)
  public expectedVersion!: number;
}

export class GenerateCompanyWebsiteAiSetupDto {
  @IsString()
  @MaxLength(160)
  public companyName!: string;

  @IsString()
  @MaxLength(40)
  public phoneWhatsapp!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public additionalDetails?: string;

  @IsOptional()
  @IsString()
  @MaxLength(700_000)
  @Matches(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/)
  public logoDataUrl?: string;
}
