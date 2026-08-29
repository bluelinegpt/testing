import { createHmac, timingSafeEqual } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { mobileComparisonKey } from "../shared/uae-mobile.js";
import { mapPublicTrackingStatus, type PublicTrackingLanguage } from "./public-tracking-status.js";
import { normalizeReferenceTerm } from "./order-search.js";

export interface PublicTrackingTimelineStep {
  readonly status: string;
  readonly statusLabel: string;
  readonly occurredAt: string;
}

export interface PublicTrackingResult {
  readonly airwayBill: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly lastUpdated: string;
  readonly deliveredAt: string | null;
  readonly timeline: readonly PublicTrackingTimelineStep[];
}

export type PublicTrackingLookupOutcome =
  | { readonly result: "verified"; readonly tracking: PublicTrackingResult }
  | { readonly result: "verification_required"; readonly verificationToken: string }
  | { readonly result: "not_found" };

export type PublicTrackingVerifyOutcome =
  | { readonly result: "verified"; readonly tracking: PublicTrackingResult }
  | { readonly result: "not_verified" }
  | { readonly result: "ambiguous" };

/**
 * Which identifier the input was recognised as. `order_number` is the
 * canonical, system-generated Tawseelhub Order Number (`ORD-000116`,
 * immutable, `nextReferenceNumber(..., "order", "ORD")`); `serial_number` is
 * the Company's own Airway Bill / label serial number.
 */
type LookupKind = "order_number" | "serial_number";

interface EligibleCandidate {
  readonly orderId: string;
  readonly companyId: string;
  readonly customerMobileComparisonKey: string;
}

interface VerificationTokenPayload {
  readonly kind: LookupKind;
  readonly value: string;
  readonly exp: number;
}

// Exactly the shape `nextReferenceNumber(db, companyId, "order", "ORD")`
// produces: `ORD-` + at least 6 digits (padStart(6, "0") only pads a
// *minimum* of 6 -- a Company past 999,999 Orders gets 7+ digits with no
// re-padding). Case-insensitive on input (customers may type "ord-000116"),
// but the stored value is always upper-case, so the match value is
// upper-cased before querying -- no digit-padding coercion, no fuzzy match:
// a mistyped Order Number simply does not match, exactly like a mistyped
// Airway Bill.
const orderNumberPattern = /^ord-\d{6,}$/iu;

// Short-lived, single-purpose. Long enough for a customer to find their
// phone and type it in; short enough that a leaked/logged token is worthless
// within minutes. It represents exactly one thing -- "this identifier was
// ambiguous" -- and nothing else is derivable from it.
const VERIFICATION_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Signs/verifies the Step-1-to-Step-2 verification token using an HMAC over
 * the identifier + expiry, mirroring the project's existing signature
 * convention exactly (see `WhatsAppCloudProvider.verifySignature` in
 * `agent/whatsapp-provider.ts`: `createHmac("sha256", secret)` +
 * `timingSafeEqual`). Deliberately stateless -- no new database table -- per
 * the approved design: the token itself carries the (non-sensitive, already
 * customer-supplied) identifier and an expiry, signed so it cannot be forged
 * or altered, and it is never sent to the browser in any other form.
 */
function verificationTokenSecret(): string {
  const configured = process.env.PUBLIC_TRACKING_TOKEN_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("PUBLIC_TRACKING_TOKEN_SECRET is required in production");
  }
  // Development/test only -- never reached in production, see check above.
  return "public-tracking-development-only-secret";
}

function signVerificationToken(payload: VerificationTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", verificationTokenSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function readVerificationToken(token: string): VerificationTokenPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [body, signature] = parts;
  if (
    body === undefined ||
    body.length === 0 ||
    signature === undefined ||
    signature.length === 0
  ) {
    return undefined;
  }
  const expected = createHmac("sha256", verificationTokenSecret()).update(body).digest("base64url");
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<VerificationTokenPayload>;
    if (
      (payload.kind !== "order_number" && payload.kind !== "serial_number") ||
      typeof payload.value !== "string" ||
      payload.value.length === 0 ||
      typeof payload.exp !== "number"
    ) {
      return undefined;
    }
    if (payload.exp < Date.now()) return undefined;
    return { kind: payload.kind, value: payload.value, exp: payload.exp };
  } catch {
    return undefined;
  }
}

