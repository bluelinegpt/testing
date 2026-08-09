import { Transform, Type } from "class-transformer";
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, Min } from "class-validator";

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

/**
 * Filters for the Platform audit browser.
 *
 * `whitelist` + `forbidNonWhitelisted` mean these are the ONLY accepted
 * parameters. There is deliberately no free-text field that reaches a SQL
 * predicate, no sort parameter (the trail is always newest-first, so a page
 * cannot be reordered into hiding an entry), and no way to widen the
 * `platform.%` action filter the query applies unconditionally.
 */
export class PlatformAuditQueryDto {
  @IsOptional()
  @IsUUID()
  public companyId?: string;

  /**
   * Matched as a PREFIX, so `platform.company` finds every Company action.
   * Constrained to the shape an action code actually has: a caller cannot pass
   * a pattern, only a name.
   */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^[a-z0-9_.]{1,120}$/, {
    message: "action must be a lowercase action code or prefix",
  })
  public action?: string;

  @IsOptional()
  @IsUUID()
  public actorAccountId?: string;

  @IsOptional()
  @IsISO8601()
  public from?: string;

  @IsOptional()
  @IsISO8601()
  public to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public pageSize?: number;
}
