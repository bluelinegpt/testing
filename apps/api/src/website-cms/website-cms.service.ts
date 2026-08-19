import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";

import { FileStoragePort } from "../files/file-storage.port.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  MediaAltDto,
  NavigationItemDto,
  PricingPlanDto,
  WebsiteContactSettingsDto,
  WebsiteFaqDto,
  WebsiteFeatureDto,
  WebsitePageContentDto,
} from "./website-cms.dto.js";

type UploadedFile = {
  readonly buffer: Buffer;
  readonly mimetype: string;
  readonly originalname: string;
  readonly size: number;
};

const allowedRoutes = new Set([
  "/",
  "/delivery-companies",
  "/send-a-package",
  "/traders",
  "/traders/register",
  "/integrations",
  "/resources",
  "/pricing",
  "/blog",
  "/about",
  "/contact",
  "/request-demo",
]);

function cleanText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.replace(/[<>]/g, "").replace(/[\u0000-\u001F]/g, "").trim();
}

function requireSafePath(path: string): string {
  const cleaned = cleanText(path) ?? "";
  if (!allowedRoutes.has(cleaned) && !cleaned.startsWith("/blog/category/") && !cleaned.startsWith("/blog/")) {
    throw new BadRequestException("Destination must be an approved public route.");
  }
  return cleaned;
}

function pagePayload(input: WebsitePageContentDto) {
  return {
    hero: {
      eyebrow: cleanText(input.heroEyebrow),
      heading: cleanText(input.heroHeading),
      subheading: cleanText(input.heroSubheading),
      primaryCtaLabel: cleanText(input.primaryCtaLabel),
      primaryCtaUrl: requireSafePath(input.primaryCtaUrl),
      secondaryCtaLabel: cleanText(input.secondaryCtaLabel),
      secondaryCtaUrl: input.secondaryCtaUrl ? requireSafePath(input.secondaryCtaUrl) : null,
    },
    pricingPreview: {
      heading: cleanText(input.pricingHeading),
      description: cleanText(input.pricingDescription),
    },
    requestDemoCta: {
      heading: cleanText(input.ctaHeading),
      text: cleanText(input.ctaText),
      buttonLabel: cleanText(input.ctaButtonLabel),
    },
    seo: {
      title: cleanText(input.seoTitle),
      description: cleanText(input.seoDescription),
      canonical: input.canonicalPath ? requireSafePath(input.canonicalPath) : `/${input.pageKey === "home" ? "" : input.pageKey}`,
      robotsIndex: input.robotsIndex,
      robotsFollow: input.robotsFollow,
      ogImage: input.ogImage ?? null,
    },
  };
}

function planPayload(input: PricingPlanDto) {
  const maxOrders = input.maxOrders ?? null;
  if (maxOrders !== null && maxOrders < input.minOrders) throw new BadRequestException("Plan max orders cannot be lower than min orders.");
  return {
    name: cleanText(input.name),
    price: input.price,
    currency: input.currency.toUpperCase(),
    period: cleanText(input.period),
    minOrders: input.minOrders,
    maxOrders,
    volume: cleanText(input.volume),
    description: cleanText(input.description),
    highlights: input.highlights.map((item) => cleanText(item)).filter(Boolean),
    ctaLabel: cleanText(input.ctaLabel),
    ctaUrl: requireSafePath(input.ctaUrl),
    recommended: input.recommended,
  };
}

function isImage(bytes: Uint8Array, declared: string): { ok: true; mediaType: string; ext: string } | { ok: false; reason: string } {
  if (bytes.length === 0) return { ok: false, reason: "empty_file" };
  if (bytes.length > 5 * 1024 * 1024) return { ok: false, reason: "file_too_large" };
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024))).toString("latin1").toLowerCase();
  if (prefix.includes("<script") || prefix.includes("<svg") || prefix.includes("<html") || prefix.includes("<?xml")) return { ok: false, reason: "markup_or_script_rejected" };
  const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length > 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  const detected = png ? { mediaType: "image/png", ext: "png" } : jpg ? { mediaType: "image/jpeg", ext: "jpg" } : webp ? { mediaType: "image/webp", ext: "webp" } : null;
  if (!detected) return { ok: false, reason: "unsupported_image_signature" };
  const normalized = declared.toLowerCase();
  if (normalized && normalized !== detected.mediaType && !(detected.mediaType === "image/jpeg" && normalized === "image/jpg")) return { ok: false, reason: "declared_media_type_mismatch" };
  return { ok: true, ...detected };
}

