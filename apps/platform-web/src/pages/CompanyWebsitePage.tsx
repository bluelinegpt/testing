import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { Link, NavLink, useParams } from "react-router-dom";

import {
  PlatformApiError,
  platformApi,
  type CompanyDetail,
  type CompanyWebsitePreview,
  type CompanyWebsiteTemplateKey,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";
import { CompanyWebsiteDomainsPanel } from "./CompanyWebsiteDomainsPanel.js";
import { CompanyWebsitePanel } from "./CompanyWebsitePanel.js";

function WebsitePageHeader({ company }: { company: CompanyDetail }): ReactElement {
  return (
    <>
      <div className="platform-panel__header">
        <div>
          <p className="platform-header__eyebrow">Delivery Company Website</p>
          <h2>{company.nameEn}</h2>
          <p className="platform-muted">
            {company.code} · {company.subdomain}
          </p>
        </div>
        <Link className="platform-button platform-button--quiet" to={`/companies/${company.id}`}>
          Back to Company
        </Link>
      </div>
      <nav aria-label="Company Website sections" className="company-website-tabs">
        <NavLink end to={`/companies/${company.id}/website`}>
          Website
        </NavLink>
        <NavLink to={`/companies/${company.id}/website/domains`}>Domains</NavLink>
      </nav>
    </>
  );
}

function useCompany(companyId: string): {
  company: CompanyDetail | undefined;
  error: string | undefined;
} {
  const [company, setCompany] = useState<CompanyDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void platformApi
      .company(companyId)
      .then(setCompany)
      .catch((failure) =>
        setError(
          failure instanceof PlatformApiError ? failure.message : "Company could not be loaded.",
        ),
      );
  }, [companyId]);
  return { company, error };
}

export function CompanyWebsitePage(): ReactElement {
  const { companyId = "" } = useParams();
  const { company, error } = useCompany(companyId);
  if (error)
    return (
      <div className="platform-login__error" role="alert">
        {error}
      </div>
    );
  if (!company) return <p>Loading Company Website…</p>;
  return (
    <section className="platform-panel company-website-page">
      <WebsitePageHeader company={company} />
      <aside className="company-website-setup-guide" aria-labelledby="website-setup-guide-heading">
        <div>
          <h3 id="website-setup-guide-heading">Set up Dana&apos;s Website</h3>
          <p>
            Create the Website foundation first. The complete branding, content, WhatsApp, AI and
            SEO editor appears immediately after it is saved.
          </p>
        </div>
        <a className="platform-button" href="#company-website-setup">
          Start Website Setup
        </a>
        <details>
          <summary>View the complete setup checklist</summary>
          <ol>
            <li>
              <strong>Company identity and logo:</strong> inherited from the Company Profile.
            </li>
            <li>
              <strong>Branding and bilingual content:</strong> colors, hero, about, English and
              Arabic.
            </li>
            <li>
              <strong>Business information:</strong> services, coverage, benefits, hours and
              location.
            </li>
            <li>
              <strong>Contact:</strong> phone, email, WhatsApp number, message and visibility.
            </li>
            <li>
              <strong>AI Agent:</strong> identity, knowledge, FAQs, behavior and handoff.
            </li>
            <li>
              <strong>Public functions and SEO:</strong> tracking, requests, metadata and indexing.
            </li>
            <li>
              <strong>Final review:</strong> preview the complete draft, then publish.
            </li>
          </ol>
        </details>
      </aside>
      <CompanyWebsitePanel companyId={companyId} suggestedSlug={company.subdomain} />
    </section>
  );
}

export function CompanyWebsiteDomainsPage(): ReactElement {
  const { companyId = "" } = useParams();
  const { company, error } = useCompany(companyId);
  const canManage = usePlatformSession().can("platform.company_websites.manage");
  if (error)
    return (
      <div className="platform-login__error" role="alert">
        {error}
      </div>
    );
  if (!company) return <p>Loading Website domains…</p>;
  return (
    <section className="platform-panel company-website-page">
      <WebsitePageHeader company={company} />
      <div className="company-website-tab-content">
        <CompanyWebsiteDomainsPanel canManage={canManage} companyId={companyId} />
      </div>
    </section>
  );
}

