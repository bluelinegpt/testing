import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  PlatformApiError,
  platformApi,
  type CompanyWebsite,
  type CompanyWebsiteAiProposal,
  type CompanyWebsiteSettings,
} from "../api/platform-client.js";

const empty: CompanyWebsiteSettings = {
  branding: {},
  languages: { en: true, ar: false, defaultLocale: "en" },
  presentation: {},
  contact: {
    whatsappEnabled: false,
    showPhone: false,
    showEmail: false,
    showWhatsapp: false,
    showAddress: false,
    showWorkingHours: false,
    workingHours: [],
  },
  services: [],
  coverage: [],
  benefits: [],
  marketing: { steps: [], industries: [], statistics: [], testimonials: [] },
  socialLinks: {},
  functions: { trackingEnabled: true, requestDeliveryEnabled: true },
  seo: { indexable: true },
  knowledge: {
    audiences: [],
    packageTypes: [],
    cod: { supported: false },
    pricing: { mode: "request_confirmation" },
    faqs: [],
    instructions: {},
    tawseelhubAttribution: true,
  },
  agent: {
    enabled: false,
    suggestedActions: ["services", "coverage", "contact"],
    tone: "friendly_professional",
    unknownBehavior: "safe_response",
    capabilities: {
      companyInformation: true,
      tracking: true,
      deliveryRequest: true,
      quoteGuidance: true,
      whatsappHandoff: true,
      contactHandoff: true,
      faqAnswers: true,
      socialLinks: true,
    },
  },
  sections: [
    "hero",
    "about",
    "services",
    "coverage",
    "benefits",
    "tracking",
    "request_delivery",
    "working_hours",
    "location",
    "contact",
    "social",
    "footer",
  ].map((key, order) => ({ key, enabled: true, order })),
};
const localizedFields = [
  "displayName",
  "tagline",
  "about",
  "heroHeadline",
  "heroSubheadline",
  "primaryCtaLabel",
  "secondaryCtaLabel",
] as const;
const localizedLabels: Record<(typeof localizedFields)[number], string> = {
  displayName: "Website display name",
  tagline: "Short tagline",
  about: "About the company",
  heroHeadline: "Homepage headline",
  heroSubheadline: "Homepage introduction",
  primaryCtaLabel: "Primary button label",
  secondaryCtaLabel: "Secondary button label",
};
const TEXT_LIMIT = 2000;

function editorSettings(value: CompanyWebsiteSettings | undefined): CompanyWebsiteSettings {
  const stored = structuredClone(value ?? empty);
  const contact = { ...empty.contact, ...stored.contact };
  // Older drafts could save the visibility and enabled flags independently.
  // Present them as the single Website control used by the current editor.
  if (contact.whatsappNumber?.trim() && (contact.whatsappEnabled || contact.showWhatsapp)) {
    contact.whatsappEnabled = true;
    contact.showWhatsapp = true;
  }
  return {
    ...structuredClone(empty),
    ...stored,
    branding: { ...empty.branding, ...stored.branding },
    languages: { ...empty.languages, ...stored.languages },
    contact,
    marketing: {
      ...empty.marketing,
      ...(stored.marketing ?? {}),
    },
  };
}

function localizedValue(
  value: string | { en?: string; ar?: string } | undefined,
  locale: "en" | "ar",
): string {
  return typeof value === "object" ? (value[locale] ?? "") : locale === "en" ? (value ?? "") : "";
}

const UAE_COVERAGE = [
  ["Abu Dhabi", "أبوظبي"],
  ["Dubai", "دبي"],
  ["Sharjah", "الشارقة"],
  ["Ajman", "عجمان"],
  ["Umm Al Quwain", "أم القيوين"],
  ["Ras Al Khaimah", "رأس الخيمة"],
  ["Fujairah", "الفجيرة"],
] as const;

function missing(value: string | undefined): boolean {
  return !value?.trim();
}

export function applyCompanyWebsiteAiProposal(
  current: CompanyWebsiteSettings,
  proposal: CompanyWebsiteAiProposal,
  phoneWhatsapp: string,
): CompanyWebsiteSettings {
  const next = structuredClone(current);
  next.languages.en = true;
  next.languages.ar = true;
  const localizedKeys = [
    "displayName",
    "tagline",
    "about",
    "heroHeadline",
    "heroSubheadline",
    "primaryCtaLabel",
  ] as const;
  for (const key of localizedKeys) {
    const existingEn = localizedValue(next.presentation[key], "en");
    const existingAr = localizedValue(next.presentation[key], "ar");
    const generated = proposal[key];
    next.presentation[key] = {
      en: missing(existingEn) ? generated.en : existingEn,
      ar: missing(existingAr) ? generated.ar : existingAr,
    };
  }
  if (missing(next.branding.primaryColor)) next.branding.primaryColor = proposal.colors.primary;
  if (missing(next.branding.secondaryColor))
    next.branding.secondaryColor = proposal.colors.secondary;
  if (missing(next.branding.accentColor)) next.branding.accentColor = proposal.colors.accent;
  if (missing(next.contact.phone)) next.contact.phone = phoneWhatsapp;
  if (missing(next.contact.mobile)) next.contact.mobile = phoneWhatsapp;
  if (missing(next.contact.whatsappNumber)) next.contact.whatsappNumber = phoneWhatsapp;
  next.contact.whatsappEnabled = true;
  next.contact.showWhatsapp = true;
  next.contact.showPhone = true;
  if (!next.contact.workingHours.length) {
    next.contact.workingHours = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ].map((day) => ({ day, closed: false, opens: "08:00", closes: "23:59" }));
    next.contact.showWorkingHours = true;
  }
  if (!next.services.length)
    next.services = proposal.services.map((item, order) => ({
      id: `ai-service-${order + 1}`,
      ...item,
      enabled: true,
      order,
    }));
  if (!next.benefits.length)
    next.benefits = proposal.benefits.map((item, order) => ({
      id: `ai-benefit-${order + 1}`,
      ...item,
      enabled: true,
      order,
    }));
  if (!next.coverage.length)
    next.coverage = UAE_COVERAGE.map(([emirate, emirateAr], order) => ({
      id: `uae-${order + 1}`,
      emirate,
      emirateAr,
      enabled: true,
      order,
    }));
  const description = next.knowledge.description ?? {};
  next.knowledge.description = {
    en: missing(description.en) ? proposal.about.en : (description.en ?? ""),
    ar: missing(description.ar) ? proposal.about.ar : (description.ar ?? ""),
  };
  if (!next.knowledge.audiences.length) next.knowledge.audiences = ["individuals", "smes"];
  if (!next.knowledge.faqs.length)
    next.knowledge.faqs = proposal.faqs.map((item, order) => ({
      id: `ai-faq-${order + 1}`,
      ...item,
      enabled: true,
      websiteVisible: true,
      agentAvailable: true,
      order,
    }));
  next.seo ??= { indexable: true };
  const seoTitle = next.seo.title ?? {};
  const seoDescription = next.seo.description ?? {};
  next.seo.title = {
    en: missing(seoTitle.en) ? proposal.seo.title.en : (seoTitle.en ?? ""),
    ar: missing(seoTitle.ar) ? proposal.seo.title.ar : (seoTitle.ar ?? ""),
  };
  next.seo.description = {
    en: missing(seoDescription.en) ? proposal.seo.description.en : (seoDescription.en ?? ""),
    ar: missing(seoDescription.ar) ? proposal.seo.description.ar : (seoDescription.ar ?? ""),
  };
  if (missing(next.agent.displayName)) next.agent.displayName = proposal.agent.displayName;
  const welcome = next.agent.welcomeMessage ?? {};
  next.agent.welcomeMessage = {
    en: missing(welcome.en) ? proposal.agent.welcomeMessage.en : (welcome.en ?? ""),
    ar: missing(welcome.ar) ? proposal.agent.welcomeMessage.ar : (welcome.ar ?? ""),
  };
  const handoff = next.agent.handoffMessage ?? {};
  next.agent.handoffMessage = {
    en: missing(handoff.en) ? proposal.agent.handoffMessage.en : (handoff.en ?? ""),
    ar: missing(handoff.ar) ? proposal.agent.handoffMessage.ar : (handoff.ar ?? ""),
  };
  return next;
}

