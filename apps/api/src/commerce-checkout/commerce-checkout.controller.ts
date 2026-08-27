import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";

import { OptionalAuthentication } from "../authentication/authentication.decorators.js";

import type { CheckoutLineResult, CheckoutResult } from "./commerce-checkout.service.js";
import { CommerceCheckoutService } from "./commerce-checkout.service.js";
import { ValidateCheckoutDto } from "./commerce-checkout.dto.js";

/** The Customer-safe line shape -- drops `productId`/`selectedOptionValueIds`
 * (internal ids kept on `CheckoutLineResult` only so C3's Store Order
 * submission can reuse them; a Customer's browser has no business seeing an
 * internal Product row id). */
type PublicCheckoutLine = Omit<CheckoutLineResult, "productId" | "selectedOptionValueIds">;
type PublicCheckoutResult = Omit<CheckoutResult, "lines"> & { readonly lines: readonly PublicCheckoutLine[] };

/** Drops the internal-only `deliveryCompanyServiceFee` field (§39/§42) and
 * every line's internal `productId`/`selectedOptionValueIds` -- none of
 * these are ever sent over HTTP, so nothing downstream comes to depend on
 * them leaking. */
function toPublicResult(result: Awaited<ReturnType<CommerceCheckoutService["validate"]>>): PublicCheckoutResult {
  const { deliveryCompanyServiceFee: _internal, ...publicResult } = result;
  return {
    ...publicResult,
    lines: publicResult.lines.map(
      ({ productId: _productId, selectedOptionValueIds: _selectedOptionValueIds, ...line }) => line,
    ),
  };
}

/**
 * Customer Commerce Prompt C2, §11-16.
 *
 * `@OptionalAuthentication()`, not `@Public()`: both guests and logged-in
 * Customers call this same route, and — unlike `ClientErrorReportController`'s
 * `/errors/public` (`@Public()`, which `AuthenticationGuard` never attempts
 * to resolve a session for, by design) — a logged-in Customer's identity
 * here is a real functional dependency (saved-address ownership, §74), not
 * just attribution. See `OptionalAuthentication`'s own doc comment for why
 * the two decorators are not interchangeable.
 *
 * This route creates nothing. It re-resolves Store, Product, options,
 * pricing and delivery eligibility from the database on every call and
 * returns a preview — never a reservation, never an Order (§13).
 *
 * Unexpected failures are left to propagate to the existing global
 * `ApiExceptionFilter`, which is already wired to the centralized Platform
 * Error Handler — no second telemetry path is introduced here. Expected
 * business-validation failures (`ApplicationException`, 4xx) are excluded
 * from that filter's crash-report capture by design, matching the same
 * expected-vs-unexpected classification the Error Handler audit already
 * established system-wide.
 */
@ApiTags("commerce-checkout")
@Controller("commerce/checkout")
export class CommerceCheckoutController {
  public constructor(@Inject(CommerceCheckoutService) private readonly checkout: CommerceCheckoutService) {}

  @OptionalAuthentication()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revalidate a Cart, resolve delivery, and preview a COD Checkout" })
  @Post("validate")
  public async validate(@Body() input: ValidateCheckoutDto): Promise<PublicCheckoutResult> {
    return toPublicResult(await this.checkout.validate(input));
  }
}
