import { useState } from "react";
import { platformApi } from "../api/platform-client.js";
import "./BlogArticleImport.css";

const labels: Record<string, string> = {
  title: "Title", slug: "Slug", content: "Article body", excerpt: "Excerpt", language: "Language",
  seoTitle: "SEO title", metaDescription: "Meta description", socialTitle: "Social title", socialDescription: "Social description",
  authorId: "Author", categoryId: "Category",
};
export function emptyImportFields(current: Record<string, unknown>, fields: Record<string, string>) {
  return Object.keys(fields).filter(key => fields[key]?.trim() && !String(current[key] ?? "").trim());
}

export function BlogArticleImport({ current, onApply, authors = [], categories = [] }: {
  current: Record<string, unknown>;
  onApply: (fields: Record<string, string>) => void;
  authors?: Array<{ id: string; display_name: string }>;
  categories?: Array<{ id: string; name: string }>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<{ fields: Record<string, string>; warnings: string[] } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<Record<string, unknown>>({});
  async function prepare() {
    setError(""); setProposal(null);
    if (file && file.size > 2 * 1024 * 1024) { setError("Choose a file up to 2 MB."); return; }
    setBusy(true);
    try {
      const result = await platformApi.importBlogArticle(file, link);
      result.fields = { ...result.fields, authorId: String(current.authorId ?? ""), categoryId: String(current.categoryId ?? "") };
      setProposal(result); setSnapshot({ ...current });
      setSelected(emptyImportFields(current, result.fields));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Import failed. Your article was not changed."); }
    finally { setBusy(false); }
  }
  function apply() {
    if (!proposal) return;
    if (selected.some(key => current[key] !== snapshot[key])) {
      setError("An article field changed while you were reviewing. Review the import again before applying it."); return;
    }
    onApply(Object.fromEntries(selected.map(key => [key, proposal.fields[key]!]))) ;
    setProposal(null); setError("");
  }
  return <details className="platform-panel blog-import">
    <summary><strong>Import Article — Word, text or Google Docs</strong></summary>
    <p>Propose article fields from your document. Nothing is saved or published. Existing fields are unchecked by default.</p>
    <p>Use .docx or UTF-8 .txt (up to 2 MB). For a private Google Doc or a file in Drive, download it as Word and upload it here. Images and formatting are not imported.</p>
    <div className="blog-import__sources">
    <label className="blog-import__input">Upload article from computer<input type="file" accept=".docx,.txt" disabled={busy}
      onChange={event => { setFile(event.target.files?.[0] ?? null); setProposal(null); }} /></label>
    <label className="blog-import__input">Or paste Google Docs link<input type="url" value={link} disabled={busy || Boolean(file)}
      onChange={event => { setLink(event.target.value); setProposal(null); }} /></label>
    </div>
    <div className="blog-import__actions">
    {file && <button type="button" disabled={busy} onClick={() => { setFile(null); setProposal(null); }}>Use Google Docs instead</button>}
    <button type="button" disabled={busy || (!file && !link.trim())} onClick={() => void prepare()}>{busy ? "Reading document…" : "Prepare import review"}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {proposal && <section className="blog-import__review" aria-label="Review imported article">
      <h3>Review proposed changes</h3>
      {proposal.warnings.map(warning => <p key={warning}>{warning}</p>)}
      <p>Check each field you want to apply. Checking an existing field explicitly replaces its value. Language is also preserved unless selected.</p>
      <p className="blog-import__notice">{selected.length} fields selected. After reviewing, use “Confirm selected fields” below to fill the main editor. Saving is a separate step.</p>
      {Object.entries(proposal.fields).map(([key, value]) => <div className={`blog-import__field${key === "content" ? " blog-import__field--body" : ""}`} key={key}>
        <label className="blog-import__toggle"><input type="checkbox" checked={selected.includes(key)} onChange={event => setSelected(keys => event.target.checked ? [...keys, key] : keys.filter(k => k !== key))} />Apply {labels[key] ?? key}</label>
        {String(current[key] ?? "").trim() && <details><summary>Existing value — preserved unless checked</summary><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(current[key])}</p></details>}
        <label className="blog-import__input">Proposed {labels[key] ?? key}{key === "authorId" || key === "categoryId" ? <select value={value}
          onChange={event => setProposal(p => p ? { ...p, fields: { ...p.fields, [key]: event.target.value } } : p)}>
          <option value="">Select an existing {key === "authorId" ? "author" : "category"}</option>
          {(key === "authorId" ? authors.map(a => ({ id: a.id, name: a.display_name })) : categories).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select> : <textarea dir="auto" rows={key === "content" ? 18 : 3} value={value}
          onChange={event => setProposal(p => p ? { ...p, fields: { ...p.fields, [key]: event.target.value } } : p)} />}</label>
      </div>)}
      <div className="blog-import__actions">
      <button className="platform-button" type="button" disabled={!selected.length} onClick={apply}>Confirm selected fields — do not save</button>
      <button type="button" onClick={() => setProposal(null)}>Discard proposal</button>
      </div>
    </section>}
  </details>;
}
