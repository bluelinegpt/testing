import { Transform } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";

import { storeOrderStatuses, type StoreOrderStatus } from "./store-order.constants.js";

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

/** §3/§6: server-side pagination input for My Orders. */
export class CustomerOrderListQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  public pageSize?: number;

  @IsOptional()
  @Transform(trim)
  @IsIn(storeOrderStatuses)
  public status?: StoreOrderStatus;
}

/** §27: tracking lookup input -- Order number, mobile and token together are
 * the whole security model (§22/§23); none of the three is optional. */
export class TrackStoreOrderDto {
  @Transform(trim)
  @IsString()
  @Length(1, 32)
  public storeOrderNumber!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 32)
  public mobile!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 128)
  public trackingToken!: string;
}
