/* eslint-disable @typescript-eslint/no-explicit-any, no-control-regex -- raw SQL rows are narrowed at the public DTO boundary; control characters are rejected intentionally */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { sql, type Kysely } from "kysely";
import { cleanBlogHtml } from "../blog/blog-html.js";
import { FileStoragePort } from "../files/file-storage.port.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { SaveSeoGuideDto, SeoGuideStatusDto } from "./seo-guide.dto.js";

const cleanText = (value: string) => value.replace(/[<>]/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
const slugPattern = /^(?!\.{1,2}$)(?!.*[\s\u0000-\u001f\u007f/\\?#\u202a-\u202e\u2066-\u2069])[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,158}[\p{L}\p{N}\p{M}])?$/u;
export const localizedGuidePath = (language: string, slug: string) => `${language === "ar" ? "/ar" : ""}/guides/${slug.normalize("NFC")}`;

function validSlug(value: string): string {
  const slug = value.normalize("NFC");
  if (!slugPattern.test(slug)) throw new BadRequestException("invalid_guide_slug");
  return slug;
}
function canonical(value: string | undefined, expectedPath: string): string | null {
  if (!value) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new BadRequestException("invalid_guide_canonical"); }
  const path = decodeURIComponent(parsed.pathname).replace(/\/$/, "") || "/";
  if (parsed.protocol !== "https:" || parsed.hostname !== "tawseelhub.com" || parsed.search || parsed.hash || path !== expectedPath) throw new BadRequestException("invalid_guide_canonical");
  return parsed.href.replace(/\/$/, "");
}
function cleanBlocks(input: SaveSeoGuideDto["content"]) {
  return input.map((block) => block.type === "html" ? { type: "html", text: cleanBlogHtml(block.text ?? "") } : block.items ? { type: block.type, items: block.items.map(cleanText).filter(Boolean) } : { type: block.type, text: cleanText(block.text ?? "") }).filter((block) => ("text" in block && block.text) || ("items" in block && block.items.length));
}
export function publicGuideSeo(row: Record<string, any>) {
  const path = localizedGuidePath(row.language, row.slug);
  const canonicalUrl = row.canonical_url || `https://tawseelhub.com${path}`;
  const image = row.social_image_url || row.featured_image_public_url || null;
  const language = row.language === "ar" ? "ar" : "en";
  const alternates = [{ language, url: canonicalUrl }, ...(row.translation_slug && ["published", "scheduled"].includes(row.translation_status) ? [{ language: row.translation_language, url: `https://tawseelhub.com${localizedGuidePath(row.translation_language, row.translation_slug)}` }] : [])];
  return {
    canonical: canonicalUrl, title: row.social_title || row.seo_title || row.title,
    description: row.social_description || row.meta_description || row.summary, image,
    imageAlt: row.social_image_url ? (row.social_image_alt || row.featured_image_alt) : row.featured_image_alt,
    locale: language === "ar" ? "ar_AE" : "en_AE", alternates,
    xDefault: alternates.find((item) => item.language === "en")?.url ?? null,
    graph: { "@context": "https://schema.org", "@graph": [
      { "@type": "Organization", "@id": "https://tawseelhub.com/#organization", name: "Tawseelhub", url: "https://tawseelhub.com" },
      { "@type": "BreadcrumbList", "@id": `${canonicalUrl}#breadcrumb`, itemListElement: [
        { "@type": "ListItem", position: 1, name: language === "ar" ? "الرئيسية" : "Home", item: language === "ar" ? "https://tawseelhub.com/ar" : "https://tawseelhub.com/" },
        { "@type": "ListItem", position: 2, name: row.title, item: canonicalUrl },
      ] },
      { "@type": "WebPage", "@id": canonicalUrl, url: canonicalUrl, headline: row.title, description: row.summary, inLanguage: language,
        datePublished: row.published_at, dateModified: row.updated_content_at || row.updated_at, mainEntityOfPage: canonicalUrl,
        publisher: { "@id": "https://tawseelhub.com/#organization" }, ...(row.author_name ? { author: { "@type": "Person", name: row.author_name } } : {}), ...(image ? { image } : {}) },
    ] },
  };
}
export function toPublicGuide(row: Record<string,any>) { return { id:row.id,title:row.title,slug:row.slug,language:row.language,summary:row.summary,content:row.content,authorName:row.author_name,primaryTopic:row.primary_topic,featuredImagePublicUrl:row.featured_image_public_url,featuredImageAlt:row.featured_image_alt,publishedAt:row.published_at,modifiedAt:row.updated_content_at||row.updated_at,robotsIndex:row.robots_index,robotsFollow:row.robots_follow,socialTitle:row.social_title,socialDescription:row.social_description,socialImageUrl:row.social_image_url,socialImageAlt:row.social_image_alt,seo:publicGuideSeo(row)}; }

@Injectable()
export class SeoGuideService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>, @Inject(FileStoragePort) private readonly storage: FileStoragePort) {}
  async adminList() { return (await sql<any>`select id,internal_title,title,slug,language,status,robots_index,include_in_sitemap,published_at,scheduled_at,updated_at from platform_seo_guides order by updated_at desc`.execute(this.db)).rows; }
  async adminDetail(id: string) {
    const guide = (await sql<any>`select * from platform_seo_guides where id=${id}::uuid`.execute(this.db)).rows[0];
    if (!guide) throw new NotFoundException("seo_guide_not_found");
    const sources = (await sql<any>`select id,revision,original_filename,content_type,size_bytes,checksum_sha256,uploaded_at,uploaded_by_account_id from platform_seo_guide_source_documents where guide_id=${id}::uuid order by revision desc`.execute(this.db)).rows;
    const history = (await sql<any>`select event_type,old_status,new_status,detail,created_at,actor_account_id from platform_seo_guide_publication_history where guide_id=${id}::uuid order by created_at desc`.execute(this.db)).rows;
    return { ...guide, sources, history };
  }
  async create(input: SaveSeoGuideDto, actor: string) {
    const slug = validSlug(input.slug), path = localizedGuidePath(input.language, slug);
    try {
      const row = (await sql<any>`insert into platform_seo_guides(internal_title,title,slug,language,translation_group_id,summary,content,author_name,primary_topic,featured_image_public_url,featured_image_alt,robots_index,robots_follow,include_in_sitemap,show_in_main_navigation,show_in_resources,canonical_url,seo_title,meta_description,social_title,social_description,social_image_url,social_image_alt,created_by_account_id,updated_by_account_id) values(${cleanText(input.internalTitle)},${cleanText(input.title)},${slug},${input.language},coalesce(${input.translationGroupId ?? null}::uuid,gen_random_uuid()),${cleanText(input.summary)},${JSON.stringify(cleanBlocks(input.content))}::jsonb,${input.authorName ? cleanText(input.authorName) : null},${input.primaryTopic ? cleanText(input.primaryTopic) : null},${input.featuredImagePublicUrl ?? null},${input.featuredImageAlt ? cleanText(input.featuredImageAlt) : null},${input.robotsIndex},${input.robotsFollow},${input.includeInSitemap},${input.showInMainNavigation},${input.showInResources},${canonical(input.canonicalUrl,path)},${input.seoTitle ? cleanText(input.seoTitle) : null},${input.metaDescription ? cleanText(input.metaDescription) : null},${input.socialTitle ? cleanText(input.socialTitle) : null},${input.socialDescription ? cleanText(input.socialDescription) : null},${input.socialImageUrl ?? null},${input.socialImageAlt ? cleanText(input.socialImageAlt) : null},${actor}::uuid,${actor}::uuid) returning id`.execute(this.db)).rows[0];
      await this.history(row.id, "created", actor, null, "draft", {});
      return this.adminDetail(row.id);
    } catch (error) { if ((error as { code?: string }).code === "23505") throw new ConflictException("seo_guide_slug_or_translation_conflict"); throw error; }
  }
  async update(id: string, input: SaveSeoGuideDto, actor: string) {
    const before = await this.adminDetail(id), slug = validSlug(input.slug), oldPath = localizedGuidePath(before.language,before.slug), newPath = localizedGuidePath(input.language,slug);
    if (before.language !== input.language) throw new BadRequestException("seo_guide_language_immutable_create_translation_instead");
    try {
      await this.db.transaction().execute(async (trx) => {
        await sql`update platform_seo_guides set internal_title=${cleanText(input.internalTitle)},title=${cleanText(input.title)},slug=${slug},language=${input.language},translation_group_id=coalesce(${input.translationGroupId ?? null}::uuid,translation_group_id),summary=${cleanText(input.summary)},content=${JSON.stringify(cleanBlocks(input.content))}::jsonb,author_name=${input.authorName ? cleanText(input.authorName) : null},primary_topic=${input.primaryTopic ? cleanText(input.primaryTopic) : null},featured_image_public_url=${input.featuredImagePublicUrl ?? null},featured_image_alt=${input.featuredImageAlt ? cleanText(input.featuredImageAlt) : null},robots_index=${input.robotsIndex},robots_follow=${input.robotsFollow},include_in_sitemap=${input.includeInSitemap},show_in_main_navigation=${input.showInMainNavigation},show_in_resources=${input.showInResources},canonical_url=${canonical(input.canonicalUrl,newPath)},seo_title=${input.seoTitle ? cleanText(input.seoTitle) : null},meta_description=${input.metaDescription ? cleanText(input.metaDescription) : null},social_title=${input.socialTitle ? cleanText(input.socialTitle) : null},social_description=${input.socialDescription ? cleanText(input.socialDescription) : null},social_image_url=${input.socialImageUrl ?? null},social_image_alt=${input.socialImageAlt ? cleanText(input.socialImageAlt) : null},updated_by_account_id=${actor}::uuid,updated_content_at=now(),updated_at=now() where id=${id}::uuid`.execute(trx);
        if (oldPath !== newPath) {
          await sql`delete from platform_public_redirects where from_path=${newPath}`.execute(trx);
          await sql`update platform_public_redirects set to_path=${newPath} where to_path=${oldPath} and from_path<>${newPath}`.execute(trx);
          await sql`insert into platform_public_redirects(from_path,to_path,status_code,active,source_content_type,created_by_account_id) values(${oldPath},${newPath},301,true,'seo_guide',${actor}::uuid) on conflict(from_path) do update set to_path=excluded.to_path,status_code=301,active=true,source_content_type='seo_guide'`.execute(trx);
        }
      });
      await this.history(id, oldPath === newPath ? "updated" : "slug_renamed", actor, before.status, before.status, oldPath === newPath ? {} : { oldPath,newPath });
      return this.adminDetail(id);
    } catch (error) { if ((error as { code?: string }).code === "23505") throw new ConflictException("seo_guide_slug_or_translation_conflict"); throw error; }
  }
  async setStatus(id: string, input: SeoGuideStatusDto, actor: string) {
    const before = await this.adminDetail(id), scheduledAt = input.status === "scheduled" ? new Date(input.scheduledAt ?? "") : null;
    if (input.status === "scheduled" && Number.isNaN(scheduledAt?.getTime())) throw new BadRequestException("invalid_schedule");
    await sql`update platform_seo_guides set status=${input.status},scheduled_at=${scheduledAt?.toISOString() ?? null},published_at=case when ${input.status}='published' then coalesce(published_at,now()) when ${input.status}='scheduled' then ${scheduledAt?.toISOString() ?? null}::timestamptz else published_at end,updated_by_account_id=${actor}::uuid,updated_at=now() where id=${id}::uuid`.execute(this.db);
    await this.history(id, input.status === "archived" ? "archived" : "status_changed", actor, before.status, input.status, scheduledAt ? { scheduledAt: scheduledAt.toISOString() } : {});
    return this.adminDetail(id);
  }
  async archive(id: string, actor: string) { return this.setStatus(id, { status: "archived" }, actor); }
  async preview(id: string) { const guide = await this.adminDetail(id); return { ...this.toPublic(guide), robots: "noindex,nofollow" }; }
  async publicGuide(slugValue: string, language = "en") {
    const slug = validSlug(slugValue), locale = language === "ar" ? "ar" : "en";
    const row = (await sql<any>`select g.*,t.slug as translation_slug,t.language as translation_language,t.status as translation_status from platform_seo_guides g left join platform_seo_guides t on t.translation_group_id=g.translation_group_id and t.language<>g.language and ((t.status='published' and t.published_at<=now()) or (t.status='scheduled' and t.scheduled_at<=now())) where g.slug=${slug} and g.language=${locale} and ((g.status='published' and g.published_at<=now()) or (g.status='scheduled' and g.scheduled_at<=now()))`.execute(this.db)).rows[0];
    if (!row) {
      const redirect = (await sql<any>`update platform_public_redirects set hit_count=hit_count+1,last_hit_at=now() where from_path=${localizedGuidePath(locale,slug)} and active returning to_path,status_code`.execute(this.db)).rows[0];
      if (redirect) return { redirect: { to: redirect.to_path, statusCode: redirect.status_code } };
      throw new NotFoundException("seo_guide_not_found");
    }
    return this.toPublic(row);
  }
  async uploadSource(id: string, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }, actor: string) {
    await this.adminDetail(id);
    const allowed = new Map([["application/pdf", ".pdf"], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"]]);
    const extension = allowed.get(file.mimetype);
    if (!extension || extname(file.originalname).toLowerCase() !== extension) throw new BadRequestException("seo_source_file_type_not_allowed");
    if (file.size < 1 || file.size > 15 * 1024 * 1024) throw new BadRequestException("seo_source_file_size_invalid");
    const revision = Number((await sql<any>`select coalesce(max(revision),0)+1 as revision from platform_seo_guide_source_documents where guide_id=${id}::uuid`.execute(this.db)).rows[0].revision);
    const key = `seo-source-documents/${new Date().getUTCFullYear()}/${id}/v${revision}-${randomUUID()}${extension}`;
    await this.storage.storeSeoSource(key,file.buffer,file.mimetype);
    const checksum = createHash("sha256").update(file.buffer).digest("hex");
    const row = (await sql<any>`insert into platform_seo_guide_source_documents(guide_id,revision,original_filename,content_type,size_bytes,storage_key,checksum_sha256,uploaded_by_account_id) values(${id}::uuid,${revision},${cleanText(file.originalname).slice(0,255)},${file.mimetype},${file.size},${key},${checksum},${actor}::uuid) returning id,revision,original_filename,content_type,size_bytes,checksum_sha256,uploaded_at`.execute(this.db)).rows[0];
    await this.history(id,"source_uploaded",actor,null,null,{sourceId:row.id,revision});
    return row;
  }
  async sourceDownload(guideId: string, sourceId: string) {
    const row = (await sql<any>`select original_filename,content_type,storage_key from platform_seo_guide_source_documents where id=${sourceId}::uuid and guide_id=${guideId}::uuid`.execute(this.db)).rows[0];
    if (!row) throw new NotFoundException("seo_source_not_found");
    return { filename: row.original_filename, contentType: row.content_type, bytes: await this.storage.readSeoSource(row.storage_key) };
  }
  async readiness(id: string) {
    const guide = await this.adminDetail(id), body = JSON.stringify(guide.content ?? []);
    const overlap = (await sql<any>`select id,title,slug from platform_seo_guides where id<>${id}::uuid and language=${guide.language} and status<>'archived' and (lower(coalesce(seo_title,''))=lower(${guide.seo_title ?? ""}) or lower(coalesce(primary_topic,''))=lower(${guide.primary_topic ?? ""})) limit 8`.execute(this.db)).rows;
    const checks = [
      {key:"title",pass:Boolean(guide.title),severity:"blocking",message:"Add the public page title."},{key:"seo_title",pass:Boolean(guide.seo_title),severity:"warning",message:"Add an SEO title."},{key:"meta_description",pass:Boolean(guide.meta_description),severity:"warning",message:"Add a meta description."},{key:"canonical",pass:Boolean(guide.slug),severity:"blocking",message:"Set a valid canonical URL."},{key:"featured_image",pass:Boolean(guide.featured_image_public_url),severity:"warning",message:"Add a featured image."},{key:"image_alt",pass:!guide.featured_image_public_url||Boolean(guide.featured_image_alt),severity:"warning",message:"Describe the featured image."},{key:"structured_data",pass:true,severity:"blocking",message:"WebPage schema is generated automatically."},{key:"internal_links",pass:/href=/.test(body),severity:"warning",message:"Add at least one relevant internal link."},{key:"indexability",pass:guide.robots_index,severity:"warning",message:"This Guide is noindex."},{key:"sitemap",pass:!guide.robots_index||guide.include_in_sitemap,severity:"warning",message:"Indexable Guide is excluded from sitemap."},{key:"overlap",pass:overlap.length===0,severity:"warning",message:"A similar active Guide may target the same search intent."},{key:"arabic_readiness",pass:guide.language!=="ar"||Boolean(guide.seo_title&&guide.meta_description),severity:"warning",message:"Complete Arabic SEO metadata."},
    ];
    return {status:checks.some(x=>!x.pass&&x.severity==="blocking")?"needs_attention":checks.some(x=>!x.pass)?"warnings":"seo_ready",checks,overlapCandidates:overlap};
  }
  private toPublic(row: Record<string,any>) { return toPublicGuide(row); }
  private async history(guideId:string,eventType:string,actor:string,oldStatus:string|null,newStatus:string|null,detail:Record<string,unknown>) { await sql`insert into platform_seo_guide_publication_history(guide_id,event_type,old_status,new_status,actor_account_id,detail) values(${guideId}::uuid,${eventType},${oldStatus},${newStatus},${actor}::uuid,${JSON.stringify(detail)}::jsonb)`.execute(this.db); }
}
