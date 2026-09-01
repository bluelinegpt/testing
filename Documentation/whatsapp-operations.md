# WhatsApp Trader Notifications — Production Operations

Operational reference for the Delivery Company WhatsApp → Trader group
notification system (Prompts 1–5). Audience: whoever deploys, supports, or
rolls this feature out. The public Website Agent's Meta WhatsApp integration
is a completely separate system and is not covered here.

## Architecture at a glance

Everything runs inside the existing API process (`apps/api`):

- **Baileys sockets** — one per connected Company, keyed by `company_id`
  (`WhatsAppConnectionRuntime`).
- **Startup restoration** — runs in the background ~5s after boot; API health
  never waits for it; one broken Company session never affects others.
- **Outbox dispatcher** (`WhatsAppOutboxDispatcher`) — drains
  `whatsapp_message_outbox` every 5s with `FOR UPDATE SKIP LOCKED` claiming,
  a per-Company claim cap of ONE plus a 10-second minimum gap between a
  Company's consecutive sends (anti-burst pacing, approved 2026-09-01: a bulk
  status change drains ~6 messages/minute per WhatsApp account instead of a
  burst; other Companies flow independently), bounded backoff (1m/5m/15m/1h, max 5
  attempts), a 10-minute processing lease, a 24h pending-age cutoff, and a
  supersession check (a stale order-status message whose Order already has a
  newer eligible status event is cancelled, not sent).
- **Durable state** — everything lives in Postgres. Session auth state is
  AES-256-GCM encrypted (`encrypted_session_state`); the key exists ONLY in
  the environment. No filesystem, no Chromium, no browser.

## Horizontal scaling restriction (critical)

**The WhatsApp-owning service must run exactly ONE instance.** Two instances
would open competing Baileys sockets for the same Company (WhatsApp treats
that as a replaced connection and both flap). The dispatcher's SKIP LOCKED
claiming is multi-worker-safe, but sends go through in-process sockets, so
sends on a non-owning instance would all fail.

- Do not enable autoscaling / more than 1 instance for the API service while
  WhatsApp runs inside it.
- `WHATSAPP_RUNTIME_ENABLED=false` disables the sockets, restoration, and
  dispatcher on an instance. It exists so a future topology (e.g. a dedicated
  WhatsApp worker + N stateless API instances) can be configured without code
  changes. There is no reliable runtime signal on Render to auto-detect
  multi-instance misconfiguration, so this is an operational rule, enforced
  by documentation and the env guard — not pretended to be self-healing.
- Long-term, if the API must scale horizontally, move the runtime +
  dispatcher to a dedicated single-instance worker service first.

## Environment variables (production)

| Variable                          | Required              | Meaning                                                                                                                                                                               |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHATSAPP_SESSION_ENCRYPTION_KEY` | Yes (for the feature) | Base64 of exactly 32 random bytes; encrypts per-Company session auth state at rest. Without it, connecting fails safely and restoration is skipped — nothing falls back to plaintext. |
| `WHATSAPP_RUNTIME_ENABLED`        | No (default enabled)  | Set `false` only on an instance that must not own WhatsApp sockets.                                                                                                                   |

Generate the key locally (never in a shared terminal/log):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Add it in Render → the API service → Environment → `WHATSAPP_SESSION_ENCRYPTION_KEY`.
Never commit it, never echo it into logs, never reuse it across environments.

**If this key is lost**, existing encrypted sessions can never be decrypted:
every Company must reconnect by QR. Nothing else is lost — mappings, history
and pending intents are plaintext-safe rows and survive.

Operational tuning (dispatcher interval, retry schedule, attempt cap,
processing lease, age cutoff, per-Company claim cap, supersession grace) is
deliberately NOT env-configurable — the constants live in one place,
`WHATSAPP_DISPATCH_POLICY` (`apps/api/src/whatsapp/whatsapp-outbox-dispatcher.service.ts`),
and change through code review.

## Session encryption key rotation plan

Current format: each stored blob is `v1:<iv>:<tag>:<ciphertext>`
(`WhatsAppSessionCipher`). The `v1:` prefix is the version hook.

To rotate without forcing QR re-pairing:

1. Introduce `WHATSAPP_SESSION_ENCRYPTION_KEY_PREVIOUS` alongside a NEW
   `WHATSAPP_SESSION_ENCRYPTION_KEY`.
2. Extend the cipher: encrypt always with the current key (bump the prefix to
   `v2:` if the algorithm ever changes; for a pure key swap `v1` stays);
   decrypt tries the current key first, then the previous key.
3. On successful decrypt-with-previous, re-encrypt with the current key and
   persist (opportunistic re-wrap — every restore/auth-update naturally
   rewrites the blob, so rotation completes organically; a one-off re-wrap
   script is optional).
4. Once no blob decrypts with the old key (or after all Companies have
   reconnected at least once), remove `_PREVIOUS`.

Rollback: keep the old key available until step 4; rolling back the code
before step 4 loses nothing because `v1` blobs written with the new key would
need the new key — so never delete a key that any live blob may still be
encrypted with. Emergency path if a key is compromised: rotate immediately
WITHOUT the previous-key fallback and accept that every Company re-pairs by
QR (sessions become undecryptable, which is exactly the point).

This plan intentionally is not implemented yet — the current architecture
(versioned format, single write path in `BaileysSessionStore`) supports it as
a small additive change when rotation is actually scheduled.

## Deploy restart vs user Disconnect

- **Process shutdown (deploy/restart/SIGTERM)**: dispatcher stops claiming;
  sockets are closed with `end()` — never `logout()`; encrypted auth is left
  intact; connection rows are NOT marked disconnected. Next boot restores
  sessions from the database without QR. (Test-proven.)
- **User clicks Disconnect**: intentional `logout()` (device unlink), auth
  state cleared, row marked `disconnected/user_disconnected`, audited. Trader
  mappings and message history always survive both.

In-flight sends interrupted by a hard kill are recovered by the processing
lease as `requires_review` (outcome unknowable — never blind-resent).

## Render deployment checklist

Before deploy:

- [ ] All WhatsApp commits pushed (`0d2431d`, `fa794db`, `d50a593`, `579b999`, Prompt 5).
- [ ] **Migration state audited**: every locally-applied migration is
      committed. Known risk on this branch: `20260952000000_link_generated_
