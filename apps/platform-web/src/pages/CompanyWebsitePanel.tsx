import { useEffect, useState, type CSSProperties, type FormEvent, type ReactElement } from "react";

import {
  PlatformApiError,
  platformApi,
  type CompanyWebsite,
  type CompanyWebsitePreview,
  type CompanyWebsiteTemplateKey,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";
import { CompanyWebsiteEditor } from "./CompanyWebsiteEditor.js";
import { CompanyWebsiteDomainsPanel } from "./CompanyWebsiteDomainsPanel.js";

export function CompanyWebsitePanel({
  companyId,
  suggestedSlug,
}: {
  companyId: string;
  suggestedSlug: string;
}): ReactElement {
  const session = usePlatformSession();
  const canManage = session.can("platform.company_websites.manage");
  const [website, setWebsite] = useState<CompanyWebsite>();
  const [preview, setPreview] = useState<CompanyWebsitePreview>();
  const [editing, setEditing] = useState(false);
  const [editingWebsite, setEditingWebsite] = useState(false);
  const [slug, setSlug] = useState(suggestedSlug);
  const [locale, setLocale] = useState<"en" | "ar">("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [versionConflict, setVersionConflict] = useState(false);
  const [agentPreviewReply, setAgentPreviewReply] = useState<string>();

  useEffect(() => {
    void reloadLatest();
  }, [companyId]);

  async function reloadLatest(showError = false): Promise<void> {
    try {
      const value = await platformApi.companyWebsite(companyId);
      setWebsite(value);
      if (value.slug) setSlug(value.slug);
      if (value.defaultLocale) setLocale(value.defaultLocale);
      setVersionConflict(false);
      setError(undefined);
    } catch (failure) {
      if (showError) {
        setError(
          failure instanceof PlatformApiError
            ? failure.message
            : "Website configuration could not be loaded.",
        );
      }
    }
  }

  function showMutationError(failure: unknown, fallback: string): void {
    if (failure instanceof PlatformApiError && failure.code === "website_version_conflict") {
      setVersionConflict(true);
      setError(
        "This website was changed by another administrator. Reload the latest version before making further changes.",
      );
      return;
    }
    setError(failure instanceof PlatformApiError ? failure.message : fallback);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setWebsite(
        await platformApi.configureCompanyWebsite(companyId, {
          slug: slug.trim().toLowerCase(),
          primaryLanguage: locale,
          defaultLocale: locale,
          templateKey: website?.templateKey ?? "corporate",
          expectedVersion: website?.version ?? 0,
        }),
      );
      setEditing(false);
    } catch (failure) {
      showMutationError(failure, "Website configuration could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  async function act(action: "publish" | "disable" | "enable"): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setWebsite(await platformApi.companyWebsiteAction(companyId, action, website?.version ?? 0));
    } catch (failure) {
      showMutationError(failure, "Website action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseTemplate(templateKey: CompanyWebsiteTemplateKey): Promise<void> {
    if (!website?.slug) return;
    setBusy(true);
    setError(undefined);
    try {
      setWebsite(
        await platformApi.configureCompanyWebsite(companyId, {
          slug: website.slug,
          primaryLanguage: website.primaryLanguage ?? locale,
          defaultLocale: website.defaultLocale ?? locale,
          templateKey,
          expectedVersion: website.version ?? 0,
        }),
      );
    } catch (failure) {
      showMutationError(failure, "Template could not be selected.");
    } finally {
      setBusy(false);
    }
  }

  async function showPreview(templateKey: CompanyWebsiteTemplateKey): Promise<void> {
    setError(undefined);
    try {
      setPreview(await platformApi.companyWebsitePreview(companyId, templateKey));
    } catch (failure) {
      setError(failure instanceof PlatformApiError ? failure.message : "Preview failed.");
    }
  }

  const status = website?.status ?? "not_configured";
  return (
    <section aria-labelledby="company-website-heading" className="company-website-panel">
      <div className="platform-panel__header">
        <div>
          <h3 id="company-website-heading">Website</h3>
          <p className="platform-muted">Public Delivery Company website foundation</p>
        </div>
        {canManage && !editing ? (
          <div className="platform-actions">
            <button
              className="platform-button platform-button--quiet"
              onClick={() => setEditing(true)}
              type="button"
            >
              {status === "not_configured" ? "Configure Website" : "Edit configuration"}
            </button>
            {status !== "not_configured" ? (
              <button
                className="platform-button"
                onClick={() => setEditingWebsite((value) => !value)}
                type="button"
              >
                {editingWebsite ? "Close Editor" : "Edit Website"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {website === undefined ? (
        <p>Loading website status…</p>
      ) : editing ? (
        <form className="platform-form" onSubmit={(event) => void save(event)}>
          <label className="platform-field">
            <span>Website slug</span>
            <input
              pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
              required
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
            />
          </label>
          <label className="platform-field">
            <span>Default language</span>
            <select
              value={locale}
              onChange={(event) => setLocale(event.target.value as "en" | "ar")}
            >
              <option value="en">English</option>
              <option value="ar">Arabic</option>
            </select>
          </label>
          <div className="platform-actions">
            <button
              className="platform-button platform-button--quiet"
              onClick={() => setEditing(false)}
              type="button"
            >
              Cancel
            </button>
            <button className="platform-button" disabled={busy} type="submit">
              Save Website
            </button>
          </div>
        </form>
      ) : (
        <>
          <dl className="platform-review">
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`platform-badge platform-badge--${status}`}>
                  {status.replace("_", " ")}
                </span>
              </dd>
            </div>
            <div>
              <dt>Website URL</dt>
              <dd>
                {website.websiteUrl ? (
                  <a href={website.websiteUrl} rel="noreferrer" target="_blank">
                    {website.websiteUrl}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>Slug</dt>
              <dd>{website.slug ?? "—"}</dd>
            </div>
            <div>
              <dt>Live Template</dt>
              <dd>{templateName(website.publishedTemplateKey)}</dd>
            </div>
            <div>
              <dt>Draft Template</dt>
              <dd>{templateName(website.templateKey)}</dd>
            </div>
            <div>
              <dt>Template changes</dt>
              <dd>{website.hasUnpublishedChanges ? "Unpublished changes" : "Up to date"}</dd>
            </div>
            <div>
              <dt>Enabled</dt>
              <dd>{website.enabled === undefined ? "—" : website.enabled ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Published</dt>
              <dd>{website.published ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>AI Agent</dt>
              <dd>{website.settings?.agent?.enabled ? "Enabled in draft" : "Disabled in draft"}</dd>
            </div>
            <div>
              <dt>WhatsApp</dt>
              <dd>
                {website.settings?.contact.whatsappEnabled && website.settings.contact.showWhatsapp
                  ? "Enabled"
                  : "Disabled"}
              </dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>{website.updatedAt ? new Date(website.updatedAt).toLocaleString() : "—"}</dd>
            </div>
            <div>
              <dt>Last published</dt>
              <dd>{website.publishedAt ? new Date(website.publishedAt).toLocaleString() : "—"}</dd>
            </div>
          </dl>
          {canManage && status !== "not_configured" ? (
            <div className="platform-actions">
              {status === "draft" || website.hasUnpublishedChanges ? (
                <button
                  className="platform-button"
                  disabled={busy}
                  onClick={() => void act("publish")}
                  type="button"
                >
                  Publish
                </button>
              ) : null}
              {status === "published" ? (
                <button
                  className="platform-button platform-button--quiet"
                  disabled={busy}
                  onClick={() => void act("disable")}
                  type="button"
                >
                  Disable Website
                </button>
              ) : null}
              {status === "disabled" ? (
                <button
                  className="platform-button"
                  disabled={busy}
                  onClick={() => void act("enable")}
                  type="button"
                >
                  Enable Website
                </button>
              ) : null}
            </div>
          ) : null}
          {status !== "not_configured" ? (
            <div className="website-template-section">
              <div className="platform-panel__header">
                <div>
                  <h4>Templates</h4>
                  <p className="platform-muted">
                    Preview safely, then select a draft design. The live website changes only after
                    Publish.
                  </p>
                </div>
              </div>
              <div className="website-template-gallery">
                {TEMPLATES.map((template) => (
                  <article
                    className={`website-template-card website-template-card--${template.key}`}
                    key={template.key}
                  >
                    <div className="website-template-card__thumbnail" aria-hidden="true">
                      <span />
                      <strong>{template.name}</strong>
                      <i />
                      <i />
                    </div>
                    <h5>{template.name}</h5>
                    <p>{template.description}</p>
                    <div className="website-template-card__status">
                      {website.publishedTemplateKey === template.key ? (
                        <span className="platform-badge">Live</span>
                      ) : null}
                      {website.templateKey === template.key ? (
                        <span className="platform-badge">Selected</span>
                      ) : null}
                    </div>
                    <div className="platform-actions">
                      <button
                        className="platform-button platform-button--quiet"
                        onClick={() => void showPreview(template.key)}
                        type="button"
                      >
                        Preview
                      </button>
                      {canManage ? (
                        <button
                          className="platform-button"
                          disabled={busy || website.templateKey === template.key}
                          onClick={() => void chooseTemplate(template.key)}
                          type="button"
                        >
                          Select
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
          {editingWebsite && website.settings ? (
            <CompanyWebsiteEditor
              companyId={companyId}
              website={website}
              onFailure={(failure) =>
                showMutationError(failure, "Website draft could not be saved.")
              }
              onSaved={(saved) => {
                setWebsite(saved);
                setPreview(undefined);
              }}
            />
          ) : null}
          {status !== "not_configured" ? (
            <CompanyWebsiteDomainsPanel canManage={canManage} companyId={companyId} />
          ) : null}
          {canManage && website.settings?.agent?.enabled ? (
            <form
              className="platform-form"
              onSubmit={(event) => {
                event.preventDefault();
                const message = String(
                  new FormData(event.currentTarget).get("agentPreviewMessage") ?? "",
                ).trim();
                if (!message) return;
                setBusy(true);
                void platformApi
                  .companyWebsiteAgentPreview(companyId, message, locale)
                  .then((result) => setAgentPreviewReply(result.reply))
                  .catch((failure) => showMutationError(failure, "Agent preview failed."))
                  .finally(() => setBusy(false));
              }}
            >
              <h4>Preview Agent</h4>
              <p className="platform-muted">
                Authenticated test mode · Draft public content · Not saved to public conversation
                history · Noindex
              </p>
              <label className="platform-field">
                <span>Test message</span>
                <input maxLength={1000} name="agentPreviewMessage" required />
              </label>
              <button className="platform-button" disabled={busy} type="submit">
                Send test
              </button>
              {agentPreviewReply ? (
                <p aria-live="polite">
                  <strong>Draft agent:</strong> {agentPreviewReply}
                </p>
              ) : null}
            </form>
          ) : null}
          {canManage && website.publishedSettings && website.hasUnpublishedChanges ? (
            <button
              className="platform-button platform-button--danger"
              disabled={busy}
              onClick={() => {
                if (globalThis.confirm("Discard all unpublished website changes?"))
                  void platformApi
                    .discardCompanyWebsiteDraft(companyId, website.version ?? 0)
                    .then(setWebsite)
                    .catch((failure) =>
                      showMutationError(failure, "Draft could not be discarded."),
                    );
              }}
              type="button"
            >
              Discard unpublished changes
            </button>
          ) : null}
        </>
      )}
      {error ? (
        <div className="platform-login__error" role="alert">
          <p>{error}</p>
          {versionConflict ? (
            <button className="platform-button" onClick={() => void reloadLatest(true)} type="button">
              Reload Latest
            </button>
          ) : null}
        </div>
      ) : null}
      {preview ? (
        <div
          className="cms-preview website-live-preview"
          role="region"
          aria-label="Website preview"
          style={
            {
              "--preview-primary": preview.settings.branding.primaryColor ?? "#123b5d",
              "--preview-secondary": preview.settings.branding.secondaryColor ?? "#dcecf4",
              "--preview-accent": preview.settings.branding.accentColor ?? "#e2a93b",
            } as CSSProperties
          }
        >
          <meta name="robots" content="noindex,nofollow" />
          <span>Authenticated preview · Not indexable</span>
          <strong>{templateName(preview.templateKey)} template</strong>
          <h4>
            {(preview.settings.presentation.heroHeadline as { en?: string } | undefined)?.en ??
              (preview.settings.presentation.displayName as { en?: string } | undefined)?.en ??
              preview.company.nameEn}
          </h4>
          <p>
            {(preview.settings.presentation.heroSubheadline as { en?: string } | undefined)?.en ??
              preview.company.subtitleEn}
          </p>
          {preview.settings.functions?.trackingEnabled !== false &&
          preview.settings.sections.find((section) => section.key === "tracking")?.enabled !==
            false ? (
            <section aria-label="Real-Time Tracking preview">
              <h4>Real-Time Tracking</h4>
              <p>Enter your shipment reference to see its latest delivery status.</p>
              <label className="platform-field">
                <span>Shipment reference</span>
                <input disabled placeholder="Preview only" />
              </label>
              <button className="platform-button" disabled type="button">
                Track
              </button>
              <small>Preview shell only — no live shipment lookup.</small>
            </section>
          ) : null}
          {preview.settings.services
            .filter((item) => item.enabled)
            .map((item) => (
              <article key={item.id}>
                <strong>{item.title.en}</strong>
                <p>{item.description?.en}</p>
              </article>
            ))}
          {preview.company.telephone ? <p>{preview.company.telephone}</p> : null}
          {preview.company.email ? <p>{preview.company.email}</p> : null}
          {preview.company.addressEn ? <p>{preview.company.addressEn}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

const TEMPLATES: ReadonlyArray<{
  key: CompanyWebsiteTemplateKey;
  name: string;
  description: string;
}> = [
  {
    key: "corporate",
    name: "Corporate",
    description: "Structured, established and trust-oriented.",
  },
  {
    key: "modern",
    name: "Modern",
    description: "Spacious technology-led cards and bold typography.",
  },
  { key: "express", name: "Express", description: "Fast, direct and conversion-focused actions." },
  { key: "local", name: "Local", description: "Approachable, mobile-first and contact-led." },
  {
    key: "premium",
    name: "Premium",
    description: "Restrained, elegant presentation for specialist service.",
  },
];

function templateName(key: CompanyWebsiteTemplateKey | null | undefined): string {
  return TEMPLATES.find((template) => template.key === key)?.name ?? "Not published";
}
