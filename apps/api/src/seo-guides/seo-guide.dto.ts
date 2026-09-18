/* eslint-disable no-control-regex -- rejecting URL control characters is intentional */
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl, Matches, MaxLength, MinLength, ValidateNested } from "class-validator";

const localizedSlugPattern = /^(?!\.{1,2}$)(?!.*[\s\u0000-\u001f\u007f/\\?#\u202a-\u202e\u2066-\u2069])[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,158}[\p{L}\p{N}\p{M}])?$/u;
const imageUrlPattern = /^(https:\/\/[^?#]+\.(?:jpe?g|png|webp)(?:[?#].*)?|\/api\/v1\/public\/website\/media\/[A-Za-z0-9_-]+)$/i;

export class SeoGuideBlockDto {
  @IsIn(["html", "paragraph", "h2", "h3", "blockquote", "bullet_list", "numbered_list"]) type!: string;
  @IsOptional() @IsString() @MaxLength(200_000) text?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) items?: string[];
}

export class SaveSeoGuideDto {
  @IsString() @MinLength(3) @MaxLength(200) internalTitle!: string;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @Matches(localizedSlugPattern, { message: "Slug must be a safe English or Arabic URL segment." }) slug!: string;
  @IsIn(["en", "ar"]) language!: "en" | "ar";
  @IsOptional() @Matches(/^[0-9a-f-]{36}$/i) translationGroupId?: string;
  @IsString() @MinLength(10) @MaxLength(500) summary!: string;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => SeoGuideBlockDto) content!: SeoGuideBlockDto[];
  @IsOptional() @IsString() @MaxLength(120) authorName?: string;
  @IsOptional() @IsString() @MaxLength(160) primaryTopic?: string;
  @IsOptional() @Matches(imageUrlPattern) featuredImagePublicUrl?: string;
  @IsOptional() @IsString() @MaxLength(300) featuredImageAlt?: string;
  @IsBoolean() robotsIndex = true;
  @IsBoolean() robotsFollow = true;
  @IsBoolean() includeInSitemap = true;
  @IsBoolean() showInMainNavigation = false;
  @IsBoolean() showInResources = false;
  @IsOptional() @IsUrl({ protocols: ["https"], require_protocol: true }) canonicalUrl?: string;
  @IsOptional() @IsString() @MaxLength(200) seoTitle?: string;
  @IsOptional() @IsString() @MaxLength(320) metaDescription?: string;
  @IsOptional() @IsString() @MaxLength(200) socialTitle?: string;
  @IsOptional() @IsString() @MaxLength(320) socialDescription?: string;
  @IsOptional() @Matches(imageUrlPattern) socialImageUrl?: string;
  @IsOptional() @IsString() @MaxLength(300) socialImageAlt?: string;
}

export class SeoGuideStatusDto {
  @IsIn(["draft", "scheduled", "published", "unpublished", "archived"]) status!: string;
  @IsOptional() @IsString() scheduledAt?: string;
}
