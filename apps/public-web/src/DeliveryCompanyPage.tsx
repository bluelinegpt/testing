import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { trackEvent } from './analytics';
import { usePublicLocale } from './public-localization';

const copy = {
  en: {
    eyebrow: 'Tawseelhub · Delivery Operating System',
    title: 'Run Your Entire Delivery Business from One Operating System',
    body: 'Manage orders, drivers, COD collections, Trader settlements, accounting, payroll, reporting and connected sales channels from one platform built for delivery companies.',
    demo: 'Request a Demo',
    explore: 'Explore Features ↓',
    points: ['Built for UAE delivery operations', 'Arabic & English ready', 'Multi-company SaaS architecture', 'Delivery operations + financial control'],
    lifecycle: 'TAWSEELHUB / OPERATING LIFECYCLE',
    stages: ['Order intake', 'Daily operations', 'Financial control', 'Reporting & growth'],
    sectionEyebrow: 'Complete operating lifecycle',
    sectionTitle: 'Everything Your Delivery Company Needs to Operate',
    sectionBody: 'From the first order entering your system to daily field work, financial control and management reporting.',
    growthEyebrow: 'Planned growth services',
    growthTitle: 'Not Just Software. A Platform to Help You Grow.',
    growthBody: "Part of Tawseelhub's upcoming network capabilities is a structured way to create qualified opportunities for participating Delivery Companies—without exposing a public directory or promising lead volume.",
    whyEyebrow: 'Why Tawseelhub',
    whyTitle: 'Practical foundations for a delivery business.',
    howEyebrow: 'How it works',
    howTitle: 'From setup to daily control—and future growth.',
    step: 'Step',
    groups: [['Orders', ['Create and import orders', 'Track the complete order lifecycle', 'Assign drivers', 'Search and filter operational orders', 'Run bulk order operations']], ['Driver Operations', ['Driver assignments', 'Delivery workflow', 'Driver collections and reconciliation', 'Delivery performance foundations']], ['COD & Collections', ['Track COD', 'Record Driver money received', 'Handle approved expenses and deductions', 'Reconcile collections']], ['Trader Management', ['Trader profiles and relationships', 'Pricing and area-based pricing', 'Statements and balances']], ['Trader Settlements', ['Calculate payable amounts', 'Track settlements', 'Partial and full allocation', 'Settlement history']], ['Accounting', ['Journals and accounting events', 'Expenses and reconciliation', 'Financial reporting']], ['Payroll', ['Employee payroll', 'Per-order and collection earnings', 'Payroll periods']], ['Reports', ['Operational and financial reports', 'Trader statements', 'Delivery performance']], ['Mobile Operations', ['Driver mobile', 'Trader mobile', 'Role-based access']], ['Integrations', ['API foundation', 'Salla — integration ready, external test pending', 'Shopify — integration ready, external test pending', 'WooCommerce — integration ready, external test pending', 'WhatsApp — planned']]],
    growth: [['New Trader Opportunities', 'Verified Traders who need a Delivery Company may be matched with suitable participating companies.'], ['Customer Delivery Requests', 'Standard package requests may later be routed to eligible companies using predefined pricing.'], ['Connected Trader Stores', 'Future Salla, Shopify and WooCommerce integrations can send Trader delivery orders directly into Tawseelhub.']],
    why: ['Delivery operations and accounting in one platform', 'Built around Delivery Company ↔ Trader relationships', 'COD and settlement workflows included', 'Role-based multi-tenant architecture', 'UAE business model support', 'Arabic & English foundation', 'Commerce integration-ready', 'Designed for operational growth'],
    how: [['Join Tawseelhub', 'Request a demo and qualify the fit for your delivery operation.'], ['Configure Your Operation', 'Set users, Traders, Drivers, areas, pricing and financial settings.'], ['Run Daily Delivery Operations', 'Manage orders, drivers, COD, collections, settlements, accounting and payroll.'], ['Connect & Grow', 'Connect future commerce channels and receive eligible business opportunities.']],
  },
  ar: {
    eyebrow: 'Tawseelhub · نظام تشغيل التوصيل',
    title: 'أدر شركة التوصيل بالكامل من نظام تشغيل واحد',
    body: 'أدر الطلبات والسائقين والتحصيل عند الاستلام وتسويات التجار والمحاسبة والرواتب والتقارير وقنوات البيع المتصلة من منصة واحدة مصممة لشركات التوصيل.',
    demo: 'اطلب عرضاً',
    explore: 'استكشف المزايا ↓',
    points: ['مصمم لعمليات التوصيل في الإمارات', 'جاهز بالعربية والإنجليزية', 'بنية SaaS متعددة الشركات', 'عمليات توصيل + تحكم مالي'],
    lifecycle: 'TAWSEELHUB / دورة التشغيل',
    stages: ['استقبال الطلبات', 'العمليات اليومية', 'التحكم المالي', 'التقارير والنمو'],
    sectionEyebrow: 'دورة تشغيل كاملة',
    sectionTitle: 'كل ما تحتاجه شركة التوصيل للتشغيل',
    sectionBody: 'من دخول الطلب إلى النظام وحتى العمل الميداني اليومي والتحكم المالي وتقارير الإدارة.',
    growthEyebrow: 'خدمات نمو مخطط لها',
    growthTitle: 'ليس برنامجاً فقط. منصة تساعدك على النمو.',
    growthBody: 'تتضمن قدرات Tawseelhub القادمة طريقة منظمة لإنشاء فرص مؤهلة لشركات التوصيل المشاركة، بدون كشف دليل شركات عام أو وعد بحجم عمل محدد.',
    whyEyebrow: 'لماذا Tawseelhub',
    whyTitle: 'أساس عملي لشركة التوصيل.',
    howEyebrow: 'كيف يعمل',
    howTitle: 'من الإعداد إلى التحكم اليومي والنمو المستقبلي.',
    step: 'الخطوة',
    groups: [['الطلبات', ['إنشاء واستيراد الطلبات', 'متابعة دورة حياة الطلب بالكامل', 'إسناد السائقين', 'البحث والتصفية في الطلبات التشغيلية', 'تشغيل إجراءات جماعية للطلبات']], ['عمليات السائقين', ['إسناد السائقين', 'مسار التوصيل', 'تحصيلات السائقين والمطابقة', 'أساسيات أداء التوصيل']], ['الدفع عند الاستلام والتحصيل', ['متابعة COD', 'تسجيل الأموال المستلمة من السائق', 'إدارة المصاريف والخصومات المعتمدة', 'مطابقة التحصيلات']], ['إدارة التجار', ['ملفات وعلاقات التجار', 'التسعير حسب المناطق', 'الكشوفات والأرصدة']], ['تسويات التجار', ['احتساب المبالغ المستحقة', 'متابعة التسويات', 'تخصيص جزئي وكامل', 'سجل التسويات']], ['المحاسبة', ['القيود والأحداث المحاسبية', 'المصاريف والمطابقة', 'التقارير المالية']], ['الرواتب', ['رواتب الموظفين', 'استحقاقات حسب الطلب والتحصيل', 'فترات الرواتب']], ['التقارير', ['تقارير تشغيلية ومالية', 'كشوفات التجار', 'أداء التوصيل']], ['عمليات الهاتف', ['تطبيق السائق', 'تطبيق التاجر', 'صلاحيات حسب الدور']], ['التكاملات', ['أساس API', 'Salla — التكامل جاهز، بانتظار الاختبار الخارجي', 'Shopify — التكامل جاهز، بانتظار الاختبار الخارجي', 'WooCommerce — التكامل جاهز، بانتظار الاختبار الخارجي', 'WhatsApp — مخطط']]],
    growth: [['فرص تجار جديدة', 'يمكن مطابقة التجار الموثقين الذين يحتاجون شركة توصيل مع شركات مشاركة مناسبة.'], ['طلبات توصيل العملاء', 'يمكن لاحقاً توجيه طلبات الشحن القياسية إلى الشركات المؤهلة باستخدام أسعار معرفة مسبقاً.'], ['متاجر تجار متصلة', 'تكاملات Salla وShopify وWooCommerce المستقبلية يمكنها إرسال طلبات التوصيل إلى Tawseelhub مباشرة.']],
    why: ['عمليات التوصيل والمحاسبة في منصة واحدة', 'مصمم حول علاقة شركة التوصيل بالتاجر', 'مسارات الدفع عند الاستلام والتسويات مدمجة', 'بنية متعددة المستأجرين حسب الصلاحيات', 'يدعم نموذج العمل في الإمارات', 'أساس عربي وإنجليزي', 'جاهز لتكاملات التجارة', 'مصمم للنمو التشغيلي'],
    how: [['انضم إلى Tawseelhub', 'اطلب عرضاً وتأكد من ملاءمة المنصة لعملية التوصيل لديك.'], ['اضبط عمليتك', 'أعد المستخدمين والتجار والسائقين والمناطق والتسعير والإعدادات المالية.'], ['شغل العمليات اليومية', 'أدر الطلبات والسائقين والتحصيل والتسويات والمحاسبة والرواتب.'], ['اربط وانمُ', 'اربط قنوات التجارة المستقبلية واستقبل فرصاً مؤهلة.']],
  },
} as const;