cash_movements_to_owner_events.ts` (unrelated work) has been applied to
      the local DB but was untracked — it MUST be committed by its owner
      before any Render deploy, or the deploy fails on missing-migration.
- [ ] `pnpm migrations:validate` green; `pnpm --filter @blueline/api db:verify` green.
- [ ] Full API/web gates reviewed (pre-existing unrelated failures documented).
- [ ] `WHATSAPP_SESSION_ENCRYPTION_KEY` set in Render (API service).
- [ ] API service is a **paid, always-on** plan (a spun-down/free service
      drops sockets and stops the dispatcher; ~512MB+ memory recommended).
- [ ] Instance count = 1 confirmed; autoscaling off.
- [ ] Neon production DB backup confirmed.
- [ ] Pilot rollout plan agreed (below).

Deploy:

- [ ] Apply migrations (existing deploy flow), deploy API + web.
- [ ] `/api/v1/health` healthy (does not wait on WhatsApp).
- [ ] Logs show startup restoration ran (or no sessions to restore); no
      QR/session content in logs.
- [ ] Do NOT mass-enable Traders — every mapping stays an intentional action.

After deploy:

- [ ] Connect ONE pilot Delivery Company by QR (Configuration → WhatsApp).
- [ ] Map ONE pilot Trader to a test group; send a test message.
- [ ] Run one real status change on a disposable Order; watch the operations
      panel (Message Delivery counts, message table, attempt history).
- [ ] Expand Trader-by-Trader, then Company-by-Company.

## Rollback / feature disable

Order operations never depend on WhatsApp — the hook only writes a local
outbox row, and eligibility fails closed. To disable the feature without
touching Orders:

1. Disable notifications per Trader (UI), or leave them — with the runtime
   disabled nothing sends.
2. Set `WHATSAPP_RUNTIME_ENABLED=false` on the API service and redeploy /
   restart: sockets stay closed, dispatcher never starts, pending rows simply
   remain durable (they age into `requires_review` after 24h — expected).
3. Do NOT delete outbox/attempt/history rows — they are the audit record.
4. Sessions stay encrypted at rest; unlink devices from the phones only if
   security requires it.
5. Full code rollback: revert the app deploy; the WhatsApp schema is additive
   and inert without the feature code.

## Rollout strategy

- **Stage 1**: one internal/test Delivery Company, test group, disposable
  Orders (the §39–49 certification script).
- **Stage 2**: one real pilot Delivery Company, a handful of Traders, watched
  daily via the operations panel.
- **Stage 3**: Company-by-Company expansion. Never auto-enable Traders.

## Manual certification status

The full real-WhatsApp certification (QR pairing, group discovery, live test
message, automatic status messages, disconnect/queue/reconnect, restart
restore, device revocation, group removal, duplicate protection — Prompt 5
§40–48) is **pending**: it requires a disposable WhatsApp account scanning a
QR from a running instance, which the automated environment cannot do.
Everything up to the physical scan is covered by the guarded test suites.
Record evidence per §49 (ids, timestamps, provider message ids — never QR or
session content) when it is performed.

## Platform Administration controls (per Company)

Platform Administration > Company > WhatsApp tab (permission
`platform.company_whatsapp.manage`, granted to the Platform Super
Administrator role):

- **Enable / Disable** — the per-Company kill switch
  (`company_whatsapp_platform_settings`; absence of a row means ENABLED).
  Disabling is a full stop: no new outbox intents are written, the dispatcher
  never claims the Company's parked pending rows, test messages and
  connect/QR are refused (`whatsapp_disabled_by_platform`), and the Company
  portal shows a "disabled by Platform Administration" banner. The paired
  session, Trader mappings and history are KEPT, so re-enabling restores
  service without re-scanning a QR code. An optional reason is shown to the
  Company while disabled.
- **Message templates** — per-status overrides
  (`company_whatsapp_message_templates`) of the built-in bilingual
  order-status wording. Placeholders: `{{orderNumber}}`,
  `{{referenceNumber}}`, `{{status}}`, `{{date}}`, `{{companyName}}`.
  A status with no override renders the built-in default. Outbox bodies are
  snapshots: edits shape FUTURE messages only, history is never rewritten.
  "Reset to default" deletes only that one Company+status override row (see
  the reviewed exemption in `platform-security-certification.test.ts`).
- **Message history** — the Company's full outbox (order-status and test
  messages) with totals (sent/pending/failed), an inclusive from/to date
  filter evaluated on Asia/Dubai dates, and the rendered body per message.

Every control writes an `audit_events` row
(`platform.company_whatsapp.enabled_changed` / `template_updated` /
`template_reset`).
