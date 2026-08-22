import { useRef, useState, type FormEvent } from 'react';
import { leadAttribution, trackConversionOnce, trackEvent, utmMetadata } from './analytics';
import { countriesByLocale, emiratesByLocale, usePublicLocale } from './public-localization';
import { submitDemoRequest } from './demo-request-client';

const featureValues = ['order_management', 'driver_management', 'cod_collections', 'trader_settlements', 'accounting', 'payroll', 'reports', 'mobile_apps', 'trader_portal', 'storefront_commerce'] as const;
const canonicalCountryName = (codeOrName: string) => countriesByLocale.en.find(([code, name]) => code === codeOrName || name === codeOrName)?.[1] ?? codeOrName;
const optionalNumber = (value: FormDataEntryValue | null): number | undefined => {
  const text = String(value ?? '').trim();
  return text === '' ? undefined : Number(text);
};

const copy = {
  en: {
    heroEyebrow: 'Request a demo',
    heroTitle: 'See your delivery business in one connected view.',
    heroCopy: 'Share the essentials and the Tawseelhub team will contact you to qualify the fit and arrange a focused demo.',
    companyContact: 'Company & contact',
    requiredHint: 'Required fields are marked with an asterisk.',
    usefulDetails: 'Useful details',
    optionalHint: 'Optional details help us prepare a better demo, but they are not required.',
    companyName: 'Company Name *',
    contactPerson: 'Contact Person *',
    mobile: 'Mobile Number *',
    mobilePlaceholder: '+971 50 689 8604 or local format',
    email: 'Email *',
    country: 'Country *',
    emirate: 'Emirate',
    optional: 'Optional',
    selectEmirate: 'Select emirate if useful',
    preferredContact: 'Preferred Contact Method *',
    selectMethod: 'Select method',
    phone: 'Phone',
    whatsapp: 'WhatsApp',
    emailMethod: 'Email',
    monthlyOrders: 'Approximate Monthly Orders',
    drivers: 'Approximate Number of Drivers',
    features: 'Features of Interest',
    challenge: 'Main Business Challenge',
    fax: 'Company Fax',
    consent: 'I agree that Tawseelhub may contact me regarding this request.',
    submit: 'Request Demo',
    submitting: 'Submitting…',
    successEyebrow: 'Demo request received',
    thankYou: 'Thank You',
    successCopy: 'Thank you. Your request has been received. Our Tawseelhub team will contact you using your preferred contact method.',
    reference: 'Reference',
    next: 'What happens next',
    nextTitle: 'A short conversation, then a focused demo.',
    nextItems: ['We review your company and contact details.', 'Yousef or the Tawseelhub team follows up by your preferred method.', 'The demo is shaped around your orders, drivers, COD and reporting needs.'],
    privacy: 'Your information is used only to respond to this request. Newsletter consent is not bundled into this form.',
    featureLabels: ['Order Management', 'Driver Management', 'COD & Collections', 'Trader Settlements', 'Accounting', 'Payroll', 'Reports', 'Mobile Apps', 'Trader Portal', 'Storefront / Commerce'],
    errors: { companyName: 'Please enter your company name.', contactPerson: 'Please enter your contact name.', mobileNumber: 'Please enter a valid mobile number.', email: 'Please enter your email address.', country: 'Please select your country.', preferredContactMethod: 'Please select your preferred contact method.', consent: 'Please agree that Tawseelhub may contact you regarding this request.', server: "We couldn't submit your request right now. Please try again." },
  },
  ar: {
    heroEyebrow: 'طلب عرض',
    heroTitle: 'شاهد شركة التوصيل لديك في صورة تشغيلية واحدة.',
    heroCopy: 'شارك البيانات الأساسية وسيتواصل معك فريق Tawseelhub لتأكيد الملاءمة وترتيب عرض مركز.',
    companyContact: 'الشركة والتواصل',
    requiredHint: 'الحقول المطلوبة مميزة بعلامة النجمة.',
    usefulDetails: 'تفاصيل مفيدة',
    optionalHint: 'التفاصيل الاختيارية تساعدنا في تجهيز عرض أفضل، لكنها ليست مطلوبة.',
    companyName: 'اسم الشركة *',
    contactPerson: 'اسم الشخص المسؤول *',
    mobile: 'رقم الهاتف *',
    mobilePlaceholder: '+971 50 689 8604 أو رقم محلي',
    email: 'البريد الإلكتروني *',
    country: 'الدولة *',
    emirate: 'الإمارة',
    optional: 'اختياري',
    selectEmirate: 'اختر الإمارة إذا كان ذلك مفيداً',
    preferredContact: 'طريقة التواصل المفضلة *',
    selectMethod: 'اختر الطريقة',
    phone: 'اتصال هاتفي',
    whatsapp: 'واتساب',
    emailMethod: 'البريد الإلكتروني',
    monthlyOrders: 'عدد الطلبات الشهري التقريبي',
    drivers: 'عدد السائقين التقريبي',
    features: 'المزايا المطلوبة',
    challenge: 'التحدي التجاري الرئيسي',
    fax: 'فاكس الشركة',
    consent: 'أوافق على أن يتواصل معي فريق Tawseelhub بخصوص هذا الطلب.',
    submit: 'اطلب عرضاً',
    submitting: 'جاري الإرسال…',
    successEyebrow: 'تم استلام طلب العرض',
    thankYou: 'شكراً لك',
    successCopy: 'شكراً لك. تم استلام طلبك وسيتواصل معك فريق Tawseelhub عبر طريقة التواصل المفضلة لديك.',
    reference: 'المرجع',
    next: 'ماذا يحدث بعد ذلك',
    nextTitle: 'محادثة قصيرة ثم عرض مركز.',
    nextItems: ['نراجع بيانات الشركة والتواصل.', 'يتابع يوسف أو فريق Tawseelhub عبر الطريقة التي اخترتها.', 'يتم تجهيز العرض حول طلباتك وسائقيك والتحصيل والتقارير.'],
    privacy: 'تستخدم معلوماتك فقط للرد على هذا الطلب. لا يتم دمج موافقة النشرات البريدية في هذا النموذج.',
    featureLabels: ['إدارة الطلبات', 'إدارة السائقين', 'الدفع عند الاستلام والتحصيل', 'تسويات التجار', 'المحاسبة', 'الرواتب', 'التقارير', 'تطبيقات الهاتف', 'بوابة التاجر', 'المتجر / التجارة'],
    errors: { companyName: 'يرجى إدخال اسم الشركة.', contactPerson: 'يرجى إدخال اسم الشخص المسؤول.', mobileNumber: 'يرجى إدخال رقم هاتف صحيح.', email: 'يرجى إدخال البريد الإلكتروني.', country: 'يرجى اختيار الدولة.', preferredContactMethod: 'يرجى اختيار طريقة التواصل المفضلة.', consent: 'يرجى الموافقة على تواصل Tawseelhub معك بخصوص هذا الطلب.', server: 'تعذر إرسال طلبك الآن. يرجى المحاولة مرة أخرى.' },
  },
} as const;

