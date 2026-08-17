import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
alter table platform_agent_knowledge
  add column if not exists audience text not null default 'all' check(audience in('public','delivery_company','trader','customer','all')),
  add column if not exists feature_status text not null default 'informational' check(feature_status in('live','planned','on_hold','future','internal_only','informational')),
  add column if not exists visibility text not null default 'public_agent' check(visibility in('public_agent','internal_only'));

create index if not exists platform_agent_knowledge_retrieval_idx
  on platform_agent_knowledge(language,status,visibility,category,feature_status,audience,sort_order);

update platform_agent_knowledge
set content='توصيل هب نظام تشغيل لشركات التوصيل في دولة الإمارات لإدارة الطلبات والسائقين والتحصيل والتسويات والتقارير وعلاقات التجار.',
    audience='all',
    feature_status='live',
    visibility='public_agent'
where language='ar'
  and category in('general','Tawseelhub Overview')
  and (content like '%???%' or title='ما هي توصيل هب');

update platform_agent_knowledge
set category='Tawseelhub Overview', audience='all', feature_status='live', visibility='public_agent'
where title='What Tawseelhub does';

update platform_agent_knowledge
set category='Privacy & Security', audience='all', feature_status='live', visibility='public_agent'
where title='Delivery company privacy';

insert into platform_agent_knowledge(language,title,content,category,status,sort_order,audience,feature_status,visibility) values
('en','Tawseelhub positioning','Tawseelhub is a Delivery Operating System designed primarily for Delivery Companies. It combines operational, financial and business-growth functions around the Delivery Company, Trader and Customer relationship. It is not a courier app, e-commerce platform, Shopify alternative or Storefront builder.','Tawseelhub Overview','published',11,'all','live','public_agent'),
('en','Delivery company operations','For Delivery Companies, Tawseelhub supports order creation and imports, active order management, order lifecycle tracking, bulk operations, driver assignment, customer/order search and operational reporting.','Delivery Companies','published',20,'delivery_company','live','public_agent'),
('en','Driver operations','Tawseelhub supports driver operations including assigned deliveries, delivery statuses, collections, reconciliation and mobile workflow foundations for role-based driver access.','Drivers','published',30,'delivery_company','live','public_agent'),
('en','COD and collections','COD and collections features help a Delivery Company see what each driver collected, what has been handed back, what is outstanding, and what expenses or deductions need to be considered.','COD & Collections','published',40,'delivery_company','live','public_agent'),
('en','Trader management','Tawseelhub supports Trader profiles, Trader pricing, area-based pricing, order relationships, statements and balances for Delivery Companies working with Traders.','Trader Registration','published',50,'delivery_company','live','public_agent'),
('en','Trader settlements','Trader settlements support outstanding amounts, full or partial settlement, allocation and settlement history so money sent to Traders is traceable.','Trader Settlements','published',60,'delivery_company','live','public_agent'),
('en','Accounting capabilities','Tawseelhub includes accounting events, journal-entry foundations, expenses, financial reports and reconciliation support connected to delivery operations.','Accounting','published',70,'delivery_company','live','public_agent'),
('en','Payroll capabilities','Tawseelhub includes payroll capabilities for delivery-company employees, including payroll periods, employee earnings, per-delivered-order earnings and collection-linked earning rules.','Payroll','published',80,'delivery_company','live','public_agent'),
('en','Reports and statements','Tawseelhub reporting includes Trader statements, financial reports and operational reporting so Delivery Companies can review activity and money movement.','Reports','published',90,'delivery_company','live','public_agent'),
('en','Delivery company growth model','Tawseelhub is also being built to help participating Delivery Companies receive future business opportunities through verified Trader leads, individual customer package requests and connected Trader commerce channels. Lead volume is not guaranteed.','Delivery Companies','published',100,'delivery_company','planned','public_agent'),
('en','Trader registration','A Trader can register with Tawseelhub whether they already have a Delivery Company or still need one. Registration goes through verification and approval. Existing Delivery Company relationships are verified; if there is no Delivery Company, matching can be handled later through controlled Tawseelhub processes.','Trader Registration','published',110,'trader','live','public_agent'),
('en','Trader portal','An activated Trader can use their Trader portal for functions such as viewing orders, creating new delivery orders, reviewing delivery status, viewing statements/financial information and future sales-channel integrations where available.','Trader Portal','published',120,'trader','live','public_agent'),
('en','Customer package quotes','For customer package quotes, Tawseelhub collects pickup, destination, package details, weight, service requirement, COD if needed and contact information. Pricing and availability come only from the Quote Engine. Public users do not see Delivery Company names, commission or internal pricing.','Customer Package Quotes','published',130,'customer','live','public_agent'),
('en','Custom quote cases','Oversized shipments, overweight shipments, unusual quantities, special handling, unsupported routes, high COD, unusual delivery speed requirements or restricted/special goods may require custom handling. Yousef must not guess a custom price.','Custom Quotes','published',140,'customer','live','public_agent'),
('en','Salla status','Salla integration is planned. The goal is for Traders to keep their Salla store while delivery orders flow directly into Tawseelhub and then to their Delivery Company. It is not currently live.','Salla','published',150,'trader','planned','public_agent'),
('en','Shopify status','Shopify integration is planned. Shopify remains the Trader commerce system while Tawseelhub becomes the delivery connection. Shopify orders should eventually become normal Tawseelhub delivery orders. It is not currently live.','Shopify','published',160,'trader','planned','public_agent'),
('en','WooCommerce status','WooCommerce integration is planned. The intended model is that the Trader keeps WooCommerce while Tawseelhub connects delivery orders into delivery operations. It is not currently live.','WooCommerce','published',170,'trader','planned','public_agent'),
('en','Storefront status','A Tawseelhub Storefront concept is part of the broader roadmap, but it is currently on hold while Tawseelhub focuses on the Delivery Operating System, customer quote service, Trader onboarding and commerce integrations.','Storefront Status','published',180,'trader','on_hold','public_agent'),
('en','Individual courier roadmap','Individual courier registration is a future phase. Tawseelhub may later allow approved individual courier partners to accept eligible shipment jobs, but public registration is not currently available.','Individual Courier Roadmap','published',190,'public','future','public_agent'),
('en','Private Delivery Company directory','Tawseelhub does not expose a public Delivery Company directory. Matching and Delivery Company relationships are controlled through Tawseelhub verification and business workflows.','Privacy & Security','published',200,'all','live','public_agent'),
('en','Demo and contact','Delivery Companies can request a Tawseelhub demo. Yousef may help collect the company name, contact person, UAE mobile number, email, emirate and relevant operating details before submitting a demo request.','Demo / Contact','published',210,'delivery_company','live','public_agent'),
('en','Internal marketplace commercial model','Internal concept only: Tawseelhub may include marketplace commission, Delivery Company net calculations, matching priority and one-time connection fees. This content is not public Agent knowledge and must not be disclosed to public visitors.','Privacy & Security','published',900,'all','internal_only','internal_only'),
('ar','نظرة عامة على Tawseelhub','Tawseelhub نظام تشغيل لشركات التوصيل في دولة الإمارات. يساعد في إدارة الطلبات والسائقين والتحصيل وتسويات التجار والمحاسبة والرواتب والتقارير، مع دعم نمو العلاقات بين شركات التوصيل والتجار والعملاء.','Tawseelhub Overview','published',11,'all','live','public_agent'),
('ar','التحصيل و COD','يساعد Tawseelhub شركة التوصيل على متابعة ما حصله كل سائق، وما تم تسليمه للشركة، وما يزال مستحقاً، مع ربط ذلك بالمصاريف والتسويات والتقارير.','COD & Collections','published',40,'delivery_company','live','public_agent'),
('ar','الرواتب','يدعم Tawseelhub قدرات الرواتب لشركات التوصيل، مثل فترات الرواتب وأرباح الموظفين وأرباح السائقين المرتبطة بالطلبات المسلمة أو التحصيل المؤهل.','Payroll','published',80,'delivery_company','live','public_agent'),
('ar','حالة Shopify','تكامل Shopify مخطط وليس متاحاً حالياً. الهدف أن يحتفظ التاجر بمتجر Shopify بينما تنتقل طلبات التوصيل إلى Tawseelhub ثم إلى شركة التوصيل.','Shopify','published',160,'trader','planned','public_agent'),
('ar','حالة المتجر','مفهوم Tawseelhub Storefront ضمن خارطة الطريق، لكنه حالياً متوقف مؤقتاً بينما يتركز العمل على نظام تشغيل شركات التوصيل وطلبات الأسعار وتسجيل التجار والتكاملات.','Storefront Status','published',180,'trader','on_hold','public_agent')
on conflict do nothing;
`.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
delete from platform_agent_knowledge
where title in(
  'Tawseelhub positioning','Delivery company operations','Driver operations','COD and collections',
  'Trader management','Trader settlements','Accounting capabilities','Payroll capabilities',
  'Reports and statements','Delivery company growth model','Trader registration','Trader portal',
  'Customer package quotes','Custom quote cases','Salla status','Shopify status','WooCommerce status',
  'Storefront status','Individual courier roadmap','Private Delivery Company directory','Demo and contact',
  'Internal marketplace commercial model','نظرة عامة على Tawseelhub','التحصيل و COD','الرواتب','حالة Shopify','حالة المتجر'
);
drop index if exists platform_agent_knowledge_retrieval_idx;
alter table platform_agent_knowledge
  drop column if exists visibility,
  drop column if exists feature_status,
  drop column if exists audience;
`.execute(database);
}
