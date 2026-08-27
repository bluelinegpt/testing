import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { trackEvent } from './analytics';
import { usePublicLocale } from './public-localization';

const channels = ['Salla', 'Shopify', 'WooCommerce', 'Own Website', 'Instagram', 'Facebook', 'TikTok', 'WhatsApp', 'Physical Store', 'Offline / manual sales'];
const channelsAr = ['Salla', 'Shopify', 'WooCommerce', 'موقع خاص', 'Instagram', 'Facebook', 'TikTok', 'WhatsApp', 'متجر فعلي', 'مبيعات يدوية / خارجية'];
const copy = {
  en: {
    eyebrow: 'For Traders & online sellers',
    title: 'Connect Your Business to Delivery',
    body: 'Register your business with Tawseelhub, connect your existing delivery relationship or let us help you find a suitable delivery partner.',
    cta: 'Register as a Trader',
    cloud: 'Sell where your customers are',
    sectionEyebrow: 'A clearer delivery path',
    sectionTitle: 'Built for the way your business already sells.',
    sectionBody: 'Tawseelhub connects verified Trader businesses to structured delivery operations without publishing a Delivery Company directory.',
    planned: 'Integration Ready — External Test Pending',
    benefits: [['Manage Delivery Orders', 'Create and monitor delivery orders through the Trader portal after activation.'], ['Track Order History & Status', 'See every order’s status, delivery outcome and history in one place instead of chasing updates by phone or WhatsApp.'], ['Connect Existing Commerce Channels', 'Salla, Shopify and WooCommerce integration is ready and awaiting external testing. No platform authentication is requested during registration.'], ['Connect Your Existing Delivery Company', 'Tell us who you work with. Tawseelhub staff verify the relationship privately before connecting it.'], ['Need a Delivery Company?', 'Register without one. After verification, your delivery requirements can feed a future controlled quotation process.'], ['Settlement Visibility', 'Once active, view your settlement status and payable history with your Delivery Company in one clear statement.']],
  },
  ar: {
    eyebrow: 'للتجار والمتاجر الإلكترونية',
    title: 'اربط نشاطك التجاري بالتوصيل',
    body: 'سجل نشاطك مع Tawseelhub واربط علاقة التوصيل الحالية لديك أو دعنا نساعدك في إيجاد شريك توصيل مناسب.',
    cta: 'سجل كتاجر',
    cloud: 'بع حيث يوجد عملاؤك',
    sectionEyebrow: 'مسار توصيل أوضح',
    sectionTitle: 'مصمم لطريقة بيعك الحالية.',
    sectionBody: 'يربط Tawseelhub التجار الموثقين بعمليات توصيل منظمة دون نشر دليل عام لشركات التوصيل.',
    planned: 'التكامل جاهز — بانتظار الاختبار الخارجي',
    benefits: [['إدارة طلبات التوصيل', 'أنشئ وتابع طلبات التوصيل من بوابة التاجر بعد التفعيل.'], ['متابعة سجل وحالة الطلبات', 'اطّلع على حالة كل طلب ونتيجة التوصيل والسجل الكامل في مكان واحد بدلاً من المتابعة عبر الهاتف أو واتساب.'], ['ربط قنوات التجارة الحالية', 'تكامل Salla وShopify وWooCommerce جاهز وبانتظار الاختبار الخارجي. لا نطلب تسجيل دخول المنصة أثناء التسجيل.'], ['اربط شركة التوصيل الحالية', 'أخبرنا بمن تعمل معه. يتحقق فريق Tawseelhub من العلاقة بشكل خاص قبل الربط.'], ['تحتاج شركة توصيل؟', 'سجل بدون شركة توصيل. بعد التحقق، يمكن استخدام احتياجاتك في مسار عروض منظم مستقبلاً.'], ['وضوح التسويات المالية', 'بعد التفعيل، تابع حالة التسوية وسجل المستحقات مع شركة التوصيل في كشف واضح.']],
  },
} as const;

export function TraderPage() {
  const locale = usePublicLocale();
  const t = copy[locale];
  useEffect(() => { trackEvent('trader_page_view', { page: '/traders', locale }); }, [locale]);
  return <><section className="trader-hero" dir={locale === 'ar' ? 'rtl' : 'ltr'}><div><p className="eyebrow"><span />{t.eyebrow}</p><h1>{t.title}</h1><p>{t.body}</p><Link className="button button-primary" to="/traders/register" onClick={() => trackEvent('trader_registration_clicked', { page: '/traders', ctaLocation: 'hero', locale })}>{t.cta}</Link></div><div className="trader-channel-cloud"><strong>{t.cloud}</strong>{(locale === 'ar' ? channelsAr : channels).map(x => <span key={x}>{x}</span>)}</div></section><section className="section"><div className="section-heading"><p className="eyebrow"><span />{t.sectionEyebrow}</p><h2>{t.sectionTitle}</h2><p>{t.sectionBody}</p></div><div className="trader-benefit-grid">{t.benefits.map(([h, p], i) => <article key={h}><span>0{i + 1}</span><h3>{h}</h3><p>{p}</p>{i === 2 && <b>{t.planned}</b>}</article>)}</div><div className="center-action"><Link className="button button-primary" to="/traders/register" onClick={() => trackEvent('trader_registration_clicked', { page: '/traders', ctaLocation: 'benefits', locale })}>{t.cta}</Link></div></section></>;
}
