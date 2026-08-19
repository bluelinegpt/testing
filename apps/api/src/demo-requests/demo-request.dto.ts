import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from "class-validator";

export const demoRequestStatuses = ["new","reviewing","contacted","qualified","demo_scheduled","converted","not_interested","rejected","closed"] as const;
export const emirates = ["abu_dhabi","dubai","sharjah","ajman","umm_al_quwain","ras_al_khaimah","fujairah"] as const;
export const contactMethods = ["phone","whatsapp","email"] as const;
export const interestFeatures = ["order_management","driver_management","cod_collections","trader_settlements","accounting","payroll","reports","mobile_apps","trader_portal","storefront_commerce","integrations","other"] as const;

const trim = ({ value }: { value: unknown }): unknown => typeof value === "string" ? value.trim() : value;

export class CreateDemoRequestDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200) public readonly companyName!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) public readonly contactPerson!: string;
  @Transform(trim) @IsString() @MaxLength(30) public readonly mobileNumber!: string;
  @Transform(trim) @IsEmail() @MaxLength(254) public readonly email!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) public readonly country!: string;
  @IsOptional() @IsIn(emirates) public readonly emirate?: (typeof emirates)[number];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) public readonly website?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) public readonly approximateDriverCount?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000000) public readonly approximateMonthlyOrders?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000000) public readonly approximateTraderCount?: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) public readonly currentSystem?: string;
  @IsIn(contactMethods) public readonly preferredContactMethod!: (typeof contactMethods)[number];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(3000) public readonly mainChallenges?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsIn(interestFeatures, { each: true }) public readonly featuresOfInterest?: (typeof interestFeatures)[number][];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(3000) public readonly additionalNotes?: string;
  @IsIn([true]) public readonly consent!: true;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) public readonly companyFax?: string;
  @Transform(trim) @IsString() @MaxLength(500) public readonly landingPage!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) public readonly referrer?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) public readonly utmSource?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) public readonly utmMedium?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) public readonly utmCampaign?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) public readonly utmTerm?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) public readonly utmContent?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) public readonly gclid?: string;
}

export class DemoRequestListQueryDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) public readonly search?: string;
  @IsOptional() @IsIn(demoRequestStatuses) public readonly status?: (typeof demoRequestStatuses)[number];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) public readonly country?: string;
  @IsOptional() @IsIn(emirates) public readonly emirate?: (typeof emirates)[number];
  @IsOptional() @IsIn(contactMethods) public readonly preferredContactMethod?: (typeof contactMethods)[number];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(10) public readonly createdFrom?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(10) public readonly createdTo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) public readonly page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) public readonly pageSize?: number;
  @IsOptional() @IsIn(["newest","oldest"]) public readonly sort?: "newest" | "oldest";
}

export class DemoRequestStatusDto {
  @IsIn(demoRequestStatuses.filter((status) => status !== "new")) public readonly status!: Exclude<(typeof demoRequestStatuses)[number], "new">;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) public readonly reason?: string;
  @ValidateIf((object: DemoRequestStatusDto) => object.demoScheduledAt !== undefined)
  @IsDateString() public readonly demoScheduledAt?: string;
  @IsOptional() @IsUUID() public readonly convertedCompanyId?: string;
}

export class AddDemoRequestNoteDto { @Transform(trim) @IsString() @MinLength(1) @MaxLength(4000) public readonly text!: string; }

export class LinkConvertedCompanyDto { @ValidateIf((_object, value) => value !== null) @IsUUID() public readonly companyId!: string | null; }
