import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from "class-validator";

import { NormalizeUaeMobile } from "../shared/uae-mobile.js";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class LinkBusinessUserDto {
  @IsUUID("4") public readonly accountId!: string;
}

export class CreateBusinessUserDto {
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/)
  public readonly username!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 200)
  public readonly displayName!: string;

  @IsOptional()
  @Transform(trim)
  @IsEmail()
  @Length(3, 320)
  public readonly email?: string;

  @IsOptional()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, {
    message: "Enter a UAE mobile number, for example 0506468442 or 9715XXXXXXXX.",
  })
  public readonly mobileNumber?: string;

  @IsIn(["en", "ar"])
  public readonly preferredLanguage!: "en" | "ar";

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID("4", { each: true })
  public readonly roleIds?: string[];
}

export class EligibleBusinessUsersQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 128)
  public readonly search?: string;
}

export class LegacyBusinessLinkSyncDto {
  @Transform(trim)
  @IsString()
  @Length(64, 64)
  public readonly previewIdentity!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  public readonly candidateIds!: string[];
}

export class BusinessAccessReasonDto {
  @Transform(trim) @IsString() @Length(3, 500) public readonly reason!: string;
}
