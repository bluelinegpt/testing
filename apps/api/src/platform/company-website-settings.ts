import { HttpStatus } from "@nestjs/common";
import { ApplicationException } from "../presentation/errors/application.exception.js";

export const WEBSITE_SECTION_KEYS = [
  "hero",
  "about",
  "services",
  "coverage",
  "benefits",
  "how_it_works",
  "industries",
  "statistics",
  "testimonials",
  "tracking",
  "request_delivery",
  "working_hours",
  "location",
  "contact",
  "social",
  "footer",
] as const;
export type WebsiteSectionKey = (typeof WEBSITE_SECTION_KEYS)[number];
export type LocalizedText = { en?: string; ar?: string };
export interface WebsiteListItem {
  id: string;
  title: LocalizedText;
  description?: LocalizedText;
  icon?: string;
  enabled: boolean;
  order: number;
}
export interface WebsiteCoverageItem {
  id: string;
  emirate: string;
  emirateAr?: string;
  area?: string;
  areaAr?: string;
  group?: string;
  enabled: boolean;
  order: number;
}
export interface WebsiteDayHours {
  day: string;
  closed: boolean;
  opens?: string;
  closes?: string;
}
export interface CompanyWebsiteSettings {
  branding: {
    primaryColor?: string;
    secondaryColor?: string;
    accentColor?: string;
    logoDataUrl?: string;
    /** @deprecated Read for backward compatibility with drafts saved before banner galleries. */
    bannerDataUrl?: string;
    bannerDataUrls?: string[];
    bannerDataUrlsAr?: string[];
    bannerTransition?: "fade" | "slide" | "zoom";
    bannerIntervalSeconds?: 4 | 6 | 8;
  };
  languages: { en: boolean; ar: boolean; defaultLocale: "en" | "ar" };
  presentation: {
    displayName?: LocalizedText;
    tagline?: LocalizedText;
    about?: LocalizedText;
    heroHeadline?: LocalizedText;
    heroSubheadline?: LocalizedText;
    primaryCtaLabel?: LocalizedText;
    primaryCtaType?: "contact" | "track" | "request_delivery" | "whatsapp" | "call" | "section";
    secondaryCtaLabel?: LocalizedText;
    secondaryCtaType?: "contact" | "track" | "request_delivery" | "whatsapp" | "call" | "section";
  };
  contact: {
    phone?: string;
    mobile?: string;
    email?: string;
    address?: LocalizedText;
    city?: LocalizedText;
    whatsappEnabled: boolean;
    whatsappNumber?: string;
    whatsappMessage?: LocalizedText;
    showPhone: boolean;
    showEmail: boolean;
    showWhatsapp: boolean;
    showAddress: boolean;
    showWorkingHours: boolean;
    latitude?: number;
    longitude?: number;
    workingHours: WebsiteDayHours[];
  };
  services: WebsiteListItem[];
  coverage: WebsiteCoverageItem[];
  benefits: WebsiteListItem[];
  marketing: {
    steps: WebsiteListItem[];
    industries: WebsiteListItem[];
    statistics: WebsiteListItem[];
    testimonials: WebsiteListItem[];
  };
  socialLinks: Partial<
    Record<"instagram" | "facebook" | "tiktok" | "linkedin" | "x" | "youtube", string>
  >;
  functions: { trackingEnabled: boolean; requestDeliveryEnabled: boolean };
  seo: {
    title?: LocalizedText;
    description?: LocalizedText;
    socialImageUrl?: string;
    indexable: boolean;
  };
  sections: Array<{ key: WebsiteSectionKey; enabled: boolean; order: number }>;
  knowledge: {
    description?: LocalizedText;
    audiences: Array<"ecommerce" | "smes" | "individuals" | "corporate">;
    packageTypes: string[];
    maximumWeightKg?: number;
    sizeRestrictions?: LocalizedText;
    fragilePolicy?: LocalizedText;
    prohibitedItems?: LocalizedText;
    specialHandling?: LocalizedText;
    cod: { supported: boolean; limitations?: LocalizedText };
    pricing: { mode: "quote" | "request_confirmation" | "contact"; guidance?: LocalizedText };
    faqs: Array<{
      id: string;
      question: LocalizedText;
      answer: LocalizedText;
      enabled: boolean;
      order: number;
      websiteVisible: boolean;
      agentAvailable: boolean;
    }>;
    instructions: {
      requestDelivery?: LocalizedText;
      packagePreparation?: LocalizedText;
      pickup?: LocalizedText;
      tracking?: LocalizedText;
      returns?: LocalizedText;
      support?: LocalizedText;
    };
    tawseelhubAttribution: boolean;
  };
  agent: {
    enabled: boolean;
    displayName?: string;
    welcomeMessage?: LocalizedText;
    handoffMessage?: LocalizedText;
    suggestedActions: Array<
      "track" | "request_delivery" | "services" | "coverage" | "contact" | "whatsapp"
    >;
    tone: "professional" | "friendly_professional" | "concise" | "warm";
    unknownBehavior: "whatsapp" | "contact" | "submit_request" | "safe_response";
    capabilities: {
      companyInformation: boolean;
      tracking: boolean;
      deliveryRequest: boolean;
      quoteGuidance: boolean;
      whatsappHandoff: boolean;
      contactHandoff: boolean;
      faqAnswers: boolean;
      socialLinks: boolean;
    };
  };
}

