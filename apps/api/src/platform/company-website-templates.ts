export const COMPANY_WEBSITE_TEMPLATE_KEYS = [
  "corporate",
  "modern",
  "express",
  "local",
  "premium",
  "skyline",
  "minimal",
  "bold",
  "elegant",
  "urban",
  "swift",
  "horizon",
  "nexus",
  "oasis",
  "fleet",
  "commerce",
  "courier",
  "executive",
  "vibrant",
  "classic",
] as const;

export type CompanyWebsiteTemplateKey = (typeof COMPANY_WEBSITE_TEMPLATE_KEYS)[number];

export function isCompanyWebsiteTemplateKey(value: string): value is CompanyWebsiteTemplateKey {
  return COMPANY_WEBSITE_TEMPLATE_KEYS.includes(value as CompanyWebsiteTemplateKey);
}

export function hasUnpublishedTemplateChanges(
  draft: CompanyWebsiteTemplateKey,
  published: CompanyWebsiteTemplateKey | null,
): boolean {
  return published !== null && draft !== published;
}

export function templateForWebsiteAudience(input: {
  draft: CompanyWebsiteTemplateKey;
  published: CompanyWebsiteTemplateKey | null;
  previewTemplate?: CompanyWebsiteTemplateKey;
}): CompanyWebsiteTemplateKey | null {
  return input.previewTemplate ?? input.published;
}
