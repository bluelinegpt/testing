import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

const clean = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class PublicWebsiteTrackingDto {
  @Transform(clean)
  @IsString()
  @MaxLength(200)
  public trackingToken!: string;
}

export class PublicWebsiteDeliveryRequestDto {
  @Transform(clean) @IsString() @MinLength(2) @MaxLength(160) public contactName!: string;
  @Transform(clean) @Matches(/^\+?[0-9][0-9\s()-]{6,24}$/u) public mobile!: string;
  @IsOptional() @Transform(clean) @IsEmail() @MaxLength(254) public email?: string;
  @Transform(clean) @IsString() @MinLength(2) @MaxLength(120) public pickupEmirate!: string;
  @Transform(clean) @IsString() @MinLength(2) @MaxLength(300) public pickupLocation!: string;
  @Transform(clean) @IsString() @MinLength(2) @MaxLength(120) public deliveryEmirate!: string;
  @Transform(clean) @IsString() @MinLength(2) @MaxLength(300) public deliveryLocation!: string;
  @Transform(clean) @IsString() @MinLength(2) @MaxLength(500) public packageDescription!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) public quantity = 1;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.01)
  @Max(10000)
  public approximateWeightKg!: number;
  @IsBoolean() public codRequired!: boolean;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  public codAmount?: number;
  @IsOptional() @IsDateString() public requestedAt?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(1000) public notes?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(120) public idempotencyKey?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(120) public utmSource?: string;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(120) public utmCampaign?: string;
}