export const EMPTY_COMPANY_WEBSITE_SETTINGS: CompanyWebsiteSettings = {
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
  sections: WEBSITE_SECTION_KEYS.map((key, order) => ({ key, enabled: true, order })),
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
};

const textLimit = 2000;
const color = /^#[0-9a-f]{6}$/iu;
const phone = /^\+?[0-9][0-9\s()-]{6,24}$/u;
const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const allowedIcons = new Set([
  "box",
  "clock",
  "document",
  "cart",
  "bulk",
  "route",
  "shield",
  "star",
]);
const ctaTypes = new Set(["contact", "track", "request_delivery", "whatsapp", "call", "section"]);
const bannerTransitions = new Set(["fade", "slide", "zoom"]);

function validatedBanner(value: string): string {
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value))
    invalid("Website banner must be a PNG, JPEG or WebP image");
  if (value.length > 2_800_000) invalid("Each Website banner must be 2 MB or smaller");
  return value;
}

export function validateCompanyWebsiteSettings(value: unknown): CompanyWebsiteSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Website settings must be an object");
  const input = value as CompanyWebsiteSettings;
  const result: CompanyWebsiteSettings = structuredClone(EMPTY_COMPANY_WEBSITE_SETTINGS);
  if (input.branding)
    for (const key of ["primaryColor", "secondaryColor", "accentColor"] as const) {
      const v = input.branding[key];
      if (v !== undefined && !color.test(v)) invalid(`${key} must be a six-digit hex color`);
      if (v) result.branding[key] = v.toLowerCase();
    }
  if (input.branding?.logoDataUrl) {
    const logo = input.branding.logoDataUrl;
    if (!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/u.test(logo))
      invalid("Website logo must be a PNG or JPEG image");
    if (logo.length > 700_000) invalid("Website logo must be 500 KB or smaller");
    result.branding.logoDataUrl = logo;
  }
  if (input.branding?.bannerDataUrls !== undefined) {
    if (!Array.isArray(input.branding.bannerDataUrls) || input.branding.bannerDataUrls.length > 3)
      invalid("A Website may have no more than 3 homepage banners");
    result.branding.bannerDataUrls = input.branding.bannerDataUrls.map(validatedBanner);
  } else if (input.branding?.bannerDataUrl) {
    result.branding.bannerDataUrls = [validatedBanner(input.branding.bannerDataUrl)];
  }
  if (input.branding?.bannerDataUrlsAr !== undefined) {
    if (
      !Array.isArray(input.branding.bannerDataUrlsAr) ||
      input.branding.bannerDataUrlsAr.length > 3
    )
      invalid("A Website may have no more than 3 Arabic homepage banners");
    result.branding.bannerDataUrlsAr = input.branding.bannerDataUrlsAr.map(validatedBanner);
  }
  if (input.branding?.bannerTransition !== undefined) {
    if (!bannerTransitions.has(input.branding.bannerTransition))
      invalid("Banner transition must be fade, slide or zoom");
    result.branding.bannerTransition = input.branding.bannerTransition;
  }
  if (input.branding?.bannerIntervalSeconds !== undefined) {
    if (![4, 6, 8].includes(input.branding.bannerIntervalSeconds))
      invalid("Banner rotation interval must be 4, 6 or 8 seconds");
    result.branding.bannerIntervalSeconds = input.branding.bannerIntervalSeconds;
  }
  if (input.languages) {
    result.languages = {
      en: input.languages.en === true,
      ar: input.languages.ar === true,
      defaultLocale: input.languages.defaultLocale,
    };
    if (!result.languages.en && !result.languages.ar)
      invalid("At least one website language must be enabled");
    if (
      !["en", "ar"].includes(result.languages.defaultLocale) ||
      !result.languages[result.languages.defaultLocale]
    )
      invalid("Default language must be enabled");
  }
  result.presentation = validatePresentation(input.presentation ?? {});
  result.contact = validateContact(input.contact ?? result.contact);
  result.services = validateList(input.services, "service");
  result.benefits = validateList(input.benefits, "benefit");
  result.marketing = {
    steps: validateList(input.marketing?.steps, "step"),
    industries: validateList(input.marketing?.industries, "industry"),
    statistics: validateList(input.marketing?.statistics, "statistic"),
    testimonials: validateList(input.marketing?.testimonials, "testimonial"),
  };
  result.coverage = validateCoverage(input.coverage);
  result.socialLinks = validateSocial(input.socialLinks);
  result.functions = {
    trackingEnabled: input.functions?.trackingEnabled !== false,
    requestDeliveryEnabled: input.functions?.requestDeliveryEnabled !== false,
  };
  result.seo = { indexable: input.seo?.indexable !== false };
  if (input.seo?.title) result.seo.title = localized(input.seo.title, "seo.title");
  if (input.seo?.description)
    result.seo.description = localized(input.seo.description, "seo.description");
  if (input.seo?.socialImageUrl) {
    try {
      const url = new URL(input.seo.socialImageUrl);
      if (url.protocol !== "https:") invalid("SEO social image must use HTTPS");
      result.seo.socialImageUrl = url.toString();
    } catch {
      invalid("SEO social image is invalid");
    }
  }
  result.sections = validateSections(input.sections);
  result.knowledge = validateKnowledge(input.knowledge);
  result.agent = validateAgent(input.agent);
  return result;
}

