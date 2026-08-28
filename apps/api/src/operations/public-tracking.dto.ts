import { Transform } from "class-transformer";
import { IsString, Length } from "class-validator";

const trim = ({ value }: { value: unknown }): unknown => (typeof value === "string" ? value.trim() : value);

/**
 * Step 1 of central public tracking: the customer's own Airway Bill /
 * Serial Number as they read it off their label. Matched by exact normalized
 * value only -- see `normalizeReferenceTerm` -- never a partial/prefix
 * search, so this can never be used to enumerate Orders.
 */
export class LookupTrackingDto {
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  public airwayBill!: string;
}

/**
 * Step 2, only reached when Step 1 found more than one eligible match. The
 * `verificationToken` is the short-lived, single-purpose, non-guessable
 * token returned by Step 1 -- it represents the ambiguous-match context, so
 * the candidate set never has to be (and never is) sent to the browser.
 */
export class VerifyTrackingDto {
  @Transform(trim)
  @IsString()
  @Length(1, 512)
  public verificationToken!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 32)
  public mobile!: string;
}
