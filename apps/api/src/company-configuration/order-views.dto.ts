import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsObject, IsOptional, Min } from "class-validator";

/**
 * Shape only. The menu's rules (which views exist, names, statuses, date
 * windows, one default) are checked by `validateOrderViews`, which returns
 * every problem at once as the 400's details.
 */
export class SaveOrderViewsMenuDto {
  @IsBoolean()
  public readonly enabled!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  public readonly expectedVersion?: number;

  @IsArray()
  @ArrayMaxSize(40)
  @IsObject({ each: true })
  public readonly views!: Record<string, unknown>[];
}
