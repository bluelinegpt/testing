/* eslint-disable @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-member-access */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { platformApi } from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";
import "./BlogEditorialSeoPage.css";

type Section =
  "Health" | "Categories" | "Tags" | "Topics" | "Authors" | "Redirects" | "404 Monitor";
const sections: Section[] = [
  "Health",
  "Categories",
  "Tags",
  "Topics",
  "Authors",
  "Redirects",
  "404 Monitor",
];
const blankTaxonomy = {
  name: "",
  slug: "",
  language: "en",
  description: "",
  seoTitle: "",
  metaDescription: "",
  robotsIndex: false,
  robotsFollow: true,
  socialTitle: "",
  socialDescription: "",
  socialImageUrl: "",
  active: true,
  sortOrder: 100,
};
const slugify = (value: string) =>
  value
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\p{M}-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
const value = (row: any, key: string) =>
  row?.[key] ?? row?.[key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] ?? "";

export function BlogEditorialSeoPage() {
  const session = usePlatformSession(),
    [section, setSection] = useState<Section>("Health"),
    [refs, setRefs] = useState<any>({ categories: [], tags: [], topics: [], authors: [] }),
    [health, setHealth] = useState<any>({}),
    [productionHealth, setProductionHealth] = useState<any>(null),
    [redirects, setRedirects] = useState<any[]>([]),
    [missing, setMissing] = useState<any[]>([]),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const load = () => {
    setError("");
    void Promise.all([
      platformApi.blogReferences(),
      platformApi.blogSeoHealth(),
      platformApi.blogRedirects(),
      platformApi.blogNotFoundPaths(),
    ])
      .then(([r, h, d, n]) => {
        setRefs(r);
        setHealth(h);
        setRedirects(d);
        setMissing(n);
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Editorial SEO could not be loaded."),
      );
  };
  useEffect(load, []);
  const checkProduction = () => {
    setError("");
    setProductionHealth({ loading: true });
    void platformApi.blogProductionSeoHealth().then(setProductionHealth).catch((e) => {
      setProductionHealth(null);
      setError(e instanceof Error ? e.message : "Production SEO checks could not run.");
    });
  };
  const run = async (action: () => Promise<any>) => {
    setError("");
    setMessage("");
    try {
      await action();
      setMessage("Saved.");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    }
  };
  const canManage = session.can("platform.blog.categories.manage");
  return (
    <section className="platform-panel editorial-seo">
      <div className="platform-panel__header">
        <div>
          <Link to="/website">← Website</Link>
          <h2>Blog Editorial SEO</h2>
          <p className="platform-muted">
            Manage discoverable content and editorial readiness. Statuses are CMS checks, not Google
            ranking scores.
          </p>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p className="platform-success">{message}</p>}
      <nav className="editorial-seo__tabs" aria-label="Editorial SEO sections">
        {sections.map((x) => (
          <button className={section === x ? "active" : ""} key={x} onClick={() => setSection(x)}>
            {x}
          </button>
        ))}
      </nav>
      {section === "Health" && <Health health={health} production={productionHealth} articles={refs.articles ?? []} onCheckProduction={checkProduction} />}
      {section === "Categories" && (
        <EntityManager
          kind="category"
          rows={refs.categories ?? []}
          blank={blankTaxonomy}
          canManage={canManage}
          onSave={(id, body) =>
            run(() =>
              id ? platformApi.updateBlogCategory(id, body) : platformApi.createBlogCategory(body),
            )
          }
        />
      )}
      {section === "Tags" && (
        <EntityManager
          kind="tag"
          rows={refs.tags ?? []}
          blank={blankTaxonomy}
          canManage={canManage}
          onSave={(id, body) => run(() => platformApi.saveBlogTag(id, body))}
        />
      )}
      {section === "Topics" && (
        <TopicManager
          rows={refs.topics ?? []}
          refs={refs}
          canManage={canManage}
          onSave={(id, body) => run(() => platformApi.saveBlogTopic(id, body))}
        />
      )}
      {section === "Authors" && (
        <AuthorManager
          rows={refs.authors ?? []}
          canManage={canManage}
          onSave={(id, body) => run(() => platformApi.saveBlogAuthor(id, body))}
        />
      )}
      {section === "Redirects" && (
        <RedirectManager
          rows={redirects}
          canManage={canManage}
          onSave={(body) => run(() => platformApi.createBlogRedirect(body))}
        />
      )}
      {section === "404 Monitor" && (
        <SimpleTable rows={missing} empty="No public Blog 404s recorded." />
      )}
    </section>
  );
}

