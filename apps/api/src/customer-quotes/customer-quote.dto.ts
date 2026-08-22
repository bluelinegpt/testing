import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from "class-validator";

const emirates = ["abu_dhabi","dubai","sharjah","ajman","umm_al_quwain","ras_al_khaimah","fujairah"] as const;
const packages = ["document","small_parcel","medium_parcel","large_parcel","box","fragile_item","food","electronics","clothing","other"] as const;
const services = ["standard","same_day","express"] as const;
const phone = /^\+[1-9][0-9]{7,14}$/;
const countryCode = /^[A-Z]{2}$/;
const clean = ({ value }: { value: unknown }) => typeof value === "string" ? value.trim() : value;
const optionalClean = ({ value }: { value: unknown }) => typeof value === "string" ? (value.trim() || undefined) : value;
const optionalNumber = ({ value }: { value: unknown }) => value === "" || value === null || value === undefined ? undefined : Number(value);
const dialingCodes: Record<string,string> = { AE:"971", SA:"966", OM:"968", QA:"974", KW:"965", BH:"973", JO:"962", EG:"20", GB:"44", US:"1", IN:"91", PK:"92", PH:"63", TR:"90", CN:"86", DE:"49", FR:"33" };
const normalizePhone = ({ value, obj, key }: { value: unknown; obj?: Record<string, unknown>; key?: string }) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  const country = key === "recipientMobile"
    ? String(obj?.deliveryCountryCode ?? "AE")
    : key === "pickupMobile"
      ? String(obj?.pickupCountryCode ?? "AE")
      : String(obj?.pickupCountryCode ?? "AE");
  const code = dialingCodes[country];
  if (!code || digits.length === 0) return trimmed;
  return `+${code}${digits.replace(/^0+/, "")}`;
};

export class CreateCustomerQuoteDto {
  @Transform(clean) @IsString() @MinLength(2) @MaxLength(160) requesterName!: string;
  @Transform(normalizePhone) @Matches(phone) requesterMobile!: string;
  @IsOptional() @IsEmail() @MaxLength(254) requesterEmail?: string;
  @IsOptional() @Matches(countryCode) pickupCountryCode = "AE"; @IsOptional() @Transform(clean) @IsString() @MaxLength(120) pickupCountryName = "United Arab Emirates";
  @IsOptional() @IsIn(emirates) pickupEmirate?: string; @IsOptional() @Transform(clean) @IsString() @MaxLength(160) pickupArea?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(160) pickupCity?: string; @IsOptional() @Transform(clean) @IsString() @MaxLength(160) pickupDistrict?: string;
  @IsOptional() @Transform(optionalClean) @IsString() @MaxLength(500) pickupAddress?: string;
  @Transform(clean) @IsString() @MinLength(2) @MaxLength(160) pickupContactName!: string; @Transform(normalizePhone) @Matches(phone) pickupMobile!: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(160) pickupBuilding?: string; @IsOptional() @Transform(clean) @IsString() @MaxLength(80) pickupUnit?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(200) pickupLandmark?: string; @IsOptional() @IsUrl({ protocols:["https"], require_protocol:true }) pickupMapsUrl?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(500) pickupInstructions?: string;
  @IsOptional() @Matches(countryCode) deliveryCountryCode = "AE"; @IsOptional() @Transform(clean) @IsString() @MaxLength(120) deliveryCountryName = "United Arab Emirates";
  @IsOptional() @IsIn(emirates) deliveryEmirate?: string; @IsOptional() @Transform(clean) @IsString() @MaxLength(160) deliveryArea?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(160) deliveryCity?: string; @IsOptional() @Transform(clean) @IsString() @MaxLength(160) deliveryDistrict?: string;
  @IsOptional() @Transform(optionalClean) @IsString() @MaxLength(500) deliveryAddress?: string;
  @IsOptional() @Transform(optionalClean) @IsString() @MaxLength(160) recipientName?: string; @IsOptional() @Transform(normalizePhone) @Matches(phone) recipientMobile?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(160) deliveryBuilding?: string; @IsOptional() @Transform(clean) @IsString() @MaxLength(80) deliveryUnit?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(200) deliveryLandmark?: string; @IsOptional() @IsUrl({ protocols:["https"], require_protocol:true }) deliveryMapsUrl?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(500) deliveryInstructions?: string;
  @IsIn(packages) packageType!: string; @IsOptional() @Transform(optionalClean) @IsString() @MaxLength(500) description?: string;
  @Type(()=>Number) @IsNumber({maxDecimalPlaces:3}) @Min(0.01) @Max(10000) weightKg!: number;
  @Transform(optionalNumber) @IsOptional() @IsNumber({maxDecimalPlaces:2}) @Min(0.01) @Max(10000) lengthCm?: number;
  @Transform(optionalNumber) @IsOptional() @IsNumber({maxDecimalPlaces:2}) @Min(0.01) @Max(10000) widthCm?: number;
  @Transform(optionalNumber) @IsOptional() @IsNumber({maxDecimalPlaces:2}) @Min(0.01) @Max(10000) heightCm?: number;
  @Type(()=>Number) @IsInt() @Min(1) @Max(100) quantity = 1;
  @IsIn(services) requestedServiceType!: string; @IsDateString() pickupDate!: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(100) pickupTimeWindow?: string;
  @IsBoolean() codRequired!: boolean; @ValidateIf(o=>o.codRequired) @Type(()=>Number) @IsNumber({maxDecimalPlaces:2}) @Min(0) @Max(1000000) codAmount = 0;
  @IsArray() @ArrayMaxSize(10) @IsString({each:true}) specialHandlingFlags: string[] = [];
  @IsOptional() @Type(()=>Number) @IsNumber({maxDecimalPlaces:2}) @Min(0) @Max(100000000) declaredValue?: number;
  @IsOptional() @Matches(/^[A-Z]{3}$/) declaredValueCurrency?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) quoteCurrency?: string;
  @IsBoolean() goodsConfirmation!: boolean;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(100) landingPage?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(300) referrer?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(120) utmSource?: string; @IsOptional() @Transform(clean) @IsString() @MaxLength(120) utmMedium?: string; @IsOptional() @Transform(clean) @IsString() @MaxLength(120) utmCampaign?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(120) utmTerm?: string; @IsOptional() @Transform(clean) @IsString() @MaxLength(120) utmContent?: string; @IsOptional() @Transform(clean) @IsString() @MaxLength(200) gclid?: string;
}

