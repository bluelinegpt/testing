import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { applyPageMetadata } from './seo';
import { usePublicLocale } from './public-localization';

/**
 * Privacy Policy and Terms of Service.
 *
 * These are structural placeholders, not final legal copy. Every section
 * heading below is a standard, safe topic a policy of this kind covers --
 * the body text under each is intentionally generic and says only what is
 * already true of the product (what data the public site and app collect,
 * that Tawseelhub does not sell personal data, that the UAE is the current
 * service area). No specific legal commitment, retention period, regulator
 * reference or liability limit is invented here: the "Pending legal review"
 * notice at the top of each page says so explicitly, and stays until Legal
 * signs off on real replacement copy.
 */

function LegalNotice({ locale }: { locale: 'en' | 'ar' }) {
  return (
    <div className="legal-pending-notice" role="note">
      {locale === 'ar'
        ? 'هذه الصفحة هيكل أولي بانتظار مراجعة الفريق القانوني. لا تمثل الفقرات أدناه نصاً قانونياً نهائياً أو التزاماً تعاقدياً.'
        : 'This page is a structural placeholder pending legal review. The sections below are not final legal text or a binding commitment.'}
    </div>
  );
}

export function PrivacyPolicyPage() {
  const locale = usePublicLocale();
  const isAr = locale === 'ar';
  useEffect(() => {
    applyPageMetadata(
      isAr ? 'سياسة الخصوصية | Tawseelhub' : 'Privacy Policy | Tawseelhub',
      isAr
        ? 'كيف يتعامل Tawseelhub مع البيانات الشخصية عبر الموقع العام والمنصة.'
        : 'How Tawseelhub handles personal data across the public website and platform.',
      '/privacy',
    );
  }, [isAr]);
  const sections = isAr
    ? [
        ['المعلومات التي نجمعها', 'قد نجمع بيانات التواصل (الاسم والبريد ورقم الجوال) عند طلب عرض أو التسجيل كتاجر أو إرسال طلب شحنة، إضافة إلى بيانات استخدام أساسية للموقع العام.'],
        ['كيف نستخدم المعلومات', 'تُستخدم المعلومات للرد على الطلبات وتشغيل الحساب وتحسين المنصة. لا يبيع Tawseelhub البيانات الشخصية لأطراف ثالثة.'],
        ['مشاركة البيانات', 'تتم مشاركة البيانات فقط مع مزودي خدمة ضروريين لتشغيل المنصة (مثل الاستضافة والتحليلات)، وبموجب اتفاقيات تحد من استخدامهم لها.'],
        ['الاحتفاظ بالبيانات', 'تُحفظ البيانات طالما كانت ضرورية لتقديم الخدمة أو الالتزام بمتطلبات قانونية سارية.'],
        ['حقوقك', 'يمكنك طلب الوصول إلى بياناتك أو تصحيحها أو حذفها عبر صفحة التواصل.'],
        ['التواصل', 'لأي استفسار يخص الخصوصية، تواصل معنا عبر صفحة التواصل.'],
      ]
    : [
        ['Information We Collect', 'We may collect contact details (name, email, mobile number) when you request a demo, register as a Trader, or submit a package request, along with basic usage data from the public website.'],
        ['How We Use Information', 'Information is used to respond to requests, operate your account, and improve the platform. Tawseelhub does not sell personal data to third parties.'],
        ['Sharing of Data', 'Data is shared only with service providers necessary to run the platform (such as hosting and analytics), under agreements limiting their use of it.'],
        ['Data Retention', 'Data is kept for as long as necessary to provide the service or to meet applicable legal requirements.'],
        ['Your Rights', 'You can request access to, correction of, or deletion of your data via the Contact page.'],
        ['Contact', 'For any privacy question, reach us via the Contact page.'],
      ];
  return (
    <section className="section legal-page" dir={isAr ? 'rtl' : 'ltr'}>
      <p className="eyebrow"><span />{isAr ? 'قانوني' : 'Legal'}</p>
      <h1>{isAr ? 'سياسة الخصوصية' : 'Privacy Policy'}</h1>
      <LegalNotice locale={locale} />
      {sections.map(([title, body]) => (
        <div className="legal-section" key={title}>
          <h2>{title}</h2>
          <p>{body}</p>
        </div>
      ))}
      <Link className="text-link" to="/contact">{isAr ? 'تواصل معنا' : 'Contact us'} <span>→</span></Link>
    </section>
  );
}

export function TermsOfServicePage() {
  const locale = usePublicLocale();
  const isAr = locale === 'ar';
  useEffect(() => {
    applyPageMetadata(
      isAr ? 'شروط الخدمة | Tawseelhub' : 'Terms of Service | Tawseelhub',
      isAr
        ? 'شروط استخدام موقع ومنصة Tawseelhub.'
        : 'Terms governing use of the Tawseelhub website and platform.',
      '/terms',
    );
  }, [isAr]);
  const sections = isAr
    ? [
        ['قبول الشروط', 'باستخدامك لموقع أو منصة Tawseelhub، فإنك توافق على هذه الشروط.'],
        ['وصف الخدمة', 'يقدم Tawseelhub منصة تشغيل توصيل لشركات التوصيل، مع مسارات مرتبطة للتجار وطلبات شحن العملاء.'],
        ['مسؤوليات الحساب', 'أنت مسؤول عن دقة المعلومات التي تقدمها وعن الحفاظ على أمان بيانات دخولك.'],
        ['حدود المسؤولية', 'يُقدَّم Tawseelhub "كما هو" ضمن حدود القانون المعمول به.'],
        ['القانون الحاكم', 'تخضع هذه الشروط لقوانين دولة الإمارات العربية المتحدة.'],
        ['تعديل الشروط', 'قد تُحدَّث هذه الشروط من وقت لآخر، وسيُشار إلى تاريخ آخر تحديث.'],
        ['التواصل', 'لأي استفسار يخص الشروط، تواصل معنا عبر صفحة التواصل.'],
      ]
    : [
        ['Acceptance of Terms', 'By using the Tawseelhub website or platform, you agree to these terms.'],
        ['Service Description', 'Tawseelhub provides a delivery operating system for delivery companies, with connected paths for Traders and customer package requests.'],
        ['Account Responsibilities', 'You are responsible for the accuracy of information you provide and for keeping your login details secure.'],
        ['Limitation of Liability', 'Tawseelhub is provided "as is" to the extent permitted by applicable law.'],
        ['Governing Law', 'These terms are governed by the laws of the United Arab Emirates.'],
        ['Changes to Terms', 'These terms may be updated from time to time, with the last-updated date noted.'],
        ['Contact', 'For any question about these terms, reach us via the Contact page.'],
      ];
  return (
    <section className="section legal-page" dir={isAr ? 'rtl' : 'ltr'}>
      <p className="eyebrow"><span />{isAr ? 'قانوني' : 'Legal'}</p>
      <h1>{isAr ? 'شروط الخدمة' : 'Terms of Service'}</h1>
      <LegalNotice locale={locale} />
      {sections.map(([title, body]) => (
        <div className="legal-section" key={title}>
          <h2>{title}</h2>
          <p>{body}</p>
        </div>
      ))}
      <Link className="text-link" to="/contact">{isAr ? 'تواصل معنا' : 'Contact us'} <span>→</span></Link>
    </section>
  );
}
