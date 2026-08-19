import { Transform } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUrl, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export const traderCategories=["fashion","perfumes_cosmetics","electronics","food_beverage","home_living","gifts","health_beauty","accessories","automotive","flowers","documents","general_trading","other"] as const;
export const traderChannels=["salla","shopify","woocommerce","website","instagram","facebook","tiktok","whatsapp","physical_store","other","none"] as const;
export const monthlyRanges=["under_100","100_500","501_1000","1001_3000","3001_5000","5001_10000","over_10000"] as const;
export const applicationStatuses=["pending_verification","reviewing","contacted","information_required","verified","approved","rejected","withdrawn"] as const;
const emirates=["abu_dhabi","dubai","sharjah","ajman","umm_al_quwain","ras_al_khaimah","fujairah"] as const;
const trim=({value}:{value:unknown})=>typeof value==="string"?value.trim():value;

export class TraderApplicationChannelDto { @IsIn(traderChannels) readonly type!:(typeof traderChannels)[number]; @IsOptional() @Transform(trim) @IsUrl({require_protocol:true}) @MaxLength(500) readonly url?:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(120) readonly handle?:string; }
export class CreateTraderApplicationDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200) readonly storeName!:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly legalCompanyName?:string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) readonly contactPerson!:string; @Transform(trim) @IsString() @MaxLength(30) readonly mobileNumber!:string;
  @Transform(trim) @IsEmail() @MaxLength(254) readonly email!:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(120) readonly tradeLicenseNumber?:string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(10) readonly tradeLicenseExpiryDate?:string; @IsOptional() @Transform(trim) @IsUrl({require_protocol:true}) @MaxLength(500) readonly website?:string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) readonly businessDescription?:string; @IsIn(traderCategories) readonly primaryCategory!:(typeof traderCategories)[number];
  @IsArray() @ArrayMaxSize(12) @IsIn(traderCategories,{each:true}) readonly additionalCategories!:(typeof traderCategories)[number][]; @ValidateIf((o:CreateTraderApplicationDto)=>o.primaryCategory==="other"||o.additionalCategories.includes("other")) @Transform(trim) @IsString() @MaxLength(120) readonly otherCategory?:string;
  @IsIn(emirates) readonly pickupEmirate!:(typeof emirates)[number]; @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) readonly pickupArea!:string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(11) @ValidateNested({each:true}) @Type(()=>TraderApplicationChannelDto) readonly channels!:TraderApplicationChannelDto[];
  @IsIn(monthlyRanges) readonly monthlyOrderRange!:(typeof monthlyRanges)[number]; @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @IsIn(emirates,{each:true}) readonly deliveryEmirates!:(typeof emirates)[number][];
  @IsIn(["mostly_cod","mostly_prepaid","mixed","not_sure"]) readonly paymentMix!:string; @IsOptional() @IsInt() @Min(0) @Max(100) readonly codPercentage?:number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) readonly averagePackageSize?:string; @IsOptional() @IsNumber() @Min(0) @Max(100000) readonly averagePackageWeight?:number;
  @IsBoolean() readonly fragileProducts!:boolean; @IsBoolean() readonly temperatureControlled!:boolean; @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) readonly specialHandlingNotes?:string;
  @IsBoolean() readonly hasExistingDeliveryCompany!:boolean; @ValidateIf((o:CreateTraderApplicationDto)=>o.hasExistingDeliveryCompany) @Transform(trim) @IsString() @MinLength(2) @MaxLength(200) readonly existingDeliveryCompanyName?:string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(160) readonly existingDeliveryCompanyContact?:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(30) readonly existingDeliveryCompanyMobile?:string; @IsOptional() @Transform(trim) @IsEmail() @MaxLength(254) readonly existingDeliveryCompanyEmail?:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(120) readonly existingDeliveryCompanyReference?:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) readonly existingDeliveryCompanyNotes?:string;
  @IsIn([true]) readonly consent!:true; @IsOptional() @Transform(trim) @IsString() @MaxLength(100) readonly companyFax?:string;
  @Transform(trim) @IsString() @MaxLength(500) readonly landingPage!:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) readonly referrer?:string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly utmSource?:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly utmMedium?:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly utmCampaign?:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly utmTerm?:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly utmContent?:string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly gclid?:string;
}
export class TraderApplicationListQueryDto { @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly search?:string; @IsOptional() @IsIn(applicationStatuses) readonly status?:string; @IsOptional() @IsIn(traderCategories) readonly primaryCategory?:string; @IsOptional() @IsIn(emirates) readonly pickupEmirate?:string; @IsOptional() @Transform(({value})=>value==="true"?true:value==="false"?false:value) @IsBoolean() readonly requiresDeliveryCompany?:boolean; @IsOptional() @IsIn(traderChannels) readonly salesChannel?:string; @IsOptional() @IsIn(monthlyRanges) readonly monthlyOrderRange?:string; @IsOptional() @IsInt() @Min(1) readonly page?:number; @IsOptional() @IsInt() @Min(1) @Max(100) readonly pageSize?:number; @IsOptional() @IsIn(["newest","oldest","volume"]) readonly sort?:string; }
export class TraderApplicationStatusDto { @IsIn(applicationStatuses.filter(x=>x!=="pending_verification")) readonly status!:string; @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) readonly reason?:string; }
export class TraderApplicationNoteDto { @Transform(trim) @IsString() @MinLength(1) @MaxLength(4000) readonly text!:string; }
export class TraderApplicationResolutionDto { @IsOptional() @IsUUID() readonly companyId?:string; @IsIn(["relationship_verified","delivery_company_not_onboarded"]) readonly resolution!:string; }