export class SelectCustomerOfferDto { @IsString() @MinLength(32) accessToken!: string; @Matches(/^OFF-[A-Z0-9]{12}$/) publicOfferId!: string; }

export class UpsertParticipationDto { @IsBoolean() participates!: boolean; @IsBoolean() acceptsInstant!: boolean; @IsBoolean() acceptsCustom!: boolean; @IsDateString() activeFrom!: string; @IsOptional() @IsDateString() activeUntil?: string; }
export class CreatePricingProfileDto { @Transform(clean) @IsString() @MinLength(2) @MaxLength(160) name!:string; @IsIn(services) serviceType!:string; @IsDateString() effectiveFrom!:string; @IsOptional() @IsDateString() effectiveTo?:string; @IsOptional() @Type(()=>Number) @IsNumber() @Min(0) maxCodAmount?:number; @IsOptional() @Type(()=>Number) @IsNumber() @Min(.01) maxWeightKg?:number; @IsOptional() @Type(()=>Number) @IsNumber() @Min(.01) maxLengthCm?:number; @IsOptional() @Type(()=>Number) @IsNumber() @Min(.01) maxWidthCm?:number; @IsOptional() @Type(()=>Number) @IsNumber() @Min(.01) maxHeightCm?:number; @IsArray() @ArrayMaxSize(10) @IsIn(packages,{each:true}) supportedPackageTypes!:string[]; }
export class CreatePricingRuleDto { @IsIn(emirates) pickupEmirate!:string; @IsOptional() @Transform(clean) @IsString() @MaxLength(160) pickupArea?:string; @IsIn(emirates) deliveryEmirate!:string; @IsOptional() @Transform(clean) @IsString() @MaxLength(160) deliveryArea?:string; @Type(()=>Number) @IsNumber({maxDecimalPlaces:2}) @Min(.01) basePrice!:number; @Type(()=>Number) @IsNumber() @Min(0) includedWeightKg!:number; @IsOptional() @Type(()=>Number) @IsNumber() @Min(0) extraWeightPrice?:number; @IsOptional() @Type(()=>Number) @IsNumber() @Min(0) codSurcharge?:number; @IsOptional() @Type(()=>Number) @IsNumber() @Min(.01) minimumCharge?:number; @IsOptional() @Type(()=>Number) @IsNumber() @Min(.01) maximumStandardWeight?:number; }
export class MarketplaceSettingsDto { @Type(()=>Number) @IsNumber({maxDecimalPlaces:4}) @Min(0) @Max(100) commissionRatePercent!:number; @Type(()=>Number) @IsInt() @Min(1) @Max(1440) quoteExpiryMinutes!:number; @IsBoolean() enabled!:boolean; }
export class ManualOfferDto { @Matches(/^[0-9a-f-]{36}$/i) companyId!:string; @IsIn(services) serviceType!:string; @Type(()=>Number) @IsNumber({maxDecimalPlaces:2}) @Min(.01) customerPrice!:number; @Type(()=>Number) @IsInt() @Min(1) @Max(1440) validityMinutes!:number; @IsOptional() @IsString() @MaxLength(1000) internalNotes?:string; }
export class ConvertCustomerQuoteToOrderDto { @Matches(/^[0-9a-f-]{36}$/i) companyId!:string; @Type(()=>Number) @IsNumber({maxDecimalPlaces:2}) @Min(.01) @Max(1000000) deliveryFee!:number; @Type(()=>Number) @IsNumber({maxDecimalPlaces:2}) @Min(0) @Max(1000000) platformFee!:number; @IsOptional() @Transform(optionalClean) @IsString() @MaxLength(1000) internalNotes?:string; }
export class RecordPlatformFeePaymentDto { @Type(()=>Number) @IsNumber({maxDecimalPlaces:2}) @Min(.01) @Max(1000000) amount!:number; @IsDateString() paymentDate!:string; @IsOptional() @Transform(optionalClean) @IsString() @MaxLength(80) paymentMethod?:string; @IsOptional() @Transform(optionalClean) @IsString() @MaxLength(120) referenceNumber?:string; @IsOptional() @Transform(optionalClean) @IsString() @MaxLength(1000) notes?:string; }
