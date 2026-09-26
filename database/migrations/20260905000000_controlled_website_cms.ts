import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_blog_articles
      add column if not exists draft_payload jsonb,
      add column if not exists has_unpublished_changes boolean not null default false,
      add column if not exists last_unpublished_change_at timestamptz,
      add column if not exists published_by_account_id uuid references accounts(id) on delete set null,
      add column if not exists unpublished_at timestamptz,
      add column if not exists archived_at timestamptz;

    create table platform_website_pages (
      id uuid primary key default gen_random_uuid(),
      page_key text not null,
      locale text not null default 'en' check (locale in ('en','ar')),
      draft_content jsonb not null default '{}',
      published_content jsonb,
      visible boolean not null default true,
      status text not null default 'draft' check (status in ('draft','published','archived')),
      created_by_account_id uuid references accounts(id) on delete set null,
      updated_by_account_id uuid references accounts(id) on delete set null,
      published_by_account_id uuid references accounts(id) on delete set null,
      archived_by_account_id uuid references accounts(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      published_at timestamptz,
      archived_at timestamptz,
      unique(page_key, locale),
      check (jsonb_typeof(draft_content) = 'object'),
      check (published_content is null or jsonb_typeof(published_content) = 'object')
    );

    create table platform_website_pricing_plans (
      id uuid primary key default gen_random_uuid(),
      plan_key text not null,
      locale text not null default 'en' check (locale in ('en','ar')),
      draft_data jsonb not null,
      published_data jsonb,
      active boolean not null default true,
      status text not null default 'draft' check (status in ('draft','published','archived')),
      sort_order integer not null default 100,
      created_by_account_id uuid references accounts(id) on delete set null,
      updated_by_account_id uuid references accounts(id) on delete set null,
      published_by_account_id uuid references accounts(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      published_at timestamptz,
      archived_at timestamptz,
      unique(plan_key, locale),
      check (jsonb_typeof(draft_data) = 'object'),
      check (published_data is null or jsonb_typeof(published_data) = 'object')
    );

    create table platform_website_features (
      id uuid primary key default gen_random_uuid(),
      slug text not null,
      locale text not null default 'en' check (locale in ('en','ar')),
      draft_data jsonb not null,
      published_data jsonb,
      audience text not null default 'all' check (audience in ('delivery_company','trader','customer','all')),
      category text not null,
      feature_status text not null default 'planned' check (feature_status in ('live','beta','in_development','planned','not_available')),
      visible boolean not null default true,
      sort_order integer not null default 100,
      status text not null default 'draft' check (status in ('draft','published','archived')),
      created_by_account_id uuid references accounts(id) on delete set null,
      updated_by_account_id uuid references accounts(id) on delete set null,
      published_by_account_id uuid references accounts(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      published_at timestamptz,
      archived_at timestamptz,
      unique(slug, locale),
      check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      check (jsonb_typeof(draft_data) = 'object'),
      check (published_data is null or jsonb_typeof(published_data) = 'object')
    );

    create table platform_website_faqs (
      id uuid primary key default gen_random_uuid(),
      faq_key text not null,
      locale text not null default 'en' check (locale in ('en','ar')),
      draft_data jsonb not null,
      published_data jsonb,
      audience text not null default 'all' check (audience in ('delivery_company','trader','customer','all')),
      category text not null default 'general',
      visible boolean not null default true,
      sort_order integer not null default 100,
      status text not null default 'draft' check (status in ('draft','published','archived')),
      available_to_agent boolean not null default false,
      created_by_account_id uuid references accounts(id) on delete set null,
      updated_by_account_id uuid references accounts(id) on delete set null,
      published_by_account_id uuid references accounts(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      published_at timestamptz,
      archived_at timestamptz,
      unique(faq_key, locale),
      check (jsonb_typeof(draft_data) = 'object'),
      check (published_data is null or jsonb_typeof(published_data) = 'object')
    );

    create table platform_website_media (
      id uuid primary key default gen_random_uuid(),
      storage_provider text not null,
      storage_key text not null unique,
      public_url text not null unique,
      original_filename text not null,
      media_type text not null check (media_type in ('image/png','image/jpeg','image/webp')),
      size_bytes integer not null check (size_bytes > 0 and size_bytes <= 5242880),
      width integer,
      height integer,
      alt_text text not null,
      caption text,
      uploaded_by_account_id uuid references accounts(id) on delete set null,
      created_at timestamptz not null default now(),
      deleted_at timestamptz
    );

    create table platform_website_navigation_items (
      id uuid primary key default gen_random_uuid(),
      item_key text not null,
      locale text not null default 'en' check (locale in ('en','ar')),
      label text not null,
      destination text not null,
      visible boolean not null default true,
      sort_order integer not null default 100,
      updated_by_account_id uuid references accounts(id) on delete set null,
      updated_at timestamptz not null default now(),
      unique(item_key, locale),
      check (destination ~ '^/[a-z0-9/?=&:%#._-]*$')
    );

    create table platform_website_contact_settings (
      id boolean primary key default true check (id),
      draft_data jsonb not null,
      published_data jsonb not null,
      status text not null default 'published' check (status in ('draft','published')),
      updated_by_account_id uuid references accounts(id) on delete set null,
      published_by_account_id uuid references accounts(id) on delete set null,
      updated_at timestamptz not null default now(),
      published_at timestamptz not null default now(),
      check (jsonb_typeof(draft_data) = 'object'),
      check (jsonb_typeof(published_data) = 'object')
    );

    create table platform_website_revisions (
      id uuid primary key default gen_random_uuid(),
      entity_type text not null,
      entity_key text not null,
      locale text,
      event_type text not null,
      actor_account_id uuid references accounts(id) on delete set null,
      snapshot jsonb not null default '{}',
      created_at timestamptz not null default now(),
      check (jsonb_typeof(snapshot) = 'object')
    );

    create function reject_website_revision_mutation() returns trigger language plpgsql as $$
    begin
      raise exception 'Website CMS revision history is append-only' using errcode = '55000';
    end;
    $$;

    create trigger website_revisions_append_only
      before update or delete on platform_website_revisions
      for each row execute function reject_website_revision_mutation();

    insert into platform_website_pages(page_key, locale, draft_content, published_content, status, published_at)
    values
      ('home','en','{"hero":{"eyebrow":"Built for Delivery Businesses in the UAE","heading":"The Delivery Operating System for Modern Delivery Companies","subheading":"Manage orders, drivers, COD collections, Trader settlements, accounting, payroll and connected sales channels from one platform — while growing your delivery business through new Traders and customer delivery requests.","primaryCtaLabel":"Request a Demo","primaryCtaUrl":"/request-demo","secondaryCtaLabel":"Send a Package","secondaryCtaUrl":"/send-a-package"},"pricingPreview":{"heading":"Simple AED pricing as your delivery volume grows.","description":"Start free, then move into a monthly plan based on order volume. The 5,001–10,000 range is kept for confirmation instead of publishing an unapproved price."},"requestDemoCta":{"heading":"Ready to connect your delivery operation?","text":"See how Tawseelhub can bring daily operations, financial control and business growth into one platform.","buttonLabel":"Request a Demo"},"seo":{"title":"Tawseelhub | Delivery Operating System","description":"Connected delivery operations for modern UAE delivery companies.","canonical":"/","robotsIndex":true,"robotsFollow":true}}'::jsonb,'{"hero":{"eyebrow":"Built for Delivery Businesses in the UAE","heading":"The Delivery Operating System for Modern Delivery Companies","subheading":"Manage orders, drivers, COD collections, Trader settlements, accounting, payroll and connected sales channels from one platform — while growing your delivery business through new Traders and customer delivery requests.","primaryCtaLabel":"Request a Demo","primaryCtaUrl":"/request-demo","secondaryCtaLabel":"Send a Package","secondaryCtaUrl":"/send-a-package"},"pricingPreview":{"heading":"Simple AED pricing as your delivery volume grows.","description":"Start free, then move into a monthly plan based on order volume. The 5,001–10,000 range is kept for confirmation instead of publishing an unapproved price."},"requestDemoCta":{"heading":"Ready to connect your delivery operation?","text":"See how Tawseelhub can bring daily operations, financial control and business growth into one platform.","buttonLabel":"Request a Demo"},"seo":{"title":"Tawseelhub | Delivery Operating System","description":"Connected delivery operations for modern UAE delivery companies.","canonical":"/","robotsIndex":true,"robotsFollow":true}}'::jsonb,'published',now()),
      ('home','ar','{"hero":{"eyebrow":"مصمم لشركات التوصيل في الإمارات","heading":"نظام تشغيل التوصيل لشركات التوصيل الحديثة","subheading":"إدارة الطلبات والسائقين والتحصيل وتسويات التجار والتقارير من منصة واحدة.","primaryCtaLabel":"اطلب عرضاً","primaryCtaUrl":"/request-demo","secondaryCtaLabel":"أرسل شحنة","secondaryCtaUrl":"/send-a-package"},"pricingPreview":{"heading":"أسعار واضحة بالدرهم حسب حجم التشغيل.","description":"ابدأ مجاناً ثم اختر الخطة المناسبة لحجم الطلبات الشهري."},"requestDemoCta":{"heading":"جاهز لربط عمليات التوصيل؟","text":"شاهد كيف يساعد Tawseelhub في تنظيم العمليات والتحكم المالي والنمو.","buttonLabel":"اطلب عرضاً"},"seo":{"title":"Tawseelhub | نظام تشغيل التوصيل","description":"عمليات توصيل مترابطة لشركات التوصيل الحديثة في الإمارات.","canonical":"/","robotsIndex":true,"robotsFollow":true}}'::jsonb,'{"hero":{"eyebrow":"مصمم لشركات التوصيل في الإمارات","heading":"نظام تشغيل التوصيل لشركات التوصيل الحديثة","subheading":"إدارة الطلبات والسائقين والتحصيل وتسويات التجار والتقارير من منصة واحدة.","primaryCtaLabel":"اطلب عرضاً","primaryCtaUrl":"/request-demo","secondaryCtaLabel":"أرسل شحنة","secondaryCtaUrl":"/send-a-package"},"pricingPreview":{"heading":"أسعار واضحة بالدرهم حسب حجم التشغيل.","description":"ابدأ مجاناً ثم اختر الخطة المناسبة لحجم الطلبات الشهري."},"requestDemoCta":{"heading":"جاهز لربط عمليات التوصيل؟","text":"شاهد كيف يساعد Tawseelhub في تنظيم العمليات والتحكم المالي والنمو.","buttonLabel":"اطلب عرضاً"},"seo":{"title":"Tawseelhub | نظام تشغيل التوصيل","description":"عمليات توصيل مترابطة لشركات التوصيل الحديثة في الإمارات.","canonical":"/","robotsIndex":true,"robotsFollow":true}}'::jsonb,'published',now())
    on conflict (page_key, locale) do nothing;

    insert into platform_website_pricing_plans(plan_key, locale, draft_data, published_data, status, sort_order, published_at)
    values
      ('free','en','{"name":"Free","price":0,"currency":"AED","period":"per month","minOrders":0,"maxOrders":100,"volume":"Up to 100 orders / month","description":"For early teams validating Tawseelhub.","highlights":["Order and driver operations foundation","COD and settlement visibility","Reports for early-stage teams"],"ctaLabel":"Start with a demo","ctaUrl":"/request-demo","recommended":false}'::jsonb,'{"name":"Free","price":0,"currency":"AED","period":"per month","minOrders":0,"maxOrders":100,"volume":"Up to 100 orders / month","description":"For early teams validating Tawseelhub.","highlights":["Order and driver operations foundation","COD and settlement visibility","Reports for early-stage teams"],"ctaLabel":"Start with a demo","ctaUrl":"/request-demo","recommended":false}'::jsonb,'published',10,now()),
      ('starter','en','{"name":"Starter","price":100,"currency":"AED","period":"per month","minOrders":101,"maxOrders":1000,"volume":"101–1,000 orders / month","description":"For daily order control.","highlights":["Daily order management","Driver assignment workflows","COD collection controls"],"ctaLabel":"Request Demo","ctaUrl":"/request-demo","recommended":false}'::jsonb,'{"name":"Starter","price":100,"currency":"AED","period":"per month","minOrders":101,"maxOrders":1000,"volume":"101–1,000 orders / month","description":"For daily order control.","highlights":["Daily order management","Driver assignment workflows","COD collection controls"],"ctaLabel":"Request Demo","ctaUrl":"/request-demo","recommended":false}'::jsonb,'published',20,now()),
      ('growth','en','{"name":"Growth","price":200,"currency":"AED","period":"per month","minOrders":1001,"maxOrders":3000,"volume":"1,001–3,000 orders / month","description":"For growing delivery teams.","highlights":["Trader relationship tracking","Trader settlement workflows","Operational reporting"],"ctaLabel":"Request Demo","ctaUrl":"/request-demo","recommended":true}'::jsonb,'{"name":"Growth","price":200,"currency":"AED","period":"per month","minOrders":1001,"maxOrders":3000,"volume":"1,001–3,000 orders / month","description":"For growing delivery teams.","highlights":["Trader relationship tracking","Trader settlement workflows","Operational reporting"],"ctaLabel":"Request Demo","ctaUrl":"/request-demo","recommended":true}'::jsonb,'published',30,now()),
      ('business','en','{"name":"Business","price":500,"currency":"AED","period":"per month","minOrders":3001,"maxOrders":5000,"volume":"3,001–5,000 orders / month","description":"For larger operating teams.","highlights":["Accounting and payroll support","Management reporting","Platform controls for growing teams"],"ctaLabel":"Request Demo","ctaUrl":"/request-demo","recommended":false}'::jsonb,'{"name":"Business","price":500,"currency":"AED","period":"per month","minOrders":3001,"maxOrders":5000,"volume":"3,001–5,000 orders / month","description":"For larger operating teams.","highlights":["Accounting and payroll support","Management reporting","Platform controls for growing teams"],"ctaLabel":"Request Demo","ctaUrl":"/request-demo","recommended":false}'::jsonb,'published',40,now()),
      ('scale','en','{"name":"Scale","price":750,"currency":"AED","period":"per month","minOrders":10001,"maxOrders":null,"volume":"Above 10,000 orders / month","description":"For high-volume delivery operations.","highlights":["High-volume operations","Advanced operational review","Commerce integration readiness"],"ctaLabel":"Contact Us","ctaUrl":"/contact","recommended":false}'::jsonb,'{"name":"Scale","price":750,"currency":"AED","period":"per month","minOrders":10001,"maxOrders":null,"volume":"Above 10,000 orders / month","description":"For high-volume delivery operations.","highlights":["High-volume operations","Advanced operational review","Commerce integration readiness"],"ctaLabel":"Contact Us","ctaUrl":"/contact","recommended":false}'::jsonb,'published',50,now())
    on conflict (plan_key, locale) do nothing;

    insert into platform_website_contact_settings(draft_data, published_data)
    values ('{"publicPhone":"+971 50 689 8604","whatsapp":"+971 50 689 8604","supportEmail":"hello@tawseelhub.com","linkedin":"","instagram":"","facebook":"","youtube":""}'::jsonb,'{"publicPhone":"+971 50 689 8604","whatsapp":"+971 50 689 8604","supportEmail":"hello@tawseelhub.com","linkedin":"","instagram":"","facebook":"","youtube":""}'::jsonb)
    on conflict (id) do nothing;

    insert into platform_website_navigation_items(item_key, locale, label, destination, visible, sort_order)
    values
      ('solutions','en','Solutions','/delivery-companies',true,10),
      ('send-package','en','Send a Package','/send-a-package',true,20),
      ('store','en','Store','/traders',true,30),
      ('pricing','en','Pricing','/pricing',true,40),
      ('blog','en','Blog','/blog',true,50),
      ('solutions','ar','الحلول','/delivery-companies',true,10),
      ('send-package','ar','أرسل شحنة','/send-a-package',true,20),
      ('store','ar','المتجر','/traders',true,30),
      ('pricing','ar','الأسعار','/pricing',true,40),
      ('blog','ar','المدونة','/blog',true,50)
    on conflict (item_key, locale) do nothing;

    insert into permissions(code, description) values
      ('platform.website.read','View Website CMS'),
      ('platform.website.manage','Manage Website CMS drafts'),
      ('platform.website.publish','Publish Website CMS content'),
      ('platform.website.media.manage','Manage Website media'),
      ('platform.website.seo.manage','Manage Website SEO')
    on conflict(code) do update set description = excluded.description;

    insert into role_permissions(role_id, permission_code)
    select r.id, p.code
      from roles r
      cross join (values
        ('platform.website.read'),
        ('platform.website.manage'),
        ('platform.website.publish'),
        ('platform.website.media.manage'),
        ('platform.website.seo.manage')
      ) p(code)
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code like 'platform.website.%';
    delete from permissions where code like 'platform.website.%';
    drop trigger if exists website_revisions_append_only on platform_website_revisions;
    drop function if exists reject_website_revision_mutation();
    drop table if exists platform_website_revisions;
    drop table if exists platform_website_contact_settings;
    drop table if exists platform_website_navigation_items;
    drop table if exists platform_website_media;
    drop table if exists platform_website_faqs;
    drop table if exists platform_website_features;
    drop table if exists platform_website_pricing_plans;
    drop table if exists platform_website_pages;
    alter table platform_blog_articles
      drop column if exists draft_payload,
      drop column if exists has_unpublished_changes,
      drop column if exists last_unpublished_change_at,
      drop column if exists published_by_account_id,
      drop column if exists unpublished_at,
      drop column if exists archived_at;
  `.execute(database);
}
