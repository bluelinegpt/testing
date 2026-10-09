/**
 * Platform announcements -- the rules, kept free of the database so they can
 * be tested directly. The service applies them; the migration's CHECK
 * constraints are the last line of defence.
 */
import type { IdentityKind } from "../security/identity-context.js";

export const ANNOUNCEMENT_TYPES = ["info", "warning", "critical"] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

export const ANNOUNCEMENT_SURFACES = ["office_web", "trader_portal", "mobile_app"] as const;
export type AnnouncementSurface = (typeof ANNOUNCEMENT_SURFACES)[number];

export const ANNOUNCEMENT_AUDIENCES = ["all_companies", "selected_companies"] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export type AnnouncementDisplayStatus = "scheduled" | "live" | "ended" | "cancelled";

export const MAX_ANNOUNCEMENT_TITLE_LENGTH = 120;
export const MAX_ANNOUNCEMENT_BODY_LENGTH = 600;
export const MAX_ANNOUNCEMENT_COMPANIES = 500;

/** Most severe first: how stacked banners are ordered. */
export const ANNOUNCEMENT_SEVERITY: Readonly<Record<AnnouncementType, number>> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Which surfaces each account type may read. The caller says which surface it
 * is drawing; the server refuses a surface that account type never sees, so
 * a Trader can never read an office-only announcement by asking for it.
 */
export const SURFACES_BY_IDENTITY_KIND: Readonly<
  Partial<Record<IdentityKind, readonly AnnouncementSurface[]>>
> = {
  company_user: ["office_web", "mobile_app"],
  driver: ["mobile_app"],
  trader: ["trader_portal", "mobile_app"],
};

export function surfaceAllowedFor(kind: IdentityKind, surface: string): boolean {
  return (SURFACES_BY_IDENTITY_KIND[kind] ?? []).includes(surface as AnnouncementSurface);
}

export interface AnnouncementInput {
  readonly type: string;
  readonly titleEn?: string | null | undefined;
  readonly titleAr?: string | null | undefined;
  readonly bodyEn?: string | null | undefined;
  readonly bodyAr?: string | null | undefined;
  readonly showFrom: string;
  readonly showUntil: string;
  readonly surfaces: readonly string[];
  readonly audience: string;
  readonly companyIds?: readonly string[] | undefined;
}

export interface NormalizedAnnouncement {
  readonly type: AnnouncementType;
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly bodyEn: string | null;
  readonly bodyAr: string | null;
  readonly showFrom: Date;
  readonly showUntil: Date;
  readonly surfaces: AnnouncementSurface[];
  readonly audience: AnnouncementAudience;
  readonly companyIds: string[];
}

export type AnnouncementValidation =
  | { readonly ok: true; readonly value: NormalizedAnnouncement }
  | { readonly ok: false; readonly errors: string[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function instant(value: string): Date | null {
  // An explicit offset or Z is required: a bare local time would be read in
  // the server's zone, and the Platform screen always sends UTC ISO strings.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Checks and tidies an announcement before it is saved. Each error is a
 * stable code the Platform screen can explain.
 */
export function validateAnnouncement(input: AnnouncementInput): AnnouncementValidation {
  const errors: string[] = [];
  const type = ANNOUNCEMENT_TYPES.find((candidate) => candidate === input.type);
  if (type === undefined) errors.push("type_invalid");

  const titleEn = clean(input.titleEn);
  const titleAr = clean(input.titleAr);
  const bodyEn = clean(input.bodyEn);
  const bodyAr = clean(input.bodyAr);
  if ((titleEn === null) !== (bodyEn === null)) errors.push("english_incomplete");
  if ((titleAr === null) !== (bodyAr === null)) errors.push("arabic_incomplete");
  if (titleEn === null && titleAr === null) errors.push("language_required");
  if (
    (titleEn?.length ?? 0) > MAX_ANNOUNCEMENT_TITLE_LENGTH ||
    (titleAr?.length ?? 0) > MAX_ANNOUNCEMENT_TITLE_LENGTH
  )
    errors.push("title_too_long");
  if (
    (bodyEn?.length ?? 0) > MAX_ANNOUNCEMENT_BODY_LENGTH ||
    (bodyAr?.length ?? 0) > MAX_ANNOUNCEMENT_BODY_LENGTH
  )
    errors.push("body_too_long");

  const showFrom = instant(input.showFrom);
  const showUntil = instant(input.showUntil);
  if (showFrom === null || showUntil === null) errors.push("dates_invalid");
  else if (showUntil.getTime() <= showFrom.getTime()) errors.push("dates_out_of_order");

  const surfaces = [...new Set(input.surfaces)];
  if (surfaces.length === 0) errors.push("surfaces_required");
  if (surfaces.some((surface) => !ANNOUNCEMENT_SURFACES.includes(surface as AnnouncementSurface)))
    errors.push("surface_invalid");

  const audience = ANNOUNCEMENT_AUDIENCES.find((candidate) => candidate === input.audience);
  if (audience === undefined) errors.push("audience_invalid");
  const companyIds = [...new Set(input.companyIds ?? [])];
  if (audience === "selected_companies") {
    if (companyIds.length === 0) errors.push("companies_required");
    if (companyIds.length > MAX_ANNOUNCEMENT_COMPANIES) errors.push("too_many_companies");
    if (companyIds.some((id) => !uuidPattern.test(id))) errors.push("company_invalid");
  }

  if (errors.length > 0 || type === undefined || audience === undefined || showFrom === null || showUntil === null) {
    return { errors: [...new Set(errors)], ok: false };
  }
  return {
    ok: true,
    value: {
      audience,
      bodyAr,
      bodyEn,
      // An "all companies" announcement never keeps a stale target list.
      companyIds: audience === "selected_companies" ? companyIds.map((id) => id.toLowerCase()) : [],
      showFrom,
      showUntil,
      surfaces: surfaces as AnnouncementSurface[],
      titleAr,
      titleEn,
      type,
    },
  };
}

/** What the Platform list shows for an announcement at a given moment. */
export function announcementDisplayStatus(
  announcement: { readonly status: string; readonly showFrom: Date; readonly showUntil: Date },
  now: Date,
): AnnouncementDisplayStatus {
  if (announcement.status === "cancelled") return "cancelled";
  if (now.getTime() < announcement.showFrom.getTime()) return "scheduled";
  if (now.getTime() >= announcement.showUntil.getTime()) return "ended";
  return "live";
}
