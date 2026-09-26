# Tawseelhub Agent Core

## Scope

Prompt 6 adds one shared Tawseelhub Agent Core used by website chat and a WhatsApp-channel simulator. It does not add Salla, Shopify, WooCommerce, Storefront, individual courier integrations, final customer payment, or final Delivery Order creation.

## Architecture

- `apps/api/src/agent`: shared Agent Core, public endpoints, model-provider router, OpenAI provider, and deterministic safety/rules provider.
- Website Chat calls `POST /api/v1/public/agent/conversations` and `POST /api/v1/public/agent/conversations/:token/messages`.
- WhatsApp simulation calls `POST /api/v1/public/agent/whatsapp/simulate` and normalizes inbound sender/message IDs into the same core.
- Platform-only administration lives under `GET/PATCH/POST /api/v1/platform/agent/...`.

The Agent does not receive generic SQL access. It can only reach controlled server-side actions:

- customer quote through `CustomerQuoteService.create`
- Trader application through `TraderApplicationService.create`
- demo request through `DemoRequestService.create`
- handoff creation through `platform_agent_handoffs`
- published knowledge lookup through `platform_agent_knowledge`

## AI Provider Abstraction

`AgentModelProvider` defines intent classification and structured extraction. Runtime routing is centralized in `AgentModelRouterProvider`:

- Production requires a configured OpenAI provider unless `AGENT_MODEL_PROVIDER=deterministic` is explicitly set.
- Local development falls back to `RulesAgentModelProvider` only when OpenAI is not configured.
- Test runs remain deterministic.
- Explicit human/team/support requests are hard-routed to handoff before model routing, so handoff is not dependent on probabilistic classification.

`OpenAIModelProvider` uses the official OpenAI SDK and the Responses API with structured JSON output. It sends only the active message, language, previous intent, known conversation slots, and pending action type. It sets `store: false`, requests minimal reasoning, and never logs or exposes `OPENAI_API_KEY`.

Default model: `gpt-5-mini`, overridable with `OPENAI_AGENT_MODEL`.

## Supported Intents

- Customer package quote
- Trader application
- Delivery Company demo request
- General Tawseelhub questions
- Human handoff

## Conversation Model

Migration `20260828000000_tawseelhub_agent_core.ts` adds:

- `platform_agent_settings`
- `platform_agent_knowledge`
- `platform_agent_conversations`
- `platform_agent_messages`
- `platform_agent_actions`
- `platform_agent_handoffs`
- `platform_agent_handoff_history`

Conversations store an opaque public token hash, channel, language, current intent, state, linked business record IDs, and message history. Business records remain authoritative once created.

## Website Chat

The public widget is lazy-mounted after initial page content, supports English/Arabic foundation, uses RTL placement for Arabic, and masks the panel with `data-clarity-mask="true"`. The browser does not persist the conversation token in local storage. If the page reloads, a new secure guest conversation starts.

Opening message:

`Hi, this is Yousef, Tawseelhub AI Assistant. How can I help you today?`

Primary quick actions:

- Send a Package
- Register as Trader
- Delivery Company Demo
- Learn About Tawseelhub

## Platform Admin

`apps/platform-web/src/pages/AgentAdminPage.tsx` adds:

- Agent Conversations
- Agent Handoffs
- Agent Knowledge
- Agent Settings
- Runtime Diagnostics: provider type, configured state, model, last success, last safe error

Routes are gated by `platform.agent.read` and `platform.agent.manage`. Tenant users do not receive these permissions.

## Privacy and Safety

- Quote pricing comes only from the existing Quote Engine.
- Public quote responses expose no Delivery Company names, IDs, commission, or internal pricing rules.
- Trader conversations do not expose or search a public Delivery Company directory.
- Planned commerce integrations remain described as planned, not live.
- Analytics events use only safe metadata: channel, language, intent, page, and result category.
- Message text, names, mobile numbers, emails, addresses, quote tokens, references, and company names are not sent in analytics.
- Prompt-injection attempts are treated as user text; the action layer has no privileged directory or arbitrary-action endpoint to call.

## WhatsApp Status

