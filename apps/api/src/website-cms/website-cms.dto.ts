import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

export class WebsitePageContentDto {
  @IsString() @MinLength(2) @MaxLength(80) pageKey!: string;
  @IsIn(["en", "ar"]) locale!: string;
  @IsBoolean() visible = true;
  @IsString() @MinLength(2) @MaxLength(80) heroEyebrow!: string;
  @IsString() @MinLength(5) @MaxLength(180) heroHeading!: string;
  @IsString() @MinLength(10) @MaxLength(600) heroSubheading!: string;
  @IsString() @MinLength(2) @MaxLength(80) primaryCtaLabel!: string;
  @Matches(/^\/[a-z0-9/?=&:%#._-]*$/) primaryCtaUrl!: string;
  @IsOptional() @IsString() @MaxLength(80) secondaryCtaLabel?: string;
  @IsOptional() @Matches(/^\/[a-z0-9/?=&:%#._-]*$/) secondaryCtaUrl?: string;
  @IsOptional() @IsString() @MaxLength(140) pricingHeading?: string;
  @IsOptional() @IsString() @MaxLength(500) pricingDescription?: string;
  @IsOptional() @IsString() @MaxLength(140) ctaHeading?: string;
  @IsOptional() @IsString() @MaxLength(500) ctaText?: string;
  @IsOptional() @IsString() @MaxLength(80) ctaButtonLabel?: string;
  @IsString() @MinLength(5) @MaxLength(200) seoTitle!: string;
  @IsString() @MinLength(20) @MaxLength(320) seoDescription!: string;
  @IsOptional() @Matches(/^\/[a-z0-9/?=&:%#._-]*$/) canonicalPath?: string;
  @IsBoolean() robotsIndex = true;
  @IsBoolean() robotsFollow = true;
  @IsOptional() @IsUrl({ protocols: ["https"], require_protocol: true }) ogImage?: string;
}

export class PricingPlanDto {
  @IsString() @MinLength(2) @MaxLength(60) planKey!: string;
  @IsIn(["en", "ar"]) locale = "en";
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(1000000) price!: number;
  @Matches(/^[A-Z]{3}$/) currency = "AED";
  @IsString() @MinLength(2) @MaxLength(80) period!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(10000000) minOrders!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000000) maxOrders?: number | null;
  @IsString() @MinLength(2) @MaxLength(120) volume!: string;
  @IsString() @MinLength(2) @MaxLength(300) description!: string;
  @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) highlights!: string[];
  @IsString() @MinLength(2) @MaxLength(80) ctaLabel!: string;
  @Matches(/^\/[a-z0-9/?=&:%#._-]*$/) ctaUrl!: string;
  @IsBoolean() recommended = false;
  @IsBoolean() active = true;
  @Type(() => Number) @IsInt() @Min(0) @Max(10000) sortOrder = 100;
}

export class WebsiteFeatureDto {
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) slug!: string;
  @IsIn(["en", "ar"]) locale = "en";
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsString() @MinLength(5) @MaxLength(320) shortDescription!: string;
  @IsOptional() @IsString() @MaxLength(2000) fullDescription?: string;
  @IsIn(["delivery_company", "trader", "customer", "all"]) audience = "all";
  @IsString() @MinLength(2) @MaxLength(80) category!: string;
  @IsIn(["live", "beta", "in_development", "planned", "not_available"]) featureStatus = "planned";
  @IsBoolean() visible = true;
  @Type(() => Number) @IsInt() @Min(0) @Max(10000) sortOrder = 100;
}

export class WebsiteFaqDto {
  @IsString() @MinLength(2) @MaxLength(80) faqKey!: string;
  @IsIn(["en", "ar"]) locale = "en";
  @IsString() @MinLength(5) @MaxLength(300) question!: string;
  @IsString() @MinLength(5) @MaxLength(2000) answer!: string;
  @IsIn(["delivery_company", "trader", "customer", "all"]) audience = "all";
  @IsString() @MinLength(2) @MaxLength(80) category = "general";
  @IsBoolean() visible = true;
  @IsBoolean() availableToAgent = false;
  @Type(() => Number) @IsInt() @Min(0) @Max(10000) sortOrder = 100;
}

export class WebsiteContactSettingsDto {
  @Matches(/^\+\d[\d\s-]{7,20}$/) publicPhone!: string;
  @IsOptional() @Matches(/^\+\d[\d\s-]{7,20}$/) whatsapp?: string;
  @IsOptional() @IsEmail() @MaxLength(120) supportEmail?: string;
  @IsOptional() @IsEmail() @MaxLength(120) salesEmail?: string;
  @IsOptional() @IsUrl({ protocols: ["https"], require_protocol: true }) linkedin?: string;
  @IsOptional() @IsUrl({ protocols: ["https"], require_protocol: true }) instagram?: string;
  @IsOptional() @IsUrl({ protocols: ["https"], require_protocol: true }) facebook?: string;
  @IsOptional() @IsUrl({ protocols: ["https"], require_protocol: true }) youtube?: string;
}

export class NavigationItemDto {
  @IsString() @MinLength(2) @MaxLength(80) itemKey!: string;
  @IsIn(["en", "ar"]) locale = "en";
  @IsString() @MinLength(2) @MaxLength(80) label!: string;
  @Matches(/^\/[a-z0-9/?=&:%#._-]*$/) destination!: string;
  @IsBoolean() visible = true;
  @Type(() => Number) @IsInt() @Min(0) @Max(10000) sortOrder = 100;
}

export class PublishDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class MediaAltDto {
  @IsString() @MinLength(2) @MaxLength(300) altText!: string;
  @IsOptional() @IsString() @MaxLength(500) caption?: string;
}
