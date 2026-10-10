import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/** Company route planning switch and budget. The provider is fixed to the
 *  free stored-pin Area engine (decision 10 Oct 2026). */
export class UpdateCompanyRouteOptimizationDto {
  @ApiProperty()
  @IsBoolean()
  public isEnabled!: boolean;

  @ApiProperty({ minimum: 1, maximum: 100000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  public dailyCallBudget!: number;

  @ApiProperty({ minimum: 0, description: "Settings version last loaded (0 when never saved)" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public expectedVersion!: number;
}

export class ConfigureRouteKillSwitchDto {
  @ApiProperty()
  @IsBoolean()
  public isEnabled!: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public note?: string;
}
