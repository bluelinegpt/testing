import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/**
 * Customer Commerce Prompt C2 -- the Checkout validation/preview contract.
 *
 * This is deliberately the ONLY money-adjacent thing the client may send:
 * lookup keys (`storeSlug`, `productSlug`, option values, a Company id to
 * select) and raw destination text. No price, subtotal, fee or total field
 * exists anywhere on this DTO -- there is nothing to strip, because there is
 * nothing accepted to strip it from (§12/§77).
 */
export class CheckoutSelectedOptionDto {
  @IsString()
  @MaxLength(200)
  public readonly groupName!: string;

  @IsString()
  @MaxLength(200)
  public readonly value!: string;
}

export class CheckoutCartLineDto {
  @IsString()
  @MaxLength(200)
  public readonly productSlug!: string;

  @IsInt()
  @Min(1)
  @Max(100000)
  public readonly quantity!: number;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CheckoutSelectedOptionDto)
  public readonly selectedOptions!: readonly CheckoutSelectedOptionDto[];
}

export class CheckoutAddressDto {
  @IsString()
  @MaxLength(120)
  public readonly emirate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly area?: string;

  @IsString()
  @MaxLength(500)
  public readonly address!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly locationLink?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly deliveryInstructions?: string;
}

export class ValidateCheckoutDto {
  @IsString()
  @MaxLength(200)
  public readonly storeSlug!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CheckoutCartLineDto)
  public readonly cartLines!: readonly CheckoutCartLineDto[];

  @IsString()
  @MaxLength(200)
  public readonly customerName!: string;

  // Reuses the same UAE mobile format every Commerce Customer surface
  // already normalizes to (`commerce_customer_addresses_mobile_format`,
  // `9715XXXXXXXX`) -- no new format invented (§22).
  @IsString()
  @MaxLength(20)
  public readonly customerMobile!: string;

  /** A logged-in Customer's saved address. Ownership is re-verified
   * server-side against the session -- never trusted merely because it was
   * sent (§74). Mutually exclusive with `newAddress` in practice; if both
   * are sent, the saved address wins. */
  @IsOptional()
  @IsUUID()
  public readonly savedAddressId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CheckoutAddressDto)
  public readonly newAddress?: CheckoutAddressDto;

  /** A Delivery Company the Customer explicitly chose, from the eligible
   * set this same endpoint already returned. Re-validated against that
   * exact set server-side on every call -- an unrelated Company id is
   * rejected as a normal business error, never trusted (§76). Omitted when
   * there is nothing to choose (0 or 1 eligible Company). */
  @IsOptional()
  @IsUUID()
  public readonly selectedDeliveryCompanyId?: string;

  @IsIn(["cod"])
  public readonly paymentMethod!: "cod";
}
