import { createHmac, timingSafeEqual } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { normalizeUaeMobile } from "../shared/uae-mobile.js";
import { mapPublicTrackingStatus } from "./public-tracking-status.js";
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

interface EligibleCandidate {
  readonly orderId: string;
  readonly companyId: string;
  readonly customerMobileComparisonKey: string;
}

interface VerificationTokenPayload {
  readonly awb: string;
  readonly exp: number;
}

// Short-lived, single-purpose. Long enough for a customer to find their
// phone and type it in; short enough that a leaked/logged token is worthless
// within minutes. It represents exactly one thing -- "this normalized Airway
// Bill was ambiguous" -- and nothing else is derivable from it.
const VERIFICATION_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Signs/verifies the Step-1-to-Step-2 verification token using an HMAC over
 * the normalized Airway Bill + expiry, mirroring the project's existing
 * signature convention exactly (see `WhatsAppCloudProvider.verifySignature`
 * in `agent/whatsapp-provider.ts`: `createHmac("sha256", secret)` +
 * `timingSafeEqual`). Deliberately stateless -- no new database table -- per
 * the approved design: the token itself carries the (non-sensitive, already
 * customer-supplied) Airway Bill and an expiry, signed so it cannot be
 * forged or altered, and it is never sent to the browser in any other form.
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
  const signature = createHmac("sha256", verificationTokenSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function readVerificationToken(token: string): VerificationTokenPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [body, signature] = parts;
  if (body === undefined || body.length === 0 || signature === undefined || signature.length === 0) {
    return undefined;
  }
  const expected = createHmac("sha256", verificationTokenSecret()).update(body).digest("base64url");
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<VerificationTokenPayload>;
    if (typeof payload.awb !== "string" || payload.awb.length === 0 || typeof payload.exp !== "number") {
      return undefined;
    }
    if (payload.exp < Date.now()) return undefined;
    return { awb: payload.awb, exp: payload.exp };
  } catch {
    return undefined;
  }
}

/**
 * Central, cross-Tawseelhub public shipment tracking -- the one place both
 * `tawseelhub.com/track` and the Yousef agent resolve an Airway Bill,
 * exactly the design in the approved brief: "Airway Bill first, mobile
 * verification only when ambiguous across companies." Also backs the
 * legacy per-order tracking-link lookup's status mapping (see
 * `OperationsService.publicTracking`) so every public tracking surface
 * shares one privacy-limited response contract.
 *
 * Eligibility: the Order's Company must be `active`, and -- reusing the
 * existing Company Website `functions.trackingEnabled` switch rather than
 * inventing a new flag -- must not have explicitly disabled tracking. A
 * Company with no Company Website configured at all defaults to eligible
 * (the flag's own default, when a website exists, is `true`).
 */
@Injectable()
export class PublicTrackingService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async lookupByAirwayBill(rawAirwayBill: string): Promise<PublicTrackingLookupOutcome> {
    const normalized = normalizeReferenceTerm(rawAirwayBill);
    if (normalized.length === 0) return { result: "not_found" };
    const candidates = await this.eligibleCandidates(normalized);
    if (candidates.length === 0) return { result: "not_found" };
    if (candidates.length === 1) {
      return { result: "verified", tracking: await this.resultForOrder(candidates[0]!) };
    }
    return {
      result: "verification_required",
      verificationToken: signVerificationToken({
        awb: normalized,
        exp: Date.now() + VERIFICATION_TOKEN_TTL_MS,
      }),
    };
  }

  public async verifyAmbiguousShipment(
    verificationToken: string,
    rawMobile: string,
  ): Promise<PublicTrackingVerifyOutcome> {
    const payload = readVerificationToken(verificationToken);
    if (payload === undefined) return { result: "not_verified" };
    const normalizedMobile = normalizeUaeMobile(rawMobile);
    if (normalizedMobile === undefined) return { result: "not_verified" };
    const candidates = await this.eligibleCandidates(payload.awb);
    const matches = candidates.filter(
      (candidate) => candidate.customerMobileComparisonKey === normalizedMobile,
    );
    if (matches.length === 0) return { result: "not_verified" };
    if (matches.length > 1) return { result: "ambiguous" };
    return { result: "verified", tracking: await this.resultForOrder(matches[0]!) };
  }

  /** Shapes the privacy-limited public result for an already-resolved Order. */
  public async resultForOrder(order: {
    readonly orderId: string;
    readonly companyId: string;
  }): Promise<PublicTrackingResult> {
    const row = (
      await sql<{
        serialNumber: string;
        deliveryStatus: string;
        deliveredAt: string | null;
        lastUpdatedAt: string;
      }>`
        select o.serial_number as "serialNumber",
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
    const current = mapPublicTrackingStatus(row.deliveryStatus);
    return {
      airwayBill: row.serialNumber,
      status: current.status,
      statusLabel: current.statusLabel,
      lastUpdated: row.lastUpdatedAt,
      deliveredAt: row.deliveredAt,
      // Real stored transitions only -- never a fabricated fixed-step
      // scaffold. An Order with no logged transitions yet shows an empty
      // timeline rather than an invented "received" entry.
      timeline: history.map((event) => ({
        ...mapPublicTrackingStatus(event.status),
        occurredAt: event.occurredAt,
      })),
    };
  }

  private async eligibleCandidates(normalizedAwb: string): Promise<readonly EligibleCandidate[]> {
    // NOTE: the approved design also excludes a Company that has explicitly
    // disabled tracking on its own Company Website
    // (company_websites.published_settings.functions.trackingEnabled ===
    // false). That table belongs to a separate, already-authored but
    // NOT-YET-APPLIED migration (20260938000000_company_website_foundation)
    // -- applying it here would touch another in-flight workstream's schema
    // state as a side effect of this feature, so it is deliberately left out
    // until that migration actually lands. Once it does, restore:
    //   left join company_websites cw on cw.company_id = o.company_id
    //   ... and coalesce((cw.published_settings->'functions'->>'trackingEnabled')::boolean, true) = true
    const rows = await sql<EligibleCandidate>`
      select o.id as "orderId",
             o.company_id as "companyId",
             customer_mobile_comparison_key(o.customer_mobile_number) as "customerMobileComparisonKey"
        from orders o
        join companies c on c.id = o.company_id and c.status = 'active'
       where o.serial_number_normalized = ${normalizedAwb}
         and o.serial_number_normalized is not null
    `.execute(this.database);
    return rows.rows;
  }
}
