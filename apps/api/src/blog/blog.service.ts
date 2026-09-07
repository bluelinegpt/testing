import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import { cleanBlogHtml } from "./blog-html.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  ArticleStatusDto,
  AuthorDto,
  CategoryDto,
  ManualRedirectDto,
  PublicSiteSettingsDto,
  SaveBlogArticleDto,
  TagDto,
  TopicDto,
} from "./blog.dto.js";
const cleanText = (value: string) =>
  value
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
const reservedBlogSlugs = new Set(["ar", "article", "author", "category", "feed", "page", "rss", "tag"]);
const localizedSlugPattern=/^(?!\.{1,2}$)(?!.*[\s\u0000-\u001f\u007f/\\?#\u202a-\u202e\u2066-\u2069])[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,158}[\p{L}\p{N}\p{M}])?$/u;
export const localizedBlogPath = (language: string, slug: string) =>
  `${language === "ar" ? "/ar" : ""}/blog/${slug.normalize("NFC")}`;
export const validateLocalizedSlug = (slug: string) => {
  const normalized = slug.normalize("NFC");
  if (!localizedSlugPattern.test(normalized)) throw new BadRequestException("invalid_blog_slug");
  if (reservedBlogSlugs.has(normalized.toLocaleLowerCase("en-US")))
    throw new BadRequestException("blog_slug_reserved");
  return normalized;
};
export const safeCanonical = (value?: string, expectedPath?: string) => {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new BadRequestException("invalid_blog_canonical"); }
  if (url.protocol !== "https:" || url.hostname !== "tawseelhub.com" || url.search || url.hash)
    throw new BadRequestException("invalid_blog_canonical");
  let decodedPath:string;
  try { decodedPath=decodeURIComponent(url.pathname); } catch { throw new BadRequestException("invalid_blog_canonical"); }
  const normalizedPath = decodedPath === "/" ? "/" : decodedPath.replace(/\/$/, "");
  if (expectedPath && normalizedPath !== expectedPath)
    throw new BadRequestException("invalid_blog_canonical");
  return url.href.replace(/\/$/, "");
};
const cleanBlocks = (blocks: SaveBlogArticleDto["content"]) =>
  blocks
    .map((b) =>
      b.type === "html" ? { type: "html", text: cleanBlogHtml(b.text ?? "") } : b.items
        ? { type: b.type, items: b.items.map(cleanText).filter(Boolean) }
        : { type: b.type, text: cleanText(b.text ?? "") },
    )
    .filter((b) => ("text" in b && b.text) || ("items" in b && b.items.length));
const articlePayload = (input: SaveBlogArticleDto, blocks = cleanBlocks(input.content)) => ({
  authorId: input.authorId,
  canonicalUrl: safeCanonical(input.canonicalUrl, localizedBlogPath(input.language, input.slug)),
  categoryId: input.categoryId,
  categoryIds: [...new Set([input.categoryId,...(input.categoryIds ?? [])])],
  content: blocks,
  excerpt: cleanText(input.excerpt),
  featuredImageAlt: input.featuredImageAlt ? cleanText(input.featuredImageAlt) : null,
  featuredImageWidth: input.featuredImageWidth ?? null,
  featuredImageHeight: input.featuredImageHeight ?? null,
  featuredImagePublicUrl: input.featuredImagePublicUrl ?? null,
  language: input.language,
  tagIds: [...new Set(input.tagIds ?? [])],
  relatedArticleIds: [...new Set(input.relatedArticleIds ?? [])],
  cornerstone: input.cornerstone,
  translationGroupId: input.translationGroupId,
  metaDescription: input.metaDescription ? cleanText(input.metaDescription) : null,
  robotsFollow: input.robotsFollow,
  robotsIndex: input.robotsIndex,
  seoTitle: input.seoTitle ? cleanText(input.seoTitle) : null,
  slug: input.slug,
  socialDescription: input.socialDescription ? cleanText(input.socialDescription) : null,
  socialImageUrl: input.socialImageUrl ?? null,
  socialImageAlt: input.socialImageAlt ? cleanText(input.socialImageAlt) : null,
  socialImageWidth: input.socialImageWidth ?? null,
  socialImageHeight: input.socialImageHeight ?? null,
  socialTitle: input.socialTitle ? cleanText(input.socialTitle) : null,
  title: cleanText(input.title),
});

export function publicArticleSeo(article: Record<string, any>) {
  const language = article.language === "ar" ? "ar" : "en";
  const path = localizedBlogPath(language, article.slug);
  const canonical = article.canonical_url || `https://tawseelhub.com${path}`;
  const title = article.social_title || article.seo_title || article.title;
  const description = article.social_description || article.meta_description || article.excerpt;
  const imageValue = article.social_image_url || article.featured_image_public_url || null;
  const image = imageValue && String(imageValue).startsWith("/") ? `https://tawseelhub.com${imageValue}` : imageValue;
  const imageAlt = article.social_image_url ? (article.social_image_alt || article.featured_image_alt || null) : (article.featured_image_alt || null);
  const imageWidth = article.social_image_url ? article.social_image_width : article.featured_image_width;
  const imageHeight = article.social_image_url ? article.social_image_height : article.featured_image_height;
  const organizationId = "https://tawseelhub.com/#organization";
  const websiteId = "https://tawseelhub.com/#website";
  const articleId = `${canonical}#article`;
  const breadcrumbId = `${canonical}#breadcrumb`;
  const homeUrl = language === "ar" ? "https://tawseelhub.com/ar" : "https://tawseelhub.com/";
  const blogUrl = language === "ar" ? "https://tawseelhub.com/ar/blog" : "https://tawseelhub.com/blog";
  const graph: Record<string, any>[] = [
    { "@type":"Organization", "@id":organizationId, name:"Tawseelhub", url:"https://tawseelhub.com", logo:{ "@type":"ImageObject", url:"https://tawseelhub.com/tawseelhub-logo.png" } },
    { "@type":"WebSite", "@id":websiteId, name:"Tawseelhub", url:"https://tawseelhub.com", publisher:{ "@id":organizationId }, inLanguage:article.language || "en" },
    { "@type":"BreadcrumbList", "@id":breadcrumbId, itemListElement:[
      { "@type":"ListItem", position:1, name:language === "ar" ? "الرئيسية" : "Home", item:homeUrl },
      { "@type":"ListItem", position:2, name:language === "ar" ? "المدونة" : "Blog", item:blogUrl },
      ...(article.category_slug ? [{ "@type":"ListItem", position:3, name:article.category, item:`${blogUrl}/category/${article.category_slug}` }] : []),
      { "@type":"ListItem", position:article.category_slug ? 4 : 3, name:article.title, item:canonical },
    ] },
    { "@type":"BlogPosting", "@id":articleId, url:canonical, headline:article.title, description:article.excerpt, mainEntityOfPage:{ "@type":"WebPage", "@id":canonical }, datePublished:article.published_at, dateModified:article.updated_content_at || article.published_at, author:{ "@type":"Person", name:article.author, ...(article.author_slug ? { url:`${blogUrl}/author/${article.author_slug}`, "@id":`${blogUrl}/author/${article.author_slug}#person` } : {}) }, publisher:{ "@id":organizationId }, isPartOf:{ "@id":websiteId }, breadcrumb:{ "@id":breadcrumbId }, articleSection:article.category, inLanguage:article.language || "en", ...(image ? { image:{ "@type":"ImageObject", url:image, ...(imageWidth ? { width:imageWidth } : {}), ...(imageHeight ? { height:imageHeight } : {}) } } : {}) },
  ];
  const alternates = [
    { language, url: canonical },
    ...(article.translation_slug && article.translation_language
      ? [{ language: article.translation_language, url: `https://tawseelhub.com${localizedBlogPath(article.translation_language, article.translation_slug)}` }]
      : []),
  ];
  return { canonical, title, description, image, imageAlt, imageWidth, imageHeight, language, locale:language === "ar" ? "ar_AE" : "en_AE", alternateLocale:article.translation_language === "ar" ? "ar_AE" : article.translation_language === "en" ? "en_AE" : null, alternates, xDefault:alternates.find((item)=>item.language === "en")?.url ?? null, graph:{ "@context":"https://schema.org", "@graph":graph } };
}
@Injectable()
export class BlogService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>) {}
  private async ensureCategoryLanguage(categoryId:string,language:string) {
    const category=(await sql<{language:string}>`select language from platform_blog_categories where id=${categoryId}::uuid and active=true`.execute(this.db)).rows[0];
    if (!category || category.language!==language) throw new BadRequestException("blog_category_language_mismatch");
  }
  private async validateRelationships(input: SaveBlogArticleDto) {
    const categoryIds=[...new Set([input.categoryId,...(input.categoryIds??[])])];
    const tagIds=[...new Set(input.tagIds??[])];
    const relatedIds=[...new Set(input.relatedArticleIds??[])];
    const categories=(await sql<{id:string}>`select id from platform_blog_categories where id=any(${categoryIds}::uuid[]) and language=${input.language} and active`.execute(this.db)).rows;
    if(categories.length!==categoryIds.length) throw new BadRequestException("blog_category_language_mismatch");
    if(tagIds.length){const tags=(await sql<{id:string}>`select id from platform_blog_tags where id=any(${tagIds}::uuid[]) and language=${input.language} and active`.execute(this.db)).rows;if(tags.length!==tagIds.length)throw new BadRequestException("blog_tag_language_mismatch");}
    if(relatedIds.length){const related=(await sql<{id:string}>`select id from platform_blog_articles where id=any(${relatedIds}::uuid[]) and language=${input.language}`.execute(this.db)).rows;if(related.length!==relatedIds.length)throw new BadRequestException("blog_related_language_mismatch");}
  }
  private async syncRelationships(articleId:string,payload:Record<string,any>) {
    const categoryIds=[...new Set([payload.categoryId,...(payload.categoryIds??[])])];
    const tagIds=[...new Set(payload.tagIds??[])];
    const relatedIds=[...new Set(payload.relatedArticleIds??[])].filter(id=>id!==articleId);
    await sql`delete from platform_blog_article_categories where article_id=${articleId}::uuid;insert into platform_blog_article_categories(article_id,category_id) select ${articleId}::uuid,x from unnest(${categoryIds}::uuid[])x;delete from platform_blog_article_tags where article_id=${articleId}::uuid;insert into platform_blog_article_tags(article_id,tag_id) select ${articleId}::uuid,x from unnest(${tagIds}::uuid[])x;delete from platform_blog_article_relations where article_id=${articleId}::uuid and relation_type='editorial';insert into platform_blog_article_relations(article_id,related_article_id,relation_type,sort_order) select ${articleId}::uuid,x,'editorial',n from unnest(${relatedIds}::uuid[])with ordinality as u(x,n)`.execute(this.db);
  }
  async publicList(input: { language?: string; category?: string; tag?: string; author?: string; topic?: string; page?: number }) {
    const language = input.language ?? "en",
      page = Math.max(1, input.page ?? 1),
      size = 9,
      offset = (page - 1) * size;
    const rows =
      await sql<any>`select a.slug,a.language,a.title,a.excerpt,a.featured_image_public_url as "featuredImageUrl",a.featured_image_alt as "featuredImageAlt",a.featured_image_width as "featuredImageWidth",a.featured_image_height as "featuredImageHeight",a.published_at as "publishedAt",a.updated_content_at as "updatedAt",c.name category,c.slug as "categorySlug",u.display_name as author,u.slug as "authorSlug",ceil(greatest(1,length(a.content::text))/1200.0)::int as "readingMinutes" from platform_blog_articles a join platform_blog_categories c on c.id=a.category_id join platform_blog_authors u on u.id=a.author_id where a.language=${language} and ((a.status='published' and a.published_at<=now())or(a.status='scheduled'and a.scheduled_at<=now())) and c.active and (${input.category ?? null}::text is null or exists(select 1 from platform_blog_article_categories ac join platform_blog_categories fc on fc.id=ac.category_id where ac.article_id=a.id and fc.slug=${input.category ?? null} and fc.language=${language})) and (${input.tag ?? null}::text is null or exists(select 1 from platform_blog_article_tags at join platform_blog_tags ft on ft.id=at.tag_id where at.article_id=a.id and ft.slug=${input.tag ?? null} and ft.language=${language} and ft.active)) and (${input.author ?? null}::text is null or u.slug=${input.author ?? null}) and (${input.topic ?? null}::text is null or exists(select 1 from platform_blog_topic_articles ta join platform_blog_topics tp on tp.id=ta.topic_id where ta.article_id=a.id and tp.slug=${input.topic ?? null} and tp.language=${language} and tp.status='published')) order by coalesce(a.published_at,a.scheduled_at)desc limit ${size} offset ${offset}`.execute(
        this.db,
      );
    const total = (
      await sql<{
        count: string;
      }>`select count(*)::text count from platform_blog_articles a join platform_blog_categories c on c.id=a.category_id join platform_blog_authors u on u.id=a.author_id where a.language=${language} and ((a.status='published' and a.published_at<=now()) or (a.status='scheduled' and a.scheduled_at<=now())) and (${input.category ?? null}::text is null or exists(select 1 from platform_blog_article_categories ac join platform_blog_categories fc on fc.id=ac.category_id where ac.article_id=a.id and fc.slug=${input.category ?? null} and fc.language=${language})) and (${input.tag ?? null}::text is null or exists(select 1 from platform_blog_article_tags at join platform_blog_tags ft on ft.id=at.tag_id where at.article_id=a.id and ft.slug=${input.tag ?? null} and ft.language=${language} and ft.active)) and (${input.author ?? null}::text is null or u.slug=${input.author ?? null}) and (${input.topic ?? null}::text is null or exists(select 1 from platform_blog_topic_articles ta join platform_blog_topics tp on tp.id=ta.topic_id where ta.article_id=a.id and tp.slug=${input.topic ?? null} and tp.language=${language} and tp.status='published'))`.execute(
        this.db,
      )
    ).rows[0]!.count;
    return { items: rows.rows, page, pageSize: size, total: Number(total) };
  }
  async publicArticle(slug: string, language = "en") {
    const normalizedSlug = validateLocalizedSlug(slug);
    if (language !== "en" && language !== "ar") throw new NotFoundException("blog_article_not_found");
    const article = (
      await sql<any>`select a.*,c.name category,c.slug category_slug,u.display_name author,u.slug author_slug,u.profile_image_public_url author_image,u.short_bio author_bio,u.expertise author_expertise,t.slug translation_slug,t.language translation_language from platform_blog_articles a join platform_blog_categories c on c.id=a.category_id join platform_blog_authors u on u.id=a.author_id left join platform_blog_articles t on t.translation_group_id=a.translation_group_id and t.id<>a.id and ((t.status='published' and t.published_at<=now()) or (t.status='scheduled' and t.scheduled_at<=now())) where a.slug=${normalizedSlug} and a.language=${language} and ((a.status='published' and a.published_at<=now()) or (a.status='scheduled' and a.scheduled_at<=now()))`.execute(
        this.db,
      )
    ).rows[0];
    if (!article) {
      const redirect = (
        await sql<{
          to_path: string;
          status_code: number;
        }>`update platform_public_redirects set hit_count=hit_count+1,last_hit_at=now() where from_path=${localizedBlogPath(language, normalizedSlug)} and active returning to_path,status_code`.execute(
          this.db,
        )
      ).rows[0];
      if (redirect) return { redirect: { to: redirect.to_path, statusCode: redirect.status_code } };
      throw new NotFoundException("blog_article_not_found");
    }
    const related = (
      await sql<any>`select x.slug,x.title,x.excerpt,x.cornerstone from platform_blog_articles x left join platform_blog_article_relations r on r.article_id=${article.id}::uuid and r.related_article_id=x.id left join platform_blog_article_tags xt on xt.article_id=x.id left join platform_blog_article_tags at on at.article_id=${article.id}::uuid and at.tag_id=xt.tag_id where x.id<>${article.id}::uuid and x.language=${language} and (r.related_article_id is not null or x.category_id=${article.category_id}::uuid or at.tag_id is not null) and ((x.status='published' and x.published_at<=now()) or (x.status='scheduled' and x.scheduled_at<=now())) group by x.id,x.slug,x.title,x.excerpt,x.cornerstone,x.published_at,x.scheduled_at order by x.cornerstone desc,coalesce(x.published_at,x.scheduled_at) desc limit 3`.execute(
        this.db,
      )
    ).rows;
    article.tags=(await sql<{name:string;slug:string}>`select t.name,t.slug from platform_blog_article_tags at join platform_blog_tags t on t.id=at.tag_id where at.article_id=${article.id}::uuid and t.active order by t.name`.execute(this.db)).rows;
    // Sanitize at the public boundary too, including previously saved markup.
    article.content = cleanBlocks(article.content ?? []);
    article.seo = publicArticleSeo(article);
    delete article.draft_payload;
    for (const internal of ["id","author_id","category_id","translation_group_id","created_by_account_id","updated_by_account_id","published_by_account_id","featured_image_storage_key","translation_slug","translation_language","reviewed_by_account_id"]) delete article[internal];
    return { article, related };
  }
  /**
   * Public category list: only categories with at least one published
   * article are returned, so an empty Draft-only category never appears on
   * the public site. CMS category data itself is untouched -- this is a
   * read filter on the public route only, not a deletion.
   */
  async categories(language = "en") {
    return (
      await sql<any>`select c.name,c.slug,c.description,t.slug as "translationSlug",t.language as "translationLanguage" from platform_blog_categories c
         left join platform_blog_categories t on t.translation_group_id=c.translation_group_id and t.id<>c.id and t.active=true
         where c.language=${language} and c.active
           and exists (
             select 1 from platform_blog_articles a
              where a.category_id=c.id and a.language=${language}
                and ((a.status='published' and a.published_at<=now()) or (a.status='scheduled' and a.scheduled_at<=now()))
           )
         order by c.sort_order,c.name`.execute(
        this.db,
      )
    ).rows;
  }
  private landingSeo(kind:string,row:Record<string,any>) {
    const language=row.language==="ar"?"ar":"en";
    const prefix=language==="ar"?"/ar":"";
    const path=`${prefix}/blog/${kind}/${row.slug}`;
    const canonical=`https://tawseelhub.com${path}`;
    const translated=row.translation_slug&&row.translation_language?`https://tawseelhub.com${row.translation_language==="ar"?"/ar":""}/blog/${kind}/${row.translation_slug}`:null;
    const title=row.social_title||row.seo_title||row.name||row.title||row.display_name;
    const description=row.social_description||row.meta_description||row.description||row.short_bio||"";
    const graph={"@context":"https://schema.org","@graph":[{"@type":kind==="author"?"ProfilePage":"CollectionPage","@id":`${canonical}#page`,url:canonical,name:title,description,inLanguage:language,...(kind==="author"?{mainEntity:{"@type":"Person","@id":`${canonical}#person`,name:row.display_name,description:row.biography||row.short_bio||undefined,knowsAbout:row.expertise||[]}}:{})},{"@type":"BreadcrumbList","@id":`${canonical}#breadcrumb`,itemListElement:[{"@type":"ListItem",position:1,name:language==="ar"?"الرئيسية":"Home",item:`https://tawseelhub.com${prefix||"/"}`},{"@type":"ListItem",position:2,name:language==="ar"?"المدونة":"Blog",item:`https://tawseelhub.com${prefix}/blog`},{"@type":"ListItem",position:3,name:title,item:canonical}]}]};
    return {canonical,title,description,image:row.social_image_url||row.profile_image_public_url||null,language,alternates:[{language,url:canonical},...(translated?[{language:row.translation_language,url:translated}]:[])],xDefault:language==="en"?canonical:(row.translation_language==="en"?translated:null),graph};
  }
  private async publicLanding(table:"categories"|"tags"|"authors"|"topics",kind:string,slug:string,language:string) {
    validateLocalizedSlug(slug);
    if(!["en","ar"].includes(language))throw new NotFoundException("blog_landing_not_found");
    const nameColumn=table==="authors"?"display_name":"name";
    const actualName=table==="topics"?"title":nameColumn;
    const status=table==="topics"?sql`and x.status='published'`:sql`and x.active`;
    const join=table==="authors"?sql`a.author_id=x.id`:table==="categories"?sql`exists(select 1 from platform_blog_article_categories ac where ac.article_id=a.id and ac.category_id=x.id)`:table==="tags"?sql`exists(select 1 from platform_blog_article_tags at where at.article_id=a.id and at.tag_id=x.id)`:sql`exists(select 1 from platform_blog_topic_articles ta where ta.article_id=a.id and ta.topic_id=x.id)`;
    const row=(await sql<any>`select x.*,x.${sql.ref(actualName)} as name,t.slug translation_slug,t.language translation_language,(select count(*)::int from platform_blog_articles a where ${join} and a.robots_index and ((a.status='published' and a.published_at<=now())or(a.status='scheduled' and a.scheduled_at<=now()))) article_count from ${sql.table(`platform_blog_${table}`)} x left join ${sql.table(`platform_blog_${table}`)} t on t.translation_group_id=x.translation_group_id and t.id<>x.id where x.slug=${slug.normalize("NFC")} and x.language=${language} ${status}`.execute(this.db)).rows[0];
    if(!row)throw new NotFoundException("blog_landing_not_found");
    row.robots_index=Boolean(row.robots_index&&row.article_count>0&&String(row.description??row.short_bio??"").trim());
    if(table==="authors")row.links=Object.fromEntries(Object.entries(row.profile_links??{}).filter(([key,value])=>["linkedin","website","x"].includes(key)&&typeof value==="string"&&/^https:\/\//.test(value)));
    row.seo=this.landingSeo(kind,row);
    for(const key of ["id","translation_group_id","profile_links","profile_image_storage_key","translation_slug","translation_language"])delete row[key];
    return row;
  }
  publicCategory(slug:string,language="en"){return this.publicLanding("categories","category",slug,language);}
  publicTag(slug:string,language="en"){return this.publicLanding("tags","tag",slug,language);}
  publicAuthor(slug:string,language="en"){return this.publicLanding("authors","author",slug,language);}
  publicTopic(slug:string,language="en"){return this.publicLanding("topics","topic",slug,language);}
  async publicTags(language="en"){return(await sql<any>`select name,slug,description,robots_index as "robotsIndex" from platform_blog_tags t where language=${language} and active and exists(select 1 from platform_blog_article_tags at join platform_blog_articles a on a.id=at.article_id where at.tag_id=t.id and ((a.status='published' and a.published_at<=now())or(a.status='scheduled' and a.scheduled_at<=now()))) order by name`.execute(this.db)).rows;}
  async publicTopics(language="en"){return(await sql<any>`select title name,slug,description,robots_index as "robotsIndex" from platform_blog_topics t where language=${language} and status='published' and exists(select 1 from platform_blog_topic_articles ta join platform_blog_articles a on a.id=ta.article_id where ta.topic_id=t.id and ((a.status='published' and a.published_at<=now())or(a.status='scheduled' and a.scheduled_at<=now()))) order by title`.execute(this.db)).rows;}
  async rss(language="en") {
    if(!["en","ar"].includes(language))throw new NotFoundException();
    const rows=(await sql<any>`select a.slug,a.title,a.excerpt,a.published_at,u.display_name author,c.name category from platform_blog_articles a join platform_blog_authors u on u.id=a.author_id join platform_blog_categories c on c.id=a.category_id where a.language=${language} and a.robots_index and ((a.status='published' and a.published_at<=now())or(a.status='scheduled' and a.scheduled_at<=now())) order by coalesce(a.published_at,a.scheduled_at) desc limit 50`.execute(this.db)).rows;
    const esc=(v:unknown)=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
    const base=`https://tawseelhub.com${language==="ar"?"/ar":""}/blog`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${esc(language==="ar"?"مدونة توصـيل هب":"Tawseelhub Blog")}</title><link>${base}</link><description>${esc(language==="ar"?"معرفة عملية لعمليات التوصيل":"Practical delivery operations knowledge")}</description><language>${language}</language>${rows.map(r=>`<item><title>${esc(r.title)}</title><link>${base}/${encodeURIComponent(r.slug)}</link><guid isPermaLink="true">${base}/${encodeURIComponent(r.slug)}</guid><pubDate>${new Date(r.published_at).toUTCString()}</pubDate><description>${esc(r.excerpt)}</description><author>${esc(r.author)}</author><category>${esc(r.category)}</category></item>`).join("")}</channel></rss>`;
  }
  async recordNotFound(path:string,referer?:string){
    let cleanPath:string;try{const url=new URL(path,"https://tawseelhub.com");cleanPath=decodeURIComponent(url.pathname);}catch{return;}
    if(!/^\/(?:ar\/)?blog(?:\/|$)/.test(cleanPath)||cleanPath.length>500)return;
    let origin:string|null=null;try{if(referer)origin=new URL(referer).origin.slice(0,300);}catch{}
    await sql`insert into platform_public_not_found_paths(path,last_referer_origin) values(${cleanPath},${origin}) on conflict(path) do update set hit_count=platform_public_not_found_paths.hit_count+1,last_seen_at=now(),last_referer_origin=excluded.last_referer_origin`.execute(this.db);
  }
  async resolveRedirect(path:string){const row=(await sql<any>`update platform_public_redirects set hit_count=hit_count+1,last_hit_at=now() where from_path=${path} and active returning to_path as "to",status_code as "statusCode"`.execute(this.db)).rows[0];if(!row)throw new NotFoundException();return row;}
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
      await sql<any>`select a.id,a.slug,a.language,a.translation_group_id,a.category_id,a.title,a.seo_title,a.meta_description,a.robots_index,a.cornerstone,a.status,a.has_unpublished_changes,a.published_at,a.scheduled_at,a.updated_at,c.name category,u.display_name author from platform_blog_articles a join platform_blog_categories c on c.id=a.category_id join platform_blog_authors u on u.id=a.author_id where not exists (select 1 from platform_blog_publication_history h where h.article_id=a.id and h.event_type='deleted') order by a.updated_at desc`.execute(
        this.db,
      )
    ).rows;
  }
  async adminDetail(id: string) {
    const deleted = (await sql`select 1 from platform_blog_publication_history where article_id=${id}::uuid and event_type='deleted' limit 1`.execute(this.db)).rows.length > 0;
    if (deleted) throw new NotFoundException();
    const article = (
      await sql<any>`select * from platform_blog_articles where id=${id}::uuid`.execute(this.db)
    ).rows[0];
    if (!article) throw new NotFoundException();
    const [categories,tags,related]=await Promise.all([
      sql<{id:string}>`select category_id id from platform_blog_article_categories where article_id=${id}::uuid`.execute(this.db),
      sql<{id:string}>`select tag_id id from platform_blog_article_tags where article_id=${id}::uuid`.execute(this.db),
      sql<{id:string}>`select related_article_id id from platform_blog_article_relations where article_id=${id}::uuid and relation_type='editorial' order by sort_order`.execute(this.db),
    ]);
    article.category_ids=categories.rows.map(x=>x.id);
    article.tag_ids=tags.rows.map(x=>x.id);
    article.related_article_ids=related.rows.map(x=>x.id);
    if (article.draft_payload) {
      const draft = article.draft_payload;
      return {
        ...article,
        author_id: draft.authorId,
        canonical_url: draft.canonicalUrl,
        category_id: draft.categoryId,
        category_ids: draft.categoryIds ?? [draft.categoryId],
        content: draft.content,
        excerpt: draft.excerpt,
        featured_image_alt: draft.featuredImageAlt,
        featured_image_public_url: draft.featuredImagePublicUrl,
        language: draft.language,
        tag_ids: draft.tagIds ?? [],
        related_article_ids: draft.relatedArticleIds ?? [],
        cornerstone: draft.cornerstone ?? article.cornerstone,
        translation_group_id: draft.translationGroupId ?? article.translation_group_id,
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
        await sql<any>`select * from platform_blog_categories order by sort_order`.execute(
          this.db,
        )
      ).rows,
      authors: (
        await sql<any>`select * from platform_blog_authors order by display_name`.execute(
          this.db,
        )
      ).rows,
      tags:(await sql<any>`select * from platform_blog_tags order by language,name`.execute(this.db)).rows,
      topics:(await sql<any>`select t.*,(select coalesce(array_agg(category_id),'{}')from platform_blog_topic_categories where topic_id=t.id)as category_ids,(select coalesce(array_agg(tag_id),'{}')from platform_blog_topic_tags where topic_id=t.id)as tag_ids,(select coalesce(array_agg(article_id order by sort_order),'{}')from platform_blog_topic_articles where topic_id=t.id)as article_ids from platform_blog_topics t order by language,title`.execute(this.db)).rows,
    };
  }
  async create(input: SaveBlogArticleDto, actor: string) {
    input.slug = validateLocalizedSlug(input.slug);
    await this.ensureCategoryLanguage(input.categoryId,input.language);
    await this.validateRelationships(input);
    const blocks = cleanBlocks(input.content);
    if (!blocks.length) throw new BadRequestException("article_content_required");
    const draftPayload = articlePayload(input, blocks);
    try {
      const row =
        await sql<any>`insert into platform_blog_articles(slug,language,translation_group_id,title,excerpt,content,author_id,category_id,cornerstone,featured_image_public_url,featured_image_alt,featured_image_width,featured_image_height,seo_title,meta_description,canonical_url,robots_index,robots_follow,social_title,social_description,social_image_url,social_image_alt,social_image_width,social_image_height,created_by_account_id,updated_by_account_id,draft_payload,has_unpublished_changes,last_unpublished_change_at) values(${input.slug},${input.language},coalesce(${input.translationGroupId ?? null}::uuid,gen_random_uuid()),${cleanText(input.title)},${cleanText(input.excerpt)},${JSON.stringify(blocks)}::jsonb,${input.authorId}::uuid,${input.categoryId}::uuid,${input.cornerstone},${input.featuredImagePublicUrl ?? null},${input.featuredImageAlt ? cleanText(input.featuredImageAlt) : null},${input.featuredImageWidth ?? null},${input.featuredImageHeight ?? null},${input.seoTitle ? cleanText(input.seoTitle) : null},${input.metaDescription ? cleanText(input.metaDescription) : null},${input.canonicalUrl ?? null},${input.robotsIndex},${input.robotsFollow},${input.socialTitle ? cleanText(input.socialTitle) : null},${input.socialDescription ? cleanText(input.socialDescription) : null},${input.socialImageUrl ?? null},${input.socialImageAlt ? cleanText(input.socialImageAlt) : null},${input.socialImageWidth ?? null},${input.socialImageHeight ?? null},${actor}::uuid,${actor}::uuid,${JSON.stringify(draftPayload)}::jsonb,true,now()) returning *`.execute(
          this.db,
        );
      const article = row.rows[0];
      await this.syncRelationships(article.id,draftPayload);
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
    return this.withArticleLock(id, service => service.updateLocked(id, input, actor));
  }
  private async updateLocked(id: string, input: SaveBlogArticleDto, actor: string) {
    input.slug = validateLocalizedSlug(input.slug);
    await this.ensureCategoryLanguage(input.categoryId,input.language);
    await this.validateRelationships(input);
    const current = await this.adminDetail(id);
    const blocks = cleanBlocks(input.content);
    const draftPayload = {...articlePayload(input, blocks),translationGroupId:input.translationGroupId??current.translation_group_id};
    if (!blocks.length) throw new BadRequestException("article_content_required");
    const persisted = (await sql<any>`select status,slug from platform_blog_articles where id=${id}::uuid`.execute(this.db)).rows[0];
    if (persisted.status === "published") {
      await sql`update platform_blog_articles set draft_payload=${JSON.stringify(draftPayload)}::jsonb,has_unpublished_changes=true,last_unpublished_change_at=now(),updated_by_account_id=${actor}::uuid,updated_at=now() where id=${id}::uuid`.execute(this.db);
      await sql`insert into platform_blog_publication_history(article_id,event_type,old_status,new_status,actor_account_id,detail) values(${id}::uuid,'draft_saved','published','published',${actor}::uuid,${JSON.stringify({ hasUnpublishedChanges: true })}::jsonb)`.execute(this.db);
      return this.adminDetail(id);
    }
    try {
      await sql`update platform_blog_articles set slug=${input.slug},language=${input.language},translation_group_id=${draftPayload.translationGroupId}::uuid,title=${cleanText(input.title)},excerpt=${cleanText(input.excerpt)},content=${JSON.stringify(blocks)}::jsonb,author_id=${input.authorId}::uuid,category_id=${input.categoryId}::uuid,cornerstone=${input.cornerstone},featured_image_public_url=${input.featuredImagePublicUrl ?? null},featured_image_alt=${input.featuredImageAlt ? cleanText(input.featuredImageAlt) : null},featured_image_width=${input.featuredImageWidth ?? null},featured_image_height=${input.featuredImageHeight ?? null},seo_title=${input.seoTitle ? cleanText(input.seoTitle) : null},meta_description=${input.metaDescription ? cleanText(input.metaDescription) : null},canonical_url=${input.canonicalUrl ?? null},robots_index=${input.robotsIndex},robots_follow=${input.robotsFollow},social_title=${input.socialTitle ? cleanText(input.socialTitle) : null},social_description=${input.socialDescription ? cleanText(input.socialDescription) : null},social_image_url=${input.socialImageUrl ?? null},social_image_alt=${input.socialImageAlt ? cleanText(input.socialImageAlt) : null},social_image_width=${input.socialImageWidth ?? null},social_image_height=${input.socialImageHeight ?? null},draft_payload=${JSON.stringify(draftPayload)}::jsonb,has_unpublished_changes=true,last_unpublished_change_at=now(),updated_by_account_id=${actor}::uuid,updated_content_at=now(),updated_at=now() where id=${id}::uuid`.execute(
        this.db,
      );
      await this.syncRelationships(id,draftPayload);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ConflictException("blog_slug_exists");
      throw e;
    }
    return this.adminDetail(id);
  }
  async status(id: string, input: ArticleStatusDto, actor: string) {
    return this.withArticleLock(id, service => service.statusLocked(id, input, actor));
  }
  private async statusLocked(id: string, input: ArticleStatusDto, actor: string) {
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
          const oldPath = localizedBlogPath(old.language, old.slug);
          const newPath = localizedBlogPath(String(draft.language), String(draft.slug));
          // Returning to an earlier slug must not create A -> B -> A. Remove
          // any redirect owned by the now-live destination, then flatten every
          // historical alias that pointed at the previous live URL.
          await sql`delete from platform_public_redirects where from_path=${newPath}`.execute(this.db);
          await sql`update platform_public_redirects set to_path=${newPath} where to_path=${oldPath} and from_path<>${newPath}`.execute(this.db);
          await sql`insert into platform_public_redirects(from_path,to_path,created_by_account_id) values(${oldPath},${newPath},${actor}::uuid) on conflict(from_path) do update set to_path=excluded.to_path`.execute(this.db);
        }
        await sql`update platform_blog_articles set slug=${String(draft.slug)},language=${String(draft.language)},translation_group_id=${(draft.translationGroupId as string | undefined) ?? old.translation_group_id}::uuid,title=${String(draft.title)},excerpt=${String(draft.excerpt)},content=${JSON.stringify(draft.content)}::jsonb,author_id=${String(draft.authorId)}::uuid,category_id=${String(draft.categoryId)}::uuid,cornerstone=${Boolean(draft.cornerstone)},featured_image_public_url=${draft.featuredImagePublicUrl as string | null},featured_image_alt=${draft.featuredImageAlt as string | null},featured_image_width=${draft.featuredImageWidth as number | null},featured_image_height=${draft.featuredImageHeight as number | null},seo_title=${draft.seoTitle as string | null},meta_description=${draft.metaDescription as string | null},canonical_url=${draft.canonicalUrl as string | null},robots_index=${Boolean(draft.robotsIndex)},robots_follow=${Boolean(draft.robotsFollow)},social_title=${draft.socialTitle as string | null},social_description=${draft.socialDescription as string | null},social_image_url=${draft.socialImageUrl as string | null},social_image_alt=${draft.socialImageAlt as string | null},social_image_width=${draft.socialImageWidth as number | null},social_image_height=${draft.socialImageHeight as number | null},status='published',scheduled_at=null,published_at=coalesce(published_at,now()),published_by_account_id=${actor}::uuid,draft_payload=null,has_unpublished_changes=false,last_unpublished_change_at=null,updated_by_account_id=${actor}::uuid,updated_content_at=now(),updated_at=now() where id=${id}::uuid`.execute(this.db);
        await this.syncRelationships(id,draft);
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
  // Serialize edits/publication/deletion; preserve history and shared media.
  private async withArticleLock<T>(id: string, action: (service: BlogService) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async transaction => {
      const row = (await sql`select id from platform_blog_articles where id=${id}::uuid for update`.execute(transaction)).rows[0];
      if (!row) throw new NotFoundException();
      const service = new BlogService(transaction);
      await service.adminDetail(id);
      return action(service);
    });
  }
  async deleteArticle(id: string, actor: string) {
    return this.withArticleLock(id, async service => {
      const article = await service.adminDetail(id);
      if (article.status !== "unpublished") throw new ConflictException("Unpublish the article before deleting it.");
      await sql`update platform_blog_articles set status='archived',scheduled_at=null,updated_by_account_id=${actor}::uuid,updated_at=now() where id=${id}::uuid`.execute(service.db);
      await sql`insert into platform_blog_publication_history(article_id,event_type,old_status,new_status,actor_account_id,detail) values(${id}::uuid,'deleted','unpublished','archived',${actor}::uuid,'{"recoverable":true}'::jsonb)`.execute(service.db);
    });
  }
  async createCategory(input: CategoryDto) {
    input.slug = validateLocalizedSlug(input.slug);
    return (
      await sql<any>`insert into platform_blog_categories(name,slug,language,translation_group_id,description,seo_title,meta_description,robots_index,robots_follow,social_title,social_description,social_image_url,active,sort_order) values(${cleanText(input.name)},${input.slug},${input.language},coalesce(${input.translationGroupId ?? null}::uuid,gen_random_uuid()),${input.description ? cleanText(input.description) : null},${input.seoTitle?cleanText(input.seoTitle):null},${input.metaDescription?cleanText(input.metaDescription):null},${input.robotsIndex},${input.robotsFollow},${input.socialTitle?cleanText(input.socialTitle):null},${input.socialDescription?cleanText(input.socialDescription):null},${input.socialImageUrl??null},${input.active},${input.sortOrder}) returning *`.execute(
        this.db,
      )
    ).rows[0];
  }
  async updateCategory(id:string,input:CategoryDto){input.slug=validateLocalizedSlug(input.slug);const row=(await sql<any>`update platform_blog_categories set name=${cleanText(input.name)},slug=${input.slug},language=${input.language},translation_group_id=coalesce(${input.translationGroupId??null}::uuid,translation_group_id),description=${input.description?cleanText(input.description):null},seo_title=${input.seoTitle?cleanText(input.seoTitle):null},meta_description=${input.metaDescription?cleanText(input.metaDescription):null},robots_index=${input.robotsIndex},robots_follow=${input.robotsFollow},social_title=${input.socialTitle?cleanText(input.socialTitle):null},social_description=${input.socialDescription?cleanText(input.socialDescription):null},social_image_url=${input.socialImageUrl??null},active=${input.active},sort_order=${input.sortOrder},updated_at=now() where id=${id}::uuid returning *`.execute(this.db)).rows[0];if(!row)throw new NotFoundException();return row;}
  async saveTag(id:string|undefined,input:TagDto){input.slug=validateLocalizedSlug(input.slug);const values=[cleanText(input.name),input.slug,input.language,input.translationGroupId??null,input.description?cleanText(input.description):null,input.seoTitle?cleanText(input.seoTitle):null,input.metaDescription?cleanText(input.metaDescription):null,input.robotsIndex,input.robotsFollow,input.socialTitle?cleanText(input.socialTitle):null,input.socialDescription?cleanText(input.socialDescription):null,input.socialImageUrl??null,input.active] as const;if(!id)return(await sql<any>`insert into platform_blog_tags(name,slug,language,translation_group_id,description,seo_title,meta_description,robots_index,robots_follow,social_title,social_description,social_image_url,active)values(${values[0]},${values[1]},${values[2]},coalesce(${values[3]}::uuid,gen_random_uuid()),${values[4]},${values[5]},${values[6]},${values[7]},${values[8]},${values[9]},${values[10]},${values[11]},${values[12]})returning *`.execute(this.db)).rows[0];const row=(await sql<any>`update platform_blog_tags set name=${values[0]},slug=${values[1]},language=${values[2]},translation_group_id=coalesce(${values[3]}::uuid,translation_group_id),description=${values[4]},seo_title=${values[5]},meta_description=${values[6]},robots_index=${values[7]},robots_follow=${values[8]},social_title=${values[9]},social_description=${values[10]},social_image_url=${values[11]},active=${values[12]},updated_at=now()where id=${id}::uuid returning *`.execute(this.db)).rows[0];if(!row)throw new NotFoundException();return row;}
  async saveAuthor(id:string|undefined,input:AuthorDto){input.slug=validateLocalizedSlug(input.slug);const links=Object.fromEntries(Object.entries(input.profileLinks??{}).filter(([key,value])=>["linkedin","website","x"].includes(key)&&typeof value==="string"&&/^https:\/\//.test(value)));if(!id)return(await sql<any>`insert into platform_blog_authors(display_name,slug,language,translation_group_id,role_title,short_bio,biography,expertise,profile_image_public_url,profile_links,seo_title,meta_description,robots_index,robots_follow,social_title,social_description,active)values(${cleanText(input.displayName)},${input.slug},${input.language},coalesce(${input.translationGroupId??null}::uuid,gen_random_uuid()),${input.roleTitle?cleanText(input.roleTitle):null},${input.shortBio?cleanText(input.shortBio):null},${input.biography?cleanText(input.biography):null},${input.expertise.map(cleanText).filter(Boolean)},${input.profileImagePublicUrl??null},${JSON.stringify(links)}::jsonb,${input.seoTitle?cleanText(input.seoTitle):null},${input.metaDescription?cleanText(input.metaDescription):null},${input.robotsIndex},${input.robotsFollow},${input.socialTitle?cleanText(input.socialTitle):null},${input.socialDescription?cleanText(input.socialDescription):null},${input.active})returning *`.execute(this.db)).rows[0];const row=(await sql<any>`update platform_blog_authors set display_name=${cleanText(input.displayName)},slug=${input.slug},language=${input.language},translation_group_id=coalesce(${input.translationGroupId??null}::uuid,translation_group_id),role_title=${input.roleTitle?cleanText(input.roleTitle):null},short_bio=${input.shortBio?cleanText(input.shortBio):null},biography=${input.biography?cleanText(input.biography):null},expertise=${input.expertise.map(cleanText).filter(Boolean)},profile_image_public_url=${input.profileImagePublicUrl??null},profile_links=${JSON.stringify(links)}::jsonb,seo_title=${input.seoTitle?cleanText(input.seoTitle):null},meta_description=${input.metaDescription?cleanText(input.metaDescription):null},robots_index=${input.robotsIndex},robots_follow=${input.robotsFollow},social_title=${input.socialTitle?cleanText(input.socialTitle):null},social_description=${input.socialDescription?cleanText(input.socialDescription):null},active=${input.active},updated_at=now()where id=${id}::uuid returning *`.execute(this.db)).rows[0];if(!row)throw new NotFoundException();return row;}
  async saveTopic(id:string|undefined,input:TopicDto){input.slug=validateLocalizedSlug(input.slug);const persist=async(topicId:string)=>{await sql`delete from platform_blog_topic_categories where topic_id=${topicId}::uuid;insert into platform_blog_topic_categories(topic_id,category_id)select ${topicId}::uuid,x from unnest(${input.categoryIds}::uuid[])x;delete from platform_blog_topic_tags where topic_id=${topicId}::uuid;insert into platform_blog_topic_tags(topic_id,tag_id)select ${topicId}::uuid,x from unnest(${input.tagIds}::uuid[])x;delete from platform_blog_topic_articles where topic_id=${topicId}::uuid;insert into platform_blog_topic_articles(topic_id,article_id,sort_order)select ${topicId}::uuid,x,n from unnest(${input.articleIds}::uuid[])with ordinality u(x,n)`.execute(this.db);};let row;if(id)row=(await sql<any>`update platform_blog_topics set title=${cleanText(input.title)},slug=${input.slug},language=${input.language},translation_group_id=coalesce(${input.translationGroupId??null}::uuid,translation_group_id),description=${cleanText(input.description)},featured_content=${input.featuredContent?cleanText(input.featuredContent):null},seo_title=${input.seoTitle?cleanText(input.seoTitle):null},meta_description=${input.metaDescription?cleanText(input.metaDescription):null},robots_index=${input.robotsIndex},robots_follow=${input.robotsFollow},social_title=${input.socialTitle?cleanText(input.socialTitle):null},social_description=${input.socialDescription?cleanText(input.socialDescription):null},social_image_url=${input.socialImageUrl??null},status=${input.status},updated_at=now()where id=${id}::uuid returning *`.execute(this.db)).rows[0];else row=(await sql<any>`insert into platform_blog_topics(title,slug,language,translation_group_id,description,featured_content,seo_title,meta_description,robots_index,robots_follow,social_title,social_description,social_image_url,status)values(${cleanText(input.title)},${input.slug},${input.language},coalesce(${input.translationGroupId??null}::uuid,gen_random_uuid()),${cleanText(input.description)},${input.featuredContent?cleanText(input.featuredContent):null},${input.seoTitle?cleanText(input.seoTitle):null},${input.metaDescription?cleanText(input.metaDescription):null},${input.robotsIndex},${input.robotsFollow},${input.socialTitle?cleanText(input.socialTitle):null},${input.socialDescription?cleanText(input.socialDescription):null},${input.socialImageUrl??null},${input.status})returning *`.execute(this.db)).rows[0];if(!row)throw new NotFoundException();await persist(row.id);return row;}
  async redirects(){return(await sql<any>`select * from platform_public_redirects order by created_at desc`.execute(this.db)).rows;}
  async saveRedirect(input:ManualRedirectDto,actor:string){if(input.fromPath===input.toPath)throw new BadRequestException("redirect_loop");const destination=(await sql`
    select 1 from platform_blog_articles where ${input.toPath}=case when language='ar'then'/ar/blog/'||slug else'/blog/'||slug end and ((status='published'and published_at<=now())or(status='scheduled'and scheduled_at<=now()))
    union all select 1 from platform_blog_categories where ${input.toPath}=case when language='ar'then'/ar/blog/category/'||slug else'/blog/category/'||slug end and active
    union all select 1 from platform_blog_tags where ${input.toPath}=case when language='ar'then'/ar/blog/tag/'||slug else'/blog/tag/'||slug end and active
    union all select 1 from platform_blog_topics where ${input.toPath}=case when language='ar'then'/ar/blog/topic/'||slug else'/blog/topic/'||slug end and status='published'
    union all select 1 from platform_blog_authors where ${input.toPath}=case when language='ar'then'/ar/blog/author/'||slug else'/blog/author/'||slug end and active
    limit 1`.execute(this.db)).rows[0];if(!destination)throw new BadRequestException("redirect_destination_not_public");const chain=(await sql`with recursive links(path)as(select ${input.toPath} union all select r.to_path from platform_public_redirects r join links l on r.from_path=l.path where r.active)select 1 from links where path=${input.fromPath} limit 1`.execute(this.db)).rows[0];if(chain)throw new BadRequestException("redirect_loop");return(await sql<any>`insert into platform_public_redirects(from_path,to_path,status_code,active,source_content_type,created_by_account_id)values(${input.fromPath},${input.toPath},${input.statusCode},${input.active},'manual',${actor}::uuid)on conflict(from_path)do update set to_path=excluded.to_path,status_code=excluded.status_code,active=excluded.active returning *`.execute(this.db)).rows[0];}
  async notFoundPaths(){return(await sql<any>`select * from platform_public_not_found_paths order by last_seen_at desc limit 500`.execute(this.db)).rows;}
  async seoReadiness(id:string){const a=await this.adminDetail(id);const content=JSON.stringify(a.content??[]);const duplicateTitle=a.seo_title?(await sql`select 1 from platform_blog_articles where id<>${id}::uuid and language=${a.language} and robots_index and status='published' and lower(seo_title)=lower(${a.seo_title})limit 1`.execute(this.db)).rows.length>0:false;const duplicateMeta=a.meta_description?(await sql`select 1 from platform_blog_articles where id<>${id}::uuid and language=${a.language} and robots_index and status='published' and lower(meta_description)=lower(${a.meta_description})limit 1`.execute(this.db)).rows.length>0:false;const checks=[{key:"seo_title",severity:"warning",pass:Boolean(a.seo_title),message:"Add an SEO title."},{key:"unique_title",severity:"warning",pass:!duplicateTitle,message:"SEO title is already used by published content."},{key:"meta_description",severity:"warning",pass:Boolean(a.meta_description),message:"Add a meta description."},{key:"unique_meta",severity:"warning",pass:!duplicateMeta,message:"Meta description is already used by published content."},{key:"featured_image",severity:"warning",pass:Boolean(a.featured_image_public_url),message:"Add a featured image."},{key:"image_alt",severity:"warning",pass:!a.featured_image_public_url||Boolean(a.featured_image_alt),message:"Describe the featured image."},{key:"author",severity:"blocking",pass:Boolean(a.author_id),message:"Select an author."},{key:"category",severity:"blocking",pass:Boolean(a.category_id),message:"Select a primary category."},{key:"internal_links",severity:"warning",pass:/href=/.test(content)||a.related_article_ids.length>0,message:"Add a relevant internal link or related article."},{key:"indexability",severity:"warning",pass:Boolean(a.robots_index),message:"This published article is noindex."},{key:"arabic_metadata",severity:"warning",pass:a.language!=="ar"||Boolean(a.seo_title&&a.meta_description&&a.translation_group_id),message:"Complete Arabic SEO metadata and translation linkage."}];return{status:checks.some(x=>!x.pass&&x.severity==="blocking")?"needs_attention":checks.some(x=>!x.pass)?"warnings":"seo_ready",checks,recommendations:(await sql<any>`select id,title,slug,cornerstone from platform_blog_articles where id<>${id}::uuid and language=${a.language} and status='published' order by cornerstone desc,(category_id=${a.category_id}::uuid)desc,updated_at desc limit 8`.execute(this.db)).rows};}
  async seoHealth(){
    const summary=(await sql<any>`select count(*)filter(where status='published'and meta_description is null)::int as "missingMeta",count(*)filter(where status='published'and featured_image_public_url is null)::int as "missingImage",count(*)filter(where status='published'and featured_image_public_url is not null and featured_image_alt is null)::int as "missingAlt",count(*)filter(where status='published'and featured_image_public_url is not null and(featured_image_width is null or featured_image_height is null))::int as "missingImageDimensions",count(*)filter(where status='published'and featured_image_public_url is not null and featured_image_width<1200)::int as "smallFeaturedImages",count(*)filter(where status='published'and not robots_index)::int as "noindexPublished",count(*)filter(where status='published'and coalesce(last_reviewed_at,updated_content_at,published_at)<now()-interval '365 days')::int as "reviewRecommended",count(*)filter(where status='published'and robots_index and not exists(select 1 from platform_blog_article_relations r where r.related_article_id=platform_blog_articles.id)and not exists(select 1 from platform_blog_articles source where source.id<>platform_blog_articles.id and source.status='published' and source.content::text like '%/blog/'||platform_blog_articles.slug||'%'))::int as "orphanArticles" from platform_blog_articles`.execute(this.db)).rows[0];
    const taxonomy=(await sql<any>`select (select count(*)::int from(select language,lower(seo_title)from platform_blog_articles where status='published'and robots_index and nullif(btrim(seo_title),'')is not null group by language,lower(seo_title)having count(*)>1)x)as "duplicateSeoTitles",(select count(*)::int from platform_blog_categories c where c.active and c.robots_index and(nullif(btrim(c.description),'')is null or not exists(select 1 from platform_blog_article_categories ac join platform_blog_articles a on a.id=ac.article_id where ac.category_id=c.id and a.status='published'and a.robots_index)))as "thinIndexableCategories"`.execute(this.db)).rows[0];
    const articles=(await sql<any>`select id,language,slug,status,content from platform_blog_articles where status<>'archived'`.execute(this.db)).rows;
    const redirects=(await sql<{from_path:string}>`select from_path from platform_public_redirects where active`.execute(this.db)).rows;
    const publicPaths=new Set(articles.filter(a=>a.status==='published').map(a=>localizedBlogPath(a.language,a.slug)));
    const knownPaths=new Map(articles.map(a=>[localizedBlogPath(a.language,a.slug),a.status]));
    const redirected=new Set(redirects.map(r=>r.from_path));
    let brokenInternalLinks=0,redirectedInternalLinks=0,unpublishedInternalLinks=0;
    for(const article of articles.filter(a=>a.status==='published'))for(const match of JSON.stringify(article.content??[]).matchAll(/href=\\?["'](\/(?:ar\/)?blog\/[^"'?#\\]+)/g)){
      const path=match[1]!.replace(/\\/g,'');
      if(redirected.has(path))redirectedInternalLinks++;
      else if(knownPaths.has(path)&&!publicPaths.has(path))unpublishedInternalLinks++;
      else if(!publicPaths.has(path)&&!/^\/(?:ar\/)?blog\/(?:category|tag|topic|author)\//.test(path))brokenInternalLinks++;
    }
    return{...summary,...taxonomy,brokenInternalLinks,redirectedInternalLinks,unpublishedInternalLinks};
  }
  async productionSeoHealth(){
    const origin="https://tawseelhub.com";
    const inspect=async(path:string)=>{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),5000);try{const response=await fetch(`${origin}${path}`,{headers:{accept:"text/html,application/xml,text/plain"},signal:controller.signal,redirect:"manual"});const body=await response.text();return{path,status:response.status,contentType:response.headers.get("content-type")??"",body:body.slice(0,1_000_000)};}catch(error){return{path,status:0,contentType:"",body:"",error:error instanceof Error?error.name:"unavailable"};}finally{clearTimeout(timeout);}};
    const [home,robots,sitemap,rssEn,rssAr]=await Promise.all([inspect("/"),inspect("/robots.txt"),inspect("/sitemap.xml"),inspect("/blog/rss.xml"),inspect("/ar/blog/rss.xml")]);
    const sitemapUrls=[...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match=>match[1]??"");
    const checks=[
      {key:"homepage",pass:home.status===200,message:`Homepage HTTP ${home.status||"unavailable"}`},
      {key:"canonical",pass:/<link[^>]+rel=["']canonical["'][^>]+href=["']https:\/\/tawseelhub\.com\//i.test(home.body),message:"Homepage has a production canonical in initial HTML."},
      {key:"robots",pass:robots.status===200&&/Sitemap:\s*https:\/\/tawseelhub\.com\/sitemap\.xml/i.test(robots.body)&&!/Disallow:\s*\/$/m.test(robots.body),message:`robots.txt HTTP ${robots.status||"unavailable"} and production sitemap reference`},
      {key:"sitemap",pass:sitemap.status===200&&/application\/xml|text\/xml/i.test(sitemap.contentType)&&sitemapUrls.length>0,message:`Sitemap HTTP ${sitemap.status||"unavailable"}; ${sitemapUrls.length} URLs`},
      {key:"sitemap_domains",pass:sitemapUrls.every(url=>url.startsWith(`${origin}/`)&&!/localhost|\.onrender\.com/i.test(url)),message:"Sitemap contains production-domain URLs only."},
      {key:"rss_en",pass:rssEn.status===200&&/<rss\b/i.test(rssEn.body),message:`English RSS HTTP ${rssEn.status||"unavailable"}`},
      {key:"rss_ar",pass:rssAr.status===200&&/<rss\b/i.test(rssAr.body),message:`Arabic RSS HTTP ${rssAr.status||"unavailable"}`},
      {key:"structured_data",pass:/application\/ld\+json/i.test(home.body),message:"Homepage structured data is present in initial HTML."},
    ];
    return{status:checks.every(check=>check.pass)?"healthy":"needs_attention",checkedAt:new Date().toISOString(),source:"live production HTTP checks",sitemapUrlCount:sitemapUrls.length,checks,searchConsole:{integration:"manual",dataFreshness:"Search Console and field Core Web Vitals are delayed and are not available through this application."}};
  }
  async adminSettings() {
    return (
      await sql<any>`select * from platform_public_site_settings where id=true`.execute(this.db)
    ).rows[0];
  }
  async updateSettings(input: PublicSiteSettingsDto, actor: string) {
    const canonicalBaseUrl = safeCanonical(input.canonicalBaseUrl, "/");
    await sql`update platform_public_site_settings set canonical_base_url=${canonicalBaseUrl},default_site_title=${cleanText(input.defaultSiteTitle)},default_meta_description=${cleanText(input.defaultMetaDescription)},default_social_image=${input.defaultSocialImage ?? null},search_console_verification=${input.searchConsoleVerification ?? null},gtm_container_id=${input.gtmContainerId ?? null},ga4_measurement_id=${input.ga4MeasurementId ?? null},analytics_enabled=${input.analyticsEnabled},clarity_project_id=${input.clarityProjectId ?? null},clarity_enabled=${input.clarityEnabled},tracking_environment=${input.trackingEnvironment},updated_by_account_id=${actor}::uuid,updated_at=now() where id=true`.execute(
      this.db,
    );
    return this.adminSettings();
  }
}
