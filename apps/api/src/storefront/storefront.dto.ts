import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
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
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

import {
  storefrontSlugMaxLength,
  storefrontSlugMinLength,
  storefrontStatuses,
  storefrontTemplates,
  storefrontThemes,
} from "./storefront.constants.js";

/**
 * Storefront request contracts.
 *
 * Enumerations come from the constants module, which the database CHECKs also
 * mirror. Free-text fields are length-bounded because they are rendered on a
 * public page; they are rendered as TEXT, never as markup, so no field here
 * accepts or sanitises HTML.
 */

const mobilePattern = /^\+?[0-9][0-9 ()-]{5,19}$/;
const colorPattern = /^#[0-9a-f]{6}$/;

export class BusinessHoursEntryDto {
  @ApiProperty({ example: "Saturday – Thursday" })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  public days!: string;

  @ApiProperty({ example: "10:00 – 22:00" })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  public time!: string;
}

export class CreateStorefrontDto {
  @ApiProperty({ description: "Trader that will own the Storefront" })
  @IsUUID()
  public traderId!: string;

  @ApiProperty({ example: "Al Noor Fashion" })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  public displayName!: string;

  @ApiProperty({ example: "al-noor-fashion" })
  @IsString()
  @MinLength(storefrontSlugMinLength)
  @MaxLength(storefrontSlugMaxLength)
  public slug!: string;

  @ApiProperty({ enum: storefrontTemplates })
  @IsIn(storefrontTemplates)
  public businessTemplate!: (typeof storefrontTemplates)[number];

  @ApiProperty({ enum: storefrontThemes })
  @IsIn(storefrontThemes)
  public theme!: (typeof storefrontThemes)[number];
}

export class UpdateStorefrontDto {
  @ApiProperty({ description: "Optimistic concurrency guard" })
  @IsInt()
  @Min(1)
  public expectedVersion!: number;

  @ApiPropertyOptional({ example: "Al Noor Fashion" })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  public displayName?: string;

  @ApiPropertyOptional({ example: "al-noor-fashion" })
  @IsOptional()
  @IsString()
  @MinLength(storefrontSlugMinLength)
  @MaxLength(storefrontSlugMaxLength)
  public slug?: string;

  @ApiPropertyOptional({ enum: storefrontTemplates })
  @IsOptional()
  @IsIn(storefrontTemplates)
  public businessTemplate?: (typeof storefrontTemplates)[number];

  @ApiPropertyOptional({ enum: storefrontThemes })
  @IsOptional()
  @IsIn(storefrontThemes)
  public theme?: (typeof storefrontThemes)[number];

  @ApiPropertyOptional({ description: "Existing uploaded file reference" })
  @IsOptional()
  @IsUUID()
  public logoFileId?: string | null;

  @ApiPropertyOptional({ description: "Existing uploaded file reference" })
  @IsOptional()
  @IsUUID()
  public coverFileId?: string | null;

  @ApiPropertyOptional({ example: "#1f2937" })
  @IsOptional()
  @Matches(colorPattern, { message: "storefront_color_invalid" })
  public brandPrimaryColor?: string | null;

  @ApiPropertyOptional({ example: "#b08d57" })
  @IsOptional()
  @Matches(colorPattern, { message: "storefront_color_invalid" })
  public brandAccentColor?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public storeDescription?: string | null;

  /**
   * SEO overrides.
   *
   * Every one of these is OPTIONAL because the metadata layer already derives a
   * sensible title and description from the Store's own name and description. A
   * Trader who never opens this section still gets correct metadata; these exist
   * only for the Trader who wants to say something different to a search engine
   * than to a visitor.
   *
   * A blank string is not a valid override -- the database rejects it -- so the
   * way to remove an override is to send null, which restores the derived value
   * rather than publishing an empty title.
   */
  @ApiPropertyOptional({ example: "Abayas in Dubai | Al Noor Fashion" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public seoTitleEn?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public seoTitleAr?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  public seoDescriptionEn?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  public seoDescriptionAr?: string | null;

  @ApiPropertyOptional({ description: "Existing uploaded file reference" })
  @IsOptional()
  @IsUUID()
  public seoSocialFileId?: string | null;

  /**
   * Opting the Store out of search indexing.
   *
   * Defaults to true. A Trader running a private or seasonal shop can turn it
   * off, and the metadata layer emits `noindex` -- but `follow` stays on, so
   * links out of the page still carry weight.
   */
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  public seoIndexable?: boolean;

  @ApiPropertyOptional({ example: "+971 50 000 0000" })
  @IsOptional()
  @Matches(mobilePattern, { message: "storefront_mobile_invalid" })
  public publicMobile?: string | null;

  @ApiPropertyOptional({ example: "+971 50 000 0000" })
  @IsOptional()
  @Matches(mobilePattern, { message: "storefront_mobile_invalid" })
  public publicWhatsapp?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: "storefront_email_invalid" })
  @MaxLength(160)
  public publicEmail?: string | null;

  @ApiPropertyOptional({ type: () => [BusinessHoursEntryDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(14)
  @ValidateNested({ each: true })
  @Type(() => BusinessHoursEntryDto)
  public businessHours?: BusinessHoursEntryDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public deliveryInformation?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public returnPolicy?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  public terms?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public customerSupport?: string | null;
}

export class StorefrontStatusActionDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  public expectedVersion!: number;

  @ApiPropertyOptional({ description: "Recorded on the audit event" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public reason?: string;
}

export class SuspendStorefrontDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  public expectedVersion!: number;

  @ApiProperty({ description: "Required: a suspension must say why" })
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  public reason!: string;
}

export class SlugAvailabilityQueryDto {
  @ApiProperty({ example: "al-noor-fashion" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  public slug!: string;

  @ApiPropertyOptional({ description: "Exclude this Storefront's own current slug" })
  @IsOptional()
  @IsUUID()
  public storefrontId?: string;
}

export class StorefrontListQueryDto {
  @ApiPropertyOptional({ enum: storefrontStatuses })
  @IsOptional()
  @IsIn(storefrontStatuses)
  public status?: (typeof storefrontStatuses)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public pageSize?: number;

  @ApiPropertyOptional({ description: "Include only Storefronts the caller's Trader owns" })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  public mineOnly?: boolean;
}

/**
 * A change to one existing Delivery Company relationship.
 *
 * Both fields are optional so the screen can send only what the user touched.
 * There is no `companyId` and no `traderCommerceId`: the relationship is
 * addressed by its own id under a Storefront the caller has already been proven
 * to reach, and creating a relationship is not possible from here at all.
 */
export class DeliveryRelationshipUpdateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public enabledForStoreOrders?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public isDefaultForStoreOrders?: boolean;
}