function Health({ health, production, articles, onCheckProduction }: { health: any; production: any; articles: any[]; onCheckProduction: () => void }) {
  const cards = [
    ["Missing meta", health.missingMeta],
    ["Missing image", health.missingImage],
    ["Missing alt", health.missingAlt],
    ["Missing image dimensions", health.missingImageDimensions],
    ["Featured images below 1200px", health.smallFeaturedImages],
    ["Duplicate SEO titles", health.duplicateSeoTitles],
    ["Thin indexable categories", health.thinIndexableCategories],
    ["Noindex published", health.noindexPublished],
    ["Orphan articles", health.orphanArticles],
    ["Broken internal links", health.brokenInternalLinks],
    ["Redirected internal links", health.redirectedInternalLinks],
    ["Unpublished internal links", health.unpublishedInternalLinks],
    ["Review recommended", health.reviewRecommended],
  ];
  return (
    <>
      <div className="editorial-seo__health">
        {cards.map(([label, count]) => (
          <article key={String(label)}>
            <strong>{count ?? 0}</strong>
            <span>{label}</span>
          </article>
        ))}
      </div>
      <div className="platform-panel__header">
        <div>
          <h3>Production SEO</h3>
          <p className="platform-muted">Live technical checks only. Google indexing, search traffic and field Core Web Vitals remain in Search Console and are delayed—not real-time metrics.</p>
        </div>
        <button type="button" onClick={onCheckProduction} disabled={production?.loading}>
          {production?.loading ? "Checking…" : "Run live checks"}
        </button>
      </div>
      {production?.checks ? (
        <>
          <p><strong>{production.status === "healthy" ? "Healthy" : "Needs attention"}</strong> · checked {new Date(production.checkedAt).toLocaleString()} · {production.sitemapUrlCount} sitemap URLs</p>
          <ul className="editorial-seo__checks">
            {production.checks.map((check: any) => <li key={check.key}>{check.pass ? "✓" : "⚠"} {check.message}</li>)}
          </ul>
        </>
      ) : <p className="platform-muted">Run this after deployment to verify the canonical production host.</p>}
      <h3>Bulk article overview</h3>
      <table className="platform-table">
        <thead>
          <tr>
            <th>Article</th>
            <th>Language</th>
            <th>Status</th>
            <th>Category</th>
            <th>Cornerstone</th>
            <th>Readiness</th>
          </tr>
        </thead>
        <tbody>
          {articles.map((a) => (
            <tr key={a.id}>
              <td>
                <Link to={`/website/${a.id}`}>{a.title}</Link>
              </td>
              <td>{a.language}</td>
              <td>{a.status}</td>
              <td>{a.category}</td>
              <td>{a.cornerstone ? "Yes" : "No"}</td>
              <td>{a.seo_readiness ?? "Open article"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function EntityManager({
  kind,
  rows,
  blank,
  canManage,
  onSave,
}: {
  kind: string;
  rows: any[];
  blank: any;
  canManage: boolean;
  onSave: (id: string | undefined, body: any) => void;
}) {
  const [selected, setSelected] = useState<any>({ ...blank });
  const id = selected.id as string | undefined;
  const set = (k: string, v: any) => setSelected((x: any) => ({ ...x, [k]: v }));
  return (
    <div className="editorial-seo__split">
      <SimpleTable
        rows={rows}
        empty={`No ${kind}s yet.`}
        onSelect={(row) =>
          setSelected({
            ...blank,
            ...row,
            seoTitle: value(row, "seoTitle"),
            metaDescription: value(row, "metaDescription"),
            robotsIndex: Boolean(value(row, "robotsIndex")),
            robotsFollow: value(row, "robotsFollow") !== false,
            socialTitle: value(row, "socialTitle"),
            socialDescription: value(row, "socialDescription"),
            socialImageUrl: value(row, "socialImageUrl"),
            translationGroupId: value(row, "translationGroupId"),
            sortOrder: Number(value(row, "sortOrder") || 100),
          })
        }
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(id, selected);
        }}
      >
        <h3>
          {id ? "Edit" : "New"} {kind}
        </h3>
        <label>
          Name
          <input
            required
            value={selected.name}
            onChange={(e) => {
              set("name", e.target.value);
              if (!id) set("slug", slugify(e.target.value));
            }}
          />
        </label>
        <label>
          Slug
          <input
            required
            value={selected.slug}
            onChange={(e) => set("slug", slugify(e.target.value))}
          />
        </label>
        <label>
          Language
          <select value={selected.language} onChange={(e) => set("language", e.target.value)}>
            <option value="en">English</option>
            <option value="ar">Arabic</option>
          </select>
        </label>
        <label>
          Matching translation
          <select
            value={selected.translationGroupId ?? ""}
            onChange={(e) => set("translationGroupId", e.target.value || undefined)}
          >
            <option value="">No linked translation</option>
            {rows
              .filter((row) => row.id !== id && row.language !== selected.language)
              .map((row) => (
                <option key={row.id} value={value(row, "translationGroupId") ?? row.id}>
                  {row.name} ({String(row.language).toUpperCase()})
                </option>
              ))}
          </select>
        </label>
        <label>
          Description
          <textarea
            value={selected.description ?? ""}
            onChange={(e) => set("description", e.target.value)}
          />
        </label>
        <SeoFields form={selected} set={set} />
        {kind === "category" && (
          <label>
            Sort order
            <input
              type="number"
              value={selected.sortOrder}
              onChange={(e) => set("sortOrder", Number(e.target.value))}
            />
          </label>
        )}
        <button disabled={!canManage} className="platform-button">
          Save {kind}
        </button>
        <button type="button" onClick={() => setSelected({ ...blank })}>
          New
        </button>
      </form>
    </div>
  );
}

function SeoFields({ form, set }: { form: any; set: (k: string, v: any) => void }) {
  return (
    <>
      <label>
        SEO title
        <input value={form.seoTitle ?? ""} onChange={(e) => set("seoTitle", e.target.value)} />
      </label>
      <label>
        Meta description
        <textarea
          value={form.metaDescription ?? ""}
          onChange={(e) => set("metaDescription", e.target.value)}
        />
      </label>
      <label>
        Social title
        <input
          value={form.socialTitle ?? ""}
          onChange={(e) => set("socialTitle", e.target.value)}
        />
      </label>
      <label>
        Social description
        <textarea
          value={form.socialDescription ?? ""}
          onChange={(e) => set("socialDescription", e.target.value)}
        />
      </label>
      <label>
        Social image URL
        <input
          value={form.socialImageUrl ?? ""}
          onChange={(e) => set("socialImageUrl", e.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={Boolean(form.robotsIndex)}
          onChange={(e) => set("robotsIndex", e.target.checked)}
        />{" "}
        Index this useful, populated page
      </label>
      <label>
        <input
          type="checkbox"
          checked={form.robotsFollow !== false}
          onChange={(e) => set("robotsFollow", e.target.checked)}
        />{" "}
        Follow links
      </label>
      <label>
        <input
          type="checkbox"
          checked={form.active !== false}
          onChange={(e) => set("active", e.target.checked)}
        />{" "}
        Active
      </label>
    </>
  );
}

function TopicManager({
  rows,
  refs,
  canManage,
  onSave,
}: {
  rows: any[];
  refs: any;
  canManage: boolean;
  onSave: (id: string | undefined, body: any) => void;
}) {
  const blank = {
    ...blankTaxonomy,
    title: "",
    featuredContent: "",
    status: "draft",
    categoryIds: [],
    tagIds: [],
    articleIds: [],
  };
  const [form, setForm] = useState<any>(blank),
    set = (k: string, v: any) => setForm((x: any) => ({ ...x, [k]: v }));
  return (
    <div className="editorial-seo__split">
      <SimpleTable
        rows={rows}
        empty="No topic hubs yet."
        onSelect={(r) =>
          setForm({
          ...blank,
          ...r,
          title: r.title,
          categoryIds: r.category_ids ?? [],
          tagIds: r.tag_ids ?? [],
          articleIds: r.article_ids ?? [],
          translationGroupId: r.translation_group_id ?? "",
            seoTitle: value(r, "seoTitle"),
            metaDescription: value(r, "metaDescription"),
            robotsIndex: Boolean(value(r, "robotsIndex")),
            robotsFollow: value(r, "robotsFollow") !== false,
          })
        }
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(form.id, form);
        }}
      >
        <h3>{form.id ? "Edit" : "New"} topic hub</h3>
        <label>
          Title
          <input
            required
            value={form.title}
            onChange={(e) => {
              set("title", e.target.value);
              if (!form.id) set("slug", slugify(e.target.value));
            }}
          />
        </label>
        <label>
          Slug
          <input
            required
            value={form.slug}
            onChange={(e) => set("slug", slugify(e.target.value))}
          />
        </label>
        <label>
          Language
          <select value={form.language} onChange={(e) => set("language", e.target.value)}>
            <option value="en">English</option>
            <option value="ar">Arabic</option>
          </select>
        </label>
        <label>
          Matching translation
          <select
            value={form.translationGroupId ?? ""}
            onChange={(e) => set("translationGroupId", e.target.value || undefined)}
          >
            <option value="">No linked translation</option>
            {rows
              .filter((row) => row.id !== form.id && row.language !== form.language)
              .map((row) => (
                <option key={row.id} value={row.translation_group_id ?? row.id}>
                  {row.title} ({String(row.language).toUpperCase()})
                </option>
              ))}
          </select>
        </label>
        <label>
          Description
          <textarea
            required
            minLength={20}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </label>
        <label>
          Featured introduction
          <textarea
            value={form.featuredContent}
            onChange={(e) => set("featuredContent", e.target.value)}
          />
        </label>
        <label>
          Status
          <select value={form.status} onChange={(e) => set("status", e.target.value)}>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <MultiSelect
          label="Selected articles"
          rows={(refs.articles ?? []).filter((x: any) => x.language === form.language)}
          selected={form.articleIds ?? []}
          onChange={(v) => set("articleIds", v)}
        />
        <MultiSelect
          label="Related categories"
          rows={(refs.categories ?? []).filter((x: any) => x.language === form.language)}
          selected={form.categoryIds ?? []}
          onChange={(v) => set("categoryIds", v)}
        />
        <MultiSelect
          label="Related tags"
          rows={(refs.tags ?? []).filter((x: any) => x.language === form.language)}
          selected={form.tagIds ?? []}
          onChange={(v) => set("tagIds", v)}
        />
        <SeoFields form={form} set={set} />
        <button disabled={!canManage} className="platform-button">
          Save topic
        </button>
        <button type="button" onClick={() => setForm(blank)}>
          New
        </button>
      </form>
    </div>
  );
}

function AuthorManager({
  rows,
  canManage,
  onSave,
}: {
  rows: any[];
  canManage: boolean;
  onSave: (id: string | undefined, body: any) => void;
}) {
  const blank = {
    displayName: "",
    slug: "",
    language: "en",
    roleTitle: "",
    shortBio: "",
    biography: "",
    expertise: [],
    profileImagePublicUrl: "",
    profileLinks: {},
    seoTitle: "",
    metaDescription: "",
    robotsIndex: false,
    robotsFollow: true,
    socialTitle: "",
    socialDescription: "",
    active: true,
  };
  const [form, setForm] = useState<any>(blank),
    set = (k: string, v: any) => setForm((x: any) => ({ ...x, [k]: v }));
  return (
    <div className="editorial-seo__split">
      <SimpleTable
        rows={rows}
        empty="No authors yet."
        onSelect={(r) =>
          setForm({
            ...blank,
            ...r,
            displayName: r.display_name,
            roleTitle: r.role_title ?? "",
            shortBio: r.short_bio ?? "",
            profileImagePublicUrl: r.profile_image_public_url ?? "",
            profileLinks: r.profile_links ?? {},
            translationGroupId: r.translation_group_id ?? "",
            seoTitle: r.seo_title ?? "",
            metaDescription: r.meta_description ?? "",
            robotsIndex: r.robots_index,
            robotsFollow: r.robots_follow,
            socialTitle: r.social_title ?? "",
            socialDescription: r.social_description ?? "",
          })
        }
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(form.id, form);
        }}
      >
        <h3>{form.id ? "Edit" : "New"} author</h3>
        <label>
          Public display name
          <input
            required
            value={form.displayName}
            onChange={(e) => {
              set("displayName", e.target.value);
              if (!form.id) set("slug", slugify(e.target.value));
            }}
          />
        </label>
        <label>
          Slug
          <input
            required
            value={form.slug}
            onChange={(e) => set("slug", slugify(e.target.value))}
          />
        </label>
        <label>
          Language
          <select value={form.language} onChange={(e) => set("language", e.target.value)}>
            <option value="en">English</option>
            <option value="ar">Arabic</option>
          </select>
        </label>
        <label>
          Matching translation
          <select
            value={form.translationGroupId ?? ""}
            onChange={(e) => set("translationGroupId", e.target.value || undefined)}
          >
            <option value="">No linked translation</option>
            {rows
              .filter((row) => row.id !== form.id && row.language !== form.language)
              .map((row) => (
                <option key={row.id} value={row.translation_group_id ?? row.id}>
                  {row.display_name} ({String(row.language).toUpperCase()})
                </option>
              ))}
          </select>
        </label>
        <label>
          Role title
          <input value={form.roleTitle} onChange={(e) => set("roleTitle", e.target.value)} />
        </label>
        <label>
          Short biography
          <textarea value={form.shortBio} onChange={(e) => set("shortBio", e.target.value)} />
        </label>
        <label>
          Biography
          <textarea value={form.biography} onChange={(e) => set("biography", e.target.value)} />
        </label>
        <label>
          Expertise (comma separated)
          <input
            value={(form.expertise ?? []).join(", ")}
            onChange={(e) =>
              set(
                "expertise",
                e.target.value
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              )
            }
          />
        </label>
        <label>
          Profile image URL
          <input
            value={form.profileImagePublicUrl}
            onChange={(e) => set("profileImagePublicUrl", e.target.value)}
          />
        </label>
        <label>
          Website URL
          <input
            type="url"
            value={form.profileLinks?.website ?? ""}
            onChange={(e) => set("profileLinks", { ...form.profileLinks, website: e.target.value })}
          />
        </label>
        <label>
          LinkedIn URL
          <input
            type="url"
            value={form.profileLinks?.linkedin ?? ""}
            onChange={(e) => set("profileLinks", { ...form.profileLinks, linkedin: e.target.value })}
          />
        </label>
        <label>
          X profile URL
          <input
            type="url"
            value={form.profileLinks?.x ?? ""}
            onChange={(e) => set("profileLinks", { ...form.profileLinks, x: e.target.value })}
          />
        </label>
        <SeoFields form={form} set={set} />
        <button disabled={!canManage} className="platform-button">
          Save author
        </button>
        <button type="button" onClick={() => setForm(blank)}>
          New
        </button>
      </form>
    </div>
  );
}

function RedirectManager({
  rows,
  canManage,
  onSave,
}: {
  rows: any[];
  canManage: boolean;
  onSave: (body: any) => void;
}) {
  const [form, setForm] = useState({ fromPath: "", toPath: "", statusCode: 301, active: true });
  return (
    <>
      <form
        className="editorial-seo__redirect"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(form);
        }}
      >
        <label>
          Old internal path
          <input
            required
            placeholder="/blog/old-slug"
            value={form.fromPath}
            onChange={(e) => setForm({ ...form, fromPath: e.target.value })}
          />
        </label>
        <label>
          Published destination
          <input
            required
            placeholder="/blog/new-slug"
            value={form.toPath}
            onChange={(e) => setForm({ ...form, toPath: e.target.value })}
          />
        </label>
        <label>
          Status
          <select
            value={form.statusCode}
            onChange={(e) => setForm({ ...form, statusCode: Number(e.target.value) })}
          >
            <option value={301}>301</option>
            <option value={308}>308</option>
          </select>
        </label>
        <button disabled={!canManage} className="platform-button">
          Create redirect
        </button>
      </form>
      <SimpleTable rows={rows} empty="No redirects yet." />
    </>
  );
}
function MultiSelect({
  label,
  rows,
  selected,
  onChange,
}: {
  label: string;
  rows: any[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      {rows.map((r) => (
        <label key={r.id}>
          <input
            type="checkbox"
            checked={selected.includes(r.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))
            }
          />
          {r.title ?? r.name}
        </label>
      ))}
    </fieldset>
  );
}
function SimpleTable({
  rows,
  empty,
  onSelect,
}: {
  rows: any[];
  empty: string;
  onSelect?: (row: any) => void;
}) {
  if (!rows.length) return <p>{empty}</p>;
  const keys = Object.keys(rows[0])
    .filter((k) => !["translation_group_id", "profile_links"].includes(k))
    .slice(0, 7);
  return (
    <div className="platform-table-scroll">
      <table className="platform-table">
        <thead>
          <tr>
            {keys.map((k) => (
              <th key={k}>{k.replace(/_/g, " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.id ?? r.path ?? i}
              onClick={() => onSelect?.(r)}
              className={onSelect ? "selectable" : undefined}
            >
              {keys.map((k) => (
                <td key={k}>
                  {typeof r[k] === "object" ? JSON.stringify(r[k]) : String(r[k] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
