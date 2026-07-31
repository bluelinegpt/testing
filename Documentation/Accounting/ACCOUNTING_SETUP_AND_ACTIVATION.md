# Accounting Setup and Controlled Activation

## Reused foundation

The Accounting Setup Wizard extends the existing Chart of Accounts, effective-dated mapping CRUD,
Fiscal Year and Period controls, Cash/Bank GL links, Opening Balance workflow, configuration
service, Automatic Posting service, permissions, idempotency records, and append-only audit
events. It does not create a parallel Accounting model.

## Deterministic mapping analysis

`GET /operations/accounting/setup/mapping-suggestions?effectiveOn=YYYY-MM-DD` evaluates the active
Company's Accounts using Account Type, Account Class, Posting/Summary status, active status,
control purpose, system status, hierarchy, normal balance, English and Arabic normalized names,
supporting code patterns, and existing mappings. No external AI service is used.

Candidates must first pass hard compatibility checks. Inactive, Summary, cross-Company,
wrong-Type, wrong-Class, and wrong-control-purpose Accounts cannot be accepted. Compatible
candidates receive a deterministic score:

- 45 points for passing the structural compatibility gate;
- 35 for an exact normalized synonym/name match or 22 for a partial match;
- 5 each for supporting System Account, Control Account, hierarchy, and code evidence.

High requires at least 85 without a close competing candidate, Medium requires at least 65, and
the remaining compatible candidates are Low. No compatible Account returns No Safe Suggestion.
Every confidence level requires explicit user confirmation. Nothing is auto-accepted.

Suggestion IDs are deterministic Company/key/date/Account hashes. Accept or Change regenerates
and validates the suggestion, then calls the existing mapping-creation service. Reject and Leave
Unresolved only add an audit decision. Existing mappings are never silently closed or changed.
Conditional roles may be marked Not Applicable with an audited reason; mandatory roles cannot.

The authoritative mapping list is in `accounting-setup.constants.ts` and uses actual operational
areas and mapping keys. Mandatory and conditional roles, expected Type/Class, mapping field,
control purpose, synonyms, and readiness impact are defined once. The issue endpoint reports
missing mappings, current/future gaps, overlaps, inactive Accounts, Summary Accounts,
incompatible Type/Class/control purpose, and expired mappings without mutating history.
Area readiness treats a conditional mapping as required only when current Company data shows that
the related VAT, Additional Fee, Bank Charge, or Cash/Bank classification is in use. Otherwise it
is reported as not currently applicable and does not silently become a mandatory blocker.

The repository's General Expense resolver already required an `accounts_payable` Control Account,
while the historical Chart-of-Accounts constraint did not permit that control purpose. The
additive setup migration aligns the constraint with the existing resolver; no historical migration
was edited.

## Zero Opening

`accounting_zero_opening_confirmations` stores one active Company confirmation with its effective
date, Fiscal Year, Fiscal Period, statement, reason, actor, timestamp, revocation metadata, and
version. Confirmation requires an Open/Reopened Year and Period and checks for Posted Opening
Balances, prior Posted/Reversed Journals, confirmed Cash/Bank opening movements, and prior
Accounting Events. It never creates a Journal, posts history, activates Accounting, or substitutes
for a real opening balance. Discovery of a blocker makes the confirmation invalid for readiness;
an authorized user can revoke it with an audited reason.

## Dashboard and area controls

The dashboard uses three bounded Company-scoped endpoints:

- `GET /operations/accounting/dashboard/actions`
- `GET /operations/accounting/dashboard/financial-snapshot`
- `GET /operations/accounting/dashboard/recent-activity`

Action counts are calculated by the backend, not from a paged UI. The financial snapshot uses only
Posted/Reversed Journal Lines according to Accounting Date and Account classification. A configured
classification with no ledger activity returns decimal string zero; missing classification returns
`null`/Unavailable. Open/Reopened Period values are Provisional. Recent activity is bounded to 50
and excludes raw Event payloads and sensitive Bank details.

Area readiness is exposed by
`GET /operations/accounting/setup/automatic-posting/areas`. Enabling or disabling an area changes
only that one area, requires explicit confirmation, reuses the current readiness service, audit,
and idempotency, and does not backfill or process history. Manual Accounting must already be
enabled.

## Activation

`POST /operations/accounting/setup/activation-preview` recomputes Chart, mandatory mappings,
Fiscal Period, Cash/Bank links, Opening/Zero Opening, and warning state from current server data.
It creates no Journal and changes no configuration.

`POST /operations/accounting/setup/activate-manual-accounting` locks the Company configuration,
re-evaluates readiness in the same transaction, checks warning acknowledgements, records activation
date/actor/time, enables Manual Accounting, explicitly leaves Automatic Posting disabled with an
empty area list, writes audit, and stores the idempotent response. It never backfills history.
The earlier `POST /operations/accounting/configuration/enable-manual-accounting` route remains as a
compatibility alias, but now accepts the same controlled activation contract and delegates to the
same readiness-checked service. The frontend no longer exposes a direct bypass action.

The controlled sequence after activation is: create, approve, and post one Manual Journal; verify
Trial Balance and Opening status; test one General Expense and payment; test one Cash/Bank
Movement; inspect Events and reconciliation; enable one ready Automatic Posting area; verify its
Journal; and test reversal. The UI says “ready for controlled testing,” never “Production Ready.”

## Permissions and cache

No permission keys or role grants were added. `accounting.view` reads setup/dashboard state;
`accounting.configuration.manage` runs analysis decisions, Zero Opening, activation, and area
changes; `users_roles.manage` remains the existing Administrator fallback. Frontend query keys
include Company identity and effective date. Successful mutations refresh setup, mappings,
dashboard, snapshot, activity, posting readiness, and completeness; Company switching clears
selection, previews, dialogs, and errors.

## Source-level status

This is source-level implementation only. The additive migration was created but not executed.
No tests, typecheck, lint, build, migration validation, database verification, or browser testing
was run. Manual Accounting and Automatic Posting were not enabled for any Company. Historical
backfill was not executed. Production readiness is not claimed.
