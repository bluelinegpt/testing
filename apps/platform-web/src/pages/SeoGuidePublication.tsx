type GuidePublication = {
  status: string;
  slug: string;
  language: string;
  published_at?: string | null;
  scheduled_at?: string | null;
};

export function seoGuidePublicUrl(guide: Pick<GuidePublication, "language" | "slug">): string {
  return `https://tawseelhub.com${guide.language === "ar" ? "/ar" : ""}/${encodeURIComponent(guide.slug.normalize("NFC"))}`;
}

export function isSeoGuidePublic(guide: GuidePublication): boolean {
  return guide.status === "published" || (guide.status === "scheduled" && Boolean(guide.scheduled_at)
    && new Date(guide.scheduled_at!).getTime() <= Date.now());
}

export function SeoGuidePublication({ guide }: { guide: GuidePublication }) {
  const available = isSeoGuidePublic(guide);
  const url = seoGuidePublicUrl(guide);
  const status = available ? "Published" : ({ draft: "Draft", scheduled: "Scheduled", unpublished: "Unpublished", archived: "Archived" }[guide.status] ?? guide.status);
  return <section className="seo-guide-publication" aria-label="Publication details">
    <h3>Publication status <span className={`platform-badge platform-badge--${available ? "active" : "draft"}`}>{status}</span></h3>
    <p>{available ? "This guide is published. Open the public page to check what visitors see." : "This guide is not public. Visitors cannot read it at the planned address yet."}</p>
    {guide.status === "scheduled" && guide.scheduled_at && <p>Scheduled for: <time dateTime={guide.scheduled_at}>{new Date(guide.scheduled_at).toLocaleString()}</time></p>}
    {available && guide.published_at && <p>Published: <time dateTime={guide.published_at}>{new Date(guide.published_at).toLocaleString()}</time></p>}
    <p><strong>{available ? "Public URL" : "Planned public URL"}</strong></p>
    <p className="seo-guide-publication__url" dir="ltr">{available ? <a href={url} target="_blank" rel="noopener noreferrer">{url}</a> : <span>{url}</span>}</p>
    {available && <a className="platform-button" href={url} target="_blank" rel="noopener noreferrer">Open published page ↗</a>}
    <p className="platform-muted">SEO Guides have their own public pages and do not appear in the Blog listing automatically.</p>
  </section>;
}