export function DeliveryCompanyPage() {
  const locale = usePublicLocale();
  const t = copy[locale];
  useEffect(() => {
    trackEvent('delivery_company_page_view', { page: '/delivery-companies', locale });
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.text = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'Tawseelhub', url: 'https://tawseelhub.com' }, { '@type': 'SoftwareApplication', name: 'Tawseelhub', applicationCategory: 'BusinessApplication', operatingSystem: 'Web', description: 'Delivery Operating System for UAE delivery companies.' }, { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: locale === 'ar' ? 'الرئيسية' : 'Home', item: 'https://tawseelhub.com/' }, { '@type': 'ListItem', position: 2, name: locale === 'ar' ? 'لشركات التوصيل' : 'For Delivery Companies', item: 'https://tawseelhub.com/delivery-companies' }] }] });
    document.head.append(script);
    return () => script.remove();
  }, [locale]);
  return <><section className="dc-hero" dir={locale === 'ar' ? 'rtl' : 'ltr'}><div><p className="eyebrow"><span />{t.eyebrow}</p><h1>{t.title}</h1><p>{t.body}</p><div className="hero-actions"><Link className="button button-primary" onClick={() => trackEvent('request_demo_clicked', { page: '/delivery-companies', ctaLocation: 'hero', locale })} to="/request-demo">{t.demo}</Link><a className="button button-secondary" href="#delivery-company-features">{t.explore}</a></div><div className="dc-points">{t.points.map(item => <span key={item}>✓ {item}</span>)}</div></div><div className="dc-system"><span>{t.lifecycle}</span>{t.stages.map((item, index) => <div key={item}><b>0{index + 1}</b><strong>{item}</strong></div>)}</div></section><section className="section dc-capabilities" id="delivery-company-features"><div className="section-heading"><p className="eyebrow"><span />{t.sectionEyebrow}</p><h2>{t.sectionTitle}</h2><p>{t.sectionBody}</p></div><div className="dc-group-grid">{t.groups.map(([title, items], index) => <article key={title}><span>{String(index + 1).padStart(2, '0')}</span><h3>{title}</h3><ul>{items.map(item => <li key={item}>{item}</li>)}</ul></article>)}</div></section><section className="split-section dc-grow"><div className="section-heading"><p className="eyebrow light"><span />{t.growthEyebrow}</p><h2>{t.growthTitle}</h2><p>{t.growthBody}</p></div><div className="growth-list">{t.growth.map(([title, body], index) => <article key={title}><span>{index + 1}</span><div><h3>{title}</h3><p>{body}</p></div></article>)}</div></section><section className="section why-section"><div className="section-heading"><p className="eyebrow"><span />{t.whyEyebrow}</p><h2>{t.whyTitle}</h2></div><div className="why-grid">{t.why.map((item, index) => <div key={item}><span>0{index + 1}</span><strong>{item}</strong></div>)}</div></section><section className="section how-section"><div className="section-heading"><p className="eyebrow"><span />{t.howEyebrow}</p><h2>{t.howTitle}</h2></div><div className="how-grid">{t.how.map(([title, body], index) => <article key={title}><span>{t.step} {index + 1}</span><h3>{title}</h3><p>{body}</p></article>)}</div><Link className="button button-primary" onClick={() => trackEvent('request_demo_clicked', { page: '/delivery-companies', ctaLocation: 'how_it_works', locale })} to="/request-demo">{t.demo}</Link></section></>;
}
