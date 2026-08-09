import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, type Transaction, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { FileOwnershipService } from "../files/file-ownership.service.js";

import { accessibleStorefrontIds } from "./storefront-access.js";

import type {
  CreateStorefrontDto,
  SlugAvailabilityQueryDto,
  StorefrontListQueryDto,
  StorefrontStatusActionDto,
  SuspendStorefrontDto,
  UpdateStorefrontDto,
} from "./storefront.dto.js";
import {
  canTransitionStorefront,
  normaliseStorefrontSlug,
  publiclyResolvableStatuses,
  rejectStorefrontSlug,
  requiredForPublication,
  type StorefrontStatus,
} from "./storefront.constants.js";

/**
 * Trader Storefront profile and configuration.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP IS RESOLVED HERE, NEVER ACCEPTED FROM THE CALLER
 * ---------------------------------------------------------------------------
 *
 * `company_id` is read from the authenticated session and nothing else. A
 * `traderId` in a request body is treated as a CLAIM: it is checked against the
 * caller's Company before it is used, and for a Trader identity it must equal
 * that identity's own Trader. A request cannot widen its own scope by naming a
 * different Company or Trader, because neither value is ever taken from the
 * request.
 *
 * ---------------------------------------------------------------------------
 * THE AVAILABILITY CHECK IS ADVISORY; THE INDEX DECIDES
 * ---------------------------------------------------------------------------
 *
 * `slugAvailability` answers a question about a moment that has already passed
 * by the time the answer is read. Two Traders can both be told "available" and
 * both submit. That is why the write path does not re-check and then trust
 * itself: it attempts the insert and translates the unique-violation into a
 * field error. The database is the only thing that can arbitrate a race, so it
 * is the only thing allowed to.
 */


/**
 * A public URL for a Commerce file, or null.
 *
 * Relative on purpose. The Store, the API and any future CDN all serve this
 * path from their own origin, so baking a host in here would tie stored
 * responses to one deployment.
 */
export function commerceMediaUrl(fileId: string | null): string | null {
  return fileId === null ? null : `/api/v1/public/commerce-media/${fileId}`;
}

/** A Storefront row as stored. Not a public shape — see `publicView`. */
export interface StorefrontRow {
  readonly brandAccentColor: string | null;
  readonly brandPrimaryColor: string | null;
  readonly businessHours: unknown;
  readonly businessTemplate: string;
  /** Compatibility reference only. Ownership is `trader_commerce_id`. */
  readonly companyId: string | null;
  readonly coverFileId: string | null;
  readonly createdAt: Date;
  readonly customerSupport: string | null;
  readonly deliveryInformation: string | null;
  readonly displayName: string;
  readonly id: string;
  readonly logoFileId: string | null;
  readonly publicEmail: string | null;
  readonly publicMobile: string | null;
  readonly publicWhatsapp: string | null;
  readonly publishedAt: Date | null;
  readonly returnPolicy: string | null;
  readonly seoDescriptionAr: string | null;
  readonly seoDescriptionEn: string | null;
  readonly seoIndexable: boolean;
  readonly seoSocialFileId: string | null;
  readonly seoTitleAr: string | null;
  readonly seoTitleEn: string | null;
  readonly slug: string;
  readonly status: string;
  readonly storeDescription: string | null;
  readonly suspendedAt: Date | null;
  readonly suspensionReason: string | null;
  readonly terms: string | null;
  readonly theme: string;
  /**
   * The authoritative owner. Internal only — `managementStorefrontView` and the
   * public view both omit it deliberately.
   */
  readonly traderCommerceId: string;
  /** Compatibility reference only. Ownership is `trader_commerce_id`. */
  readonly traderId: string | null;
  readonly updatedAt: Date;
  readonly version: string;
}

/** Unaliased twin of `storefrontColumns`, for `returning` where no alias exists. */
const returningColumns = sql`
  id, company_id as "companyId", trader_id as "traderId",
  trader_commerce_id as "traderCommerceId",
  display_name as "displayName", slug,
  business_template as "businessTemplate", theme,
  logo_file_id as "logoFileId", cover_file_id as "coverFileId",
  brand_primary_color as "brandPrimaryColor", brand_accent_color as "brandAccentColor",
  store_description as "storeDescription", public_mobile as "publicMobile",
  public_whatsapp as "publicWhatsapp", public_email as "publicEmail",
  business_hours as "businessHours", delivery_information as "deliveryInformation",
  return_policy as "returnPolicy", terms, customer_support as "customerSupport",
  seo_title_en as "seoTitleEn", seo_title_ar as "seoTitleAr",
  seo_description_en as "seoDescriptionEn", seo_description_ar as "seoDescriptionAr",
  seo_social_file_id as "seoSocialFileId", seo_indexable as "seoIndexable",
  status, published_at as "publishedAt", suspended_at as "suspendedAt",
  suspension_reason as "suspensionReason",
  created_at as "createdAt", updated_at as "updatedAt", version::text as version
`;

