import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import mammoth from "mammoth";

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export type ArticleImportFile = { buffer: Buffer; originalname: string };

// Never fetch arbitrary hosts or follow redirects from imported links.
export function googleDocumentExport(link: string): string {
  let url: URL;
  try { url = new URL(link); } catch { throw new BadRequestException("Enter a valid Google Docs document link."); }
  const id = /^\/document\/d\/([A-Za-z0-9_-]+)(?:\/|$)/u.exec(url.pathname)?.[1];
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || url.port || url.username || url.password || !id)
    throw new BadRequestException("Use an HTTPS docs.google.com/document/d/... link. For a Drive file, download it as .docx and upload it.");
  const target = new URL(`https://docs.google.com/document/d/${id}/export`);
  target.searchParams.set("format", "txt");
  const tab = url.searchParams.get("tab");
  if (tab && /^t\.[A-Za-z0-9_-]+$/u.test(tab)) target.searchParams.set("tab", tab);
  return target.toString();
}

export function proposeArticle(raw: string) {
  const text = raw.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  if (text.length < 20) throw new BadRequestException("Include a title and article body in the document.");
  if (text.length > 200_000 || text.includes("\0")) throw new BadRequestException("Article text must be plain text and no longer than 200,000 characters.");
  const lines = text.split("\n");
  const title = lines.shift()!.replace(/^#+\s*/u, "").trim().slice(0, 200);
  const content = lines.join("\n").trim();
  if (title.length < 5 || content.length < 10) throw new BadRequestException("Put the article title (at least 5 characters) on the first line, followed by its body.");
  if (content.split(/\n\n+/u).length > 500 || content.split(/\n\n+/u).some(part => part.length > 10000))
    throw new BadRequestException("Split the article into at most 500 paragraphs, each under 10,000 characters.");
  const summary = content.replace(/\s+/gu, " ").slice(0, 300);
  const latinSlug = title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  const language = (text.match(/[\u0600-\u06ff]/gu)?.length ?? 0) > (text.match(/[a-z]/giu)?.length ?? 0) ? "ar" : "en";
  return {
    fields: { title, content, slug: latinSlug || `article-${createHash("sha256").update(title).digest("hex").slice(0, 12)}`, language,
      excerpt: summary, seoTitle: title, metaDescription: summary.slice(0, 160), socialTitle: title, socialDescription: summary.slice(0, 160) },
    warnings: ["Text import only: formatting, embedded images and comments are not imported. Upload your featured image separately using the image uploader.",
      "Review the proposed title, excerpt and SEO text. Select an existing author and category; no author or image description is invented.",
      ...(!latinSlug ? ["An English URL slug could not be derived. Replace the suggested article identifier if desired."] : [])],
  };
}

export async function extractArticleFile(file: ArticleImportFile): Promise<string> {
  if (!file.buffer.length || file.buffer.length > IMPORT_MAX_BYTES) throw new BadRequestException("Upload a .docx or .txt file up to 2 MB.");
  if (/\.txt$/iu.test(file.originalname)) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(file.buffer); }
    catch { throw new BadRequestException("Save the text file using UTF-8 encoding and upload it again."); }
  }
  if (!/\.docx$/iu.test(file.originalname)) throw new BadRequestException("Supported files are Word .docx and UTF-8 .txt. Download Google Docs as Word for private documents.");
  try {
    let expanded = 0, entries = 0;
    const files = unzipSync(file.buffer, { filter: entry => {
      expanded += entry.originalSize;
      if (++entries > 1000 || expanded > 20 * 1024 * 1024) throw new Error("Document too large");
      return entry.name === "word/document.xml";
    } });
    if (!files["word/document.xml"]) throw new Error("Not a Word document");
    return (await mammoth.extractRawText({ buffer: file.buffer })).value;
  } catch { throw new BadRequestException("This Word file is invalid, encrypted or too large when expanded. Export a fresh .docx or UTF-8 .txt file."); }
}

@Injectable()
export class BlogImportService {
  public async propose(file: ArticleImportFile | undefined, link?: string) {
    if (Boolean(file) === Boolean(link?.trim())) throw new BadRequestException("Choose either one file or one Google Docs link.");
    if (file) return proposeArticle(await extractArticleFile(file));
    const url = googleDocumentExport(link!.trim());
    let response: Response;
    try { response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(12_000) }); }
    catch { throw new BadRequestException("Google Docs could not be reached. Download the document as .docx and upload it instead."); }
    if (!response.ok || !response.headers.get("content-type")?.includes("text/plain")) {
      await response.body?.cancel();
      throw new BadRequestException("This Google Doc cannot be read without sign-in. Download it as .docx and upload it; you do not need to make a private document public.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new BadRequestException("Google returned an empty document.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > IMPORT_MAX_BYTES) throw new BadRequestException("Google document exceeds the 2 MB import limit.");
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("The Google download was interrupted. Try uploading the document as .docx.");
    } finally { await reader.cancel().catch(() => undefined); }
    return proposeArticle(Buffer.concat(chunks).toString("utf8"));
  }
}