function validate(form: HTMLFormElement, locale: keyof typeof copy) {
  const data = new FormData(form);
  const errors: Record<string, string> = {};
  const required = copy[locale].errors;
  for (const field of ['companyName', 'contactPerson', 'mobileNumber', 'email', 'country', 'preferredContactMethod'] as const) if (String(data.get(field) ?? '').trim() === '') errors[field] = required[field];
  const email = String(data.get('email') ?? '');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = required.email;
  const mobileDigits = String(data.get('mobileNumber') ?? '').replace(/\D/g, '');
  if (mobileDigits && (mobileDigits.length < 7 || mobileDigits.length > 15)) errors.mobileNumber = required.mobileNumber;
  if (!data.get('consent')) errors.consent = required.consent;
  return errors;
}

export function DemoRequestPage() {
  const locale = usePublicLocale();
  const t = copy[locale];
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [reference, setReference] = useState('');
  const [message, setMessage] = useState('');
  const [country, setCountry] = useState('United Arab Emirates');
  const started = useRef(false);
  const onStart = () => { if (!started.current) { started.current = true; trackEvent('demo_form_started', { page: '/request-demo', locale, ...utmMetadata() }); } };
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'loading') return;
    const form = event.currentTarget, next = validate(form, locale);
    setErrors(next);
    if (Object.keys(next).length) { trackEvent('demo_form_validation_error', { page: '/request-demo', locale, ...utmMetadata() }); return; }
    const data = new FormData(form), attribution = leadAttribution();
    setStatus('loading'); setMessage('');
    trackEvent('demo_form_submitted', { page: '/request-demo', locale, ...utmMetadata() });
    try {
      const result = await submitDemoRequest({ companyName: String(data.get('companyName')), contactPerson: String(data.get('contactPerson')), mobileNumber: String(data.get('mobileNumber')), email: String(data.get('email')), country: canonicalCountryName(String(data.get('country'))), emirate: canonicalCountryName(String(data.get('country'))) === 'United Arab Emirates' ? String(data.get('emirate') ?? '') || undefined : undefined, approximateDriverCount: optionalNumber(data.get('approximateDriverCount')), approximateMonthlyOrders: optionalNumber(data.get('approximateMonthlyOrders')), preferredContactMethod: String(data.get('preferredContactMethod')), mainChallenges: String(data.get('mainChallenges') ?? '') || undefined, featuresOfInterest: data.getAll('featuresOfInterest').map(String), consent: true, companyFax: String(data.get('companyFax') ?? ''), landingPage: location.pathname, ...attribution });
      setReference(result.referenceNumber); setStatus('success');
      trackEvent('demo_form_success', { page: '/request-demo', locale, ...utmMetadata() });
      trackConversionOnce('demo_request_submitted', result.referenceNumber, { page: '/request-demo', country: canonicalCountryName(String(data.get('country'))), lead_type: 'delivery_company', source: attribution.utmSource === 'google' || attribution.gclid ? 'google_ads' : 'public_website', cta_type: String(data.get('preferredContactMethod')), locale });
    } catch (error) {
      setStatus('error'); setMessage(error instanceof Error ? error.message : t.errors.server); trackEvent('demo_form_failed', { page: '/request-demo', locale, ...utmMetadata() });
    }
  }
  if (status === 'success') return <section className="demo-success" aria-live="polite" dir={locale === 'ar' ? 'rtl' : 'ltr'}><span>✓</span><p className="eyebrow">{t.successEyebrow}</p><h1>{t.thankYou}</h1><p>{t.successCopy}</p><strong>{locale === 'ar' ? <>{t.reference}: <bdi dir="ltr">{reference}</bdi></> : `${t.reference}: ${reference}`}</strong></section>;
  return <><section className="inner-hero demo-hero"><p className="eyebrow"><span />{t.heroEyebrow}</p><h1>{t.heroTitle}</h1><p>{t.heroCopy}</p></section><section className="demo-form-section" dir={locale === 'ar' ? 'rtl' : 'ltr'}><form noValidate onFocus={onStart} onSubmit={onSubmit}><SectionTitle number="01" title={t.companyContact} copy={t.requiredHint} /><div className="form-grid"><Field label={t.companyName} name="companyName" error={errors.companyName} /><Field label={t.contactPerson} name="contactPerson" error={errors.contactPerson} /><Field label={t.mobile} name="mobileNumber" placeholder={t.mobilePlaceholder} error={errors.mobileNumber} dir="ltr" /><Field label={t.email} name="email" type="email" error={errors.email} dir="ltr" /><label><span>{t.country}</span><select name="country" value={country} onChange={(event) => setCountry(event.target.value)}>{countriesByLocale[locale].map(([code, label]) => <option key={code} value={canonicalCountryName(code)}>{label}</option>)}</select>{errors.country && <small>{errors.country}</small>}</label>{country === 'United Arab Emirates' && <label><span>{t.emirate} <em>{t.optional}</em></span><select name="emirate" defaultValue=""><option value="">{t.selectEmirate}</option>{emiratesByLocale[locale].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}<label><span>{t.preferredContact}</span><select name="preferredContactMethod" defaultValue=""><option value="" disabled>{t.selectMethod}</option><option value="phone">{t.phone}</option><option value="whatsapp">{t.whatsapp}</option><option value="email">{t.emailMethod}</option></select>{errors.preferredContactMethod && <small>{errors.preferredContactMethod}</small>}</label></div><SectionTitle number="02" title={t.usefulDetails} copy={t.optionalHint} /><div className="form-grid"><Field label={t.monthlyOrders} name="approximateMonthlyOrders" type="number" /><Field label={t.drivers} name="approximateDriverCount" type="number" /></div><fieldset><legend>{t.features} <em>{t.optional}</em></legend><div className="interest-grid">{featureValues.map((value, index) => <label key={value}><input name="featuresOfInterest" type="checkbox" value={value} /><span>{t.featureLabels[index]}</span></label>)}</div></fieldset><label><span>{t.challenge} <em>{t.optional}</em></span><textarea name="mainChallenges" rows={4} /></label><label className="honeypot" aria-hidden="true"><span>{t.fax}</span><input name="companyFax" tabIndex={-1} autoComplete="off" /></label><label className="consent"><input name="consent" type="checkbox" /><span>{t.consent}</span></label>{errors.consent && <small className="field-error">{errors.consent}</small>}{status === 'error' && <div className="form-error" role="alert">{message}</div>}<button className="button button-primary" disabled={status === 'loading'} type="submit">{status === 'loading' ? t.submitting : t.submit}</button></form><aside><span>{t.next}</span><h2>{t.nextTitle}</h2><ul>{t.nextItems.map(item => <li key={item}>{item}</li>)}</ul><p>{t.privacy}</p></aside></section></>;
}

function Field({ label, name, type = 'text', placeholder, error, dir }: { label: string; name: string; type?: string | undefined; placeholder?: string | undefined; error?: string | undefined; dir?: 'ltr' | 'rtl' | undefined }) {
  return <label><span>{label}</span><input aria-invalid={error ? true : undefined} name={name} type={type} placeholder={placeholder} dir={dir} />{error && <small>{error}</small>}</label>;
}

function SectionTitle({ number, title, copy }: { number: string; title: string; copy: string }) {
  return <div className="form-section-title"><span>{number}</span><div><h2>{title}</h2><p>{copy}</p></div></div>;
}