No production WhatsApp Business or WhatsApp Web integration was introduced. Prompt 6 includes a development simulator channel that feeds normalized WhatsApp-like messages into the same Agent Core. Production connectivity remains blocked until the approved WhatsApp infrastructure and credentials are available.

## Verification

- Development DB backup: `backup/pre-agent-core-20260816.dump`
- Migration ordering: passed, 137 ordered migration files.
- Agent migration: applied and recorded as `20260828000000_tawseelhub_agent_core`.
- Public web typecheck: passed.
- OpenAI provider live smoke: passed with `gpt-5-mini` and structured JSON extraction.
- Direct public API route checks:
  - `POST /api/v1/public/agent/conversations`: 201, Yousef greeting, four quick actions.
  - `POST /api/v1/public/agent/conversations/:token/messages`: 201, live `customer_quote` intent.
  - Trader, Delivery Company demo, general Tawseelhub information, and handoff intent checks: passed.
- Public web route/proxy check: `http://127.0.0.1:5174/api/v1/public/agent/conversations` returned 201 through Vite.
- In-app browser check: `http://127.0.0.1:5174/` loaded current public site, chat launcher appeared, Yousef greeting/actions rendered, and a test package message returned a quote follow-up without leaking `Cannot POST`.
- API + public web typecheck: passed.
- Public web focused tests: 7 passed.
- Agent/provider and Platform permission tests: 22 passed.

Resolved corrective issues:

- `Cannot POST /api/v1/public/agent/conversations` was caused by stale runtime/app wiring during Prompt 6 verification. Current-source API maps `PublicAgentController`.
- `PublicAgentController` now uses explicit Nest injection for `AgentService`, matching repository controller patterns.
- Local Windows ACL issues in installed packages were repaired enough for API runtime/typecheck verification.
- Public widget now suppresses raw backend route errors and shows only the approved visitor-safe connection message.

Remaining unrelated local note:

- Platform web typecheck still has an existing `recharts` package-resolution issue outside Agent Core.

## Prompt 7 Conversational Intelligence Update

Prompt 7 corrected the first operational Agent issue: Yousef answered many normal visitor messages with the first static knowledge row, so greetings and small talk felt like canned FAQ responses.

Root cause:

- `AgentService.nextResponse` routed nearly every non-action intent to the general-question path.
- The general-question path selected published knowledge primarily by `sort_order`, so the first overview row repeatedly won.
- The deterministic classifier also let previous intents remain too sticky, so a later business question could inherit earlier small-talk or workflow context.

Changes:

- Added explicit conversational intents: greeting, small talk, thanks, goodbye, product-feature question, current-feature status, and clarification.
- Added UAE time-aware greetings through `greetingPeriod`, `englishGreeting(now)`, and `arabicGreeting(now)`. Greetings use `Asia/Dubai`, with morning, afternoon, evening, and overnight periods.
- Added context memory fields to Agent conversation state: `audience`, `discussedTopics`, and `lastBusinessIntent`.
- Added audience detection for Delivery Company, Trader, customer, and unknown visitors.
- Added topic memory for COD collections, payroll, accounting, reports, integrations, storefront, Trader registration, customer quotes, and Delivery Company operations.
- Added OpenAI-generated public replies through `AgentModelRouterProvider.generateReply`, using retrieved approved knowledge and safe fallback text.
- Kept deterministic routing for clear social/workflow/status/safety intents so OpenAI cannot accidentally convert a private-directory question into a quote, Trader, or demo flow.
- Updated prompt policy so Yousef is transparent as an AI assistant without repeating heavy “not a human” disclaimers unless relevant.
- Added a “no unsolicited handoff” rule for generated replies.

## Returning Quote and Price Question Corrective Pass

The Agent now classifies the current user turn before applying a workflow slot answer. Price questions, returning-quote decisions, clarifications, corrections, and “then/what next” messages are handled before slot filling.

Final delivery-address rule:

- Exact delivery address is optional for the initial quote because the current Quote Engine prices from pickup emirate/area, delivery emirate/area, package type, weight, service, quantity, and COD.
- The Agent may ask for an exact delivery address or nearby landmark after the core pricing fields, but it must clearly say this is optional and accept `skip`.
- Delivery-address clarifications keep the workflow on the delivery-address prompt and do not mark the field complete.

