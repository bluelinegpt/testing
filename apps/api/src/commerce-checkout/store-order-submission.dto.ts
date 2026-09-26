import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";

import { CheckoutAddressDto, CheckoutCartLineDto } from "./commerce-checkout.dto.js";

/**
 * Customer Commerce Prompt C3 -- Store Order submission ("Place Order").
 *
 * Deliberately reuses `CheckoutCartLineDto`/`CheckoutAddressDto` from C2's
 * `ValidateCheckoutDto` rather than redefining an equivalent shape: the same
 * "lookup keys only, no money field exists to strip" contract applies here
 * too (§8 of C3 -- unit price, subtotal, delivery fee, COD total, Company
 * service fee, Product name/image/Store name are all absent by
 * construction, not merely ignored if present).
 *
 * `expectedCodTotal` is the ONE non-authoritative addition (§17/§18): the
 * COD total the Customer's browser last showed them, from their most recent
 * `checkout/validate` call. It is compared against the freshly recomputed
 * total inside the submission transaction purely as a UX safety check -- if
 * they differ, submission is rejected with `checkout_changed` rather than
 * silently charging a different total than the Customer just reviewed. It
 * is NEVER used as, or substituted for, an authoritative money value.
 */
export class PlaceStoreOrderDto {
  @IsString()
  @MaxLength(200)
  public readonly storeSlug!: string;

  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CheckoutCartLineDto)
  public readonly cartLines!: readonly CheckoutCartLineDto[];

  @IsString()
  @MaxLength(200)
  public readonly customerName!: string;

  @IsString()
  @MaxLength(20)
  public readonly customerMobile!: string;

  @IsOptional()
  @IsUUID()
  public readonly savedAddressId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CheckoutAddressDto)
  public readonly newAddress?: CheckoutAddressDto;

  @IsOptional()
  @IsUUID()
  public readonly selectedDeliveryCompanyId?: string;

  @IsIn(["cod"])
  public readonly paymentMethod!: "cod";

  /** The Review screen's own total, non-authoritative (§18). */
  @IsString()
  @MaxLength(32)
  public readonly expectedCodTotal!: string;

  /** Client-generated, e.g. `crypto.randomUUID()` (§10). Scoped to
   * (Customer-or-guest, this key) -- replaying the same key with the SAME
   * submission contents returns the original Store Order; replaying it with
   * DIFFERENT contents is rejected (§11), never silently substituted. */
  @IsUUID()
  public readonly idempotencyKey!: string;
}
