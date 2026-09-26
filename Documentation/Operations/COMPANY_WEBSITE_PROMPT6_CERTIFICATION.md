# Delivery Company Website Prompt 6 Certification

Date: 2026-08-28

## Architecture and scope

- The Company Website Agent reuses the server-side OpenAI Responses API client and the existing `OPENAI_API_KEY` / `OPENAI_AGENT_MODEL` configuration. A deterministic public-information provider remains available when OpenAI is absent, times out, or fails.
- Public identity and data scope come from the server-classified `companyslug.tawseelhub.com` hostname. Production does not accept the local tenant-host simulation header or logo query override.
- The model receives a dedicated public-safe object containing only published Company name, enabled services, enabled coverage, published hours/contact/about data, and public-function availability. It receives no Company, Order, Trader, Driver, customer, credential, or platform-network model.
- Pricing, tracking, service, coverage, hours, contact, handoff, internal-data, tenant-switch, and prompt-injection intents use deterministic boundary responses. The model cannot call the database or arbitrary tools.
- Tracking and delivery-request actions link visitors to the existing hostname-bound, validated public flows. The Agent does not directly query Orders and does not create an AI-only delivery-request path.

## Lifecycle and administration

- Agent configuration is part of `draft_settings` / `published_settings`; it includes enabled state, display name, EN/AR welcome messages, handoff message, and approved suggested actions.
- All saves use the Website `expectedVersion` optimistic-concurrency path. Publish atomically promotes the complete draft, including Agent configuration. Public requests read only `published_settings`.
- Preview Agent is authenticated under the Company Website management permission, reads the draft, is marked preview/noindex, and does not persist in public conversation history.
- Website and Agent enabled states are independent. A disabled/unpublished website returns no Agent endpoint.

## Conversations, abuse controls, and observability

- Public conversations use a random 256-bit opaque token stored only as a SHA-256 hash. Lookup is bound to token hash, hostname-resolved Company, website, and expiry.
- Conversations expire after 24 hours, retain only a short transcript, and allow at most 40 visitor messages. Input is capped at 1,000 characters; public start/message endpoints are throttled at 6/15 requests per minute.
- Model and output limits are server-controlled (default existing model, 400 output tokens, eight-second timeout, no browser SDK or API key).
- Logs record Company, website, latency, provider/model, and success without logging visitor message text or secrets.

## Schema

Migration `20260940000000_company_website_agent.ts` adds `company_website_agent_conversations` with Company/website foreign keys, token and optional IP hashes, language, bounded JSON transcript, message count, handoff state, source, expiry, and timestamps. No Company content is duplicated in the conversation table; public knowledge is derived from the current published Website document.

## Automated certification results

- Migration ordering: 187 migrations validated.
- API typecheck and production build: passed.
- Company Web typecheck and production build: passed. The Agent is emitted as a separate lazy-loaded chunk.
- Platform Web typecheck and production build: passed.
- API Agent/security/hostname/authorization/lifecycle/deletion-manifest/route-inventory: 82 tests passed.
- Public Website templates/functions/Agent: 19 tests passed.
- Platform Website Editor/Panel: 5 tests passed.
- `git diff --check`: passed (line-ending notices only).

## Dana manual acceptance matrix

Live manual acceptance is **pending** because this work has not been migrated or deployed, as required by the no-push/no-deploy instruction.

- `danaapp.tawseelhub.com`: login/logout and existing operations — pending live regression check; no authenticated Company-app routing code was changed by Prompt 6.
- `dana.tawseelhub.com`: template, branding, EN/AR RTL, services, coverage, tracking, request delivery, contacts, hours/map, Agent, and mobile viewport — automated coverage passed; live visual/functional check pending.
- Preview/publish/disable/re-enable — automated lifecycle/concurrency coverage passed; live state-transition check pending.
- Cross-host isolation and draft leakage — automated source/unit certification passed; live two-Company adversarial check pending.

## Release requirements

1. Back up and migrate Neon through `20260940000000_company_website_agent.ts`.
2. Deploy API, Company Web, and Platform Web to Render.
3. No Cloudflare or DNS change and no per-Company environment variable is required.
4. Confirm the three build-version badges, then execute the Dana matrix above with a second enabled Company for adversarial isolation.

Prompt 6 must not be labelled fully production-certified until those live acceptance items pass.
