import { useRef, useState, type FormEvent } from 'react';
import { leadAttribution, trackConversionOnce, trackEvent, utmMetadata } from './analytics';
import { submitDemoRequest } from './demo-request-client';

const features = [
  ['order_management', 'Order Management'],
  ['driver_management', 'Driver Management'],
  ['cod_collections', 'COD & Collections'],
  ['trader_settlements', 'Trader Settlements'],
  ['accounting', 'Accounting'],
  ['payroll', 'Payroll'],
  ['reports', 'Reports'],
  ['mobile_apps', 'Mobile Apps'],
  ['trader_portal', 'Trader Portal'],
  ['storefront_commerce', 'Storefront / Commerce'],
] as const;

const countries = [
  'United Arab Emirates',
  'Saudi Arabia',
  'Oman',
  'Qatar',
  'Kuwait',
  'Bahrain',
  'Jordan',
  'Egypt',
  'Iraq',
  'Lebanon',
  'Morocco',
  'Pakistan',
  'India',
  'United Kingdom',
  'United States',
  'Other',
] as const;

const emirates = [
  ['abu_dhabi', 'Abu Dhabi'],
  ['dubai', 'Dubai'],
  ['sharjah', 'Sharjah'],
  ['ajman', 'Ajman'],
  ['umm_al_quwain', 'Umm Al Quwain'],
  ['ras_al_khaimah', 'Ras Al Khaimah'],
  ['fujairah', 'Fujairah'],
] as const;

const optionalNumber = (value: FormDataEntryValue | null): number | undefined => {
  const text = String(value ?? '').trim();
  return text === '' ? undefined : Number(text);
};

function validate(form: HTMLFormElement) {
  const data = new FormData(form);
  const errors: Record<string, string> = {};
  const required: Record<string, string> = {
    companyName: 'Please enter your company name.',
    contactPerson: 'Please enter your contact name.',
    mobileNumber: 'Please enter a valid mobile number.',
    email: 'Please enter your email address.',
    country: 'Please select your country.',
    preferredContactMethod: 'Please select your preferred contact method.',
  };
  for (const [field, message] of Object.entries(required)) if (String(data.get(field) ?? '').trim() === '') errors[field] = message;
  const email = String(data.get('email') ?? '');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Please enter your email address.';
  const mobileDigits = String(data.get('mobileNumber') ?? '').replace(/\D/g, '');
  if (mobileDigits && (mobileDigits.length < 7 || mobileDigits.length > 15)) errors.mobileNumber = 'Please enter a valid mobile number.';
  if (!data.get('consent')) errors.consent = 'Please agree that Tawseelhub may contact you regarding this request.';
  return errors;
}

