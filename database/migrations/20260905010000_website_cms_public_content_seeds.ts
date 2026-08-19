import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

const features = [
  ["order-management", "en", "Order Management", "Capture, organize and follow every delivery order from one clear workspace.", "delivery_company", "Operations", 10],
  ["driver-operations", "en", "Driver Operations", "Assign work, support drivers and keep delivery progress visible throughout the day.", "delivery_company", "Operations", 20],
  ["cod-collections", "en", "COD & Collections", "Bring cash-on-delivery handovers and collections into a controlled workflow.", "delivery_company", "Finance", 30],
  ["trader-settlements", "en", "Trader Settlements", "Prepare and track Trader payables with consistent records and clear status.", "delivery_company", "Finance", 40],
  ["accounting", "en", "Accounting", "Connect daily delivery activity with the financial picture of your business.", "delivery_company", "Finance", 50],
  ["payroll", "en", "Payroll", "Manage employee payroll and delivery-related earnings in the same operating environment.", "delivery_company", "Workforce", 60],
  ["reports-analytics", "en", "Reports & Analytics", "Turn operational records into practical views for faster management decisions.", "delivery_company", "Reports", 70],
  ["mobile-operations", "en", "Mobile Operations", "Keep field teams connected to the work that matters while they are moving.", "delivery_company", "Mobile", 80],
  ["trader-management", "en", "Trader Management", "Organize Trader relationships, service expectations and operational activity.", "delivery_company", "Traders", 90],
  ["commerce-integrations", "en", "Commerce Integrations", "Prepare connected order intake from the sales channels your Traders already use.", "delivery_company", "Integrations", 100],
  ["order-management", "ar", "إدارة الطلبات", "تنظيم ومتابعة طلبات التوصيل من مساحة عمل واضحة.", "delivery_company", "العمليات", 10],
  ["driver-operations", "ar", "عمليات السائقين", "إسناد العمل ومتابعة تقدم التوصيل خلال اليوم.", "delivery_company", "العمليات", 20],
  ["cod-collections", "ar", "التحصيل والدفع عند الاستلام", "إدارة تسليمات وتحصيلات الدفع عند الاستلام بطريقة منظمة.", "delivery_company", "المالية", 30],
  ["trader-settlements", "ar", "تسويات التجار", "تجهيز ومتابعة مستحقات التجار بسجلات واضحة.", "delivery_company", "المالية", 40],
  ["accounting", "ar", "المحاسبة", "ربط نشاط التوصيل اليومي بالصورة المالية للشركة.", "delivery_company", "المالية", 50],
  ["payroll", "ar", "الرواتب", "إدارة رواتب الموظفين واستحقاقات التوصيل من نفس النظام.", "delivery_company", "الفريق", 60],
  ["reports-analytics", "ar", "التقارير والتحليلات", "تحويل سجلات التشغيل إلى تقارير عملية لاتخاذ قرارات أسرع.", "delivery_company", "التقارير", 70],
  ["mobile-operations", "ar", "عمليات الميدان", "إبقاء فرق العمل الميدانية متصلة بالمهام المهمة أثناء الحركة.", "delivery_company", "الميدان", 80],
  ["trader-management", "ar", "إدارة التجار", "تنظيم علاقات التجار وتوقعات الخدمة والنشاط التشغيلي.", "delivery_company", "التجار", 90],
  ["commerce-integrations", "ar", "تكاملات التجارة", "تجهيز استقبال الطلبات من قنوات البيع التي يستخدمها التجار.", "delivery_company", "التكاملات", 100],
] as const;

const faqs = [
  ["delivery-company-fit", "en", "Is Tawseelhub for delivery companies?", "Yes. Tawseelhub is built for delivery companies that need one place for orders, drivers, COD, settlements, accounting, payroll and reports.", "all", "general", true, 10],
  ["send-package-fit", "en", "Can customers request a package quotation?", "Yes. The public website can collect package quote requests. Instant prices appear only for configured UAE routes; other shipments go for manual quotation.", "customer", "send-package", true, 20],
  ["pricing-gap", "en", "Why is the 5,001–10,000 order range not priced?", "That range is intentionally kept for confirmation with the Tawseelhub team, so the website does not publish an unapproved price.", "delivery_company", "pricing", true, 30],
  ["arabic-support", "en", "Does the website support Arabic?", "Yes. Public website content can be managed in English and Arabic, with right-to-left display for Arabic pages.", "all", "website", true, 40],
  ["delivery-company-fit", "ar", "هل توصيل هب مخصص لشركات التوصيل؟", "نعم. توصيل هب مصمم لشركات التوصيل التي تحتاج إلى إدارة الطلبات والسائقين والتحصيل والتسويات والمحاسبة والرواتب والتقارير من مكان واحد.", "all", "عام", true, 10],
  ["send-package-fit", "ar", "هل يمكن للعميل طلب عرض سعر لشحنة؟", "نعم. يمكن للموقع استقبال طلبات عروض أسعار الشحنات. تظهر الأسعار الفورية فقط للمسارات الإماراتية المعدة مسبقاً، أما الحالات الأخرى فتذهب للمراجعة اليدوية.", "customer", "الشحنات", true, 20],
  ["pricing-gap", "ar", "لماذا لا يوجد سعر لنطاق 5,001 إلى 10,000 طلب؟", "هذا النطاق محفوظ للتأكيد مع فريق توصيل هب حتى لا ينشر الموقع سعراً غير معتمد.", "delivery_company", "الأسعار", true, 30],
  ["arabic-support", "ar", "هل يدعم الموقع اللغة العربية؟", "نعم. يمكن إدارة محتوى الموقع بالإنجليزية والعربية مع عرض عربي من اليمين إلى اليسار.", "all", "الموقع", true, 40],
] as const;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  for (const [slug, locale, name, shortDescription, audience, category, sortOrder] of features) {
    const data = JSON.stringify({ name, shortDescription, fullDescription: shortDescription });
    await sql`
      insert into platform_website_features(slug, locale, draft_data, published_data, audience, category, feature_status, visible, status, sort_order, published_at)
      values (${slug}, ${locale}, ${data}::jsonb, ${data}::jsonb, ${audience}, ${category}, 'live', true, 'published', ${sortOrder}, now())
      on conflict (slug, locale) do nothing
    `.execute(database);
  }

  for (const [faqKey, locale, question, answer, audience, category, availableToAgent, sortOrder] of faqs) {
    const data = JSON.stringify({ question, answer });
    await sql`
      insert into platform_website_faqs(faq_key, locale, draft_data, published_data, audience, category, visible, available_to_agent, status, sort_order, published_at)
      values (${faqKey}, ${locale}, ${data}::jsonb, ${data}::jsonb, ${audience}, ${category}, true, ${availableToAgent}, 'published', ${sortOrder}, now())
      on conflict (faq_key, locale) do nothing
    `.execute(database);
  }
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`delete from platform_website_faqs where faq_key in ('delivery-company-fit','send-package-fit','pricing-gap','arabic-support')`.execute(database);
  await sql`delete from platform_website_features where slug in ('order-management','driver-operations','cod-collections','trader-settlements','accounting','payroll','reports-analytics','mobile-operations','trader-management','commerce-integrations')`.execute(database);
}
