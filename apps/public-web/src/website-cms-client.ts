export type Locale = "en" | "ar";

import { apiUrl } from "./api-base";

export type CmsPage = {
  pageKey: string;
  locale: Locale;
  visible: boolean;
  content: Record<string, any>;
};

export type CmsPlan = {
  planKey: string;
  locale: Locale;
  active: boolean;
  sortOrder: number;
  data: {
    name: string;
    price: number;
    currency: string;
    period: string;
    minOrders: number;
    maxOrders: number | null;
    volume: string;
    description: string;
    highlights: string[];
    ctaLabel: string;
    ctaUrl: string;
    recommended: boolean;
  };
};

export type CmsFaq = {
  faqKey: string;
  locale: Locale;
  data: { question: string; answer: string };
  audience: string;
  category: string;
};

export type CmsFeature = {
  slug: string;
  locale: Locale;
  data: { name: string; shortDescription: string; fullDescription?: string };
  audience: string;
  category: string;
  featureStatus: string;
};

export type CmsNavigation = {
  itemKey: string;
  locale: Locale;
  label: string;
  destination: string;
  visible: boolean;
  sortOrder: number;
};

export type WebsiteCmsBundle = {
  locale: Locale;
  direction: "ltr" | "rtl";
  pages: CmsPage[];
  pricing: CmsPlan[];
  features: CmsFeature[];
  faqs: CmsFaq[];
  navigation: CmsNavigation[];
  contact: { publicPhone: string; whatsapp?: string; supportEmail?: string };
};

export async function loadWebsiteCms(locale: Locale): Promise<WebsiteCmsBundle | null> {
  try {
    const response = await fetch(apiUrl(`/public/website/content?locale=${locale}`), { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as WebsiteCmsBundle;
  } catch {
    return null;
  }
}

export function phoneHref(value: string | undefined): string {
  return `tel:${(value ?? "+971 50 689 8604").replace(/[^\d+]/g, "")}`;
}