@Injectable()
export class WebsiteCmsService {
  public constructor(
    @Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>,
    @Inject(FileStoragePort) private readonly storage: FileStoragePort,
  ) {}

  public async publicBundle(locale = "en") {
    const safeLocale = locale === "ar" ? "ar" : "en";
    const [pages, pricing, features, faqs, navigation, contact] = await Promise.all([
      sql<any>`select page_key as "pageKey", locale, visible, published_content as content from platform_website_pages where status='published' and published_content is not null and locale in (${safeLocale}, 'en') order by case when locale=${safeLocale} then 0 else 1 end`.execute(this.db),
      sql<any>`select plan_key as "planKey", locale, published_data as data, active, sort_order as "sortOrder" from platform_website_pricing_plans where status='published' and active and published_data is not null and locale in (${safeLocale}, 'en') order by sort_order`.execute(this.db),
      sql<any>`select slug, locale, published_data as data, audience, category, feature_status as "featureStatus", visible, sort_order as "sortOrder" from platform_website_features where status='published' and visible and published_data is not null and locale in (${safeLocale}, 'en') order by sort_order`.execute(this.db),
      sql<any>`select faq_key as "faqKey", locale, published_data as data, audience, category, visible, sort_order as "sortOrder" from platform_website_faqs where status='published' and visible and published_data is not null and locale in (${safeLocale}, 'en') order by sort_order`.execute(this.db),
      sql<any>`select item_key as "itemKey", locale, label, destination, visible, sort_order as "sortOrder" from platform_website_navigation_items where visible and locale in (${safeLocale}, 'en') order by sort_order`.execute(this.db),
      sql<any>`select published_data as data from platform_website_contact_settings where id=true`.execute(this.db),
    ]);
    const prefer = (rows: any[], key: string) => Object.values(rows.reduce((acc, row) => {
      acc[row[key]] = acc[row[key]] && acc[row[key]].locale === safeLocale ? acc[row[key]] : row;
      return acc;
    }, {} as Record<string, any>));
    return {
      locale: safeLocale,
      direction: safeLocale === "ar" ? "rtl" : "ltr",
      pages: prefer(pages.rows, "pageKey"),
      pricing: prefer(pricing.rows, "planKey"),
      features: prefer(features.rows, "slug"),
      faqs: prefer(faqs.rows, "faqKey"),
      navigation: prefer(navigation.rows, "itemKey"),
      contact: contact.rows[0]?.data ?? { publicPhone: "+971 50 689 8604", whatsapp: "+971 50 689 8604" },
    };
  }

