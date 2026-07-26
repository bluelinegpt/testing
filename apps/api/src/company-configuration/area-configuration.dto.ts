import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from "class-validator";

/**
 * Area write payloads never carry a Company or an Area code. The Company comes
 * from the authenticated tenant context and the code is generated server-side.
 */
export class CreateAreaDto {
  @IsUUID()
  public emirateId!: string;

  @IsString()
  @Length(1, 160)
  public nameEn!: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  public nameAr?: string;

  @IsOptional()
  @IsString()
  @Length(1, 1000)
  public notes?: string;
}

export class UpdateAreaDto {
  @IsOptional()
  @IsUUID()
  public emirateId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  public nameEn?: string;

  @IsOptional()
  @IsString()
  @Length(0, 160)
  public nameAr?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  public notes?: string;
}

export class UpdateAreaStatusDto {
  @IsBoolean()
  public isActive!: boolean;
}

export const areaPageSizes = [25, 50, 100] as const;

export class AreaListQueryDto {
  @IsOptional()
  @IsString()
  @Length(0, 160)
  public search?: string;

  @IsOptional()
  @IsUUID()
  public emirateId?: string;

  /** "all" is the default so the list is not silently filtered. */
  @IsOptional()
  @IsIn(["all", "active", "disabled"])
  public status?: "all" | "active" | "disabled";

  @IsOptional()
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @IsInt()
  @IsIn([...areaPageSizes])
  public pageSize?: number;
}

export class AreaSearchQueryDto {
  @IsOptional()
  @IsString()
  @Length(0, 160)
  public search?: string;

  @IsOptional()
  @IsUUID()
  public emirateId?: string;

  /**
   * Operational pickers must offer active Areas only. Edit screens showing a
   * historical record pass false so a disabled Area still resolves.
   */
  @IsOptional()
  @IsBoolean()
  public activeOnly?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  public limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  public offset?: number;
}