/**
 * Central, cross-Tawseelhub public shipment tracking -- the one place both
 * `tawseelhub.com/track` and the Yousef agent resolve a shipment, exactly
 * the design in the approved brief: "Tawseelhub Order Number or Company
 * Airway Bill first, mobile verification only when ambiguous across
 * companies." Also backs the legacy per-order tracking-link lookup's status
 * mapping (see `OperationsService.publicTracking`) so every public tracking
 * surface shares one privacy-limited response contract.
 *
 * Eligibility: the Order's Company must be `active` -- canonical
 * operational/Company state only. This is deliberately independent of the
 * Company Website's own `functions.trackingEnabled` switch: central
 * tawseelhub.com/track is a platform-level customer utility, not a
 * Company-Website-hosted feature (that page is explicitly out of scope for
 * now), so a Company's Orders stay centrally trackable regardless of
 * whether it has published, or ever configured, its own Company Website.
 */
@Injectable()
export class PublicTrackingService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async lookupByAirwayBill(
    rawInput: string,
    language: PublicTrackingLanguage = "en",
  ): Promise<PublicTrackingLookupOutcome> {
    const trimmed = rawInput.trim();
    if (trimmed.length === 0) return { result: "not_found" };
    // Order Number is checked first -- it has an unambiguous, narrow shape
    // (`ORD-######+`) that a genuine Airway Bill essentially never collides
    // with. Anything else is treated as a Company Airway Bill / Serial
    // Number, exactly the existing behaviour.
    const isOrderNumber = orderNumberPattern.test(trimmed);
    const kind: LookupKind = isOrderNumber ? "order_number" : "serial_number";
    const value = isOrderNumber ? trimmed.toUpperCase() : normalizeReferenceTerm(trimmed);
    if (value.length === 0) return { result: "not_found" };
    const candidates = await this.eligibleCandidates(kind, value);
    if (candidates.length === 0) return { result: "not_found" };
    if (candidates.length === 1) {
      return {
        result: "verified",
        tracking: await this.resultForOrder(candidates[0]!, language, kind),
      };
    }
    // A genuine Order Number collision across two Companies is rare (each
    // Company's counter is independent) but not impossible -- it gets the
    // exact same safe ambiguity/mobile-verification workflow as a duplicate
    // Airway Bill, never a silent "not found".
    return {
      result: "verification_required",
      verificationToken: signVerificationToken({
        kind,
        value,
        exp: Date.now() + VERIFICATION_TOKEN_TTL_MS,
      }),
    };
  }

  public async verifyAmbiguousShipment(
    verificationToken: string,
    rawMobile: string,
    language: PublicTrackingLanguage = "en",
  ): Promise<PublicTrackingVerifyOutcome> {
    const payload = readVerificationToken(verificationToken);
    if (payload === undefined) return { result: "not_verified" };
    // Operations may temporarily register the exact mobile value supplied by
    // a Trader even when it is incomplete, then correct it on the Order later.
    // Compare with the same deterministic digits-only key used by PostgreSQL
    // for the stored value. This still folds equivalent valid UAE formats
    // together, but never guesses, pads, or performs a partial match.
    const normalizedMobile = mobileComparisonKey(rawMobile);
    if (normalizedMobile.length === 0) return { result: "not_verified" };
    const candidates = await this.eligibleCandidates(payload.kind, payload.value);
    const matches = candidates.filter(
      (candidate) => candidate.customerMobileComparisonKey === normalizedMobile,
    );
    if (matches.length === 0) return { result: "not_verified" };
    if (matches.length > 1) return { result: "ambiguous" };
    return {
      result: "verified",
      tracking: await this.resultForOrder(matches[0]!, language, payload.kind),
    };
  }

  /** Shapes the privacy-limited public result for an already-resolved Order. */
  public async resultForOrder(
    order: {
      readonly orderId: string;
      readonly companyId: string;
    },
    language: PublicTrackingLanguage = "en",
    kind: LookupKind = "serial_number",
  ): Promise<PublicTrackingResult> {
    const row = (
      await sql<{
        serialNumber: string;
        orderNumber: string;
        deliveryStatus: string;
        deliveredAt: string | null;
        lastUpdatedAt: string;
      }>`
        select o.serial_number as "serialNumber",
               o.order_number as "orderNumber",
               o.delivery_status as "deliveryStatus",
               o.delivered_at::text as "deliveredAt",
               greatest(o.updated_at, coalesce(max(h.occurred_at), o.updated_at))::text as "lastUpdatedAt"
          from orders o
          left join order_status_history h on h.order_id = o.id and h.company_id = o.company_id
         where o.id = ${order.orderId}::uuid and o.company_id = ${order.companyId}::uuid
         group by o.id
         limit 1
      `.execute(this.database)
    ).rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "tracking_not_found",
        "Tracking information was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const history = (
      await sql<{ status: string; occurredAt: string }>`
        select to_status as status, occurred_at::text as "occurredAt"
          from order_status_history
         where order_id = ${order.orderId}::uuid and company_id = ${order.companyId}::uuid
           and status_dimension = 'delivery'
         order by occurred_at asc
      `.execute(this.database)
    ).rows;
    const current = mapPublicTrackingStatus(row.deliveryStatus, language);
    return {
      // Echoes back whichever identifier the customer actually searched
      // with -- the Order Number for an Order Number lookup, the Airway
      // Bill/Serial Number otherwise -- rather than always showing one
      // field regardless of what was typed.
      airwayBill: kind === "order_number" ? row.orderNumber : row.serialNumber,
      status: current.status,
      statusLabel: current.statusLabel,
      lastUpdated: row.lastUpdatedAt,
      deliveredAt: row.deliveredAt,
      // Real stored transitions only -- never a fabricated fixed-step
      // scaffold. An Order with no logged transitions yet shows an empty
      // timeline rather than an invented "received" entry.
      timeline: history.map((event) => ({
        ...mapPublicTrackingStatus(event.status, language),
        occurredAt: event.occurredAt,
      })),
    };
  }

  private async eligibleCandidates(
    kind: LookupKind,
    value: string,
  ): Promise<readonly EligibleCandidate[]> {
    // Deliberate architecture decision, not a placeholder: central
    // tawseelhub.com/track is a platform-level customer utility, independent
    // of any single Company's own Company Website. Eligibility is defined
    // entirely from canonical operational/Company state (an active Company),
    // never from company_websites.published_settings.functions.trackingEnabled
    // -- that flag governs ONLY a Company's own Company-Website-hosted
    // tracking page (out of scope for now), and a Company that has never
    // published a website at all (or disabled tracking on it) must not lose
    // central tracking eligibility as a side effect. Do not add a join to
    // company_websites here.
    const rows =
      kind === "order_number"
        ? await sql<EligibleCandidate>`
          select o.id as "orderId",
                 o.company_id as "companyId",
                 customer_mobile_comparison_key(o.customer_mobile_number) as "customerMobileComparisonKey"
            from orders o
            join companies c on c.id = o.company_id and c.status = 'active'
           where o.order_number = ${value}
        `.execute(this.database)
        : await sql<EligibleCandidate>`
          select o.id as "orderId",
                 o.company_id as "companyId",
                 customer_mobile_comparison_key(o.customer_mobile_number) as "customerMobileComparisonKey"
            from orders o
            join companies c on c.id = o.company_id and c.status = 'active'
           where o.serial_number_normalized = ${value}
             and o.serial_number_normalized is not null
        `.execute(this.database);
    return rows.rows;
  }
}
