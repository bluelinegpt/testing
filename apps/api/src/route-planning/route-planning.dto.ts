import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsLatitude, IsLongitude, IsOptional, IsUUID, Max, Min } from "class-validator";

/**
 * Route planning request bodies. The global ValidationPipe runs with
 * `forbidNonWhitelisted: true`, so every field a client may send is declared
 * here; anything else is a 400, not a silently ignored field.
 *
 * A start is optional: GPS (both coordinates) or a selected Area. When both
 * are sent, GPS wins.
 */
export class PlanRouteDto {
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID()
  public startAreaId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  public startLatitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  public startLongitude?: number;
}

export class ReplanRouteDto extends PlanRouteDto {
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  public expectedRevision!: number;
}

export class ReverseRouteDto {
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  public expectedRevision!: number;
}

export class DeferRouteOrderDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  public orderId!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  public expectedRevision!: number;
}