export function CompanyWebsiteEditor({
  companyId,
  website,
  onSaved,
  onFailure,
}: {
  companyId: string;
  website: CompanyWebsite;
  onSaved: (website: CompanyWebsite) => void;
  onFailure: (error: unknown) => void;
}): ReactElement {
  const [settings, setSettings] = useState<CompanyWebsiteSettings>(() =>
    editorSettings(website.settings),
  );
  const [busy, setBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string>();
  const [validationErrors, setValidationErrors] = useState<readonly string[]>([]);
  const [aiCompanyName, setAiCompanyName] = useState("");
  const [aiPhone, setAiPhone] = useState("");
  const [aiDetails, setAiDetails] = useState("");
  const [aiLogoUrl, setAiLogoUrl] = useState<string>();
  const [aiProposal, setAiProposal] = useState<CompanyWebsiteAiProposal>();
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string>();
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaStatus, setMediaStatus] = useState<string>();
  const bannerUrls =
    settings.branding.bannerDataUrls ??
    (settings.branding.bannerDataUrl ? [settings.branding.bannerDataUrl] : []);
  const arabicBannerUrls = settings.branding.bannerDataUrlsAr ?? [];
  const completionItems = [
    {
      label: "Public company description",
      complete: Boolean(settings.knowledge.description?.en?.trim()),
    },
    { label: "At least one service", complete: settings.services.some((item) => item.enabled) },
    {
      label: "At least one coverage area",
      complete: settings.coverage.some((item) => item.enabled),
    },
    { label: "Working hours", complete: settings.contact.workingHours.length > 0 },
    {
      label: "At least one valid social link",
      complete: Object.values(settings.socialLinks).some((value) =>
        /^https?:\/\//iu.test(value ?? ""),
      ),
    },
    {
      label: "At least one public FAQ",
      complete: settings.knowledge.faqs.some((faq) => faq.enabled && faq.websiteVisible),
    },
    ...(settings.languages.ar
      ? [
          {
            label: "Arabic homepage content",
            complete: Boolean(
              localizedValue(settings.presentation.displayName, "ar").trim() &&
              localizedValue(settings.presentation.heroHeadline, "ar").trim() &&
              localizedValue(settings.presentation.heroSubheadline, "ar").trim(),
            ),
          },
          {
            label: "Arabic service and benefit content",
            complete: [...settings.services, ...settings.benefits]
              .filter((item) => item.enabled)
              .every((item) => Boolean(item.title.ar?.trim() && item.description?.ar?.trim())),
          },
          {
            label: "Arabic coverage names",
            complete: settings.coverage
              .filter((item) => item.enabled)
              .every((item) => Boolean(item.emirateAr?.trim())),
          },
        ]
      : []),
  ];
  const completeness = Math.round(
    (completionItems.filter((item) => item.complete).length / completionItems.length) * 100,
  );
  useEffect(() => setSettings(editorSettings(website.settings)), [website.version]);
  const update = (recipe: (next: CompanyWebsiteSettings) => void) =>
    setSettings((current) => {
      const next = structuredClone(current);
      recipe(next);
      return next;
    });
  async function generateAiProposal(): Promise<void> {
    setAiError(undefined);
    setAiProposal(undefined);
    if (!aiCompanyName.trim() || !aiPhone.trim()) {
      setAiError("Company name and Phone / WhatsApp are required.");
      return;
    }
    setAiBusy(true);
    try {
      const result = await platformApi.proposeCompanyWebsiteAiSetup(companyId, {
        companyName: aiCompanyName.trim(),
        phoneWhatsapp: aiPhone.trim(),
        ...(aiDetails.trim() ? { additionalDetails: aiDetails.trim() } : {}),
        ...(aiLogoUrl ? { logoUrl: aiLogoUrl } : {}),
      });
      setAiProposal(result.proposal);
    } catch (error) {
      setAiError(
        error instanceof PlatformApiError
          ? error.message
          : "OpenAI could not prepare the Website proposal.",
      );
    } finally {
      setAiBusy(false);
    }
  }
  async function uploadLogo(file: File | undefined, forAiSetup = false): Promise<void> {
    if (!file) return;
    setMediaBusy(true);
    setMediaStatus("Uploading logo to R2…");
    try {
      const url = await readWebsiteLogo(companyId, file, update, setValidationErrors);
      if (!url) {
        setMediaStatus(undefined);
        return;
      }
      if (forAiSetup) setAiLogoUrl(url);
      setMediaStatus("Logo uploaded to R2. Save Draft when the Website changes are ready.");
    } finally {
      setMediaBusy(false);
    }
  }
  async function uploadBanners(
    files: FileList | null,
    existing: readonly string[],
    field: "bannerDataUrls" | "bannerDataUrlsAr",
  ): Promise<void> {
    if (!files?.length) return;
    setMediaBusy(true);
    setMediaStatus("Uploading banner images to R2…");
    try {
      const count = await readWebsiteBanners(
        companyId,
        files,
        existing,
        field,
        update,
        setValidationErrors,
      );
      setMediaStatus(
        count > 0
          ? `${count} banner image${count === 1 ? "" : "s"} uploaded to R2. Save Draft when ready.`
          : undefined,
      );
    } finally {
      setMediaBusy(false);
    }
  }
  async function save(): Promise<void> {
    if (!website.slug || !website.templateKey) return;
    const errors = validateDraft(settings);
    setValidationErrors(errors);
    setSaveStatus(undefined);
    if (errors.length > 0) {
      globalThis.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setBusy(true);
    try {
      const saved = await platformApi.configureCompanyWebsite(companyId, {
        slug: website.slug,
        primaryLanguage: settings.languages.defaultLocale,
        defaultLocale: settings.languages.defaultLocale,
        templateKey: website.templateKey,
        expectedVersion: website.version ?? 0,
        settings,
      });
      onSaved(saved);
      setSaveStatus(
        "All Website Setup fields were saved to the draft. The public website is unchanged until Publish.",
      );
    } catch (error) {
      setValidationErrors([
        error instanceof PlatformApiError
          ? error.message
          : "The Website draft could not be saved. Please try again.",
      ]);
      globalThis.scrollTo({ top: 0, behavior: "smooth" });
      onFailure(error);
    } finally {
      setBusy(false);
    }
  }
  function addList(kind: "services" | "benefits"): void {
    const title = globalThis
      .prompt(`Enter ${kind === "services" ? "service" : "benefit"} title`)
      ?.trim();
    if (!title) return;
    update((next) =>
      next[kind].push({
        id: `${kind.slice(0, -1)}-${crypto.randomUUID().slice(0, 8)}`,
        title: { en: title },
        enabled: true,
        order: next[kind].length,
      }),
    );
  }
  function addMarketing(kind: keyof CompanyWebsiteSettings["marketing"]): void {
    const labels = {
      steps: "step",
      industries: "industry",
      statistics: "statistic",
      testimonials: "testimonial",
    } as const;
    const title = globalThis.prompt(`Enter ${labels[kind]} title`)?.trim();
    if (!title) return;
    update((next) =>
      next.marketing[kind].push({
        id: `${labels[kind]}-${crypto.randomUUID().slice(0, 8)}`,
        title: { en: title },
        enabled: true,
        order: next.marketing[kind].length,
      }),
    );
  }
  function moveSection(index: number, direction: -1 | 1): void {
    update((next) => {
      const ordered = [...next.sections].sort((a, b) => a.order - b.order);
      const target = index + direction;
      if (target < 0 || target >= ordered.length) return;
      [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
      ordered.forEach((item, order) => (item.order = order));
      next.sections = ordered;
    });
  }
  return (
    <div className="website-editor">
      <div className="platform-panel__header">
        <div>
          <h4>Edit Website</h4>
          <p className="platform-muted">Saved changes remain draft until Publish.</p>
          <p>
            <strong>Website Information: {completeness}% complete</strong>
          </p>
          <p className="platform-muted">
            Save Draft saves every section on this page: branding, bilingual content, services,
            coverage, contact, WhatsApp, AI Agent, social links, SEO and section order.
          </p>
        </div>
        <button
          className="platform-button"
          disabled={busy || mediaBusy}
          onClick={() => void save()}
          type="button"
        >
          Save Draft
        </button>
      </div>
      {saveStatus ? (
        <p className="website-editor__save-status" role="status">
          {saveStatus}
        </p>
      ) : null}
      {mediaStatus ? (
        <p className="website-editor__save-status" role="status">
          {mediaStatus}
        </p>
      ) : null}
      {validationErrors.length ? (
        <div className="platform-login__error website-editor__errors" role="alert">
          <strong>Draft was not saved. Correct these items:</strong>
          <ul>
            {validationErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="website-editor__completion website-ai-setup" open>
        <summary>AI Website Setup — generate a bilingual proposal</summary>
        <p className="platform-muted">
          OpenAI prepares English and Arabic content for review. It does not save or publish.
          Existing populated fields and uploaded banners are preserved.
        </p>
        <div className="website-editor__grid">
          <label className="platform-field">
            <span>Company name</span>
            <input
              maxLength={160}
              onChange={(event) => setAiCompanyName(event.target.value)}
              required
              value={aiCompanyName}
            />
          </label>
          <label className="platform-field">
            <span>Phone / WhatsApp</span>
            <input
              maxLength={40}
              onChange={(event) => setAiPhone(event.target.value)}
              required
              value={aiPhone}
            />
          </label>
          <label className="platform-field website-ai-setup__wide">
            <span>Additional confirmed details (optional)</span>
            <textarea
              maxLength={2000}
              onChange={(event) => setAiDetails(event.target.value)}
              value={aiDetails}
            />
          </label>
          <label className="platform-field website-ai-setup__wide">
            <span>Logo for Website Setup</span>
            <input
              accept="image/png,image/jpeg"
              disabled={mediaBusy}
              type="file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                void uploadLogo(file, true);
              }}
            />
            <small>
              PNG or JPEG, maximum 500 KB. The logo is sent with the supplied details to OpenAI for
              brand-color guidance only.
            </small>
          </label>
        </div>
        <p>
          Confirmed defaults: UAE coverage · individuals and normal business customers · every day
          08:00–24:00 · modern friendly-professional tone.
        </p>
        {aiError ? <p role="alert">{aiError}</p> : null}
        <button
          className="platform-button"
          disabled={aiBusy || mediaBusy}
          onClick={() => void generateAiProposal()}
          type="button"
        >
          {aiBusy ? "Preparing proposal…" : "Generate with OpenAI"}
        </button>
        {aiProposal ? (
          <section className="website-ai-review" aria-labelledby="website-ai-review-heading">
            <h5 id="website-ai-review-heading">Review proposed content</h5>
            <dl>
              <div>
                <dt>Website name</dt>
                <dd>{aiProposal.displayName.en}</dd>
              </div>
              <div dir="rtl">
                <dt>اسم الموقع</dt>
                <dd>{aiProposal.displayName.ar}</dd>
              </div>
              <div>
                <dt>English tagline</dt>
                <dd>{aiProposal.tagline.en}</dd>
              </div>
              <div dir="rtl">
                <dt>الشعار النصي العربي</dt>
                <dd>{aiProposal.tagline.ar}</dd>
              </div>
              <div>
                <dt>English headline</dt>
                <dd>{aiProposal.heroHeadline.en}</dd>
              </div>
              <div dir="rtl">
                <dt>العنوان العربي</dt>
                <dd>{aiProposal.heroHeadline.ar}</dd>
              </div>
              <div>
                <dt>English introduction</dt>
                <dd>{aiProposal.heroSubheadline.en}</dd>
              </div>
              <div dir="rtl">
                <dt>المقدمة العربية</dt>
                <dd>{aiProposal.heroSubheadline.ar}</dd>
              </div>
              <div>
                <dt>English company description</dt>
                <dd>{aiProposal.about.en}</dd>
              </div>
              <div dir="rtl">
                <dt>وصف الشركة بالعربية</dt>
                <dd>{aiProposal.about.ar}</dd>
              </div>
              <div>
                <dt>Primary action</dt>
                <dd>{aiProposal.primaryCtaLabel.en}</dd>
              </div>
              <div dir="rtl">
                <dt>الإجراء الأساسي</dt>
                <dd>{aiProposal.primaryCtaLabel.ar}</dd>
              </div>
              <div>
                <dt>Services</dt>
                <dd>
                  {aiProposal.services.map((item) => (
                    <p key={item.title.en}>
                      <strong>{item.title.en}:</strong> {item.description.en}
                    </p>
                  ))}
                </dd>
              </div>
              <div dir="rtl">
                <dt>الخدمات</dt>
                <dd>
                  {aiProposal.services.map((item) => (
                    <p key={item.title.ar}>
                      <strong>{item.title.ar}:</strong> {item.description.ar}
                    </p>
                  ))}
                </dd>
              </div>
              <div>
                <dt>Benefits</dt>
                <dd>
                  {aiProposal.benefits.map((item) => (
                    <p key={item.title.en}>
                      <strong>{item.title.en}:</strong> {item.description.en}
                    </p>
                  ))}
                </dd>
              </div>
              <div dir="rtl">
                <dt>المزايا</dt>
                <dd>
                  {aiProposal.benefits.map((item) => (
                    <p key={item.title.ar}>
                      <strong>{item.title.ar}:</strong> {item.description.ar}
                    </p>
                  ))}
                </dd>
              </div>
              <div>
                <dt>FAQs (English)</dt>
                <dd>
                  {aiProposal.faqs.map((item) => (
                    <p key={item.question.en}>
                      <strong>{item.question.en}</strong>
                      <br />
                      {item.answer.en}
                    </p>
                  ))}
                </dd>
              </div>
              <div dir="rtl">
                <dt>الأسئلة الشائعة</dt>
                <dd>
                  {aiProposal.faqs.map((item) => (
                    <p key={item.question.ar}>
                      <strong>{item.question.ar}</strong>
                      <br />
                      {item.answer.ar}
                    </p>
                  ))}
                </dd>
              </div>
              <div>
                <dt>SEO</dt>
                <dd>
                  <strong>{aiProposal.seo.title.en}</strong>
                  <br />
                  {aiProposal.seo.description.en}
                </dd>
              </div>
              <div dir="rtl">
                <dt>تهيئة محركات البحث</dt>
                <dd>
                  <strong>{aiProposal.seo.title.ar}</strong>
                  <br />
                  {aiProposal.seo.description.ar}
                </dd>
              </div>
              <div>
                <dt>AI agent wording</dt>
                <dd>
                  <strong>{aiProposal.agent.displayName}</strong>
                  <br />
                  {aiProposal.agent.welcomeMessage.en}
                  <br />
                  {aiProposal.agent.handoffMessage.en}
                </dd>
              </div>
              <div dir="rtl">
                <dt>نص وكيل الذكاء الاصطناعي</dt>
                <dd>
                  {aiProposal.agent.welcomeMessage.ar}
                  <br />
                  {aiProposal.agent.handoffMessage.ar}
                </dd>
              </div>
              <div>
                <dt>Brand colors</dt>
                <dd>
                  {aiProposal.colors.primary} · {aiProposal.colors.secondary} ·{" "}
                  {aiProposal.colors.accent}
                </dd>
              </div>
              <div>
                <dt>Confirmed operational details</dt>
                <dd>All UAE · Individuals and SMEs · Daily 08:00–24:00 · {aiPhone.trim()}</dd>
              </div>
            </dl>
            <p className="platform-muted">
              Applying fills empty fields in this browser only. Review the full editor, then use
              Save Draft. Publishing remains a separate action.
            </p>
            <button
              className="platform-button"
              onClick={() => {
                setSettings((current) =>
                  applyCompanyWebsiteAiProposal(current, aiProposal, aiPhone.trim()),
                );
                setSaveStatus("AI proposal applied locally. Review it, then choose Save Draft.");
                setAiProposal(undefined);
              }}
              type="button"
            >
              Apply to empty fields
            </button>
          </section>
        ) : null}
      </details>
      <details className="website-editor__completion" open={completeness < 100}>
        <summary>
          Completion checklist — {completionItems.filter((item) => item.complete).length} of{" "}
          {completionItems.length}
        </summary>
        <ul>
          {completionItems.map((item) => (
            <li className={item.complete ? "is-complete" : "is-missing"} key={item.label}>
              {item.complete ? "✓" : "○"} {item.label}
              {item.complete ? "" : " — missing"}
            </li>
          ))}
        </ul>
        <p className="platform-muted">
          This score is guidance only. It does not control saving or publishing.
        </p>
      </details>
      <p className="website-editor__limits">
        <strong>Content limits:</strong> Website logo 500 KB · up to 3 Homepage banners, 2 MB each ·
        Agent name 100 characters · all multi-line public text fields 2,000 characters. Current
        counters appear below the main bilingual Website fields.
      </p>
      {website.hasHiddenLegacyMedia ? (
        <div className="website-editor__legacy-media-notice" role="status">
          This Website has an existing logo or banner saved in an old format that is too large to
          preview here, so it is hidden below — it has not been deleted. Upload a new logo/banner to
          replace it. If you Save Draft without uploading a replacement for a hidden image, that
          image is cleared.
        </div>
      ) : null}
      <nav aria-label="Website editor sections" className="website-editor__tabs">
        <a href="#website-brand">Brand</a>
        <a href="#website-homepage">Homepage</a>
        <a href="#website-services">Services</a>
        <a href="#website-trust">Trust</a>
        <a href="#website-contact">WhatsApp &amp; Contact</a>
        <a href="#website-agent">AI Agent</a>
        <a href="#website-seo">SEO</a>
        <a href="#website-sections">Review order</a>
      </nav>
      <details id="website-brand" open>
        <summary>Branding</summary>
        <div className="website-logo-editor">
          <div className="website-logo-editor__preview">
            {settings.branding.logoDataUrl ? (
              <img alt="Website logo preview" src={settings.branding.logoDataUrl} />
            ) : (
              <span>No Website logo uploaded</span>
            )}
          </div>
          <label className="platform-field">
            <span>Website logo — separate from the Company Portal logo</span>
            <input
              accept="image/png,image/jpeg"
              disabled={mediaBusy}
              type="file"
              onChange={(event) => void uploadLogo(event.currentTarget.files?.[0])}
            />
            <small>
              PNG or JPEG · maximum 500 KB. Saved in the Website draft and becomes public only after
              Publish.
            </small>
          </label>
          {settings.branding.logoDataUrl ? (
            <button
              className="platform-button platform-button--quiet"
              onClick={() =>
                update((next) => {
                  delete next.branding.logoDataUrl;
                })
              }
              type="button"
            >
              Remove Website logo
            </button>
          ) : null}
        </div>
        <div className="website-banner-editor">
          <div className="website-banner-editor__gallery">
            {bannerUrls.length ? (
              bannerUrls.map((url, index) => (
                <div className="website-banner-editor__item" key={`${url.slice(-24)}-${index}`}>
                  <div className="website-banner-editor__preview">
                    <img alt={`Homepage banner ${index + 1} preview`} src={url} />
                  </div>
                  <button
                    className="platform-button platform-button--quiet"
                    onClick={() =>
                      update((next) => {
                        next.branding.bannerDataUrls = bannerUrls.filter(
                          (_, itemIndex) => itemIndex !== index,
                        );
                        delete next.branding.bannerDataUrl;
                      })
                    }
                    type="button"
                  >
                    Remove banner {index + 1}
                  </button>
                </div>
              ))
            ) : (
              <div className="website-banner-editor__preview">
                <span>No Homepage banners uploaded</span>
              </div>
            )}
          </div>
          <label className="platform-field">
            <span>Add Homepage banners — {bannerUrls.length}/3 uploaded</span>
            <input
              accept="image/png,image/jpeg,image/webp"
              disabled={bannerUrls.length >= 3 || mediaBusy}
              multiple
              type="file"
              onChange={(event) =>
                void uploadBanners(event.currentTarget.files, bannerUrls, "bannerDataUrls")
              }
            />
            <small>
              Select one or more PNG, JPEG or WebP files · maximum 3 images total · 2 MB each ·
              recommended 16:9, such as 1600 × 900. Images rotate only after the draft is published.
            </small>
          </label>
          <div className="website-banner-editor__gallery">
            {arabicBannerUrls.map((url, index) => (
              <div className="website-banner-editor__item" key={`ar-${url.slice(-24)}-${index}`}>
                <div className="website-banner-editor__preview">
                  <img alt={`Arabic homepage banner ${index + 1} preview`} src={url} />
                </div>
                <button
                  className="platform-button platform-button--quiet"
                  onClick={() =>
                    update((next) => {
                      next.branding.bannerDataUrlsAr = arabicBannerUrls.filter(
                        (_, itemIndex) => itemIndex !== index,
                      );
                    })
                  }
                  type="button"
                >
                  Remove Arabic banner {index + 1}
                </button>
              </div>
            ))}
          </div>
          <label className="platform-field">
            <span>Arabic Homepage banners — {arabicBannerUrls.length}/3 uploaded</span>
            <input
              accept="image/png,image/jpeg,image/webp"
              disabled={arabicBannerUrls.length >= 3 || mediaBusy}
              multiple
              type="file"
              onChange={(event) =>
                void uploadBanners(event.currentTarget.files, arabicBannerUrls, "bannerDataUrlsAr")
              }
            />
            <small>
              Optional Arabic versions of the banners. When absent, the English/default banners are
              used.
            </small>
          </label>
          <div className="website-banner-editor__options">
            <label className="platform-field">
              <span>Rotation effect</span>
              <select
                value={settings.branding.bannerTransition ?? "fade"}
                onChange={(event) =>
                  update((next) => {
                    next.branding.bannerTransition = event.target.value as
                      "fade" | "slide" | "zoom";
                  })
                }
              >
                <option value="fade">Fade</option>
                <option value="slide">Slide</option>
                <option value="zoom">Gentle zoom</option>
              </select>
            </label>
            <label className="platform-field">
              <span>Change image every</span>
              <select
                value={settings.branding.bannerIntervalSeconds ?? 6}
                onChange={(event) =>
                  update((next) => {
                    next.branding.bannerIntervalSeconds = Number(event.target.value) as 4 | 6 | 8;
                  })
                }
              >
                <option value={4}>4 seconds</option>
                <option value={6}>6 seconds</option>
                <option value={8}>8 seconds</option>
              </select>
            </label>
            <label className="platform-field">
              <span>Banner size</span>
              <select
                value={settings.branding.bannerSize ?? "standard"}
                onChange={(event) =>
                  update((next) => {
                    next.branding.bannerSize = event.target.value as
                      "compact" | "standard" | "full";
                  })
                }
              >
                <option value="compact">Compact — capped height</option>
                <option value="standard">Standard — matches page content width</option>
                <option value="full">Full width — edge to edge</option>
              </select>
              <small>
                Standard shows the whole image at the same width as the page content, with height
                following the image itself.
              </small>
            </label>
          </div>
        </div>
        <div className="website-editor__grid">
          {(["primaryColor", "secondaryColor", "accentColor"] as const).map((key) => (
            <label className="platform-field" key={key}>
              <span>{key.replace("Color", " color")}</span>
              <input
                type="color"
                value={
                  settings.branding[key] ??
                  { primaryColor: "#123b5d", secondaryColor: "#dcecf4", accentColor: "#e2a93b" }[
                    key
                  ]
                }
                onChange={(event) =>
                  update((next) => {
                    next.branding[key] = event.target.value;
                  })
                }
              />
            </label>
          ))}
        </div>
        <div
          className="website-branding-preview"
          style={
            {
              "--brand-primary": settings.branding.primaryColor ?? "#123b5d",
              "--brand-secondary": settings.branding.secondaryColor ?? "#dcecf4",
              "--brand-accent": settings.branding.accentColor ?? "#e2a93b",
            } as CSSProperties
          }
        >
          <div>
            <strong>Live color preview</strong>
            <span>Header and primary buttons</span>
            <button type="button">Primary action</button>
          </div>
          <aside>
            <strong>Secondary section</strong>
            <span>Accent highlights and links</span>
            <a>Example link</a>
          </aside>
        </div>
        <button
          className="platform-button platform-button--quiet"
          onClick={() =>
            update((next) => {
              next.branding = {};
            })
          }
          type="button"
        >
          Reset theme defaults
        </button>
        <p className="platform-muted">
          If no Website logo is uploaded, Preview and the published Website fall back to the Company
          Profile logo.
        </p>
      </details>
      <details id="website-homepage">
        <summary>Languages & content</summary>
        <div className="website-editor__grid">
          <label>
            <input
              checked={settings.languages.en}
              onChange={(e) =>
                update((n) => {
                  n.languages.en = e.target.checked;
                  if (!n.languages.en) n.languages.defaultLocale = "ar";
                })
              }
              type="checkbox"
            />{" "}
            English
          </label>
          <label>
            <input
              checked={settings.languages.ar}
              onChange={(e) =>
                update((n) => {
                  n.languages.ar = e.target.checked;
                  if (!n.languages.ar) n.languages.defaultLocale = "en";
                })
              }
              type="checkbox"
            />{" "}
            Arabic
          </label>
          <label className="platform-field">
            <span>Default language</span>
            <select
              value={settings.languages.defaultLocale}
              onChange={(e) =>
                update((n) => {
                  n.languages.defaultLocale = e.target.value as "en" | "ar";
                })
              }
            >
              {settings.languages.en ? <option value="en">English</option> : null}
              {settings.languages.ar ? <option value="ar">Arabic</option> : null}
            </select>
          </label>
        </div>
        {localizedFields.map((field) => (
          <div className="website-editor__localized" key={field}>
            <label className="platform-field">
              <span>{localizedLabels[field]} (English)</span>
              <textarea
                maxLength={TEXT_LIMIT}
                value={(settings.presentation[field] as { en?: string } | undefined)?.en ?? ""}
                onChange={(e) =>
                  update((n) => {
                    n.presentation[field] = {
                      ...(n.presentation[field] as object),
                      en: e.target.value,
                    };
                  })
                }
              />
              <small>
                {localizedValue(settings.presentation[field], "en").length.toLocaleString()} /{" "}
                {TEXT_LIMIT.toLocaleString()} characters
              </small>
            </label>
            {settings.languages.ar ? (
              <label className="platform-field" dir="rtl">
                <span>{localizedLabels[field]} (Arabic)</span>
                <textarea
                  maxLength={TEXT_LIMIT}
                  value={(settings.presentation[field] as { ar?: string } | undefined)?.ar ?? ""}
                  onChange={(e) =>
                    update((n) => {
                      n.presentation[field] = {
                        ...(n.presentation[field] as object),
                        ar: e.target.value,
                      };
                    })
                  }
                />
                <small>
                  {localizedValue(settings.presentation[field], "ar").length.toLocaleString()} /{" "}
                  {TEXT_LIMIT.toLocaleString()} characters
                </small>
              </label>
            ) : null}
          </div>
        ))}
        <div className="website-editor__grid">
          {(["primaryCtaType", "secondaryCtaType"] as const).map((key) => (
            <label className="platform-field" key={key}>
              <span>{key}</span>
              <select
                value={(settings.presentation[key] as string | undefined) ?? "contact"}
                onChange={(event) =>
                  update((next) => {
                    next.presentation[key] = event.target.value;
                  })
                }
              >
                {["contact", "track", "request_delivery", "whatsapp", "call", "section"].map(
                  (value) => (
                    <option key={value} value={value}>
                      {value.replaceAll("_", " ")}
                    </option>
                  ),
                )}
              </select>
            </label>
          ))}
        </div>
      </details>
      <details id="website-services">
        <summary>Services & Why Choose Us</summary>
        {(["services", "benefits"] as const).map((kind) => (
          <section key={kind}>
            <div className="platform-panel__header">
              <h5>{kind === "services" ? "Services" : "Benefits"}</h5>
              <button
                className="platform-button platform-button--quiet"
                onClick={() => addList(kind)}
                type="button"
              >
                Add
              </button>
            </div>
            {settings[kind].map((item, index) => (
              <div className="website-editor__row" key={item.id}>
                <input
                  aria-label={`${kind} title`}
                  value={item.title.en ?? ""}
                  onChange={(e) =>
                    update((n) => {
                      n[kind][index]!.title.en = e.target.value;
                    })
                  }
                />
                <input
                  aria-label={`${kind} description`}
                  value={item.description?.en ?? ""}
                  onChange={(e) =>
                    update((n) => {
                      n[kind][index]!.description = {
                        ...n[kind][index]!.description,
                        en: e.target.value,
                      };
                    })
                  }
                />
                <input
                  aria-label={`${kind} title Arabic`}
                  dir="rtl"
                  placeholder="العنوان بالعربية"
                  value={item.title.ar ?? ""}
                  onChange={(e) =>
                    update((n) => {
                      n[kind][index]!.title.ar = e.target.value;
                    })
                  }
                />
                <input
                  aria-label={`${kind} description Arabic`}
                  dir="rtl"
                  placeholder="الوصف بالعربية"
                  value={item.description?.ar ?? ""}
                  onChange={(e) =>
                    update((n) => {
                      n[kind][index]!.description = {
                        ...n[kind][index]!.description,
                        ar: e.target.value,
                      };
                    })
                  }
                />
                <label>
                  <input
                    checked={item.enabled}
                    onChange={(e) =>
                      update((n) => {
                        n[kind][index]!.enabled = e.target.checked;
                      })
                    }
                    type="checkbox"
                  />{" "}
                  Show
                </label>
                <button
                  onClick={() =>
                    update((n) => {
                      n[kind].splice(index, 1);
                      n[kind].forEach((x, i) => (x.order = i));
                    })
                  }
                  type="button"
                >
                  Remove
                </button>
              </div>
            ))}
          </section>
        ))}
      </details>
      <details id="website-trust">
        <summary>How It Works, Industries, Statistics &amp; Testimonials</summary>
        {(["steps", "industries", "statistics", "testimonials"] as const).map((kind) => (
          <section key={kind}>
            <div className="platform-panel__header">
              <h5>
                {
                  (
                    {
                      steps: "How It Works",
                      industries: "Industries Served",
                      statistics: "Trust Statistics",
                      testimonials: "Testimonials",
                    } as const
                  )[kind]
                }
              </h5>
              <button
                className="platform-button platform-button--quiet"
                onClick={() => addMarketing(kind)}
                type="button"
              >
                Add
              </button>
            </div>
            <p className="platform-muted">
              {kind === "statistics"
                ? "Use the title for the value (for example 4,000+) and the description for its label."
                : kind === "testimonials"
                  ? "Use the title for the customer/company and the description for the approved testimonial."
                  : "Enter English and Arabic public content."}
            </p>
            {settings.marketing[kind].map((item, index) => (
              <div className="website-editor__row website-editor__row--bilingual" key={item.id}>
                <input
                  aria-label={`${kind} title English`}
                  placeholder="English title"
                  value={item.title.en ?? ""}
                  onChange={(event) =>
                    update((next) => {
                      next.marketing[kind][index]!.title.en = event.target.value;
                    })
                  }
                />
                <input
                  aria-label={`${kind} description English`}
                  placeholder="English description"
                  value={item.description?.en ?? ""}
                  onChange={(event) =>
                    update((next) => {
                      next.marketing[kind][index]!.description = {
                        ...next.marketing[kind][index]!.description,
                        en: event.target.value,
                      };
                    })
                  }
                />
                <input
                  aria-label={`${kind} title Arabic`}
                  dir="rtl"
                  placeholder="العنوان بالعربية"
                  value={item.title.ar ?? ""}
                  onChange={(event) =>
                    update((next) => {
                      next.marketing[kind][index]!.title.ar = event.target.value;
                    })
                  }
                />
                <input
                  aria-label={`${kind} description Arabic`}
                  dir="rtl"
                  placeholder="الوصف بالعربية"
                  value={item.description?.ar ?? ""}
                  onChange={(event) =>
                    update((next) => {
                      next.marketing[kind][index]!.description = {
                        ...next.marketing[kind][index]!.description,
                        ar: event.target.value,
                      };
                    })
                  }
                />
                <label>
                  <input
                    checked={item.enabled}
                    onChange={(event) =>
                      update((next) => {
                        next.marketing[kind][index]!.enabled = event.target.checked;
                      })
                    }
                    type="checkbox"
                  />{" "}
                  Show
                </label>
                <button
                  onClick={() =>
                    update((next) => {
                      next.marketing[kind].splice(index, 1);
                      next.marketing[kind].forEach((entry, order) => {
                        entry.order = order;
                      });
                    })
                  }
                  type="button"
                >
                  Remove
                </button>
              </div>
            ))}
          </section>
        ))}
      </details>
      <details>
        <summary>Coverage</summary>
        <button
          className="platform-button platform-button--quiet"
          onClick={() => {
            const emirate = globalThis.prompt("Emirate")?.trim();
            if (emirate)
              update((n) =>
                n.coverage.push({
                  id: `coverage-${crypto.randomUUID().slice(0, 8)}`,
                  emirate,
                  enabled: true,
                  order: n.coverage.length,
                }),
              );
          }}
          type="button"
        >
          Add coverage area
        </button>
        {settings.coverage.map((item, index) => (
          <div className="website-editor__row" key={item.id}>
            <input
              aria-label="Emirate"
              value={item.emirate}
              onChange={(e) =>
                update((n) => {
                  n.coverage[index]!.emirate = e.target.value;
                })
              }
            />
            <input
              aria-label="Area"
              placeholder="Optional area"
              value={item.area ?? ""}
              onChange={(e) =>
                update((n) => {
                  n.coverage[index]!.area = e.target.value;
                })
              }
            />
            <input
              aria-label="Emirate Arabic"
              dir="rtl"
              placeholder="الإمارة بالعربية"
              value={item.emirateAr ?? ""}
              onChange={(e) =>
                update((n) => {
                  n.coverage[index]!.emirateAr = e.target.value;
                })
              }
            />
            <input
              aria-label="Area Arabic"
              dir="rtl"
              placeholder="المنطقة بالعربية (اختياري)"
              value={item.areaAr ?? ""}
              onChange={(e) =>
                update((n) => {
                  n.coverage[index]!.areaAr = e.target.value;
                })
              }
            />
            <label>
              <input
                checked={item.enabled}
                onChange={(e) =>
                  update((n) => {
                    n.coverage[index]!.enabled = e.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              Show
            </label>
          </div>
        ))}
      </details>
      <details id="website-contact" open>
        <summary>Contact, WhatsApp & location</summary>
        <div className="website-editor__grid">
          {(["phone", "mobile", "email", "whatsappNumber"] as const).map((key) => (
            <label className="platform-field" key={key}>
              <span>{key}</span>
              <input
                value={settings.contact[key] ?? ""}
                onChange={(e) =>
                  update((n) => {
                    n.contact[key] = e.target.value;
                  })
                }
              />
            </label>
          ))}
          <label className="platform-field">
            <span>Address EN</span>
            <input
              value={settings.contact.address?.en ?? ""}
              onChange={(e) =>
                update((n) => {
                  n.contact.address = { ...n.contact.address, en: e.target.value };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>City/Emirate</span>
            <input
              value={settings.contact.city?.en ?? ""}
              onChange={(e) =>
                update((n) => {
                  n.contact.city = { ...n.contact.city, en: e.target.value };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Latitude</span>
            <input
              type="number"
              value={settings.contact.latitude ?? ""}
              onChange={(e) =>
                update((n) => {
                  if (e.target.value) n.contact.latitude = Number(e.target.value);
                  else delete n.contact.latitude;
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Longitude</span>
            <input
              type="number"
              value={settings.contact.longitude ?? ""}
              onChange={(e) =>
                update((n) => {
                  if (e.target.value) n.contact.longitude = Number(e.target.value);
                  else delete n.contact.longitude;
                })
              }
            />
          </label>
        </div>
        <div className="website-editor__toggles">
          <label>
            <input
              checked={settings.contact.whatsappEnabled && settings.contact.showWhatsapp}
              onChange={(e) =>
                update((n) => {
                  n.contact.whatsappEnabled = e.target.checked;
                  n.contact.showWhatsapp = e.target.checked;
                })
              }
              type="checkbox"
            />{" "}
            Show WhatsApp button on Website
          </label>
          {(["showPhone", "showEmail", "showAddress", "showWorkingHours"] as const).map((key) => (
            <label key={key}>
              <input
                checked={settings.contact[key]}
                onChange={(e) =>
                  update((n) => {
                    n.contact[key] = e.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              {key}
            </label>
          ))}
        </div>
        <div className="platform-panel__header">
          <h5>Working hours</h5>
          <button
            className="platform-button platform-button--quiet"
            onClick={() => {
              const day = globalThis.prompt("Day (monday–sunday)")?.trim().toLowerCase();
              if (day)
                update((next) =>
                  next.contact.workingHours.push({
                    day,
                    closed: false,
                    opens: "09:00",
                    closes: "18:00",
                  }),
                );
            }}
            type="button"
          >
            Add day
          </button>
        </div>
        {settings.contact.workingHours.map((hours, index) => (
          <div className="website-editor__row" key={`${hours.day}-${index}`}>
            <strong>{hours.day}</strong>
            <label>
              <input
                checked={hours.closed}
                onChange={(event) =>
                  update((next) => {
                    next.contact.workingHours[index]!.closed = event.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              Closed
            </label>
            <input
              aria-label={`${hours.day} opens`}
              disabled={hours.closed}
              type="time"
              value={hours.opens ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.contact.workingHours[index]!.opens = event.target.value;
                })
              }
            />
            <input
              aria-label={`${hours.day} closes`}
              disabled={hours.closed}
              type="time"
              value={hours.closes ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.contact.workingHours[index]!.closes = event.target.value;
                })
              }
            />
          </div>
        ))}
      </details>
      <details id="website-agent" open>
        <summary>AI Agent &amp; Company Knowledge</summary>
        <h5>Company Facts</h5>
        <div className="website-editor__grid">
          <label className="platform-field">
            <span>Public specialization / description EN</span>
            <textarea
              maxLength={2000}
              value={settings.knowledge.description?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.description = {
                    ...next.knowledge.description,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field" dir="rtl">
            <span>Public description AR</span>
            <textarea
              maxLength={2000}
              value={settings.knowledge.description?.ar ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.description = {
                    ...next.knowledge.description,
                    ar: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Supported package types (comma separated)</span>
            <input
              value={settings.knowledge.packageTypes.join(", ")}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.packageTypes = event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean);
                })
              }
            />
          </label>
          <fieldset>
            <legend>Who do you serve?</legend>
            {(["ecommerce", "smes", "individuals", "corporate"] as const).map((audience) => (
              <label key={audience}>
                <input
                  checked={settings.knowledge.audiences.includes(audience)}
                  onChange={(event) =>
                    update((next) => {
                      next.knowledge.audiences = event.target.checked
                        ? [...new Set([...next.knowledge.audiences, audience])]
                        : next.knowledge.audiences.filter((value) => value !== audience);
                    })
                  }
                  type="checkbox"
                />{" "}
                {audience}
              </label>
            ))}
          </fieldset>
          <label className="platform-field">
            <span>Maximum weight (kg, optional)</span>
            <input
              min="0.01"
              step="0.01"
              type="number"
              value={settings.knowledge.maximumWeightKg ?? ""}
              onChange={(event) =>
                update((next) => {
                  const value = Number(event.target.value);
                  if (event.target.value) next.knowledge.maximumWeightKg = value;
                  else delete next.knowledge.maximumWeightKg;
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Fragile-items policy EN</span>
            <textarea
              value={settings.knowledge.fragilePolicy?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.fragilePolicy = {
                    ...next.knowledge.fragilePolicy,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Prohibited / restricted items EN</span>
            <textarea
              value={settings.knowledge.prohibitedItems?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.prohibitedItems = {
                    ...next.knowledge.prohibitedItems,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Size restrictions EN</span>
            <textarea
              value={settings.knowledge.sizeRestrictions?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.sizeRestrictions = {
                    ...next.knowledge.sizeRestrictions,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Package preparation instructions EN</span>
            <textarea
              value={settings.knowledge.instructions.packagePreparation?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.instructions.packagePreparation = {
                    ...next.knowledge.instructions.packagePreparation,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Pickup instructions EN</span>
            <textarea
              value={settings.knowledge.instructions.pickup?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.instructions.pickup = {
                    ...next.knowledge.instructions.pickup,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label>
            <input
              checked={settings.knowledge.cod.supported}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.cod.supported = event.target.checked;
                })
              }
              type="checkbox"
            />{" "}
            COD supported
          </label>
          <label className="platform-field">
            <span>Public COD limitations EN</span>
            <textarea
              value={settings.knowledge.cod.limitations?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.cod.limitations = {
                    ...next.knowledge.cod.limitations,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Pricing response</span>
            <select
              value={settings.knowledge.pricing.mode}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.pricing.mode = event.target.value as
                    "quote" | "request_confirmation" | "contact";
                })
              }
            >
              <option value="quote">Use quote function</option>
              <option value="request_confirmation">Request confirmation</option>
              <option value="contact">Contact Company</option>
            </select>
          </label>
          <label className="platform-field">
            <span>Approved pricing guidance EN</span>
            <textarea
              value={settings.knowledge.pricing.guidance?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.pricing.guidance = {
                    ...next.knowledge.pricing.guidance,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
        </div>
        <div className="platform-panel__header">
          <h5>Public FAQs</h5>
          <button
            className="platform-button platform-button--quiet"
            onClick={() =>
              update((next) =>
                next.knowledge.faqs.push({
                  id: `faq-${crypto.randomUUID().slice(0, 8)}`,
                  question: { en: "New question" },
                  answer: { en: "Approved answer" },
                  enabled: true,
                  order: next.knowledge.faqs.length,
                  websiteVisible: true,
                  agentAvailable: true,
                }),
              )
            }
            type="button"
          >
            Add FAQ
          </button>
        </div>
        {settings.knowledge.faqs.map((faq, index) => (
          <div className="website-editor__grid" key={faq.id}>
            <label className="platform-field">
              <span>Question EN</span>
              <input
                value={faq.question.en ?? ""}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.question.en = event.target.value;
                  })
                }
              />
            </label>
            <label className="platform-field">
              <span>Answer EN</span>
              <textarea
                value={faq.answer.en ?? ""}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.answer.en = event.target.value;
                  })
                }
              />
            </label>
            <label className="platform-field" dir="rtl">
              <span>Question AR</span>
              <input
                value={faq.question.ar ?? ""}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.question.ar = event.target.value;
                  })
                }
              />
            </label>
            <label className="platform-field" dir="rtl">
              <span>Answer AR</span>
              <textarea
                value={faq.answer.ar ?? ""}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.answer.ar = event.target.value;
                  })
                }
              />
            </label>
            <label>
              <input
                checked={faq.enabled}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.enabled = event.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              Enabled
            </label>
            <label>
              <input
                checked={faq.websiteVisible}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.websiteVisible = event.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              Website visible
            </label>
            <label>
              <input
                checked={faq.agentAvailable}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.agentAvailable = event.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              Agent available
            </label>
            <button
              className="platform-button platform-button--danger"
              onClick={() =>
                update((next) => {
                  next.knowledge.faqs.splice(index, 1);
                  next.knowledge.faqs.forEach((item, order) => (item.order = order));
                })
              }
              type="button"
            >
              Remove FAQ
            </button>
          </div>
        ))}
        <h5>Agent Behavior</h5>
        <div className="website-editor__grid">
          <label>
            <input
              checked={settings.agent.enabled}
              onChange={(event) =>
                update((next) => {
                  next.agent.enabled = event.target.checked;
                })
              }
              type="checkbox"
            />{" "}
            Agent enabled
          </label>
          <label className="platform-field">
            <span>Agent display name</span>
            <input
              maxLength={100}
              value={settings.agent.displayName ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.agent.displayName = event.target.value;
                })
              }
            />
            <small>{(settings.agent.displayName ?? "").length} / 100 characters</small>
          </label>
          <label className="platform-field">
            <span>Tone</span>
            <select
              value={settings.agent.tone}
              onChange={(event) =>
                update((next) => {
                  next.agent.tone = event.target.value as typeof next.agent.tone;
                })
              }
            >
              <option value="professional">Professional</option>
              <option value="friendly_professional">Friendly Professional</option>
              <option value="concise">Concise</option>
              <option value="warm">Warm</option>
            </select>
          </label>
          <label className="platform-field">
            <span>Unknown-answer behavior</span>
            <select
              value={settings.agent.unknownBehavior}
              onChange={(event) =>
                update((next) => {
                  next.agent.unknownBehavior = event.target
                    .value as typeof next.agent.unknownBehavior;
                })
              }
            >
              <option value="safe_response">General safe response</option>
              <option value="whatsapp">Offer WhatsApp</option>
              <option value="contact">Offer phone/email</option>
              <option value="submit_request">Offer delivery request</option>
            </select>
          </label>
          <label className="platform-field">
            <span>Welcome message EN</span>
            <textarea
              value={settings.agent.welcomeMessage?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.agent.welcomeMessage = {
                    ...next.agent.welcomeMessage,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field" dir="rtl">
            <span>Welcome message AR</span>
            <textarea
              value={settings.agent.welcomeMessage?.ar ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.agent.welcomeMessage = {
                    ...next.agent.welcomeMessage,
                    ar: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Human handoff message</span>
            <textarea
              value={settings.agent.handoffMessage?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.agent.handoffMessage = {
                    ...next.agent.handoffMessage,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
        </div>
        <div className="website-editor__toggles">
          {Object.keys(settings.agent.capabilities).map((key) => (
            <label key={key}>
              <input
                checked={
                  settings.agent.capabilities[key as keyof typeof settings.agent.capabilities]
                }
                onChange={(event) =>
                  update((next) => {
                    next.agent.capabilities[key as keyof typeof next.agent.capabilities] =
                      event.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              {key.replace(/([A-Z])/gu, " $1")}
            </label>
          ))}
        </div>
        <div className="website-editor__toggles">
          {(
            ["track", "request_delivery", "services", "coverage", "contact", "whatsapp"] as const
          ).map((action) => (
            <label key={action}>
              <input
                checked={settings.agent.suggestedActions.includes(action)}
                onChange={(event) =>
                  update((next) => {
                    next.agent.suggestedActions = event.target.checked
                      ? [...new Set([...next.agent.suggestedActions, action])]
                      : next.agent.suggestedActions.filter((item) => item !== action);
                  })
                }
                type="checkbox"
              />{" "}
              {action.replaceAll("_", " ")}
            </label>
          ))}
        </div>
      </details>
      <details>
        <summary>Social links</summary>
        <div className="website-editor__grid">
          {["instagram", "facebook", "tiktok", "linkedin", "x", "youtube"].map((key) => (
            <label className="platform-field" key={key}>
              <span>{key}</span>
              <input
                type="url"
                value={settings.socialLinks[key] ?? ""}
                onChange={(e) =>
                  update((n) => {
                    n.socialLinks[key] = e.target.value || undefined;
                  })
                }
              />
            </label>
          ))}
        </div>
      </details>
      <details id="website-seo" open>
        <summary>Public functions &amp; SEO</summary>
        <div className="website-editor__toggles">
          <label>
            <input
              checked={settings.functions?.trackingEnabled !== false}
              onChange={(event) =>
                update((next) => {
                  next.functions = {
                    ...(next.functions ?? { requestDeliveryEnabled: true }),
                    trackingEnabled: event.target.checked,
                  };
                })
              }
              type="checkbox"
            />{" "}
            Shipment tracking
          </label>
          <label>
            <input
              checked={settings.functions?.requestDeliveryEnabled !== false}
              onChange={(event) =>
                update((next) => {
                  next.functions = {
                    ...(next.functions ?? { trackingEnabled: true }),
                    requestDeliveryEnabled: event.target.checked,
                  };
                })
              }
              type="checkbox"
            />{" "}
            Request delivery
          </label>
          <label>
            <input
              checked={settings.seo?.indexable !== false}
              onChange={(event) =>
                update((next) => {
                  next.seo = { ...(next.seo ?? {}), indexable: event.target.checked };
                })
              }
              type="checkbox"
            />{" "}
            Allow search indexing
          </label>
        </div>
        <div className="website-editor__grid">
          <label className="platform-field">
            <span>SEO title (EN)</span>
            <input
              value={settings.seo?.title?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.seo = {
                    ...(next.seo ?? { indexable: true }),
                    title: { ...next.seo?.title, en: event.target.value },
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>SEO description (EN)</span>
            <textarea
              value={settings.seo?.description?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.seo = {
                    ...(next.seo ?? { indexable: true }),
                    description: { ...next.seo?.description, en: event.target.value },
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Social image URL</span>
            <input
              type="url"
              value={settings.seo?.socialImageUrl ?? ""}
              onChange={(event) =>
                update((next) => {
                  const value = event.target.value;
                  next.seo = {
                    ...(next.seo ?? { indexable: true }),
                    ...(value ? { socialImageUrl: value } : {}),
                  };
                  if (!value) delete next.seo.socialImageUrl;
                })
              }
            />
          </label>
        </div>
      </details>
      <details id="website-sections">
        <summary>Sections</summary>
        {[...settings.sections]
          .sort((a, b) => a.order - b.order)
          .map((section, index) => (
            <div className="website-editor__row" key={section.key}>
              <label>
                <input
                  checked={section.enabled}
                  onChange={(e) =>
                    update((n) => {
                      n.sections.find((x) => x.key === section.key)!.enabled = e.target.checked;
                    })
                  }
                  type="checkbox"
                />{" "}
                {section.key.replaceAll("_", " ")}
              </label>
              <button disabled={index === 0} onClick={() => moveSection(index, -1)} type="button">
                Up
              </button>
              <button
                disabled={index === settings.sections.length - 1}
                onClick={() => moveSection(index, 1)}
                type="button"
              >
                Down
              </button>
            </div>
          ))}
      </details>
    </div>
  );
}

function validateDraft(settings: CompanyWebsiteSettings): string[] {
  const errors: string[] = [];
  for (const field of localizedFields) {
    for (const locale of ["en", "ar"] as const) {
      const value = localizedValue(settings.presentation[field], locale);
      if (value.length > TEXT_LIMIT)
        errors.push(
          `${localizedLabels[field]} (${locale.toUpperCase()}) exceeds ${TEXT_LIMIT} characters.`,
        );
    }
  }
  for (const [network, value] of Object.entries(settings.socialLinks)) {
    if (value && !/^https?:\/\/[^\s]+$/iu.test(value)) {
      errors.push(`${network} must be a complete URL beginning with https://`);
    }
  }
  if (settings.contact.whatsappEnabled && !settings.contact.whatsappNumber?.trim()) {
    errors.push("WhatsApp is enabled but no WhatsApp number is entered.");
  }
  return errors;
}

// Uploads to Cloudflare R2 via platformApi.uploadCompanyWebsiteMedia and
// saves the returned URL, rather than reading the file into a base64 data
// URL and storing it inline in the Website settings. The public Website
// payload embeds these branding fields verbatim (see
// `settingsForWebsiteAudience`), so an inline banner used to mean every
// visitor's page load re-transmitted the full image bytes as JSON; a URL is
// a few dozen bytes and the browser loads the image itself, once, cached.
async function readWebsiteLogo(
  companyId: string,
  file: File | undefined,
  update: (recipe: (next: CompanyWebsiteSettings) => void) => void,
  showErrors: (errors: readonly string[]) => void,
): Promise<string | undefined> {
  if (!file) return undefined;
  if (!new Set(["image/png", "image/jpeg"]).has(file.type)) {
    showErrors(["Website logo must be a PNG or JPEG image."]);
    return undefined;
  }
  if (file.size > 500_000) {
    showErrors(["Website logo must be 500 KB or smaller."]);
    return undefined;
  }
  try {
    const { url } = await platformApi.uploadCompanyWebsiteMedia(companyId, file);
    update((next) => {
      next.branding.logoDataUrl = url;
    });
    showErrors([]);
    return url;
  } catch (error) {
    showErrors([
      error instanceof PlatformApiError ? error.message : "The Website logo could not be uploaded.",
    ]);
    return undefined;
  }
}

async function readWebsiteBanners(
  companyId: string,
  files: FileList | null,
  existing: readonly string[],
  field: "bannerDataUrls" | "bannerDataUrlsAr",
  update: (recipe: (next: CompanyWebsiteSettings) => void) => void,
  showErrors: (errors: readonly string[]) => void,
): Promise<number> {
  if (!files?.length) return 0;
  const selected = Array.from(files);
  if (existing.length + selected.length > 3) {
    showErrors([
      `You can upload a maximum of 3 Homepage banners. Remove ${existing.length + selected.length - 3} image(s) or select fewer files.`,
    ]);
    return 0;
  }
  const unsupported = selected.find(
    (file) => !new Set(["image/png", "image/jpeg", "image/webp"]).has(file.type),
  );
  if (unsupported) {
    showErrors([`${unsupported.name} must be a PNG, JPEG or WebP image.`]);
    return 0;
  }
  const oversized = selected.find((file) => file.size > 2_000_000);
  if (oversized) {
    showErrors([`${oversized.name} must be 2 MB or smaller.`]);
    return 0;
  }
  try {
    const uploaded = await Promise.all(
      selected.map((file) => platformApi.uploadCompanyWebsiteMedia(companyId, file)),
    );
    update((next) => {
      next.branding[field] = [...existing, ...uploaded.map((result) => result.url)];
      if (field === "bannerDataUrls") delete next.branding.bannerDataUrl;
      next.branding.bannerTransition ??= "fade";
      next.branding.bannerIntervalSeconds ??= 6;
      next.branding.bannerSize ??= "standard";
    });
    showErrors([]);
    return uploaded.length;
  } catch (error) {
    showErrors([
      error instanceof PlatformApiError
        ? error.message
        : "The Homepage banner could not be uploaded.",
    ]);
    return 0;
  }
}
