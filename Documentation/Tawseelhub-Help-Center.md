# Tawseelhub Help Center

The public Help Center lives at `/resources`.

It is managed from Platform Administration → Website → Help Center and uses dedicated CMS tables:

- `platform_help_categories`
- `platform_help_articles`

Public rules:

- Only `published` Help articles are visible on the public website.
- Draft and archived articles are not returned by public Help APIs.
- Public article URLs use `/resources/{slug}`.
- Help articles are included in sitemap entries only when published and indexable.
- `/blog` remains the marketing/insight article area; `/resources` is the support/help area.

Platform rules:

- Website CMS permissions are reused:
  - `platform.website.manage` saves categories and article drafts.
  - `platform.website.publish` publishes or archives Help articles.
- Provider-specific integration guides can stay as draft until connector readiness is confirmed.
- Help content marked `available_to_agent` is public support knowledge intended for Yousef.

Initial published guide coverage:

- Getting started with Tawseelhub
- Send a Package quote guidance
- Order creation
- Driver assignment
- Order statuses
- COD collections
- Driver reconciliation overview
- Trader statements and settlements
- Reports overview
- Trader Portal basics
- Commerce integrations overview
- Contact support

Arabic architecture is present through locale-aware categories/articles, with starter Arabic content seeded for `what-is-tawseelhub`.
