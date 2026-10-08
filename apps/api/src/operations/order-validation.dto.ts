import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsString, Min } from "class-validator";

export class OrderLookupQueryDto {
  @IsString()
  @IsNotEmpty()
  public q!: string;
}

export class OrderValidationQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public version!: number;
}