  public async sitemapEntries() {
    const pages = (await sql<{ page_key: string; updated_at: Date }>`
      select page_key, greatest(updated_at, coalesce(published_at, updated_at)) as updated_at
      from platform_website_pages
      where visible = true and status = 'published' and locale = 'en'
    `.execute(this.db)).rows;
    const navigation = (await sql<{ destination: string; updated_at: Date }>`
      select destination, updated_at
      from platform_website_navigation_items
      where visible = true and locale = 'en'
    `.execute(this.db)).rows;
    const blog = (await sql<{ path: string; updated_at: Date }>`
      select '/blog/' || slug as path, coalesce(updated_content_at, updated_at) as updated_at
      from platform_blog_articles
      where language = 'en'
        and ((status = 'published' and published_at <= now()) or (status = 'scheduled' and scheduled_at <= now()))
    `.execute(this.db)).rows;
    const pagePaths = pages.map((row) => ({
      path: row.page_key === "home" ? "/" : `/${row.page_key}`,
      lastmod: row.updated_at,
    }));
    const navigationPaths = navigation.map((row) => ({ path: row.destination, lastmod: row.updated_at }));
    const blogPaths = blog.map((row) => ({ path: row.path, lastmod: row.updated_at }));
    return [...new Map([...pagePaths, ...navigationPaths, ...blogPaths].map((entry) => [entry.path, entry])).values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  public async overview() {
    const row = (await sql<any>`
      select
        (select count(*)::int from platform_website_pages where status='draft') as "draftPages",
        (select count(*)::int from platform_website_pages where status='published') as "publishedPages",
        (select count(*)::int from platform_blog_articles where status='draft') as "draftBlogPosts",
        (select count(*)::int from platform_blog_articles where status='scheduled') as "scheduledPosts",
        (select count(*)::int from platform_blog_articles where status='published') as "publishedPosts",
        (select max(created_at) from platform_website_revisions) as "lastPublished"
    `.execute(this.db)).rows[0];
    return row;
  }

  public async adminBundle() {
    const [overview, pages, pricing, features, faqs, media, navigation, contact, revisions] = await Promise.all([
      this.overview(),
      sql<any>`select * from platform_website_pages order by page_key, locale`.execute(this.db),
      sql<any>`select * from platform_website_pricing_plans order by sort_order, plan_key, locale`.execute(this.db),
      sql<any>`select * from platform_website_features order by sort_order, slug, locale`.execute(this.db),
      sql<any>`select * from platform_website_faqs order by sort_order, faq_key, locale`.execute(this.db),
      sql<any>`select id, public_url as "publicUrl", original_filename as "originalFilename", media_type as "mediaType", size_bytes as "sizeBytes", alt_text as "altText", caption, created_at as "createdAt" from platform_website_media where deleted_at is null order by created_at desc limit 50`.execute(this.db),
      sql<any>`select * from platform_website_navigation_items order by sort_order, item_key, locale`.execute(this.db),
      sql<any>`select * from platform_website_contact_settings where id=true`.execute(this.db),
      sql<any>`select entity_type as "entityType", entity_key as "entityKey", locale, event_type as "eventType", created_at as "createdAt" from platform_website_revisions order by created_at desc limit 30`.execute(this.db),
    ]);
    return { overview, pages: pages.rows, pricing: pricing.rows, features: features.rows, faqs: faqs.rows, media: media.rows, navigation: navigation.rows, contact: contact.rows[0], revisions: revisions.rows };
  }

  private async revision(actor: string, entityType: string, entityKey: string, locale: string | null, eventType: string, snapshot: object) {
    await sql`insert into platform_website_revisions(entity_type,entity_key,locale,event_type,actor_account_id,snapshot) values(${entityType},${entityKey},${locale},${eventType},${actor}::uuid,${JSON.stringify(snapshot)}::jsonb)`.execute(this.db);
  }

  public async savePageDraft(input: WebsitePageContentDto, actor: string) {
    const payload = pagePayload(input);
    const row = (await sql<any>`insert into platform_website_pages(page_key,locale,draft_content,visible,status,created_by_account_id,updated_by_account_id) values(${input.pageKey},${input.locale},${JSON.stringify(payload)}::jsonb,${input.visible},'draft',${actor}::uuid,${actor}::uuid) on conflict(page_key,locale) do update set draft_content=excluded.draft_content,visible=excluded.visible,status=case when platform_website_pages.status='archived' then 'draft' else platform_website_pages.status end,updated_by_account_id=excluded.updated_by_account_id,updated_at=now() returning *`.execute(this.db)).rows[0];
    await this.revision(actor, "page", input.pageKey, input.locale, "draft_saved", payload);
    return row;
  }

  public async publishPage(pageKey: string, locale: string, actor: string) {
    const row = (await sql<any>`update platform_website_pages set published_content=draft_content,status='published',published_by_account_id=${actor}::uuid,published_at=now(),updated_at=now() where page_key=${pageKey} and locale=${locale} returning *`.execute(this.db)).rows[0];
    if (!row) throw new NotFoundException("website_page_not_found");
    await this.revision(actor, "page", pageKey, locale, "published", row.published_content);
    return row;
  }

  public async savePricingDraft(input: PricingPlanDto, actor: string) {
    const payload = planPayload(input);
    const row = (await sql<any>`insert into platform_website_pricing_plans(plan_key,locale,draft_data,active,status,sort_order,created_by_account_id,updated_by_account_id) values(${input.planKey},${input.locale},${JSON.stringify(payload)}::jsonb,${input.active},'draft',${input.sortOrder},${actor}::uuid,${actor}::uuid) on conflict(plan_key,locale) do update set draft_data=excluded.draft_data,active=excluded.active,sort_order=excluded.sort_order,status=case when platform_website_pricing_plans.status='archived' then 'draft' else platform_website_pricing_plans.status end,updated_by_account_id=excluded.updated_by_account_id,updated_at=now() returning *`.execute(this.db)).rows[0];
    await this.revision(actor, "pricing", input.planKey, input.locale, "draft_saved", payload);
    return row;
  }

  public async publishPricing(planKey: string, locale: string, actor: string) {
    const row = await this.db.transaction().execute(async (trx) => {
      const published = (await sql<any>`update platform_website_pricing_plans set published_data=draft_data,status='published',published_by_account_id=${actor}::uuid,published_at=now(),updated_at=now() where plan_key=${planKey} and locale=${locale} returning *`.execute(trx)).rows[0];
      if (!published) throw new NotFoundException("pricing_plan_not_found");
      const active = (await sql<any>`select plan_key,published_data as data,active from platform_website_pricing_plans where locale=${locale} and status='published' and active and published_data is not null order by sort_order`.execute(trx)).rows;
      this.validatePricingRanges(active.map((item) => ({ key: item.plan_key, ...(item.data as Record<string, unknown>) })));
      await sql`insert into platform_website_revisions(entity_type,entity_key,locale,event_type,actor_account_id,snapshot) values('pricing',${planKey},${locale},'published',${actor}::uuid,${JSON.stringify(published.published_data)}::jsonb)`.execute(trx);
      return published;
    });
    return row;
  }

  private validatePricingRanges(plans: Array<Record<string, unknown>>) {
    const names = new Set<string>();
    const ranges = plans.map((plan) => {
      const name = String(plan.name ?? "").toLowerCase();
      if (names.has(name)) throw new ConflictException("Duplicate active published pricing plan name.");
      names.add(name);
      const price = Number(plan.price);
      const min = Number(plan.minOrders);
      const max = plan.maxOrders === null || plan.maxOrders === undefined ? Number.POSITIVE_INFINITY : Number(plan.maxOrders);
      if (Number.isNaN(price) || price < 0 || Number.isNaN(min) || min < 0 || Number.isNaN(max) || max < min) throw new BadRequestException("Invalid pricing range or price.");
      return { name, min, max };
    }).sort((a, b) => a.min - b.min);
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i]!.min <= ranges[i - 1]!.max) throw new BadRequestException("Pricing ranges overlap.");
    }
  }

  public async saveFeature(input: WebsiteFeatureDto, actor: string) {
    const data = { name: cleanText(input.name), shortDescription: cleanText(input.shortDescription), fullDescription: cleanText(input.fullDescription) };
    const row = (await sql<any>`insert into platform_website_features(slug,locale,draft_data,audience,category,feature_status,visible,sort_order,status,created_by_account_id,updated_by_account_id) values(${input.slug},${input.locale},${JSON.stringify(data)}::jsonb,${input.audience},${cleanText(input.category)},${input.featureStatus},${input.visible},${input.sortOrder},'draft',${actor}::uuid,${actor}::uuid) on conflict(slug,locale) do update set draft_data=excluded.draft_data,audience=excluded.audience,category=excluded.category,feature_status=excluded.feature_status,visible=excluded.visible,sort_order=excluded.sort_order,updated_by_account_id=excluded.updated_by_account_id,updated_at=now() returning *`.execute(this.db)).rows[0];
    await this.revision(actor, "feature", input.slug, input.locale, "draft_saved", data);
    return row;
  }

  public async publishFeature(slug: string, locale: string, actor: string) {
    const row = (await sql<any>`update platform_website_features set published_data=draft_data,status='published',published_by_account_id=${actor}::uuid,published_at=now(),updated_at=now() where slug=${slug} and locale=${locale} returning *`.execute(this.db)).rows[0];
    if (!row) throw new NotFoundException("feature_not_found");
    await this.revision(actor, "feature", slug, locale, "published", row.published_data);
    return row;
  }

  public async saveFaq(input: WebsiteFaqDto, actor: string) {
    const data = { question: cleanText(input.question), answer: cleanText(input.answer) };
    const row = (await sql<any>`insert into platform_website_faqs(faq_key,locale,draft_data,audience,category,visible,sort_order,status,available_to_agent,created_by_account_id,updated_by_account_id) values(${input.faqKey},${input.locale},${JSON.stringify(data)}::jsonb,${input.audience},${cleanText(input.category)},${input.visible},${input.sortOrder},'draft',${input.availableToAgent},${actor}::uuid,${actor}::uuid) on conflict(faq_key,locale) do update set draft_data=excluded.draft_data,audience=excluded.audience,category=excluded.category,visible=excluded.visible,sort_order=excluded.sort_order,available_to_agent=excluded.available_to_agent,updated_by_account_id=excluded.updated_by_account_id,updated_at=now() returning *`.execute(this.db)).rows[0];
    await this.revision(actor, "faq", input.faqKey, input.locale, "draft_saved", data);
    return row;
  }

  public async publishFaq(faqKey: string, locale: string, actor: string) {
    const row = (await sql<any>`update platform_website_faqs set published_data=draft_data,status='published',published_by_account_id=${actor}::uuid,published_at=now(),updated_at=now() where faq_key=${faqKey} and locale=${locale} returning *`.execute(this.db)).rows[0];
    if (!row) throw new NotFoundException("faq_not_found");
    await this.revision(actor, "faq", faqKey, locale, "published", row.published_data);
    return row;
  }

  public async saveContactDraft(input: WebsiteContactSettingsDto, actor: string) {
    const data = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? cleanText(value) : value]));
    const row = (await sql<any>`update platform_website_contact_settings set draft_data=${JSON.stringify(data)}::jsonb,status='draft',updated_by_account_id=${actor}::uuid,updated_at=now() where id=true returning *`.execute(this.db)).rows[0];
    await this.revision(actor, "contact", "public", null, "draft_saved", data);
    return row;
  }

  public async publishContact(actor: string) {
    const row = (await sql<any>`update platform_website_contact_settings set published_data=draft_data,status='published',published_by_account_id=${actor}::uuid,published_at=now(),updated_at=now() where id=true returning *`.execute(this.db)).rows[0];
    await this.revision(actor, "contact", "public", null, "published", row.published_data);
    return row;
  }

  public async saveNavigation(input: NavigationItemDto, actor: string) {
    requireSafePath(input.destination);
    const row = (await sql<any>`insert into platform_website_navigation_items(item_key,locale,label,destination,visible,sort_order,updated_by_account_id) values(${input.itemKey},${input.locale},${cleanText(input.label)},${input.destination},${input.visible},${input.sortOrder},${actor}::uuid) on conflict(item_key,locale) do update set label=excluded.label,destination=excluded.destination,visible=excluded.visible,sort_order=excluded.sort_order,updated_by_account_id=excluded.updated_by_account_id,updated_at=now() returning *`.execute(this.db)).rows[0];
    await this.revision(actor, "navigation", input.itemKey, input.locale, "saved", { label: input.label, destination: input.destination, visible: input.visible });
    return row;
  }

  public async uploadMedia(file: UploadedFile | undefined, body: MediaAltDto, actor: string) {
    if (!file) throw new BadRequestException("Featured image must be JPG, PNG, or WebP.");
    const validation = isImage(file.buffer, file.mimetype);
    if (!validation.ok) throw new BadRequestException(`Featured image must be JPG, PNG, or WebP (${validation.reason}).`);
    const mediaToken = randomUUID();
    const key = `website/${mediaToken}.${validation.ext}`;
    await this.storage.storeWebsite(key, file.buffer);
    const row = (await sql<any>`insert into platform_website_media(storage_provider,storage_key,public_url,original_filename,media_type,size_bytes,alt_text,caption,uploaded_by_account_id) values('local',${key},${`/api/v1/public/website/media/${mediaToken}`},${cleanText(file.originalname) ?? "upload"},${validation.mediaType},${file.size},${cleanText(body.altText)},${cleanText(body.caption)},${actor}::uuid) returning id,public_url as "publicUrl",original_filename as "originalFilename",media_type as "mediaType",size_bytes as "sizeBytes",alt_text as "altText",caption,created_at as "createdAt"`.execute(this.db)).rows[0];
    await this.revision(actor, "media", row.id, null, "uploaded", { mediaType: validation.mediaType, sizeBytes: file.size });
    return row;
  }

  public async readMedia(shaOrId: string) {
    const row = (await sql<any>`select storage_key as "storageKey", media_type as "mediaType" from platform_website_media where deleted_at is null and (public_url=${`/api/v1/public/website/media/${shaOrId}`} or id::text=${shaOrId})`.execute(this.db)).rows[0];
    if (!row) throw new NotFoundException("media_not_found");
    return { bytes: await this.storage.readWebsite(row.storageKey), mediaType: row.mediaType };
  }
}
