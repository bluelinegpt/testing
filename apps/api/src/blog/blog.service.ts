import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  ArticleStatusDto,
  CategoryDto,
  PublicSiteSettingsDto,
  SaveBlogArticleDto,
} from "./blog.dto.js";
const cleanText = (value: string) =>
  value
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
const cleanBlocks = (blocks: SaveBlogArticleDto["content"]) =>
  blocks
    .map((b) =>
      b.items
        ? { type: b.type, items: b.items.map(cleanText).filter(Boolean) }
        : { type: b.type, text: cleanText(b.text ?? "") },
    )
    .filter((b) => ("text" in b && b.text) || ("items" in b && b.items.length));
const articlePayload = (input: SaveBlogArticleDto, blocks = cleanBlocks(input.content)) => ({
  authorId: input.authorId,
  canonicalUrl: input.canonicalUrl ?? null,
  categoryId: input.categoryId,
  content: blocks,
  excerpt: cleanText(input.excerpt),
  featuredImageAlt: input.featuredImageAlt ? cleanText(input.featuredImageAlt) : null,
  featuredImagePublicUrl: input.featuredImagePublicUrl ?? null,
  language: input.language,
  metaDescription: input.metaDescription ? cleanText(input.metaDescription) : null,
  robotsFollow: input.robotsFollow,
  robotsIndex: input.robotsIndex,
  seoTitle: input.seoTitle ? cleanText(input.seoTitle) : null,
  slug: input.slug,
  socialDescription: input.socialDescription ? cleanText(input.socialDescription) : null,
  socialImageUrl: input.socialImageUrl ?? null,
  socialTitle: input.socialTitle ? cleanText(input.socialTitle) : null,
  title: cleanText(input.title),
});
@Injectable()
export class BlogService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>) {}
  async publicList(input: { language?: string; category?: string; page?: number }) {
    const language = input.language ?? "en",
      page = Math.max(1, input.page ?? 1),
      size = 9,
      offset = (page - 1) * size;
    const rows =
      await sql<any>`select a.slug,a.language,a.title,a.excerpt,a.featured_image_public_url as "featuredImageUrl",a.featured_image_alt as "featuredImageAlt",a.published_at as "publishedAt",a.updated_content_at as "updatedAt",c.name category,c.slug as "categorySlug",u.display_name as author,ceil(greatest(1,length(a.content::text))/1200.0)::int as "readingMinutes" from platform_blog_articles a join platform_blog_categories c on c.id=a.category_id join platform_blog_authors u on u.id=a.author_id where a.language=${language} and ((a.status='published' and a.published_at<=now())or(a.status='scheduled'and a.scheduled_at<=now())) and c.active and (${input.category ?? null}::text is null or c.slug=${input.category ?? null}) order by coalesce(a.published_at,a.scheduled_at)desc limit ${size} offset ${offset}`.execute(
        this.db,
      );
    const total = (
      await sql<{
        count: string;
      }>`select count(*)::text count from platform_blog_articles a join platform_blog_categories c on c.id=a.category_id where a.language=${language} and ((a.status='published' and a.published_at<=now()) or (a.status='scheduled' and a.scheduled_at<=now())) and (${input.category ?? null}::text is null or c.slug=${input.category ?? null})`.execute(
        this.db,
      )
    ).rows[0]!.count;
    return { items: rows.rows, page, pageSize: size, total: Number(total) };
  }
  async publicArticle(slug: string, language = "en") {
    const article = (
      await sql<any>`select a.*,c.name category,c.slug category_slug,u.display_name author from platform_blog_articles a join platform_blog_categories c on c.id=a.category_id join platform_blog_authors u on u.id=a.author_id where a.slug=${slug} and a.language=${language} and ((a.status='published' and a.published_at<=now()) or (a.status='scheduled' and a.scheduled_at<=now()))`.execute(
        this.db,
      )
    ).rows[0];
    if (!article) {
      const redirect = (
        await sql<{
          to_path: string;
          status_code: number;
        }>`select to_path,status_code from platform_public_redirects where from_path=${`/blog/${slug}`}`.execute(
          this.db,
        )
      ).rows[0];
      if (redirect) return { redirect: { to: redirect.to_path, statusCode: redirect.status_code } };
      throw new NotFoundException("blog_article_not_found");
    }
    const related = (
      await sql<any>`select x.slug,x.title,x.excerpt from platform_blog_articles x where x.id<>${article.id}::uuid and x.language=${language} and x.category_id=${article.category_id}::uuid and ((x.status='published' and x.published_at<=now()) or (x.status='scheduled' and x.scheduled_at<=now())) order by coalesce(x.published_at,x.scheduled_at) desc limit 3`.execute(
        this.db,
      )
    ).rows;
    return { article, related };
  }
  async categories(language = "en") {
    return (
      await sql<any>`select name,slug,description from platform_blog_categories where language=${language} and active order by sort_order,name`.execute(
        this.db,
      )
    ).rows;
  }
  async publicSettings() {
    const x = (
      await sql<any>`select canonical_base_url as "canonicalBaseUrl",default_site_title as "defaultSiteTitle",default_meta_description as "defaultMetaDescription",default_social_image as "defaultSocialImage",search_console_verification as "searchConsoleVerification",gtm_container_id as "gtmContainerId",ga4_measurement_id as "ga4MeasurementId",analytics_enabled as "analyticsEnabled",clarity_project_id as "clarityProjectId",clarity_enabled as "clarityEnabled",tracking_environment as "trackingEnvironment" from platform_public_site_settings where id=true`.execute(
        this.db,
      )
    ).rows[0];
    return x;
  }
  async sitemap() {
    return (
      await sql<any>`select '/blog/'||slug path,coalesce(updated_content_at,updated_at) lastmod from platform_blog_articles where language='en' and ((status='published' and published_at<=now()) or (status='scheduled' and scheduled_at<=now())) union all select '/blog/category/'||slug,updated_at from platform_blog_categories where language='en' and active order by path`.execute(
        this.db,
      )
    ).rows;
  }
  async adminList() {
    return (
      await sql<any>`select a.id,a.slug,a.language,a.title,a.status,a.has_unpublished_changes,a.published_at,a.scheduled_at,a.updated_at,c.name category,u.display_name author from platform_blog_articles a join platform_blog_categories c on c.id=a.category_id join platform_blog_authors u on u.id=a.author_id order by a.updated_at desc`.execute(
        this.db,
      )
    ).rows;
  }
  async adminDetail(id: string) {
    const article = (
      await sql<any>`select * from platform_blog_articles where id=${id}::uuid`.execute(this.db)
    ).rows[0];
    if (!article) throw new NotFoundException();
    if (article.draft_payload) {
      const draft = article.draft_payload;
      return {
        ...article,
        author_id: draft.authorId,
        canonical_url: draft.canonicalUrl,
        category_id: draft.categoryId,
        content: draft.content,
        excerpt: draft.excerpt,
        featured_image_alt: draft.featuredImageAlt,
        featured_image_public_url: draft.featuredImagePublicUrl,
        language: draft.language,
        meta_description: draft.metaDescription,
        robots_follow: draft.robotsFollow,
        robots_index: draft.robotsIndex,
        seo_title: draft.seoTitle,
        slug: draft.slug,
        social_description: draft.socialDescription,
        social_image_url: draft.socialImageUrl,
        social_title: draft.socialTitle,
        title: draft.title,
      };
    }
    return article;
  }
  async adminPreview(id: string) {
    const article = await this.adminDetail(id);
    const category = (await sql<{ name: string; slug: string }>`select name,slug from platform_blog_categories where id=${String(article.category_id)}::uuid`.execute(this.db)).rows[0];
    const author = (await sql<{ display_name: string }>`select display_name from platform_blog_authors where id=${String(article.author_id)}::uuid`.execute(this.db)).rows[0];
    return {
      article: {
        ...article,
        category: category?.name ?? "Blog",
        category_slug: category?.slug ?? "blog",
        author: author?.display_name ?? "Tawseelhub",
        robots_index: false,
        robots_follow: false,
      },
      related: [],
      preview: {
        noindex: true,
        source: article.has_unpublished_changes ? "saved_draft" : "current_article",
      },
    };
  }
  async references() {
    return {
      categories: (
        await sql<any>`select id,name,slug,language,active,sort_order from platform_blog_categories order by sort_order`.execute(
          this.db,
        )
      ).rows,
      authors: (
        await sql<any>`select id,display_name,role_title,active from platform_blog_authors order by display_name`.execute(
          this.db,
        )
      ).rows,
    };
  }
  async create(input: SaveBlogArticleDto, actor: string) {
    const blocks = cleanBlocks(input.content);
    if (!blocks.length) throw new BadRequestException("article_content_required");
    const draftPayload = articlePayload(input, blocks);
    try {
      const row =
        await sql<any>`insert into platform_blog_articles(slug,language,title,excerpt,content,author_id,category_id,featured_image_public_url,featured_image_alt,seo_title,meta_description,canonical_url,robots_index,robots_follow,social_title,social_description,social_image_url,created_by_account_id,updated_by_account_id,draft_payload,has_unpublished_changes,last_unpublished_change_at) values(${input.slug},${input.language},${cleanText(input.title)},${cleanText(input.excerpt)},${JSON.stringify(blocks)}::jsonb,${input.authorId}::uuid,${input.categoryId}::uuid,${input.featuredImagePublicUrl ?? null},${input.featuredImageAlt ? cleanText(input.featuredImageAlt) : null},${input.seoTitle ? cleanText(input.seoTitle) : null},${input.metaDescription ? cleanText(input.metaDescription) : null},${input.canonicalUrl ?? null},${input.robotsIndex},${input.robotsFollow},${input.socialTitle ? cleanText(input.socialTitle) : null},${input.socialDescription ? cleanText(input.socialDescription) : null},${input.socialImageUrl ?? null},${actor}::uuid,${actor}::uuid,${JSON.stringify(draftPayload)}::jsonb,true,now()) returning *`.execute(
          this.db,
        );
      const article = row.rows[0];
      await sql`insert into platform_blog_publication_history(article_id,event_type,new_status,actor_account_id) values(${article.id}::uuid,'created','draft',${actor}::uuid)`.execute(
        this.db,
      );
      return article;
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new ConflictException("blog_slug_exists");
      throw e;
    }
  }
  async update(id: string, input: SaveBlogArticleDto, actor: string) {
    const current = await this.adminDetail(id);
    const blocks = cleanBlocks(input.content);
    const draftPayload = articlePayload(input, blocks);
    const persisted = (await sql<any>`select status,slug from platform_blog_articles where id=${id}::uuid`.execute(this.db)).rows[0];
    if (persisted.status === "published") {
      await sql`update platform_blog_articles set draft_payload=${JSON.stringify(draftPayload)}::jsonb,has_unpublished_changes=true,last_unpublished_change_at=now(),updated_by_account_id=${actor}::uuid,updated_at=now() where id=${id}::uuid`.execute(this.db);
      await sql`insert into platform_blog_publication_history(article_id,event_type,old_status,new_status,actor_account_id,detail) values(${id}::uuid,'draft_saved','published','published',${actor}::uuid,${JSON.stringify({ hasUnpublishedChanges: true })}::jsonb)`.execute(this.db);
      return this.adminDetail(id);
    }
    try {
      await sql`update platform_blog_articles set slug=${input.slug},language=${input.language},title=${cleanText(input.title)},excerpt=${cleanText(input.excerpt)},content=${JSON.stringify(blocks)}::jsonb,author_id=${input.authorId}::uuid,category_id=${input.categoryId}::uuid,featured_image_public_url=${input.featuredImagePublicUrl ?? null},featured_image_alt=${input.featuredImageAlt ? cleanText(input.featuredImageAlt) : null},seo_title=${input.seoTitle ? cleanText(input.seoTitle) : null},meta_description=${input.metaDescription ? cleanText(input.metaDescription) : null},canonical_url=${input.canonicalUrl ?? null},robots_index=${input.robotsIndex},robots_follow=${input.robotsFollow},social_title=${input.socialTitle ? cleanText(input.socialTitle) : null},social_description=${input.socialDescription ? cleanText(input.socialDescription) : null},social_image_url=${input.socialImageUrl ?? null},draft_payload=${JSON.stringify(draftPayload)}::jsonb,has_unpublished_changes=true,last_unpublished_change_at=now(),updated_by_account_id=${actor}::uuid,updated_content_at=now(),updated_at=now() where id=${id}::uuid`.execute(
        this.db,
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ConflictException("blog_slug_exists");
      throw e;
    }
    return this.adminDetail(id);
  }
  async status(id: string, input: ArticleStatusDto, actor: string) {
    const old = (await sql<any>`select * from platform_blog_articles where id=${id}::uuid`.execute(this.db)).rows[0];
    if (!old) throw new NotFoundException();
    if (
      input.status === "scheduled" &&
      (!input.scheduledAt || Number.isNaN(Date.parse(input.scheduledAt)))
    )
      throw new BadRequestException("valid_schedule_required");
    const draft = old.draft_payload as Record<string, unknown> | null;
    try {
      if (input.status === "published" && draft) {
        if (old.slug !== draft.slug && old.status === "published") {
          await sql`insert into platform_public_redirects(from_path,to_path,created_by_account_id) values(${`/blog/${old.slug}`},${`/blog/${draft.slug}`},${actor}::uuid) on conflict(from_path) do update set to_path=excluded.to_path`.execute(this.db);
        }
        await sql`update platform_blog_articles set slug=${String(draft.slug)},language=${String(draft.language)},title=${String(draft.title)},excerpt=${String(draft.excerpt)},content=${JSON.stringify(draft.content)}::jsonb,author_id=${String(draft.authorId)}::uuid,category_id=${String(draft.categoryId)}::uuid,featured_image_public_url=${draft.featuredImagePublicUrl as string | null},featured_image_alt=${draft.featuredImageAlt as string | null},seo_title=${draft.seoTitle as string | null},meta_description=${draft.metaDescription as string | null},canonical_url=${draft.canonicalUrl as string | null},robots_index=${Boolean(draft.robotsIndex)},robots_follow=${Boolean(draft.robotsFollow)},social_title=${draft.socialTitle as string | null},social_description=${draft.socialDescription as string | null},social_image_url=${draft.socialImageUrl as string | null},status='published',scheduled_at=null,published_at=coalesce(published_at,now()),published_by_account_id=${actor}::uuid,draft_payload=null,has_unpublished_changes=false,last_unpublished_change_at=null,updated_by_account_id=${actor}::uuid,updated_content_at=now(),updated_at=now() where id=${id}::uuid`.execute(this.db);
      } else {
        const published = input.status === "published" ? (old.published_at ?? new Date()) : old.published_at;
        await sql`update platform_blog_articles set status=${input.status},scheduled_at=${input.status === "scheduled" ? (input.scheduledAt ?? null) : null},published_at=${published},published_by_account_id=case when ${input.status}='published' then ${actor}::uuid else published_by_account_id end,unpublished_at=case when ${input.status}='unpublished' then now() else unpublished_at end,archived_at=case when ${input.status}='archived' then now() else archived_at end,updated_by_account_id=${actor}::uuid,updated_at=now() where id=${id}::uuid`.execute(this.db);
      }
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ConflictException("blog_slug_exists");
      throw e;
    }
    await sql`insert into platform_blog_publication_history(article_id,event_type,old_status,new_status,actor_account_id) values(${id}::uuid,${input.status},${old.status},${input.status},${actor}::uuid)`.execute(this.db);
    return this.adminDetail(id);
  }
  async createCategory(input: CategoryDto) {
    return (
      await sql<any>`insert into platform_blog_categories(name,slug,language,description,active,sort_order) values(${cleanText(input.name)},${input.slug},${input.language},${input.description ? cleanText(input.description) : null},${input.active},${input.sortOrder}) returning *`.execute(
        this.db,
      )
    ).rows[0];
  }
  async adminSettings() {
    return (
      await sql<any>`select * from platform_public_site_settings where id=true`.execute(this.db)
    ).rows[0];
  }
  async updateSettings(input: PublicSiteSettingsDto, actor: string) {
    await sql`update platform_public_site_settings set canonical_base_url=${input.canonicalBaseUrl.replace(/\/$/, "")},default_site_title=${cleanText(input.defaultSiteTitle)},default_meta_description=${cleanText(input.defaultMetaDescription)},default_social_image=${input.defaultSocialImage ?? null},search_console_verification=${input.searchConsoleVerification ?? null},gtm_container_id=${input.gtmContainerId ?? null},ga4_measurement_id=${input.ga4MeasurementId ?? null},analytics_enabled=${input.analyticsEnabled},clarity_project_id=${input.clarityProjectId ?? null},clarity_enabled=${input.clarityEnabled},tracking_environment=${input.trackingEnvironment},updated_by_account_id=${actor}::uuid,updated_at=now() where id=true`.execute(
      this.db,
    );
    return this.adminSettings();
  }
}