Returning active quote rule:

- When a mobile number matches an active customer quote, the Agent pauses the new shipment workflow and asks whether to continue that quote or start a new shipment.
- Price questions about an active quote read the current quote status and available offer amount from the database.
- A new shipment decision starts a fresh shipment workflow and reuses only identity/contact details, not the previous route/package/COD details.

Knowledge metadata:

- Migration `20260829000000_agent_conversational_knowledge.ts` adds `audience`, `feature_status`, and `visibility` to `platform_agent_knowledge`.
- Public retrieval filters to `visibility='public_agent'`.
- Internal-only rows are reserved for admin/team context and are not used in website replies.
- Feature status values are `live`, `planned`, `on_hold`, `future`, `internal_only`, and `informational`.
- Agent Admin can now create/edit knowledge with Audience, Feature Status, and Visibility.

Seeded/updated knowledge:

- Updated existing overview/privacy rows with metadata.
- Seeded 28 additional conversational knowledge entries covering:
  - Tawseelhub positioning
  - Delivery Company operations
  - Driver operations
  - COD and collections
  - Trader management and settlements
  - Accounting
  - Payroll
  - Reports and statements
  - Delivery Company growth model
  - Trader registration and Trader portal
  - Customer package quotes and custom quote cases
  - Salla, Shopify, and WooCommerce planned status
  - Tawseelhub Storefront on-hold status
  - Individual courier future roadmap
  - Private Delivery Company directory policy
  - Demo/contact handling
  - Arabic overview, COD, payroll, Shopify, and Storefront rows
  - One internal-only marketplace commercial-model row

Retrieval approach:

- Retrieves up to 80 published public-agent rows in the requested language plus English fallback.
- Scores rows by detected topic, user-message tokens, audience match, language match, and overview relevance.
- Sends the top 5 approved rows to OpenAI generation.
- Uses deterministic safe fallback for sensitive/status cases such as Shopify planned, Salla planned, WooCommerce planned, Storefront on hold, private directory refusal, and COD explanations.

Follow-up policy:

- Social replies do not force a sales question.
- Business replies usually ask one relevant next question based on audience and topic.
- Quote, Trader, demo, and handoff flows still collect only the business-service-required fields.

Validation on 2026-08-16:

- Migration ordering: passed, 138 ordered migration files.
- Agent conversational migration applied locally: `20260829000000_agent_conversational_knowledge`.
- Schema verification passed: 93 business tables, 130 hardening triggers, 73 integrity functions.
- Focused Agent tests passed: 24 tests across 4 files.
- API + public web typecheck passed: `tsc -b apps/api apps/public-web`.
- API live greeting: “Good evening, I’m Yousef, Tawseelhub AI Assistant...” at UAE evening time.
- API live English examples passed:
  - “How are you?” returns small talk, not a Tawseelhub overview.
  - “What is Tawseelhub?” returns a natural overview with a relevant follow-up.
  - “How does COD work?” returns COD-specific operational context.
  - “Do you support Shopify?” says Shopify is planned/not live.
  - “Can I create a store on Tawseelhub?” says Storefront is on hold.
  - “Can you show me your Delivery Companies?” refuses the public directory.
- API live Arabic examples passed:
  - “شو هو Tawseelhub؟” returns readable Arabic, not corrupted question marks.
  - “أنا عندي شركة توصيل وعندي ٣٠ سائق” routes to Delivery Company demo context.
  - “كيف ممكن يساعدني النظام في التحصيل؟” returns Arabic COD/collections guidance.
- Browser acceptance on `http://127.0.0.1:5174/` passed:
  - Public chat opens with the current UAE-time greeting.
  - “Do you support Shopify?” replies planned/not available in the widget.
  - “Can you show me your Delivery Companies?” replies that Tawseelhub does not expose a public Delivery Company directory.

Known limitations:

- Generated answer wording varies because OpenAI is used for normal business replies.
- Knowledge retrieval is intentionally lightweight keyword/topic scoring, not embeddings.
- Commerce integrations remain informational only; no Salla, Shopify, WooCommerce, Storefront, individual courier, payment, or final delivery-order booking integration was started.
