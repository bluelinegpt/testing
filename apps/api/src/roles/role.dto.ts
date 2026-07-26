import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class RoleListQueryDto {
  @IsOptional() @IsString() @Length(1, 128) public search?: string;
  @IsOptional() @IsIn(["active", "disabled", "all"]) public status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) public page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) public pageSize = 25;
}

export class CreateRoleDto {
  @Transform(trim) @IsString() @Length(2, 128) public name!: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 500) public description?: string;
  @IsBoolean() public isActive!: boolean;
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  public permissions!: string[];
}

export class UpdateRoleDto {
  @IsOptional() @Transform(trim) @IsString() @Length(2, 128) public name?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 500) public description?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  public permissions?: string[];
  @IsOptional() @IsBoolean() public isActive?: boolean;
}

export class DuplicateRoleDto {
  @Transform(trim) @IsString() @Length(2, 128) public name!: string;
}