const storefrontColumns = sql`
  s.id, s.company_id as "companyId", s.trader_id as "traderId",
  s.trader_commerce_id as "traderCommerceId",
  s.display_name as "displayName", s.slug,
  s.business_template as "businessTemplate", s.theme,
  s.logo_file_id as "logoFileId", s.cover_file_id as "coverFileId",
  s.brand_primary_color as "brandPrimaryColor", s.brand_accent_color as "brandAccentColor",
  s.store_description as "storeDescription", s.public_mobile as "publicMobile",
  s.public_whatsapp as "publicWhatsapp", s.public_email as "publicEmail",
  s.business_hours as "businessHours", s.delivery_information as "deliveryInformation",
  s.return_policy as "returnPolicy", s.terms, s.customer_support as "customerSupport",
  s.seo_title_en as "seoTitleEn", s.seo_title_ar as "seoTitleAr",
  s.seo_description_en as "seoDescriptionEn", s.seo_description_ar as "seoDescriptionAr",
  s.seo_social_file_id as "seoSocialFileId", s.seo_indexable as "seoIndexable",
  s.status, s.published_at as "publishedAt", s.suspended_at as "suspendedAt",
  s.suspension_reason as "suspensionReason",
  s.created_at as "createdAt", s.updated_at as "updatedAt", s.version::text as version
`;

