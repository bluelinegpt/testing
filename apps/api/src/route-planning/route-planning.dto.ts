import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";

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

/** The Driver's own Area order, and optionally the Orders inside the Areas. */
export class ReorderRouteDto {
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  public expectedRevision!: number;

  @ApiProperty({ type: [String], format: "uuid" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  public areaIds!: string[];

  @ApiPropertyOptional({ type: [String], format: "uuid" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  public orderIds?: string[];
}

export class RouteStopStatusDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  public orderId!: string;

  @ApiProperty({ enum: ["delivered", "hold", "returned_to_branch"] })
  @IsIn(["delivered", "hold", "returned_to_branch"])
  public status!: "delivered" | "hold" | "returned_to_branch";

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  public reason?: string;
}

export class RouteOrderActionDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  public orderId!: string;
}

/** One Area pin or the branch location: both coordinates are required. */
export class RoutePointDto {
  @ApiProperty({ minimum: -90, maximum: 90 })
  @Type(() => Number)
  @IsLatitude()
  public latitude!: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @Type(() => Number)
  @IsLongitude()
  public longitude!: number;
}
