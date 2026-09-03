# Blog article import

Platform Administration → Website → Blog → New article (or an existing article) → **Import Article**.

- Requires `platform.blog.create`, an authenticated Platform session and the existing CSRF header.
- Upload `.docx` or UTF-8 `.txt`, maximum 2 MB, or paste an HTTPS Google Docs document link.
- Google links are downloaded from a reconstructed `docs.google.com` text-export URL only. Redirects are blocked, downloads time out after 12 seconds, and responses are size-limited.
- Private Google Docs / Drive files: download as Word and upload. No Google OAuth connection is added and no document needs to be made public.
- The first line becomes the proposed title. Remaining text becomes the body; the opening body text supplies editable excerpt, SEO and social descriptions. This is text extraction, not an OpenAI rewrite or summary.
- Review each proposed field. Existing values, including language, are unchecked by default. Existing authors/categories can be selected in the review; none are invented or created.
- **Confirm selected fields** only updates the browser editor. **Save Draft** and **Publish** remain separate administrator actions.
- Original documents, embedded images, formatting and comments are not stored or imported. Use the separate featured-image upload workflow. This importer does not write images to the database, R2, or disk.
- No schema changes. Expected validation failures return clear 400 errors; unexpected errors use the existing API exception filter and centralized Error Handler.

Deployment: rebuild both API and Platform frontend. DOCX parsing uses `mammoth` with an archive size/count check using `fflate`.