@Injectable()
export class StorefrontService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly auditWriter: OperationsHistoryWriter,
    @Inject(FileOwnershipService) private readonly fileOwnership: FileOwnershipService,
  ) {}

  // ---------------------------------------------------------------- reads

  public async list(query: StorefrontListQueryDto) {
    this.assertRead();
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 100);
    const search = query.search === undefined ? null : `%${query.search.trim()}%`;
    // The Trader narrowing that used to be a second predicate is now inside
    // `accessibleStorefronts()`: a Trader actor resolves to its own Commerce
    // identity's Stores and nothing else.
    const rows = await sql<StorefrontRow & { total: number }>`
      select ${storefrontColumns}, count(*) over()::int as total
        from trader_storefronts s
       where s.id in (${this.accessibleStorefronts()})
         and (${query.status ?? null}::text is null or s.status = ${query.status ?? null})
         and (${search}::text is null
              or s.display_name ilike ${search} or s.slug ilike ${search})
       order by lower(s.display_name), s.id
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);
    return {
      items: rows.rows.map((row) => managementStorefrontView(row)),
      page,
      pageSize,
      total: rows.rows[0]?.total ?? 0,
    };
  }

  public async detail(storefrontId: string) {
    this.assertRead();
    const row = await this.loadOwned(this.database, storefrontId);
    return managementStorefrontView(row);
  }

  /** The authenticated Trader's own Storefront, or null when none exists yet. */
  public async mine() {
    this.assertRead();
    const traderId = this.callerTraderId();
    if (traderId === null) {
      throw new ApplicationException(
        "storefront_trader_context_required",
        "This operation is available to a Trader account",
        HttpStatus.FORBIDDEN,
      );
    }
    // Resolved through the Commerce identity rather than `company_id`, so the
    // Trader still finds its shop when it has no Delivery Company at all.
    const result = await sql<StorefrontRow>`
      select ${storefrontColumns} from trader_storefronts s
       where s.id in (${this.accessibleStorefronts()})
    `.execute(this.database);
    const row = result.rows[0];
    return row === undefined ? null : managementStorefrontView(row);
  }

  /**
   * Advisory availability.
   *
   * Reports every deterministic reason a slug is unusable, plus whether it is
   * currently taken by a live Storefront or reserved by a retired one. The
   * answer is a snapshot; see the class comment.
   */
  public async slugAvailability(query: SlugAvailabilityQueryDto) {
    this.assertRead();
    const normalised = normaliseStorefrontSlug(query.slug);
    const rejection = rejectStorefrontSlug(normalised);
    if (rejection !== null) {
      return { available: false, normalised, reason: rejection };
    }
    const taken = await this.slugTaken(this.database, normalised, query.storefrontId ?? null);
    return {
      available: !taken,
      normalised,
      reason: taken ? "storefront_slug_taken" : null,
    };
  }

  public async history(storefrontId: string) {
    this.assertRead();
    const row = await this.loadOwned(this.database, storefrontId);
    const events = await sql<Record<string, unknown>>`
      select a.action, a.occurred_at as "occurredAt", a.after_data as "afterData",
             a.correlation_id as "correlationId",
             coalesce(actor.username, 'System') as "actorName"
        from audit_events a
        left join accounts actor on actor.id = a.actor_account_id
       where a.company_id = ${row.companyId}::uuid
         and a.subject_type = 'trader_storefront' and a.subject_id = ${row.id}
       order by a.occurred_at desc, a.id desc
       limit 200
    `.execute(this.database);
    return { items: events.rows };
  }

  /**
   * Public resolution by slug.
   *
   * Deliberately NOT a tenant-scoped query: a public visitor has no session and
   * no Company. Safety comes from the status filter and from `publicView`,
   * which allow-lists the fields that leave this method — a Storefront that is
   * draft, unpublished or suspended is reported exactly as one that does not
   * exist, because a distinguishable response would confirm that a given slug
   * belongs to someone.
   */
  /**
   * Published Stores for the marketplace listing.
   *
   * A new endpoint rather than a duplicate: nothing existed that could answer
   * "which shops are open", and the alternative was a marketplace homepage that
   * invented Store cards to look populated.
   *
   * The projection is the SAME allow-list as `resolvePublic`, narrowed to what
   * a card needs. It is not a paged operational list: `publiclyResolvableStatuses`
   * is the only filter, so a draft, unpublished or suspended shop is absent
   * here exactly as it is absent from slug resolution, and no caller can
   * enumerate shops that are not meant to be public.
   */
  public async listPublic() {
    const result = await sql<StorefrontRow>`
      select ${storefrontColumns} from trader_storefronts s
       where s.status = any(${[...publiclyResolvableStatuses]}::text[])
       order by lower(s.display_name), s.id
       limit 96
    `.execute(this.database);
    return {
      items: result.rows.map((row) => {
        const view = publicStorefrontView(row);
        return {
          displayName: view.displayName,
          // Taken from the same view as every other Store projection. This was
          // hardcoded null while Commerce media did not exist yet, and stayed
          // null after it did -- so the marketplace listing was the one surface
          // that never showed a Trader's logo, while the Store page and the
          // Category listing both did.
          logoUrl: view.logoUrl,
          slug: view.slug,
          status: view.status,
          storeDescription: view.storeDescription,
        };
      }),
    };
  }

  public async resolvePublic(slug: string) {
    const normalised = normaliseStorefrontSlug(slug);
    if (rejectStorefrontSlug(normalised) !== null) throw this.storefrontNotFound();
    const result = await sql<StorefrontRow>`
      select ${storefrontColumns} from trader_storefronts s
       where lower(s.slug) = ${normalised}
         and s.status = any(${[...publiclyResolvableStatuses]}::text[])
    `.execute(this.database);
    const row = result.rows[0];
    // `canonicalSlug` is present on BOTH branches so callers read one shape;
    // it is undefined when the requested address is already the current one.
    if (row !== undefined) {
      return { ...publicStorefrontView(row), canonicalSlug: undefined as string | undefined };
    }

    // No live match. The address may be one this Storefront published under
    // before it renamed, and people still hold those links — so a retired slug
    // resolves to its owner's CURRENT address rather than to a dead end.
    //
    // The same status filter applies, so a retired slug belonging to a draft,
    // unpublished or suspended shop stays indistinguishable from one that never
    // existed. A redirect loop is not possible: the response only ever names a
    // slug that matched the LIVE query above, and that slug resolves directly.
    const historical = await sql<StorefrontRow>`
      select ${storefrontColumns} from trader_storefront_slugs h
        join trader_storefronts s on s.id = h.storefront_id
       where lower(h.slug) = ${normalised}
         and s.status = any(${[...publiclyResolvableStatuses]}::text[])
       order by h.released_at desc
       limit 1
    `.execute(this.database);
    const previous = historical.rows[0];
    if (previous === undefined) throw this.storefrontNotFound();
    if (previous.slug.toLowerCase() === normalised) throw this.storefrontNotFound();
    return { ...publicStorefrontView(previous), canonicalSlug: previous.slug };
  }

  // --------------------------------------------------------------- writes

  public async create(input: CreateStorefrontDto, correlationId: string) {
    this.assertManage();
    const { companyId } = this.tenants.current();
    const actorId = this.actorId();
    await this.assertTraderInScope(this.database, input.traderId);

    const normalised = normaliseStorefrontSlug(input.slug);
    this.assertSlugShape(normalised);

    return this.transactions.execute(async (transaction) => {
      const existing = await sql<{ id: string }>`
        select id from trader_storefronts
         where trader_id = ${input.traderId}::uuid
      `.execute(transaction);
      if (existing.rows.length > 0) {
        throw new ApplicationException(
          "storefront_already_exists",
          "This Trader already has a Storefront",
          HttpStatus.CONFLICT,
        );
      }
      // A RETIRED slug is still owned. The unique index on `trader_storefronts`
      // cannot see the history table, so the reservation has to be asserted
      // here, inside the write transaction, or a Storefront that renamed itself
      // would hand its old public address to whoever asked for it next — and
      // every link anyone still holds would land on a stranger's shop.
      await this.assertSlugFree(transaction, normalised, null);
      const traderCommerceId = await this.resolveCommerceIdentity(
        transaction,
        companyId,
        input.traderId,
        actorId,
      );
      const inserted = await this.claimSlug(async () =>
        sql<StorefrontRow>`
          insert into trader_storefronts (
            company_id, trader_id, trader_commerce_id, display_name, slug,
            business_template, theme,
            created_by_account_id, updated_by_account_id
          ) values (
            ${companyId}::uuid, ${input.traderId}::uuid, ${traderCommerceId}::uuid,
            ${input.displayName.trim()},
            ${normalised}, ${input.businessTemplate}, ${input.theme},
            ${actorId}::uuid, ${actorId}::uuid
          )
          returning ${returningColumns}
        `.execute(transaction),
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("Storefront insert returned no row");
      await this.audit(transaction, row, "storefront.created", correlationId, {
        businessTemplate: row.businessTemplate,
        displayName: row.displayName,
        slug: row.slug,
        theme: row.theme,
      });
      return managementStorefrontView(row);
    });
  }

  public async update(storefrontId: string, input: UpdateStorefrontDto, correlationId: string) {
    this.assertManage();
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const current = await this.loadOwned(transaction, storefrontId, true);
      this.assertVersion(current, input.expectedVersion);
      this.assertNotSuspendedForTrader(current);

      let nextSlug = current.slug;
      if (input.slug !== undefined) {
        const normalised = normaliseStorefrontSlug(input.slug);
        this.assertSlugShape(normalised);
        nextSlug = normalised;
      }
      const slugChanged = nextSlug !== current.slug;
      // Same reservation rule on rename: a Storefront may return to one of its
      // OWN retired addresses, but never take another's.
      if (slugChanged) await this.assertSlugFree(transaction, nextSlug, current.id);

      // A slug that was ever public stays reserved. Recorded BEFORE the update
      // so the reservation and the change land in one transaction: a crash
      // between them would otherwise free an address people still hold links to.
      if (slugChanged && current.publishedAt !== null) {
        await this.claimSlug(async () =>
          sql`
            insert into trader_storefront_slugs (
              storefront_id, company_id, slug, released_by_account_id
            ) values (
              ${current.id}::uuid, ${current.companyId}::uuid, ${current.slug}, ${actorId}::uuid
            )
          `.execute(transaction),
        );
      }

      const hours =
        input.businessHours === undefined ? null : JSON.stringify(input.businessHours ?? []);
      // A logo or cover id arrives in the request body. These prove the file is
      // a Commerce file owned by THIS Store's Commerce identity before it is
      // adopted as the Store's branding.
      await this.fileOwnership.assertCommerceFileOwned(
        transaction,
        current.traderCommerceId,
        input.logoFileId ?? null,
      );
      await this.fileOwnership.assertCommerceFileOwned(
        transaction,
        current.traderCommerceId,
        input.coverFileId ?? null,
      );
      const updated = await this.claimSlug(async () =>
        sql<StorefrontRow>`
          update trader_storefronts s set
            display_name = coalesce(${input.displayName?.trim() ?? null}, s.display_name),
            slug = ${nextSlug},
            business_template = coalesce(${input.businessTemplate ?? null}, s.business_template),
            theme = coalesce(${input.theme ?? null}, s.theme),
            logo_file_id = ${this.patch(input, "logoFileId", current.logoFileId)}::uuid,
            cover_file_id = ${this.patch(input, "coverFileId", current.coverFileId)}::uuid,
            brand_primary_color =
              ${this.patch(input, "brandPrimaryColor", current.brandPrimaryColor)},
            brand_accent_color =
              ${this.patch(input, "brandAccentColor", current.brandAccentColor)},
            store_description = ${this.patch(input, "storeDescription", current.storeDescription)},
            public_mobile = ${this.patch(input, "publicMobile", current.publicMobile)},
            public_whatsapp = ${this.patch(input, "publicWhatsapp", current.publicWhatsapp)},
            public_email = ${this.patch(input, "publicEmail", current.publicEmail)},
            business_hours = coalesce(${hours}::jsonb, s.business_hours),
            delivery_information =
              ${this.patch(input, "deliveryInformation", current.deliveryInformation)},
            return_policy = ${this.patch(input, "returnPolicy", current.returnPolicy)},
            terms = ${this.patch(input, "terms", current.terms)},
            customer_support = ${this.patch(input, "customerSupport", current.customerSupport)},
            seo_title_en = ${this.patch(input, "seoTitleEn", current.seoTitleEn)},
            seo_title_ar = ${this.patch(input, "seoTitleAr", current.seoTitleAr)},
            seo_description_en =
              ${this.patch(input, "seoDescriptionEn", current.seoDescriptionEn)},
            seo_description_ar =
              ${this.patch(input, "seoDescriptionAr", current.seoDescriptionAr)},
            seo_social_file_id =
              ${this.patch(input, "seoSocialFileId", current.seoSocialFileId)}::uuid,
            seo_indexable = ${input.seoIndexable ?? current.seoIndexable},
            updated_by_account_id = ${actorId}::uuid,
            updated_at = now(),
            version = s.version + 1
          where s.id = ${current.id}::uuid
          returning ${returningColumns}
        `.execute(transaction),
      );
      const row = updated.rows[0];
      if (row === undefined) throw this.storefrontNotFound();
      await this.audit(transaction, row, "storefront.updated", correlationId, {
        slugChanged,
        ...(slugChanged ? { newSlug: row.slug, previousSlug: current.slug } : {}),
      });
      return managementStorefrontView(row);
    });
  }

  public publish(storefrontId: string, input: StorefrontStatusActionDto, correlationId: string) {
    return this.changeStatus(storefrontId, "published", input, correlationId, {
      permission: "storefront.publish",
      requireComplete: true,
    });
  }

  public temporarilyClose(
    storefrontId: string,
    input: StorefrontStatusActionDto,
    correlationId: string,
  ) {
    return this.changeStatus(storefrontId, "temporarily_closed", input, correlationId, {
      permission: "storefront.publish",
    });
  }

  public reopen(storefrontId: string, input: StorefrontStatusActionDto, correlationId: string) {
    return this.changeStatus(storefrontId, "published", input, correlationId, {
      permission: "storefront.publish",
      requireComplete: true,
    });
  }

  public unpublish(storefrontId: string, input: StorefrontStatusActionDto, correlationId: string) {
    return this.changeStatus(storefrontId, "unpublished", input, correlationId, {
      permission: "storefront.publish",
    });
  }

  /**
   * Administrative suspension.
   *
   * Company-only and permission-gated. It is not routed through
   * `changeStatus`, because the transition table deliberately has no edge into
   * `suspended` from anywhere — the graph a Trader can steer must not contain
   * this state at all.
   */
  public async suspend(storefrontId: string, input: SuspendStorefrontDto, correlationId: string) {
    this.assertCompanyPermission("storefront.suspend");
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const current = await this.loadOwned(transaction, storefrontId, true);
      this.assertVersion(current, input.expectedVersion);
      if (current.status === "suspended") {
        throw new ApplicationException(
          "storefront_already_suspended",
          "This Storefront is already suspended",
          HttpStatus.CONFLICT,
        );
      }
      const updated = await sql<StorefrontRow>`
        update trader_storefronts s
           set status = 'suspended', suspended_at = now(),
               suspended_by_account_id = ${actorId}::uuid,
               suspension_reason = ${input.reason},
               updated_by_account_id = ${actorId}::uuid,
               updated_at = now(), version = s.version + 1
         where s.id = ${current.id}::uuid
        returning ${returningColumns}
      `.execute(transaction);
      const row = updated.rows[0];
      if (row === undefined) throw this.storefrontNotFound();
      await this.audit(transaction, row, "storefront.suspended", correlationId, {
        previousStatus: current.status,
        reason: input.reason,
      });
      return managementStorefrontView(row);
    });
  }

  /**
   * Lifting a suspension.
   *
   * Returns the Storefront to `unpublished` rather than to whatever it was:
   * coming back from an administrative suspension should be a deliberate
   * re-publication, not an automatic reappearance on the public web.
   */
  public async removeSuspension(
    storefrontId: string,
    input: StorefrontStatusActionDto,
    correlationId: string,
  ) {
    this.assertCompanyPermission("storefront.suspend");
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const current = await this.loadOwned(transaction, storefrontId, true);
      this.assertVersion(current, input.expectedVersion);
      if (current.status !== "suspended") {
        throw new ApplicationException(
          "storefront_not_suspended",
          "This Storefront is not suspended",
          HttpStatus.CONFLICT,
        );
      }
      const updated = await sql<StorefrontRow>`
        update trader_storefronts s
           set status = 'unpublished', suspended_at = null,
               suspended_by_account_id = null, suspension_reason = null,
               updated_by_account_id = ${actorId}::uuid,
               updated_at = now(), version = s.version + 1
         where s.id = ${current.id}::uuid
        returning ${returningColumns}
      `.execute(transaction);
      const row = updated.rows[0];
      if (row === undefined) throw this.storefrontNotFound();
      await this.audit(transaction, row, "storefront.suspension_removed", correlationId, {
        reason: input.reason ?? null,
      });
      return managementStorefrontView(row);
    });
  }

  // ------------------------------------------------------------- internals

  private async changeStatus(
    storefrontId: string,
    target: StorefrontStatus,
    input: StorefrontStatusActionDto,
    correlationId: string,
    options: { readonly permission: string; readonly requireComplete?: boolean },
  ) {
    this.assertPublicationAuthority(options.permission);
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const current = await this.loadOwned(transaction, storefrontId, true);
      this.assertVersion(current, input.expectedVersion);
      const from = current.status as StorefrontStatus;
      if (from === "suspended") {
        throw new ApplicationException(
          "storefront_suspended",
          "A suspended Storefront cannot change status",
          HttpStatus.CONFLICT,
        );
      }
      if (!canTransitionStorefront(from, target)) {
        throw new ApplicationException(
          "storefront_transition_invalid",
          `A Storefront cannot move from ${from} to ${target}`,
          HttpStatus.CONFLICT,
        );
      }
      if (options.requireComplete === true) this.assertPublishable(current);

      const updated = await sql<StorefrontRow>`
        update trader_storefronts s
           set status = ${target},
               published_at = case when ${target} = 'published' and s.published_at is null
                                   then now() else s.published_at end,
               updated_by_account_id = ${actorId}::uuid,
               updated_at = now(), version = s.version + 1
         where s.id = ${current.id}::uuid
        returning ${returningColumns}
      `.execute(transaction);
      const row = updated.rows[0];
      if (row === undefined) throw this.storefrontNotFound();
      await this.audit(transaction, row, `storefront.${target}`, correlationId, {
        previousStatus: from,
        reason: input.reason ?? null,
      });
      return managementStorefrontView(row);
    });
  }

  /** Mandatory profile completeness, checked before a Storefront goes public. */
  private assertPublishable(row: StorefrontRow): void {
    const values: Record<string, unknown> = {
      businessTemplate: row.businessTemplate,
      deliveryInformation: row.deliveryInformation,
      displayName: row.displayName,
      publicMobile: row.publicMobile,
      returnPolicy: row.returnPolicy,
      slug: row.slug,
      storeDescription: row.storeDescription,
      theme: row.theme,
    };
    const missing = requiredForPublication.filter((field) => {
      const value = values[field];
      return value === null || value === undefined || String(value).trim() === "";
    });
    if (missing.length > 0) {
      throw new ApplicationException(
        "storefront_incomplete_for_publication",
        `Complete these fields before publishing: ${missing.join(", ")}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        missing,
      );
    }
  }

  private assertSlugShape(normalised: string): void {
    const rejection = rejectStorefrontSlug(normalised);
    if (rejection !== null) {
      throw new ApplicationException(
        rejection,
        "That Storefront URL cannot be used",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private async slugTaken(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    slug: string,
    exceptStorefrontId: string | null,
  ): Promise<boolean> {
    const result = await sql<{ taken: boolean }>`
      select exists (
        select 1 from trader_storefronts
         where lower(slug) = ${slug}
           and (${exceptStorefrontId}::uuid is null or id <> ${exceptStorefrontId}::uuid)
        union all
        select 1 from trader_storefront_slugs
         where lower(slug) = ${slug}
           and (${exceptStorefrontId}::uuid is null or storefront_id <> ${exceptStorefrontId}::uuid)
      ) as taken
    `.execute(executor);
    return result.rows[0]?.taken === true;
  }

  /**
   * Refuses a slug that any live OR retired Storefront already holds.
   *
   * The live namespace is guarded by a unique index, which is authoritative and
   * settles races on its own. The RETIRED namespace lives in a second table, so
   * no single index spans both and this check is what enforces it. It runs
   * inside the write transaction against the same rows the write will touch,
   * which leaves one narrow window: a rename that retires a slug committing in
   * the instant between this read and another caller's insert. The consequence
   * is bounded — the loser of that race keeps a slug someone else just
   * released — and closing it properly means making the history table the
   * registry of every slug ever claimed, live ones included, so one index
   * governs both. That is a schema change and is recorded as a follow-up.
   */
  private async assertSlugFree(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    slug: string,
    exceptStorefrontId: string | null,
  ): Promise<void> {
    if (await this.slugTaken(executor, slug, exceptStorefrontId)) {
      throw new ApplicationException(
        "storefront_slug_taken",
        "That Storefront URL is no longer available",
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Runs a slug-claiming write and turns a lost race into a field error.
   *
   * The unique index is what actually decides who gets a slug. Translating its
   * violation here means the loser is told "this URL is no longer available"
   * instead of receiving a 500 — and the constraint name never reaches them.
   */
  private async claimSlug<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const code = (error as { code?: string }).code;
      const constraint = String((error as { constraint?: string }).constraint ?? "");
      if (code === "23505" && constraint.includes("slug")) {
        throw new ApplicationException(
          "storefront_slug_taken",
          "That Storefront URL is no longer available",
          HttpStatus.CONFLICT,
        );
      }
      if (code === "23505" && constraint.includes("trader_unique")) {
        throw new ApplicationException(
          "storefront_already_exists",
          "This Trader already has a Storefront",
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  private async loadOwned(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    storefrontId: string,
    lock = false,
  ): Promise<StorefrontRow> {
    const result = await sql<StorefrontRow>`
      select ${storefrontColumns} from trader_storefronts s
       where s.id = ${storefrontId}::uuid
         and s.id in (${this.accessibleStorefronts()})
       ${lock ? sql`for update` : sql``}
    `.execute(executor);
    const row = result.rows[0];
    // An id the actor may not reach is reported as missing, never as forbidden:
    // a 403 would confirm the Storefront exists.
    if (row === undefined) throw this.storefrontNotFound();
    return row;
  }

  private async assertTraderInScope(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    traderId: string,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const callerTrader = this.callerTraderId();
    if (callerTrader !== null && callerTrader !== traderId) throw this.storefrontNotFound();
    const result = await sql<{ id: string }>`
      select id from traders
       where id = ${traderId}::uuid and company_id = ${companyId}::uuid
    `.execute(executor);
    if (result.rows[0] === undefined) throw this.storefrontNotFound();
  }

  /**
   * The Trader Commerce identity that will own this Storefront.
   *
   * Resolved from the Company Trader, never from the request. A caller that
   * could name the Commerce identity could attach its Storefront to somebody
   * else's shop, so the only input here is a Trader that `assertTraderInScope`
   * has already proven belongs to the caller's Company.
   *
   * Creating the identity on demand mirrors the backfill rule exactly — one
   * identity per existing Company Trader — so a Trader registered after the
   * migration is indistinguishable from one migrated by it. The `unique
   * (trader_id)` on the link table means two concurrent first-Storefront
   * creations cannot mint two identities for one Trader; the loser's insert
   * fails and its transaction rolls back rather than producing a duplicate.
   */
  private async resolveCommerceIdentity(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    traderId: string,
    actorId: string | null,
  ): Promise<string> {
    const existing = await sql<{ traderCommerceId: string }>`
      select trader_commerce_id as "traderCommerceId"
        from trader_commerce_company_links
       where trader_id = ${traderId}::uuid
    `.execute(executor);
    const linked = existing.rows[0];
    if (linked !== undefined) return linked.traderCommerceId;

    const created = await sql<{ id: string }>`
      with source as (
        select
          gen_random_uuid() as commerce_id,
          trader.id as trader_id,
          trader.company_id as company_id,
          trader.name_en as public_name,
          nullif(btrim(coalesce(trader.contact_person, '')), '') as contact_name,
          nullif(btrim(coalesce(trader.mobile_number, '')), '') as mobile_number,
          nullif(btrim(coalesce(trader.telephone, '')), '') as telephone,
          nullif(btrim(coalesce(trader.email, '')), '') as email,
          nullif(btrim(coalesce(trader.address_en, '')), '') as address
        from traders trader
        where trader.id = ${traderId}::uuid and trader.company_id = ${companyId}::uuid
      ),
      created_profile as (
        insert into trader_commerce_profiles (
          id, public_name, contact_name, mobile_number, telephone, email, address,
          registration_source, approval_status, is_active, created_by_account_id,
          updated_by_account_id
        )
        select
          source.commerce_id, source.public_name, source.contact_name,
          source.mobile_number, source.telephone, source.email, source.address,
          'delivery_company_registered', 'approved', true, ${actorId}::uuid, ${actorId}::uuid
        from source
        returning id
      ),
      created_relationship as (
        insert into trader_delivery_company_relationships (
          trader_commerce_id, company_id, trader_id, relationship_source, status,
          enabled_for_store_orders, is_default_for_store_orders, created_by_account_id
        )
        select source.commerce_id, source.company_id, source.trader_id,
               'delivery_company_registered', 'active', true, true, ${actorId}::uuid
        from source
        returning id
      )
      insert into trader_commerce_company_links (
        trader_commerce_id, company_id, trader_id, link_source, status,
        created_by_account_id
      )
      select source.commerce_id, source.company_id, source.trader_id,
             'delivery_company_registered', 'active', ${actorId}::uuid
      from source
      returning trader_commerce_id as id
    `.execute(executor);
    const row = created.rows[0];
    if (row === undefined) throw this.storefrontNotFound();
    return row.id;
  }

  private assertVersion(row: StorefrontRow, expected: number): void {
    if (Number(row.version) !== expected) {
      throw new ApplicationException(
        "storefront_version_conflict",
        "This Storefront changed since it was loaded",
        HttpStatus.CONFLICT,
      );
    }
  }

  private assertNotSuspendedForTrader(row: StorefrontRow): void {
    if (row.status !== "suspended") return;
    if (this.callerTraderId() === null) return;
    // A Trader may not edit around an administrative suspension.
    throw new ApplicationException(
      "storefront_suspended",
      "This Storefront is suspended",
      HttpStatus.CONFLICT,
    );
  }

  /**
   * `null` for a Company user; the Trader's own id for a Trader identity.
   *
   * Every owned read and write narrows on this, so a Trader session can only
   * ever reach its own Storefront regardless of the id it supplies.
   */
  private callerTraderId(): string | null {
    const identity = this.identities.current();
    if (identity.kind !== "trader") return null;
    const traderId = identity.profileId ?? identity.profileLinkId;
    if (traderId === undefined) {
      throw new ApplicationException(
        "storefront_trader_context_required",
        "This Trader account is not linked to a Trader record",
        HttpStatus.FORBIDDEN,
      );
    }
    return traderId;
  }

  /**
   * The Storefronts this actor may reach, as a subquery.
   *
   * There is no caller-supplied variant of this, because a scope taken from a
   * request is not a scope. See `storefront-access.ts` for the two rules.
   */
  private accessibleStorefronts() {
    return accessibleStorefrontIds({
      callerTraderId: this.callerTraderId(),
      companyId: this.tenants.current().companyId,
    });
  }

  private assertRead(): void {
    if (this.callerTraderId() !== null) return;
    this.assertCompanyPermission("storefront.view", "storefront.manage");
  }

  private assertManage(): void {
    if (this.callerTraderId() !== null) return;
    this.assertCompanyPermission("storefront.manage");
  }

  /** Publication is permitted to a Trader for its own shop, or to a permitted user. */
  private assertPublicationAuthority(permission: string): void {
    if (this.callerTraderId() !== null) return;
    this.assertCompanyPermission(permission);
  }

  private assertCompanyPermission(...permissions: readonly string[]): void {
    const identity = this.identities.current();
    const held = identity.permissions;
    if (permissions.some((permission) => held.has(permission))) return;
    // The same administrator escalation `AccountingOperationSupport` applies.
    // Without it a Company administrator can reach every other module but not
    // Storefronts, which is an inconsistency rather than a security boundary.
    if (held.has("users_roles.manage")) return;
    throw new ApplicationException(
      "storefront_permission_denied",
      "This account cannot perform that Storefront operation",
      HttpStatus.FORBIDDEN,
    );
  }

  private actorId(): string {
    return this.tenants.current().identityId;
  }

  private storefrontNotFound(): ApplicationException {
    return new ApplicationException(
      "storefront_not_found",
      "The Storefront was not found",
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Distinguishes "field absent" from "field explicitly cleared".
   *
   * `undefined` means the caller did not mention the field, so the stored value
   * survives; an explicit `null` clears it. Without this an unrelated PATCH
   * would blank every optional field on the profile.
   */
  private patch<K extends keyof UpdateStorefrontDto>(
    input: UpdateStorefrontDto,
    key: K,
    current: unknown,
  ): unknown {
    const value = input[key];
    if (value === undefined) return current;
    return value;
  }

  private async audit(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    row: StorefrontRow,
    action: string,
    correlationId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.auditWriter.audit(executor as Kysely<DatabaseSchema>, {
      action,
      actorId: this.actorId(),
      after: { ...after, status: row.status, storefrontId: row.id, traderId: row.traderId },
      // The Company the ACTION happened in, not the Store's owner — operational
      // history is Company-scoped and the Store may have no Company at all.
      companyId: row.companyId ?? this.tenants.current().companyId,
      correlationId,
      subjectId: row.id,
      subjectType: "trader_storefront",
    });
  }
}

/**
 * Full configuration for an authorised, authenticated caller.
 */
export function managementStorefrontView(row: StorefrontRow) {

    return {
      brandAccentColor: row.brandAccentColor,
      brandPrimaryColor: row.brandPrimaryColor,
      businessHours: Array.isArray(row.businessHours) ? row.businessHours : [],
      businessTemplate: row.businessTemplate,
      // A URL, not an id: the public contract should hand a browser something
      // it can load, and `/files/{id}` (the previous shape) was never a route.
      coverUrl: commerceMediaUrl(row.coverFileId),
      createdAt: row.createdAt,
      customerSupport: row.customerSupport,
      deliveryInformation: row.deliveryInformation,
      displayName: row.displayName,
      id: row.id,
      logoUrl: commerceMediaUrl(row.logoFileId),
      publicEmail: row.publicEmail,
      publicMobile: row.publicMobile,
      publicUrl: `/store/${row.slug}`,
      publicWhatsapp: row.publicWhatsapp,
      publishedAt: row.publishedAt,
      returnPolicy: row.returnPolicy,
      // The management view carries the raw overrides, not the derived result:
      // the editing screen must show the Trader what they actually set, and an
      // empty field has to read as "not set" rather than echoing back the
      // fallback as though it were their own text.
      seoDescriptionAr: row.seoDescriptionAr,
      seoDescriptionEn: row.seoDescriptionEn,
      seoIndexable: row.seoIndexable,
      seoSocialUrl: commerceMediaUrl(row.seoSocialFileId),
      seoTitleAr: row.seoTitleAr,
      seoTitleEn: row.seoTitleEn,
      slug: row.slug,
      status: row.status,
      storeDescription: row.storeDescription,
      suspendedAt: row.suspendedAt,
      suspensionReason: row.suspensionReason,
      terms: row.terms,
      theme: row.theme,
      traderId: row.traderId,
      updatedAt: row.updatedAt,
      version: Number(row.version),
    };
}

/**
 * The public projection — an ALLOW-LIST, not an omission list.
 *
 * Written as an explicit object literal so a column added to the table later
 * does not silently become public. `companyId`, `traderId`, the actor columns,
 * `version`, the suspension detail and every internal timestamp are absent by
 * construction rather than by remembering to strip them. Exported so the
 * allow-list can be asserted directly, without a database.
 */
export function publicStorefrontView(row: StorefrontRow) {

    return {
      brandAccentColor: row.brandAccentColor,
      brandPrimaryColor: row.brandPrimaryColor,
      businessHours: Array.isArray(row.businessHours) ? row.businessHours : [],
      businessTemplate: row.businessTemplate,
      // A URL, not an id: the public contract should hand a browser something
      // it can load, and `/files/{id}` (the previous shape) was never a route.
      coverUrl: commerceMediaUrl(row.coverFileId),
      customerSupport: row.customerSupport,
      deliveryInformation: row.deliveryInformation,
      displayName: row.displayName,
      logoUrl: commerceMediaUrl(row.logoFileId),
      publicEmail: row.publicEmail,
      publicMobile: row.publicMobile,
      publicWhatsapp: row.publicWhatsapp,
      returnPolicy: row.returnPolicy,
      // SEO overrides only. The metadata layer derives everything else from
      // fields already present above, so an unset override is not a gap.
      seoDescriptionAr: row.seoDescriptionAr,
      seoDescriptionEn: row.seoDescriptionEn,
      seoIndexable: row.seoIndexable,
      seoTitleAr: row.seoTitleAr,
      seoTitleEn: row.seoTitleEn,
      slug: row.slug,
      socialImageUrl: commerceMediaUrl(row.seoSocialFileId ?? row.coverFileId ?? row.logoFileId),
      // Public callers learn only whether the shop is open or closed. The
      // internal vocabulary (draft/unpublished/suspended) never leaves here.
      status: row.status === "temporarily_closed" ? "temporarily_closed" : "published",
      storeDescription: row.storeDescription,
      terms: row.terms,
      theme: row.theme,
    };
}
