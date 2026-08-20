import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table if not exists platform_help_categories (
      id uuid primary key default gen_random_uuid(),
      slug text not null,
      locale text not null default 'en' check (locale in ('en','ar')),
      name text not null,
      description text not null default '',
      audience text not null default 'all' check (audience in ('delivery_company','trader','customer','integration_developer','all')),
      icon text,
      visible boolean not null default true,
      sort_order integer not null default 100,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (slug, locale),
      check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
    )
  `.execute(db);

  await sql`
    create table if not exists platform_help_articles (
      id uuid primary key default gen_random_uuid(),
      slug text not null,
      locale text not null default 'en' check (locale in ('en','ar')),
      title text not null,
      summary text not null,
      body jsonb not null default '[]'::jsonb,
      category_id uuid references platform_help_categories(id) on delete set null,
      audience text not null default 'all' check (audience in ('delivery_company','trader','customer','integration_developer','all')),
      status text not null default 'draft' check (status in ('draft','published','archived')),
      sort_order integer not null default 100,
      featured boolean not null default false,
      available_to_agent boolean not null default false,
      related_slugs text[] not null default '{}',
      seo_title text,
      meta_description text,
      canonical_path text,
      robots_index boolean not null default true,
      robots_follow boolean not null default true,
      og_title text,
      og_description text,
      og_image text,
      created_by_account_id uuid references accounts(id),
      updated_by_account_id uuid references accounts(id),
      published_by_account_id uuid references accounts(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      published_at timestamptz,
      unique (slug, locale),
      check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      check (canonical_path is null or canonical_path ~ '^/resources/[a-z0-9]+(-[a-z0-9]+)*$')
    )
  `.execute(db);

  await sql`create index if not exists idx_platform_help_articles_public on platform_help_articles(locale,status,featured,sort_order)`.execute(db);
  await sql`create index if not exists idx_platform_help_articles_category on platform_help_articles(category_id,status,sort_order)`.execute(db);
  await sql`create index if not exists idx_platform_help_categories_public on platform_help_categories(locale,visible,sort_order)`.execute(db);

  await sql`
    insert into platform_help_categories(slug, locale, name, description, audience, icon, sort_order)
    values
      ('getting-started','en','Getting Started','Basic guides for customers, Traders and delivery companies.','all','compass',10),
      ('orders','en','Orders','Create, assign and track delivery orders.','delivery_company','package',20),
      ('cod-finance','en','COD & Finance','COD collections, Trader statements, settlements and accounting visibility.','delivery_company','wallet',30),
      ('reports','en','Reports','Operational reports for managers and finance teams.','delivery_company','chart',40),
      ('trader-portal','en','Trader Portal','Guides for Traders using Tawseelhub.','trader','store',50),
      ('integrations','en','Integrations','Commerce connection guides and readiness information.','integration_developer','plug',60),
      ('support','en','Support','How to get help from Yousef and the Tawseelhub team.','all','life-buoy',70),
      ('getting-started','ar','البداية','أدلة أساسية للعملاء والتجار وشركات التوصيل.','all','compass',10)
    on conflict (slug, locale) do nothing
  `.execute(db);

  await sql`
    insert into platform_help_articles(slug, locale, title, summary, body, category_id, audience, status, featured, available_to_agent, sort_order, seo_title, meta_description, canonical_path, published_at)
    select article.slug, article.locale, article.title, article.summary, article.body::jsonb, category.id, article.audience, article.status, article.featured, article.available_to_agent, article.sort_order, article.seo_title, article.meta_description, '/resources/' || article.slug, now()
    from (values
      ('what-is-tawseelhub','en','What is Tawseelhub?','Tawseelhub is a delivery operating system for UAE delivery companies, Traders and shipment customers.','[{"type":"paragraph","text":"Tawseelhub helps delivery companies manage daily delivery operations from one controlled system."},{"type":"bullet_list","items":["Create and manage orders","Assign drivers and follow operational status","Track COD collections and Trader settlement visibility","Review reports and operational performance"]},{"type":"paragraph","text":"If you are new, start by choosing whether you are sending one package, registering as a Trader, or requesting a delivery company demo."}]','getting-started','all','published',true,true,10,'What is Tawseelhub? | Help Center','Learn what Tawseelhub does for UAE delivery companies, Traders and shipment customers.'),
      ('send-a-package-quote','en','How to request a delivery quote','Use the Send a Package flow or ask Yousef to collect the needed shipment information one question at a time.','[{"type":"paragraph","text":"To request a quote, Tawseelhub needs your name, UAE mobile number, pickup emirate, pickup area, delivery emirate, delivery area, package details, weight and pickup date."},{"type":"paragraph","text":"After the core details are captured, the team reviews the request and replies through the selected contact channel."}]','getting-started','customer','published',true,true,20,'How to request a delivery quote | Tawseelhub','Request a UAE delivery quote through Tawseelhub and understand what information is needed.'),
      ('create-an-order','en','Create an order','Create an order with customer, delivery, pickup and payment details before assigning it to operations.','[{"type":"paragraph","text":"Orders should include the customer name and mobile number, delivery location, payment method, COD amount when applicable, and package notes."},{"type":"paragraph","text":"Clean order data helps dispatch, driver collection and Trader settlement workflows stay accurate."}]','orders','delivery_company','published',true,true,30,'Create an order | Tawseelhub Help Center','Learn what order details Tawseelhub needs before dispatch and delivery operations.'),
      ('assign-an-order-to-driver','en','Assign an order to a driver','Assign orders to the correct driver so delivery progress and cash responsibility are tracked.','[{"type":"paragraph","text":"Use driver assignment when an order is ready for dispatch. Once assigned, the order can be followed in the operational workflow."},{"type":"paragraph","text":"Driver assignment supports accountability for delivery attempts, collection and final reconciliation."}]','orders','delivery_company','published',false,true,40,'Assign an order to a driver | Tawseelhub','Learn how driver assignment supports delivery operations and accountability.'),
      ('order-statuses','en','Understand order statuses','Order statuses show where each shipment is in the delivery workflow.','[{"type":"paragraph","text":"Statuses help the operations team understand whether an order is new, assigned, out for delivery, delivered, returned, cancelled or needs attention."},{"type":"paragraph","text":"Managers should use status filters before taking bulk operational action."}]','orders','delivery_company','published',false,true,50,'Order statuses | Tawseelhub Help Center','Understand delivery order statuses and how to use them in daily operations.'),
      ('cod-collections','en','Understand COD collections','COD collection tracking helps delivery companies know what was collected and what still needs reconciliation.','[{"type":"paragraph","text":"Cash on Delivery is operationally sensitive because the delivery company collects money from customers on behalf of Traders."},{"type":"paragraph","text":"Tawseelhub separates delivery activity, driver cash collection and Trader settlement visibility so each team can see the correct numbers."}]','cod-finance','delivery_company','published',true,true,60,'COD collections | Tawseelhub Help Center','Learn how Tawseelhub supports COD visibility for delivery companies.'),
      ('driver-reconciliation','en','Driver reconciliation overview','Driver reconciliation confirms what a driver handed over after completed deliveries.','[{"type":"paragraph","text":"Driver reconciliation is used after eligible delivered orders are reviewed and the cash or payment collection is confirmed."},{"type":"paragraph","text":"This protects the company from duplicate collection entries and keeps finance reporting clean."}]','cod-finance','delivery_company','published',false,true,70,'Driver reconciliation | Tawseelhub','Understand driver cash reconciliation at a high level.'),
      ('trader-statements','en','Trader statements and settlements','Trader statements help delivery companies review what is payable to each Trader.','[{"type":"paragraph","text":"A Trader statement shows delivered orders, COD values, company charges, payments and balances depending on the configured workflow."},{"type":"paragraph","text":"Use settlement controls when money is ready to be paid to the Trader."}]','cod-finance','delivery_company','published',false,true,80,'Trader statements and settlements | Tawseelhub','Understand Trader statements and settlement visibility in Tawseelhub.'),
      ('reports-overview','en','Reports overview','Reports help managers review operational and finance activity without exporting everything manually.','[{"type":"paragraph","text":"Tawseelhub reports are designed for operational visibility: orders, drivers, COD, settlements and business activity."},{"type":"paragraph","text":"Use reports to spot delays, missing collection activity and team workload."}]','reports','delivery_company','published',false,true,90,'Reports overview | Tawseelhub Help Center','Learn what managers can review in Tawseelhub reports.'),
      ('trader-portal-basics','en','Trader Portal basics','The Trader Portal gives Traders controlled visibility into their delivery activity.','[{"type":"paragraph","text":"Traders can use the portal to follow their shipments and business information where enabled by the delivery company."},{"type":"paragraph","text":"For account access or setup questions, contact the delivery company or Tawseelhub support."}]','trader-portal','trader','published',false,true,100,'Trader Portal basics | Tawseelhub','Learn what Traders can do from the Tawseelhub Trader Portal.'),
      ('commerce-integrations-overview','en','Commerce integrations overview','Tawseelhub is building commerce integrations for store platforms using a controlled integration foundation.','[{"type":"paragraph","text":"Commerce integrations are designed to help Traders connect online store order flow with Tawseelhub operations."},{"type":"paragraph","text":"Provider-specific readiness depends on configuration and external testing. Contact Tawseelhub before relying on a connector in production."}]','integrations','integration_developer','published',false,true,110,'Commerce integrations overview | Tawseelhub','Understand Tawseelhub commerce integration readiness and next steps.'),
      ('contact-support','en','Contact support','Use Ask Tawseelhub, WhatsApp or the Contact page when you need help.','[{"type":"paragraph","text":"For quick questions, use the Ask Tawseelhub button on the website. If a human is available, Yousef can hand the conversation to the Tawseelhub team."},{"type":"paragraph","text":"If the live team is unavailable, share your name and UAE mobile number so operations can follow up."}]','support','all','published',true,true,120,'Contact Tawseelhub support | Help Center','Find the best way to contact Tawseelhub support, Yousef or WhatsApp.'),
      ('what-is-tawseelhub','ar','ما هو توصيل هب؟','توصيل هب نظام تشغيل لشركات التوصيل في الإمارات يساعد في الطلبات والسائقين والتحصيل والتقارير.','[{"type":"paragraph","text":"يساعد توصيل هب شركات التوصيل على إدارة الطلبات والسائقين وتحصيل مبالغ الدفع عند الاستلام وتسويات التجار والتقارير من نظام واحد."},{"type":"paragraph","text":"للبداية اختر إرسال شحنة، تسجيل تاجر، أو طلب عرض توضيحي لشركة توصيل."}]','getting-started','all','published',true,true,10,'ما هو توصيل هب؟ | مركز المساعدة','تعرف على توصيل هب وكيف يساعد شركات التوصيل والتجار والعملاء في الإمارات.')
    ) as article(slug, locale, title, summary, body, category_slug, audience, status, featured, available_to_agent, sort_order, seo_title, meta_description)
    join platform_help_categories category on category.slug = article.category_slug and category.locale = article.locale
    on conflict (slug, locale) do nothing
  `.execute(db);

  await sql`
    insert into platform_help_articles(slug, locale, title, summary, body, category_id, audience, status, featured, available_to_agent, sort_order, seo_title, meta_description, canonical_path)
    select article.slug, article.locale, article.title, article.summary, article.body::jsonb, category.id, article.audience, 'draft', false, false, article.sort_order, article.seo_title, article.meta_description, '/resources/' || article.slug
    from (values
      ('connect-salla','en','Connect Salla','Draft provider guide for Salla connection readiness and setup.','[{"type":"paragraph","text":"This guide is draft until the Salla connector is confirmed ready for production use."}]','integrations','integration_developer',200,'Connect Salla | Tawseelhub Help Center','Draft Tawseelhub Salla connection guide.'),
      ('connect-shopify','en','Connect Shopify','Draft provider guide for Shopify connection readiness and setup.','[{"type":"paragraph","text":"This guide is draft until the Shopify connector is confirmed ready for production use."}]','integrations','integration_developer',210,'Connect Shopify | Tawseelhub Help Center','Draft Tawseelhub Shopify connection guide.'),
      ('connect-woocommerce','en','Connect WooCommerce','Draft provider guide for WooCommerce connection readiness and setup.','[{"type":"paragraph","text":"This guide is draft until the WooCommerce connector is confirmed ready for production use."}]','integrations','integration_developer',220,'Connect WooCommerce | Tawseelhub Help Center','Draft Tawseelhub WooCommerce connection guide.')
    ) as article(slug, locale, title, summary, body, category_slug, audience, sort_order, seo_title, meta_description)
    join platform_help_categories category on category.slug = article.category_slug and category.locale = article.locale
    on conflict (slug, locale) do nothing
  `.execute(db);

  await sql`
    insert into platform_website_navigation_items(item_key, locale, label, destination, visible, sort_order)
    values ('help-center','en','Help','/resources',true,55), ('help-center','ar','المساعدة','/resources',true,55)
    on conflict (item_key, locale) do update set label=excluded.label, destination=excluded.destination, visible=excluded.visible, sort_order=excluded.sort_order, updated_at=now()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from platform_website_navigation_items where item_key = 'help-center'`.execute(db);
  await sql`drop table if exists platform_help_articles`.execute(db);
  await sql`drop table if exists platform_help_categories`.execute(db);
}
