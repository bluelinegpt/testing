# Blog rich editor and private enquiries

The platform Blog editor now supports Visual and HTML source modes, section
headings H2/H3 (the article title is H1), bold/italic/underline, lists, links,
approved fonts and font sizes, and inline image uploads using existing CMS media.
Images can occupy 25/50/75/100% of article width; source HTML can adjust this later.
Existing paragraph/heading/list blocks are converted without losing text.
Word/text import remains text-only and applies escaped paragraphs to the editor.

Safe presentation HTML is stored as an `html` block in the existing JSON content.
No schema migration, direct database operation, or historical backfill is needed.
Scripts, forms, handlers, unsafe schemes, and arbitrary styles are removed server-side.
Public reads sanitize again; H1 within body is normalized to H2.
Save Draft and Publish remain separate. Existing publication permissions apply.
The sticky save bar identifies unsaved edits and surfaces failures beside the
save controls. Publish first saves current edits and aborts if saving fails;
it no longer silently publishes an older draft. Closing/reloading or following
a link with unsaved edits prompts a warning. Safe inline font-weight, font-style
and text-decoration survive sanitization; pasted H1 becomes H2 without dropping
the heading text. Editor save/reopen and failed-save regression tests use a
mocked API; live Render persistence still requires deployment verification.
Save requests now explicitly select only SaveBlogArticleDto fields: response
metadata (id, status, timestamps, snake-case fields and draft_payload) is never
sent back. A cross-app contract test passes the actual frontend serializer
through Nest's production ValidationPipe, reproducing the previous 400 for
extra fields. Platform validation errors display the server's field details.
The Platform CSP allows sanitized style attributes via style-src-attr, while
inline scripts and style blocks remain blocked; HTTPS inline images are allowed.

Every public platform blog article has an English/Arabic private enquiry form
and WhatsApp link to +971506898604 with the approved Tawseelhub greeting.
POST `/api/v1/public/blog/articles/:slug/enquiry` validates a publicly available
article, name/email/message, explicit consent and honeypot. The shared rate limiter
allows three requests per minute per IP. This is not a public comment system.
Messages are emailed only to **aothman@gmail.com**. They are not saved in a new
database table, and they do not appear in the Website Leads screen.

## Required API Render environment

- `SMTP_HOST`: your email provider's SMTP hostname
- `SMTP_PORT`: 587 (STARTTLS), 465 (TLS), or 2525 (STARTTLS)
- `SMTP_USER`: sending account username
- `SMTP_PASSWORD`: sending account SMTP credential/app password
- `SMTP_FROM`: authorized sender email address

The receiving Gmail address is not a sending credential. Use the provider's
authorized sender. Do not place SMTP credentials in frontend/VITE variables.
TLS verification remains enabled. No live email was sent during tests.
Missing SMTP or failed delivery shows a failure and WhatsApp alternative, never
success. Unexpected failures use the existing ApiExceptionFilter and central
Error Handler with a sanitized fixed message, not SMTP responses or customer text.
The form reports success only after SMTP accepts the recipient; inbox delivery
still depends on the provider. There is no durable retry queue or auto-resend.

Deploy API, Platform admin and Public website together, then test with a real
article after SMTP is configured. No production deployment or sending credentials
are configured by this change.
