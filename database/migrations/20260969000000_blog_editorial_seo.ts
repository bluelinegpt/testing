import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_blog_categories
      add column robots_index boolean not null default false,
      add column robots_follow boolean not null default true,
      add column social_title text,
      add column social_description text,
      add column social_image_url text;

    update platform_blog_categories c
       set robots_index = true
     where c.active
       and nullif(btrim(c.description), '') is not null
       and exists (
         select 1 from platform_blog_articles a
          where a.category_id = c.id
            and a.robots_index
            and ((a.status = 'published' and a.published_at <= now())
              or (a.status = 'scheduled' and a.scheduled_at <= now()))
       );

    alter table platform_blog_tags
      add column description text,
      add column translation_group_id uuid default gen_random_uuid(),
      add column seo_title text,
      add column meta_description text,
      add column robots_index boolean not null default false,
      add column robots_follow boolean not null default true,
      add column social_title text,
      add column social_description text,
      add column social_image_url text,
      add column active boolean not null default true,
      add column updated_at timestamptz not null default now();
    update platform_blog_tags set translation_group_id = gen_random_uuid() where translation_group_id is null;
    alter table platform_blog_tags alter column translation_group_id set not null;
    alter table platform_blog_tags add constraint platform_blog_tags_translation_language_unique unique(translation_group_id, language);

    alter table platform_blog_authors
      add column slug text,
      add column language text not null default 'en' check(language in ('en','ar')),
      add column translation_group_id uuid default gen_random_uuid(),
      add column biography text,
      add column expertise text[] not null default '{}',
      add column profile_image_public_url text,
      add column profile_links jsonb not null default '{}' check(jsonb_typeof(profile_links) = 'object'),
      add column seo_title text,
      add column meta_description text,
      add column robots_index boolean not null default false,
      add column robots_follow boolean not null default true,
      add column social_title text,
      add column social_description text;
    update platform_blog_authors
       set slug = case
         when lower(display_name) = 'tawseelhub team' then 'tawseelhub-team'
         else 'author-' || left(replace(id::text, '-', ''), 12)
       end,
       translation_group_id = coalesce(translation_group_id, gen_random_uuid());
    alter table platform_blog_authors alter column slug set not null;
    alter table platform_blog_authors alter column translation_group_id set not null;
    alter table platform_blog_authors add constraint platform_blog_authors_language_slug_unique unique(language, slug);
    alter table platform_blog_authors add constraint platform_blog_authors_translation_language_unique unique(translation_group_id, language);

    alter table platform_blog_articles
      add column cornerstone boolean not null default false,
      add column last_reviewed_at timestamptz,
      add column reviewed_by_account_id uuid references accounts(id) on delete set null;

    create table platform_blog_article_categories (
      article_id uuid not null references platform_blog_articles(id) on delete cascade,
      category_id uuid not null references platform_blog_categories(id) on delete restrict,
      primary key(article_id, category_id)
    );
    insert into platform_blog_article_categories(article_id, category_id)
    select id, category_id from platform_blog_articles on conflict do nothing;

    create table platform_blog_article_relations (
      article_id uuid not null references platform_blog_articles(id) on delete cascade,
      related_article_id uuid not null references platform_blog_articles(id) on delete cascade,
      relation_type text not null check(relation_type in ('supporting','editorial')),
      sort_order integer not null default 100,
      primary key(article_id, related_article_id),
      check(article_id <> related_article_id)
    );

    create table platform_blog_topics (
      id uuid primary key default gen_random_uuid(),
      translation_group_id uuid not null default gen_random_uuid(),
      language text not null check(language in ('en','ar')),
      title text not null,
      slug text not null,
      description text not null,
      featured_content text,
      seo_title text,
      meta_description text,
      robots_index boolean not null default false,
      robots_follow boolean not null default true,
      social_title text,
      social_description text,
      social_image_url text,
      status text not null default 'draft' check(status in ('draft','published','archived')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(language, slug),
      unique(translation_group_id, language)
    );
    create table platform_blog_topic_categories (
      topic_id uuid not null references platform_blog_topics(id) on delete cascade,
      category_id uuid not null references platform_blog_categories(id) on delete restrict,
      primary key(topic_id, category_id)
    );
    create table platform_blog_topic_tags (
      topic_id uuid not null references platform_blog_topics(id) on delete cascade,
      tag_id uuid not null references platform_blog_tags(id) on delete restrict,
      primary key(topic_id, tag_id)
    );
    create table platform_blog_topic_articles (
      topic_id uuid not null references platform_blog_topics(id) on delete cascade,
      article_id uuid not null references platform_blog_articles(id) on delete restrict,
      sort_order integer not null default 100,
      primary key(topic_id, article_id)
    );

    alter table platform_public_redirects
      add column active boolean not null default true,
      add column source_content_type text,
      add column source_content_id uuid,
      add column hit_count bigint not null default 0,
      add column last_hit_at timestamptz;

    create table platform_public_not_found_paths (
      path text primary key,
      hit_count bigint not null default 1,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      last_referer_origin text
    );

    create index platform_blog_article_categories_category_idx on platform_blog_article_categories(category_id, article_id);
    create index platform_blog_article_tags_tag_idx on platform_blog_article_tags(tag_id, article_id);
    create index platform_blog_topics_public_idx on platform_blog_topics(language, status, robots_index);
    create index platform_public_not_found_paths_last_seen_idx on platform_public_not_found_paths(last_seen_at desc);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table platform_public_not_found_paths;
    alter table platform_public_redirects
      drop column last_hit_at,
      drop column hit_count,
      drop column source_content_id,
      drop column source_content_type,
      drop column active;
    drop table platform_blog_topic_articles;
    drop table platform_blog_topic_tags;
    drop table platform_blog_topic_categories;
    drop table platform_blog_topics;
    drop table platform_blog_article_relations;
    drop table platform_blog_article_categories;
    alter table platform_blog_articles
      drop column reviewed_by_account_id,
      drop column last_reviewed_at,
      drop column cornerstone;
    alter table platform_blog_authors
      drop constraint platform_blog_authors_translation_language_unique,
      drop constraint platform_blog_authors_language_slug_unique,
      drop column social_description,
      drop column social_title,
      drop column robots_follow,
      drop column robots_index,
      drop column meta_description,
      drop column seo_title,
      drop column profile_links,
      drop column profile_image_public_url,
      drop column expertise,
      drop column biography,
      drop column translation_group_id,
      drop column language,
      drop column slug;
    alter table platform_blog_tags
      drop constraint platform_blog_tags_translation_language_unique,
      drop column updated_at,
      drop column active,
      drop column social_image_url,
      drop column social_description,
      drop column social_title,
      drop column robots_follow,
      drop column robots_index,
      drop column meta_description,
      drop column seo_title,
      drop column translation_group_id,
      drop column description;
    alter table platform_blog_categories
      drop column social_image_url,
      drop column social_description,
      drop column social_title,
      drop column robots_follow,
      drop column robots_index;
  `.execute(database);
}
