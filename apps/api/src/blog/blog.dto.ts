import{Type}from"class-transformer";import{ArrayMaxSize,IsArray,IsBoolean,IsIn,IsInt,IsObject,IsOptional,IsString,IsUrl,Matches,Max,MaxLength,Min,MinLength,ValidateNested}from"class-validator";
export class BlogBlockDto{@IsIn(["html","paragraph","h2","h3","blockquote","bullet_list","numbered_list"])type!:string;@IsOptional()@IsString()@MaxLength(200000)text?:string;@IsOptional()@IsArray()@ArrayMaxSize(100)@IsString({each:true})items?:string[];}
const imageUrlPattern=/^(https:\/\/[^?#]+\.(?:jpe?g|png|webp)(?:[?#].*)?|\/api\/v1\/public\/website\/media\/[A-Za-z0-9_-]+)$/i;
const localizedSlugPattern=/^(?!\.{1,2}$)(?!.*[\s\u0000-\u001f\u007f/\\?#\u202a-\u202e\u2066-\u2069])[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,158}[\p{L}\p{N}\p{M}])?$/u;
export class SaveBlogArticleDto{
  @Matches(localizedSlugPattern,{message:"Slug must be a safe English or Arabic URL segment."}) slug!:string;
  @IsIn(["en","ar"]) language!:string;
  @IsOptional() @Matches(/^[0-9a-f-]{36}$/i) translationGroupId?:string;
  @IsString() @MinLength(5) @MaxLength(200) title!:string;
  @IsString() @MinLength(10) @MaxLength(500) excerpt!:string;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({each:true}) @Type(()=>BlogBlockDto) content!:BlogBlockDto[];
  @Matches(/^[0-9a-f-]{36}$/i) authorId!:string;
  @Matches(/^[0-9a-f-]{36}$/i) categoryId!:string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @Matches(/^[0-9a-f-]{36}$/i,{each:true}) categoryIds?:string[];
  @IsOptional() @IsArray() @ArrayMaxSize(40) @Matches(/^[0-9a-f-]{36}$/i,{each:true}) tagIds?:string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @Matches(/^[0-9a-f-]{36}$/i,{each:true}) relatedArticleIds?:string[];
  @IsBoolean() cornerstone=false;
  @IsOptional() @Matches(imageUrlPattern,{message:"Please select a valid image or enter a direct HTTPS image URL."}) featuredImagePublicUrl?:string;
  @IsOptional() @IsString() @MaxLength(300) featuredImageAlt?:string;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) featuredImageWidth?:number;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) featuredImageHeight?:number;
  @IsOptional() @IsString() @MaxLength(200) seoTitle?:string;
  @IsOptional() @IsString() @MaxLength(320) metaDescription?:string;
  @IsOptional() @IsUrl({protocols:["https"],require_protocol:true}) canonicalUrl?:string;
  @IsBoolean() robotsIndex=true;
  @IsBoolean() robotsFollow=true;
  @IsOptional() @IsString() @MaxLength(200) socialTitle?:string;
  @IsOptional() @IsString() @MaxLength(320) socialDescription?:string;
  @IsOptional() @Matches(imageUrlPattern,{message:"Please select a valid image or enter a direct HTTPS image URL."}) socialImageUrl?:string;
  @IsOptional() @IsString() @MaxLength(300) socialImageAlt?:string;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) socialImageWidth?:number;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) socialImageHeight?:number;
}
export class ArticleStatusDto{@IsIn(["draft","scheduled","published","unpublished","archived"])status!:string;@IsOptional()@IsString()scheduledAt?:string;}
export class TaxonomySeoDto {
  @IsString() @MinLength(2) @MaxLength(120) name!:string;
  @Matches(localizedSlugPattern,{message:"Slug must be a safe English or Arabic URL segment."}) slug!:string;
  @IsIn(["en","ar"]) language!:string;
  @IsOptional() @Matches(/^[0-9a-f-]{36}$/i) translationGroupId?:string;
  @IsOptional() @IsString() @MaxLength(1000) description?:string;
  @IsOptional() @IsString() @MaxLength(200) seoTitle?:string;
  @IsOptional() @IsString() @MaxLength(320) metaDescription?:string;
  @IsBoolean() robotsIndex=false;
  @IsBoolean() robotsFollow=true;
  @IsOptional() @IsString() @MaxLength(200) socialTitle?:string;
  @IsOptional() @IsString() @MaxLength(320) socialDescription?:string;
  @IsOptional() @Matches(imageUrlPattern) socialImageUrl?:string;
  @IsBoolean() active=true;
}
export class CategoryDto extends TaxonomySeoDto {@Type(()=>Number)@IsInt()@Min(0)@Max(10000)sortOrder=100;}
export class TagDto extends TaxonomySeoDto {}
export class AuthorDto {
  @IsString() @MinLength(2) @MaxLength(120) displayName!:string;
  @Matches(localizedSlugPattern) slug!:string;
  @IsIn(["en","ar"]) language!:string;
  @IsOptional() @Matches(/^[0-9a-f-]{36}$/i) translationGroupId?:string;
  @IsOptional() @IsString() @MaxLength(160) roleTitle?:string;
  @IsOptional() @IsString() @MaxLength(500) shortBio?:string;
  @IsOptional() @IsString() @MaxLength(5000) biography?:string;
  @IsArray() @ArrayMaxSize(20) @IsString({each:true}) expertise:string[]=[];
  @IsOptional() @Matches(imageUrlPattern) profileImagePublicUrl?:string;
  @IsOptional() @IsObject() profileLinks?:Record<string,string>;
  @IsOptional() @IsString() @MaxLength(200) seoTitle?:string;
  @IsOptional() @IsString() @MaxLength(320) metaDescription?:string;
  @IsBoolean() robotsIndex=false;
  @IsBoolean() robotsFollow=true;
  @IsOptional() @IsString() @MaxLength(200) socialTitle?:string;
  @IsOptional() @IsString() @MaxLength(320) socialDescription?:string;
  @IsBoolean() active=true;
}
export class TopicDto {
  @IsString() @MinLength(2) @MaxLength(160) title!:string;
  @Matches(localizedSlugPattern) slug!:string;
  @IsIn(["en","ar"]) language!:string;
  @IsOptional() @Matches(/^[0-9a-f-]{36}$/i) translationGroupId?:string;
  @IsString() @MinLength(20) @MaxLength(5000) description!:string;
  @IsOptional() @IsString() @MaxLength(10000) featuredContent?:string;
  @IsOptional() @IsString() @MaxLength(200) seoTitle?:string;
  @IsOptional() @IsString() @MaxLength(320) metaDescription?:string;
  @IsBoolean() robotsIndex=false;
  @IsBoolean() robotsFollow=true;
  @IsOptional() @IsString() @MaxLength(200) socialTitle?:string;
  @IsOptional() @IsString() @MaxLength(320) socialDescription?:string;
  @IsOptional() @Matches(imageUrlPattern) socialImageUrl?:string;
  @IsIn(["draft","published","archived"]) status="draft";
  @IsArray() @ArrayMaxSize(20) @Matches(/^[0-9a-f-]{36}$/i,{each:true}) categoryIds:string[]=[];
  @IsArray() @ArrayMaxSize(40) @Matches(/^[0-9a-f-]{36}$/i,{each:true}) tagIds:string[]=[];
  @IsArray() @ArrayMaxSize(50) @Matches(/^[0-9a-f-]{36}$/i,{each:true}) articleIds:string[]=[];
}
export class ManualRedirectDto {
  @IsString() @Matches(/^\/(?!\/)[^?#\u0000-\u001f]*$/) fromPath!:string;
  @IsString() @Matches(/^\/(?!\/)[^?#\u0000-\u001f]*$/) toPath!:string;
  @IsIn([301,308]) statusCode=301;
  @IsBoolean() active=true;
}
export class PublicNotFoundDto {
  @IsString() @MaxLength(500) path!:string;
  @IsOptional() @IsString() @MaxLength(300) referer?:string;
}
export class PublicSiteSettingsDto{@IsUrl({protocols:["https"],require_protocol:true})canonicalBaseUrl!:string;@IsString()@MinLength(5)@MaxLength(200)defaultSiteTitle!:string;@IsString()@MinLength(20)@MaxLength(320)defaultMetaDescription!:string;@IsOptional()@IsUrl({protocols:["https"],require_protocol:true})defaultSocialImage?:string;@IsOptional()@Matches(/^[A-Za-z0-9_-]{10,200}$/)searchConsoleVerification?:string;@IsOptional()@Matches(/^GTM-[A-Z0-9]{4,12}$/)gtmContainerId?:string;@IsOptional()@Matches(/^G-[A-Z0-9]{6,14}$/)ga4MeasurementId?:string;@IsBoolean()analyticsEnabled!:boolean;@IsOptional()@Matches(/^[a-z0-9]{6,20}$/)clarityProjectId?:string;@IsBoolean()clarityEnabled!:boolean;@IsIn(["development","staging","production"])trackingEnvironment!:string;}