function validateAgent(
  input: CompanyWebsiteSettings["agent"] | undefined,
): CompanyWebsiteSettings["agent"] {
  const source = input ?? EMPTY_COMPANY_WEBSITE_SETTINGS.agent;
  const displayName = source.displayName?.trim();
  if (displayName && displayName.length > 100) invalid("Agent display name is too long");
  const allowed = new Set([
    "track",
    "request_delivery",
    "services",
    "coverage",
    "contact",
    "whatsapp",
  ]);
  const tone = source.tone ?? "friendly_professional";
  if (!new Set(["professional", "friendly_professional", "concise", "warm"]).has(tone))
    invalid("Agent tone is invalid");
  const unknownBehavior = source.unknownBehavior ?? "safe_response";
  if (!new Set(["whatsapp", "contact", "submit_request", "safe_response"]).has(unknownBehavior))
    invalid("Agent unknown-answer behavior is invalid");
  const capabilityKeys = [
    "companyInformation",
    "tracking",
    "deliveryRequest",
    "quoteGuidance",
    "whatsappHandoff",
    "contactHandoff",
    "faqAnswers",
    "socialLinks",
  ] as const;
  if (
    Object.keys(source.capabilities ?? {}).some(
      (key) => !capabilityKeys.includes(key as (typeof capabilityKeys)[number]),
    )
  )
    invalid("Agent capability is invalid");
  const capabilities = Object.fromEntries(
    capabilityKeys.map((key) => [key, source.capabilities?.[key] !== false]),
  ) as CompanyWebsiteSettings["agent"]["capabilities"];
  if (
    !Array.isArray(source.suggestedActions) ||
    source.suggestedActions.some((action) => !allowed.has(action))
  )
    invalid("Agent suggested action is invalid");
  return {
    enabled: source.enabled === true,
    suggestedActions: [...new Set(source.suggestedActions)],
    tone,
    unknownBehavior,
    capabilities,
    ...(displayName ? { displayName } : {}),
    ...(source.welcomeMessage
      ? { welcomeMessage: localized(source.welcomeMessage, "agent.welcomeMessage") }
      : {}),
    ...(source.handoffMessage
      ? { handoffMessage: localized(source.handoffMessage, "agent.handoffMessage") }
      : {}),
  };
}