export function CompanyWebsitePreviewPage(): ReactElement {
  const { companyId = "", templateKey = "corporate" } = useParams();
  const [preview, setPreview] = useState<CompanyWebsitePreview>();
  const [error, setError] = useState<string>();
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const previewFrame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    void platformApi
      .companyWebsitePreview(companyId, templateKey as CompanyWebsiteTemplateKey)
      .then(setPreview)
      .catch((failure) =>
        setError(failure instanceof PlatformApiError ? failure.message : "Preview failed."),
      );
  }, [companyId, templateKey]);
  const previewOrigin =
    globalThis.location.hostname === "localhost" || globalThis.location.hostname === "127.0.0.1"
      ? "http://127.0.0.1:5177"
      : preview
        ? new URL(preview.canonicalUrl ?? `https://${preview.slug}.tawseelhub.com`).origin
        : "";
  useEffect(() => {
    const respond = async (event: MessageEvent<unknown>) => {
      if (event.source !== previewFrame.current?.contentWindow || event.origin !== previewOrigin)
        return;
      if (!event.data || typeof event.data !== "object") return;
      const request = event.data as {
        type?: string;
        requestId?: string;
        message?: string;
        language?: "en" | "ar";
        trackingToken?: string;
      };
      if (!request.requestId) return;
      try {
        const result =
          request.type === "tawseelhub:preview-agent-request"
            ? await platformApi.companyWebsiteAgentPreview(
                companyId,
                request.message ?? "",
                request.language ?? "en",
              )
            : request.type === "tawseelhub:preview-tracking-request"
              ? await platformApi.companyWebsiteTrackingPreview(
                  companyId,
                  request.trackingToken ?? "",
                )
              : undefined;
        if (result !== undefined)
          previewFrame.current?.contentWindow?.postMessage(
            { type: `${request.type}:result`, requestId: request.requestId, result },
            previewOrigin,
          );
      } catch {
        previewFrame.current?.contentWindow?.postMessage(
          { type: `${request.type}:result`, requestId: request.requestId, error: true },
          previewOrigin,
        );
      }
    };
    globalThis.addEventListener("message", respond);
    return () => globalThis.removeEventListener("message", respond);
  }, [companyId, previewOrigin]);
  if (error)
    return (
      <div className="platform-login__error" role="alert">
        {error}
      </div>
    );
  if (!preview) return <p>Preparing authenticated preview…</p>;
  const sendPreview = () =>
    previewFrame.current?.contentWindow?.postMessage(
      { type: "tawseelhub:company-website-draft-preview", payload: preview },
      previewOrigin,
    );
  return (
    <section className="company-website-preview-page company-website-preview-page--exact">
      <header className="company-website-preview-toolbar">
        <div>
          <strong>Exact Draft Website Preview</strong>
          <span>Actual public renderer · Draft content · Noindex</span>
        </div>
        <div className="company-website-preview-devices" role="group" aria-label="Preview width">
          {(["desktop", "tablet", "mobile"] as const).map((option) => (
            <button
              aria-pressed={device === option}
              className="platform-button platform-button--quiet"
              key={option}
              onClick={() => setDevice(option)}
              type="button"
            >
              {option[0]!.toUpperCase() + option.slice(1)}
            </button>
          ))}
          <Link className="platform-button" to={`/companies/${companyId}/website`}>
            Close Preview
          </Link>
        </div>
      </header>
      <div className={`company-website-preview-stage company-website-preview-stage--${device}`}>
        <iframe
          aria-label="Exact draft Website preview"
          className="company-website-exact-preview"
          onLoad={sendPreview}
          ref={previewFrame}
          src={`${previewOrigin}/?websiteDraftPreview=1`}
          title={`${preview.company.nameEn} Website draft preview`}
        />
      </div>
    </section>
  );
}