export function DemoRequestPage() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [reference, setReference] = useState('');
  const [message, setMessage] = useState('');
  const [country, setCountry] = useState('United Arab Emirates');
  const started = useRef(false);

  const onStart = () => {
    if (!started.current) {
      started.current = true;
      trackEvent('demo_form_started', { page: '/request-demo', ...utmMetadata() });
    }
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'loading') return;
    const form = event.currentTarget;
    const next = validate(form);
    setErrors(next);
    if (Object.keys(next).length) {
      trackEvent('demo_form_validation_error', { page: '/request-demo', ...utmMetadata() });
      return;
    }
    const data = new FormData(form);
    const attribution = leadAttribution();
    setStatus('loading');
    setMessage('');
    trackEvent('demo_form_submitted', { page: '/request-demo', ...utmMetadata() });
    try {
      const result = await submitDemoRequest({
        companyName: String(data.get('companyName')),
        contactPerson: String(data.get('contactPerson')),
        mobileNumber: String(data.get('mobileNumber')),
        email: String(data.get('email')),
        country: String(data.get('country')),
        emirate: String(data.get('country')) === 'United Arab Emirates' ? String(data.get('emirate') ?? '') || undefined : undefined,
        approximateDriverCount: optionalNumber(data.get('approximateDriverCount')),
        approximateMonthlyOrders: optionalNumber(data.get('approximateMonthlyOrders')),
        preferredContactMethod: String(data.get('preferredContactMethod')),
        mainChallenges: String(data.get('mainChallenges') ?? '') || undefined,
        featuresOfInterest: data.getAll('featuresOfInterest').map(String),
        consent: true,
        companyFax: String(data.get('companyFax') ?? ''),
        landingPage: location.pathname,
        ...attribution,
      });
      setReference(result.referenceNumber);
      setStatus('success');
      trackEvent('demo_form_success', { page: '/request-demo', ...utmMetadata() });
      trackConversionOnce('demo_request_submitted', result.referenceNumber, {
        page: '/request-demo',
        country: String(data.get('country')),
        lead_type: 'delivery_company',
        source: attribution.utmSource === 'google' || attribution.gclid ? 'google_ads' : 'public_website',
        cta_type: String(data.get('preferredContactMethod')),
      });
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : "We couldn't submit your request right now. Please try again.");
      trackEvent('demo_form_failed', { page: '/request-demo', ...utmMetadata() });
    }
  }

  if (status === 'success') {
    return (
      <section className="demo-success" aria-live="polite">
        <span>✓</span>
        <p className="eyebrow">Demo request received</p>
        <h1>Thank You</h1>
        <p>Thank you. Your request has been received. Our Tawseelhub team will contact you using your preferred contact method.</p>
        <strong>Reference: {reference}</strong>
      </section>
    );
  }

  return (
    <>
      <section className="inner-hero demo-hero">
        <p className="eyebrow"><span />Request a demo</p>
        <h1>See your delivery business in one connected view.</h1>
        <p>Share the essentials and the Tawseelhub team will contact you to qualify the fit and arrange a focused demo.</p>
      </section>
      <section className="demo-form-section">
        <form noValidate onFocus={onStart} onSubmit={onSubmit}>
          <SectionTitle number="01" title="Company & contact" copy="Required fields are marked with an asterisk." />
          <div className="form-grid">
            <Field label="Company Name *" name="companyName" error={errors.companyName} />
            <Field label="Contact Person *" name="contactPerson" error={errors.contactPerson} />
            <Field label="Mobile Number *" name="mobileNumber" placeholder="+971 50 689 8604 or local format" error={errors.mobileNumber} />
            <Field label="Email *" name="email" type="email" error={errors.email} />
            <label>
              <span>Country *</span>
              <select name="country" value={country} onChange={(event) => setCountry(event.target.value)}>
                {countries.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              {errors.country && <small>{errors.country}</small>}
            </label>
            {country === 'United Arab Emirates' && (
              <label>
                <span>Emirate <em>Optional</em></span>
                <select name="emirate" defaultValue="">
                  <option value="">Select emirate if useful</option>
                  {emirates.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            )}
            <label>
              <span>Preferred Contact Method *</span>
              <select name="preferredContactMethod" defaultValue="">
                <option value="" disabled>Select method</option>
                <option value="phone">Phone</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
              </select>
              {errors.preferredContactMethod && <small>{errors.preferredContactMethod}</small>}
            </label>
          </div>

          <SectionTitle number="02" title="Useful details" copy="Optional details help us prepare a better demo, but they are not required." />
          <div className="form-grid">
            <Field label="Approximate Monthly Orders" name="approximateMonthlyOrders" type="number" />
            <Field label="Approximate Number of Drivers" name="approximateDriverCount" type="number" />
          </div>

          <fieldset>
            <legend>Features of Interest <em>Optional</em></legend>
            <div className="interest-grid">
              {features.map(([value, label]) => (
                <label key={value}>
                  <input name="featuresOfInterest" type="checkbox" value={value} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            <span>Main Business Challenge <em>Optional</em></span>
            <textarea name="mainChallenges" rows={4} />
          </label>

          <label className="honeypot" aria-hidden="true">
            <span>Company Fax</span>
            <input name="companyFax" tabIndex={-1} autoComplete="off" />
          </label>
          <label className="consent">
            <input name="consent" type="checkbox" />
            <span>I agree that Tawseelhub may contact me regarding this request.</span>
          </label>
          {errors.consent && <small className="field-error">{errors.consent}</small>}
          {status === 'error' && <div className="form-error" role="alert">{message}</div>}
          <button className="button button-primary" disabled={status === 'loading'} type="submit">{status === 'loading' ? 'Submitting…' : 'Request Demo'}</button>
        </form>
        <aside>
          <span>What happens next</span>
          <h2>A short conversation, then a focused demo.</h2>
          <ul>
            <li>We review your company and contact details.</li>
            <li>Yousef or the Tawseelhub team follows up by your preferred method.</li>
            <li>The demo is shaped around your orders, drivers, COD and reporting needs.</li>
          </ul>
          <p>Your information is used only to respond to this request. Newsletter consent is not bundled into this form.</p>
        </aside>
      </section>
    </>
  );
}

function Field({ label, name, type = 'text', placeholder, error }: { label: string; name: string; type?: string | undefined; placeholder?: string | undefined; error?: string | undefined }) {
  return <label><span>{label}</span><input aria-invalid={error ? true : undefined} name={name} type={type} placeholder={placeholder} />{error && <small>{error}</small>}</label>;
}

function SectionTitle({ number, title, copy }: { number: string; title: string; copy: string }) {
  return <div className="form-section-title"><span>{number}</span><div><h2>{title}</h2><p>{copy}</p></div></div>;
}
