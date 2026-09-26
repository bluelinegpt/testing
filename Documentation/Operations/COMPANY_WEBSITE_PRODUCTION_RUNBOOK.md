# Delivery Company Website production runbook

## Architecture and tenant boundary

One API, one Platform Web service, and one Company Web service serve all Delivery Companies. A Company application host is `companyslugapp.tawseelhub.com`; its public Website host is `companyslug.tawseelhub.com`. Public requests are scoped on the server from the normalized request hostname. Client-supplied Company identifiers are never authoritative.

The five templates (`corporate`, `modern`, `express`, `local`, and `premium`) render the same published Website settings object. Business content is not stored per template. Platform Preview reads draft settings and is authenticated/noindex; public bootstrap, tracking, delivery requests, sitemap, and Agent endpoints read published state only. Publish and all administrative mutations use `expectedVersion`; stale mutations return `409 website_version_conflict` without a partial write.

Operational Company sessions remain host-only, `HttpOnly`, `Secure`, and `SameSite=Lax`. Public and custom-domain hosts do not receive Company application cookies. Authenticated CORS is not widened for public Websites.

## Schema and lifecycle

Apply these migrations in order:

1. `20260938000000_company_website_foundation.ts`
2. `20260939000000_company_website_public_functions.ts`
3. `20260940000000_company_website_agent.ts`
4. `20260941000000_company_website_custom_domains.ts`

They create `company_websites`, `company_website_delivery_requests`, `company_website_agent_conversations`, and `company_website_domains`. They do not modify Orders, reconciliation, settlements, Accounting, Journal Entries, or `file_objects`.

Lifecycle is Draft → Preview → Published. Disable makes all public Website functions ineligible while leaving the operational application untouched. Re-enable restores the existing published snapshot. Website, Agent, tracking, request-delivery, WhatsApp, and custom-domain switches are independent within the published settings/lifecycle rules.

## Deployment order

1. Take and verify a current Neon backup.
2. Apply and verify migrations.
3. Deploy API (`bluelinegpt-api-test`).
4. Deploy Platform Web (`bluelinegpt-platform-test`).
5. Deploy Company Web (`bluelinegpt-web-test`).
6. Enable/verify Cloudflare custom-hostname infrastructure only after the fallback origin is proven.

Do not create one service per Company. Confirm the version badge on each user-facing service after deployment and update `Documentation/deployment-registry.json`. Only a user-confirmed Render revision may be marked `confirmed_live`.

## Environment configuration

API Website/Agent configuration uses the existing database, hostname suffix, AI provider/model, request timeout, rate-limit, and token-limit settings defined in `.env.example`. Keep provider secrets server-side. Company Web requires the correct `API_PROXY_TARGET` and `WEB_TENANT_HOST_SUFFIX=tawseelhub.com`.

Custom domains additionally require:

```text
COMPANY_WEBSITE_DOMAIN_PROVIDER=cloudflare
CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN=<secret>
CLOUDFLARE_CUSTOM_HOSTNAMES_ZONE_ID=<zone-id>
COMPANY_WEBSITE_CUSTOM_DOMAIN_CNAME_TARGET=<approved-fallback-cname>
WEB_ALLOW_CUSTOM_DOMAINS=true
```

See `COMPANY_WEBSITE_CUSTOM_DOMAINS.md` for Cloudflare ownership, SSL, CNAME, Render-origin, removal, and primary-domain procedures. Never record secret values in this repository.

## Backup and restore

Before every production Website schema write, create a full Neon snapshot or `pg_dump --format=custom` archive, verify it with `pg_restore --list`, record UTC creation time and checksum outside source control, and confirm it predates the migration.

Restore is a disaster-recovery action: create a clean replacement Neon branch/database, restore with `pg_restore --clean --if-exists --no-owner --no-privileges`, run schema/application validation, then switch the application connection only after approval. Do not overwrite the active production database during a restore drill.

Prompt 8 backup record (production Neon `neondb`):

- identifier: `neon-pre-prompt8-20260828T075300Z`
- created: `2026-08-28T03:59:06.0266851Z`
- format/size: PostgreSQL custom archive, 2,354,595 bytes
- archive entries: 2,513
- SHA-256: `2E91CD7175B1ECF2B06367864C30B7ACEFC56B876BE94F3883C392035C1ECC95`
- local ignored recovery artifact: `.backups/neon-pre-prompt8-20260828T075300Z.dump`

## Privacy, isolation, and abuse controls

Public tracking accepts only the opaque public reference and returns the dedicated public DTO: public reference, translated public status, approved status timeline/timestamps, last update, and public Company identity. It never serializes customer identity/contact/address, Trader or Driver private data, notes, operational identifiers, accounting, settlement, or reconciliation fields. Invalid, malformed, rate-limited, and cross-Company references use neutral responses.

Delivery requests use the validated public endpoint, Company/Website derived from hostname, idempotency, rate limiting, and a `REQ-######` public reference. They do not create an operational Order automatically.

The Company Agent receives only published public Website context. It cannot query arbitrary operational models. Tracking reuses the public tracking service; delivery-request guidance reuses the public request flow. Conversation tokens are hashed, Company/Website-bound, expiring, message-capped, and cannot move between hosts. Input/output sizes, model, timeout, and throttles are server-controlled. Prompt injection cannot override server-side context/tool scope. Provider failure leaves tracking, requests, WhatsApp, phone, and email available.

Company working-hours answers use the centrally validated `company_settings.timezone` (default `Asia/Dubai`) and server time; the model never guesses the current time.

## Rollback

- Frontends/API: redeploy the previous known-good commit in reverse dependency order (Company Web, Platform Web, API) while keeping the compatible additive schema.
- Immediate containment: disable the affected Website, Agent, or custom domain in Platform Admin. The operational Company application remains available.
- Custom domain: disable/remove the mapping and provider hostname; retain the Tawseelhub fallback host.
- Database: the four migrations are additive, but their down migrations drop Website data. Do not run migration-down in production as a routine rollback. Restore the verified pre-change backup to a replacement database only for an approved disaster recovery.

## Troubleshooting and release gates

- Unknown host: verify wildcard DNS/Render host acceptance, `WEB_TENANT_HOST_SUFFIX`, and the API hostname resolver. Never add per-Company environment variables.
- Public 404: verify Website is published/enabled and the hostname maps exactly to that Company.
- `website_version_conflict`: reload the latest Website state and reapply the intended edit.
- Agent unavailable: verify server-side provider configuration and limits; do not expose keys or bypass the fallback.
- Custom domain pending: reconcile Cloudflare ownership and SSL independently, then verify Render/fallback-origin Host handling.
- Primary-domain redirect is not production-certified until an origin/edge HTTP redirect (preferably 308) is proven; an SPA-only redirect is insufficient.

Release requires two-Company adversarial tests, five-template desktop/mobile English/Arabic checks, tracking privacy, Agent injection/isolation, lifecycle/concurrency, operational-application regression, and live version confirmation. A missing real custom domain/Cloudflare test is reported as external infrastructure pending, never as a simulated pass.
