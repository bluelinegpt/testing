import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table platform_seo_guides (
      id uuid primary key default gen_random_uuid(),
      internal_title text not null,
      title text not null,
      slug text not null,
      language text not null check (language in ('en','ar')),
      translation_group_id uuid not null default gen_random_uuid(),
      summary text not null,
      content jsonb not null default '[]'::jsonb check (jsonb_typeof(content) = 'array'),
      author_name text,
      primary_topic text,
      featured_image_public_url text,
      featured_image_alt text,
      status text not null default 'draft' check (status in ('draft','scheduled','published','unpublished','archived')),
      published_at timestamptz,
      scheduled_at timestamptz,
      updated_content_at timestamptz,
      robots_index boolean not null default true,
      robots_follow boolean not null default true,
      include_in_sitemap boolean not null default true,
      show_in_main_navigation boolean not null default false,
      show_in_resources boolean not null default false,
      canonical_url text,
      seo_title text,
      meta_description text,
      social_title text,
      social_description text,
      social_image_url text,
      social_image_alt text,
      created_by_account_id uuid references accounts(id) on delete set null,
      updated_by_account_id uuid references accounts(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (language, slug),
      unique (translation_group_id, language),
      check (position('/' in slug) = 0 and position('?' in slug) = 0 and position('#' in slug) = 0),
      check (slug !~ '[[:space:][:cntrl:]]'),
      check ((status = 'scheduled' and scheduled_at is not null) or status <> 'scheduled'),
      check ((featured_image_public_url is null and featured_image_alt is null) or
             (featured_image_public_url is not null and featured_image_alt is not null))
    );
    create index platform_seo_guides_public_idx
      on platform_seo_guides(language, status, published_at, scheduled_at)
      where robots_index and include_in_sitemap;

    create table platform_seo_guide_source_documents (
      id uuid primary key default gen_random_uuid(),
      guide_id uuid not null references platform_seo_guides(id) on delete restrict,
      revision integer not null check (revision > 0),
      original_filename text not null,
      content_type text not null,
      size_bytes bigint not null check (size_bytes > 0),
      storage_key text not null unique,
      checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
      uploaded_by_account_id uuid references accounts(id) on delete set null,
      uploaded_at timestamptz not null default now(),
      unique (guide_id, revision)
    );

    create table platform_seo_guide_publication_history (
      id uuid primary key default gen_random_uuid(),
      guide_id uuid not null references platform_seo_guides(id) on delete restrict,
      event_type text not null,
      old_status text,
      new_status text,
      actor_account_id uuid references accounts(id) on delete set null,
      detail jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create function reject_seo_guide_history_mutation() returns trigger language plpgsql as $$
    begin
      raise exception 'SEO Guide publication history is append-only' using errcode = '55000';
    end;
    $$;
    create trigger seo_guide_history_append_only
      before update or delete on platform_seo_guide_publication_history
      for each row execute function reject_seo_guide_history_mutation();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists seo_guide_history_append_only on platform_seo_guide_publication_history;
    drop function if exists reject_seo_guide_history_mutation();
    drop table if exists platform_seo_guide_publication_history;
    drop table if exists platform_seo_guide_source_documents;
    drop table if exists platform_seo_guides;
  `.execute(database);
}
