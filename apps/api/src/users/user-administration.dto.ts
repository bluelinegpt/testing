import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";

import { NormalizeUaeMobile } from "../shared/uae-mobile.js";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

const uaeMobileMessage = {
  message: "Enter a UAE mobile number, for example 0506468442 or 9715XXXXXXXX.",
};

export class UserListQueryDto {
  @IsOptional() @IsString() @Length(1, 128) public search?: string;
  @IsOptional() @IsIn(["company_user", "driver", "trader", "all"]) public accountKind?: string;
  @IsOptional() @IsIn(["active", "disabled", "locked", "all"]) public status?: string;
  @IsOptional() @IsUUID("4") public roleId?: string;
  @IsOptional() @IsIn(["linked", "unlinked", "all"]) public employee?: string;
  @IsOptional()
  @IsIn(["username", "name", "email", "status", "lastLoginAt", "createdAt"])
  public sort?: string;
  @IsOptional() @IsIn(["asc", "desc"]) public direction?: "asc" | "desc";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) public page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @IsIn([25, 50, 100]) public pageSize = 25;
}

export class CreateUserDto {
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/)
  public username!: string;
  @Transform(trim) @IsString() @Length(1, 200) public displayName!: string;
  @Transform(trim) @IsEmail() @Length(3, 320) public email!: string;
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, uaeMobileMessage)
  public mobileNumber!: string;
  @IsIn(["en", "ar"]) public preferredLanguage!: "en" | "ar";
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID("4", { each: true })
  public roleIds!: string[];
  @IsOptional() @IsUUID("4") public employeeId?: string;
  @IsIn(["active", "disabled"]) public status!: "active" | "disabled";
  @IsBoolean() public forcePasswordChange!: boolean;
}

export class UserIdentifierAvailabilityQueryDto {
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/)
  public username?: string;

  @IsOptional() @Transform(trim) @IsEmail() @Length(3, 320) public email?: string;

  @IsOptional()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, uaeMobileMessage)
  public mobileNumber?: string;

  @IsOptional() @IsUUID("4") public excludeAccountId?: string;
}

export class EditUserDto {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 200) public displayName?: string;
  @IsOptional() @Transform(trim) @IsEmail() @Length(3, 320) public email?: string;
  @IsOptional()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, uaeMobileMessage)
  public mobileNumber?: string | null;
  @IsOptional() @IsIn(["en", "ar"]) public preferredLanguage?: "en" | "ar";
}

export class AssignUserRolesDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID("4", { each: true })
  public roleIds!: string[];
}

export class ReasonDto {
  @Transform(trim) @IsString() @Length(3, 500) public reason!: string;
}

export class ForcePasswordChangeDto {
  @Equals(true) public required!: true;
  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) public reason?: string;
}

export class SessionActionDto {
  @IsOptional() @IsBoolean() public preserveCurrentSession?: boolean;
  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) public reason?: string;
}

export class AuditListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) public page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) public pageSize = 25;
}