function validateKnowledge(
  input: CompanyWebsiteSettings["knowledge"] | undefined,
): CompanyWebsiteSettings["knowledge"] {
  const source = input ?? EMPTY_COMPANY_WEBSITE_SETTINGS.knowledge;
  const audiences = [...new Set(source.audiences ?? [])];
  if (audiences.some((value) => !["ecommerce", "smes", "individuals", "corporate"].includes(value)))
    invalid("Company audience is invalid");
  const packageTypes = [...new Set(source.packageTypes ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  if (packageTypes.length > 30 || packageTypes.some((value) => value.length > 100))
    invalid("Package types are invalid");
  if (
    source.maximumWeightKg !== undefined &&
    (!Number.isFinite(source.maximumWeightKg) ||
      source.maximumWeightKg <= 0 ||
      source.maximumWeightKg > 100000)
  )
    invalid("Maximum package weight is invalid");
  const faqs = (source.faqs ?? []).map((faq, index) => {
    if (
      !/^[a-z0-9-]{1,64}$/u.test(faq.id) ||
      index >= 50 ||
      !Number.isInteger(faq.order) ||
      faq.order < 0
    )
      invalid("FAQ configuration is invalid");
    const question = localized(faq.question, "faq.question");
    const answer = localized(faq.answer, "faq.answer");
    if ((!question.en && !question.ar) || (!answer.en && !answer.ar))
      invalid("FAQ question and answer are required");
    return {
      id: faq.id,
      question,
      answer,
      enabled: faq.enabled === true,
      order: faq.order,
      websiteVisible: faq.websiteVisible === true,
      agentAvailable: faq.agentAvailable === true,
    };
  });
  if (new Set(faqs.map((faq) => faq.id)).size !== faqs.length) invalid("FAQ id is duplicated");
  const pricingMode = source.pricing?.mode ?? "request_confirmation";
  if (!new Set(["quote", "request_confirmation", "contact"]).has(pricingMode))
    invalid("Pricing behavior is invalid");
  const out: CompanyWebsiteSettings["knowledge"] = {
    audiences,
    packageTypes,
    cod: { supported: source.cod?.supported === true },
    pricing: { mode: pricingMode },
    faqs,
    instructions: {},
    tawseelhubAttribution: source.tawseelhubAttribution !== false,
  };
  if (source.description) out.description = localized(source.description, "knowledge.description");
  if (source.maximumWeightKg !== undefined) out.maximumWeightKg = source.maximumWeightKg;
  for (const key of [
    "sizeRestrictions",
    "fragilePolicy",
    "prohibitedItems",
    "specialHandling",
  ] as const)
    if (source[key]) out[key] = localized(source[key]!, `knowledge.${key}`);
  if (source.cod?.limitations)
    out.cod.limitations = localized(source.cod.limitations, "knowledge.cod.limitations");
  if (source.pricing?.guidance)
    out.pricing.guidance = localized(source.pricing.guidance, "knowledge.pricing.guidance");
  for (const key of [
    "requestDelivery",
    "packagePreparation",
    "pickup",
    "tracking",
    "returns",
    "support",
  ] as const)
    if (source.instructions?.[key])
      out.instructions[key] = localized(source.instructions[key]!, `knowledge.instructions.${key}`);
  return out;
}

export function settingsForWebsiteAudience(
  draft: CompanyWebsiteSettings,
  published: CompanyWebsiteSettings | null,
  preview: boolean,
): CompanyWebsiteSettings | null {
  return preview ? draft : published;
}

function validatePresentation(
  input: CompanyWebsiteSettings["presentation"],
): CompanyWebsiteSettings["presentation"] {
  const out: CompanyWebsiteSettings["presentation"] = {};
  for (const key of [
    "displayName",
    "tagline",
    "about",
    "heroHeadline",
    "heroSubheadline",
    "primaryCtaLabel",
    "secondaryCtaLabel",
  ] as const) {
    if (input[key]) out[key] = localized(input[key]!, key);
  }
  for (const key of ["primaryCtaType", "secondaryCtaType"] as const) {
    const v = input[key];
    if (v !== undefined && !ctaTypes.has(v)) invalid(`${key} is invalid`);
    if (v) out[key] = v;
  }
  return out;
}
function localized(value: LocalizedText, field: string): LocalizedText {
  const out: LocalizedText = {};
  for (const locale of ["en", "ar"] as const) {
    const v = value[locale]?.trim();
    if (v && v.length > textLimit) invalid(`${field}.${locale} is too long`);
    if (
      v &&
      /ignore (?:all|previous)|system prompt|api key|reveal (?:customer|private|secret)|تجاهل التعليمات|مفتاح api|اكشف/u.test(
        v,
      )
    )
      invalid(`${field}.${locale} contains unsafe instructions`);
    if (v) out[locale] = v;
  }
  return out;
}
function validateContact(
  input: CompanyWebsiteSettings["contact"],
): CompanyWebsiteSettings["contact"] {
  const out: CompanyWebsiteSettings["contact"] = {
    ...structuredClone(EMPTY_COMPANY_WEBSITE_SETTINGS.contact),
    ...input,
    workingHours: [],
  };
  for (const key of ["phone", "mobile", "whatsappNumber"] as const) {
    const v = input[key]?.trim();
    if (v && !phone.test(v)) invalid(`${key} is invalid`);
    if (v) out[key] = v;
  }
  const whatsappRequested = input.whatsappEnabled || input.showWhatsapp;
  if (whatsappRequested && !out.whatsappNumber)
    invalid("WhatsApp number is required when the Website WhatsApp button is enabled");
  // Legacy drafts could set these two flags independently. They represent one
  // public feature now, so normalize them atomically at the API boundary.
  out.whatsappEnabled = whatsappRequested;
  out.showWhatsapp = whatsappRequested;
  if (input.email && !email.test(input.email)) invalid("Public email is invalid");
  if (input.latitude !== undefined && (input.latitude < -90 || input.latitude > 90))
    invalid("Latitude is invalid");
  if (input.longitude !== undefined && (input.longitude < -180 || input.longitude > 180))
    invalid("Longitude is invalid");
  if (input.address) out.address = localized(input.address, "address");
  if (input.city) out.city = localized(input.city, "city");
  if (input.whatsappMessage)
    out.whatsappMessage = localized(input.whatsappMessage, "whatsappMessage");
  out.workingHours = (input.workingHours ?? []).map((item) => {
    if (!/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/u.test(item.day))
      invalid("Working-hours day is invalid");
    if (
      !item.closed &&
      (!item.opens || !item.closes || !time.test(item.opens) || !time.test(item.closes))
    )
      invalid("Working-hours time is invalid");
    return {
      day: item.day,
      closed: item.closed,
      ...(!item.closed ? { opens: item.opens, closes: item.closes } : {}),
    };
  });
  return out;
}
function validateList(items: WebsiteListItem[] | undefined, kind: string): WebsiteListItem[] {
  const ids = new Set<string>();
  return (items ?? []).map((item, index) => {
    if (!/^[a-z0-9-]{1,64}$/u.test(item.id) || ids.has(item.id))
      invalid(`${kind} id is invalid or duplicated`);
    ids.add(item.id);
    if (item.icon && !allowedIcons.has(item.icon)) invalid(`${kind} icon is invalid`);
    if (!Number.isInteger(item.order) || item.order < 0) invalid(`${kind} order is invalid`);
    return {
      id: item.id,
      title: localized(item.title, `${kind}.title`),
      ...(item.description
        ? { description: localized(item.description, `${kind}.description`) }
        : {}),
      ...(item.icon ? { icon: item.icon } : {}),
      enabled: item.enabled === true,
      order: item.order ?? index,
    };
  });
}
function validateCoverage(items: WebsiteCoverageItem[] | undefined): WebsiteCoverageItem[] {
  const ids = new Set<string>();
  return (items ?? []).map((item) => {
    if (!/^[a-z0-9-]{1,64}$/u.test(item.id) || ids.has(item.id))
      invalid("Coverage id is invalid or duplicated");
    ids.add(item.id);
    if (
      !item.emirate?.trim() ||
      item.emirate.length > 100 ||
      !Number.isInteger(item.order) ||
      item.order < 0
    )
      invalid("Coverage entry is invalid");
    const area = item.area?.trim();
    const emirateAr = item.emirateAr?.trim();
    const areaAr = item.areaAr?.trim();
    const group = item.group?.trim();
    if (emirateAr && emirateAr.length > 100) invalid("Coverage Arabic emirate is too long");
    if (areaAr && areaAr.length > 200) invalid("Coverage Arabic area is too long");
    return {
      id: item.id,
      emirate: item.emirate.trim(),
      ...(emirateAr ? { emirateAr } : {}),
      enabled: item.enabled === true,
      order: item.order,
      ...(area ? { area } : {}),
      ...(areaAr ? { areaAr } : {}),
      ...(group ? { group } : {}),
    };
  });
}
function validateSocial(
  input: CompanyWebsiteSettings["socialLinks"] | undefined,
): CompanyWebsiteSettings["socialLinks"] {
  const out: CompanyWebsiteSettings["socialLinks"] = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!["instagram", "facebook", "tiktok", "linkedin", "x", "youtube"].includes(key))
      invalid("Social network is invalid");
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") invalid("Social links must use HTTPS");
    } catch {
      invalid("Social link is invalid");
    }
    out[key as keyof typeof out] = value;
  }
  return out;
}
function validateSections(
  items: CompanyWebsiteSettings["sections"] | undefined,
): CompanyWebsiteSettings["sections"] {
  if (!items) return structuredClone(EMPTY_COMPANY_WEBSITE_SETTINGS.sections);
  const seen = new Set<string>();
  const result = items.map((item) => {
    if (
      !WEBSITE_SECTION_KEYS.includes(item.key) ||
      seen.has(item.key) ||
      !Number.isInteger(item.order) ||
      item.order < 0
    )
      invalid("Section configuration is invalid");
    seen.add(item.key);
    return { key: item.key, enabled: item.enabled === true, order: item.order };
  });
  for (const key of WEBSITE_SECTION_KEYS)
    if (!seen.has(key)) result.push({ key, enabled: true, order: result.length });
  return result;
}
function invalid(message: string): never {
  throw new ApplicationException(
    "company_website_settings_invalid",
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
