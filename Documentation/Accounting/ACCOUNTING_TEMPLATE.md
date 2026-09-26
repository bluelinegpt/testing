# BluelineGPT Accounting Templates

Status: **Export, validation and import implemented.** Sections 1-11 describe
the exporter and are unchanged; section 12 covers the importer added by Platform
Portal Phase 1, Prompt 3.

Artefact: `apps/api/resources/accounting-templates/uae-delivery-standard-v1.json`

| | |
| --- | --- |
| templateCode | `UAE_DELIVERY_STANDARD` |
| templateVersion | 1 |
| schemaVersion | 1 |
| sha256 | `2d66f8ee57cc17ce732a2ee3158f8e40131b8e815dfa9355ff13551070e06581` |
| exported from | Dana Delivery Services (development Company, after its controlled reset) |

---

## 1. What a template is

A template describes **how a Company posts**, never **what it has posted**. It
holds a Chart of Accounts, the automatic-posting mappings that drive it, the
named account slots the Accounting engine resolves, and the small set of
defaults a new UAE delivery Company should start from.

It holds no balance, no journal, no accounting event, no order, customer,
trader, driver or employee, and no opening balance. `openingBalances` exists in
the format for one reason: so the file can state, explicitly and checkably, that
it is empty.

## 2. Why templates cannot use database identifiers

This is the single most important property of the format, and the reason the
whole thing exists rather than a `pg_dump` of a few tables.

A template that carried the source Company's account UUIDs could only be loaded
into a database where those exact rows already existed. It would not be a
template; it would be a backup of one Company. So every relationship —
mapping → account, Cash account → GL account, child account → parent account,
expense category → mapping — is expressed as a **stable template key**, and the
validator fails the file if any UUID-shaped string, or any field named like an
identifier, appears anywhere in it.

A new Company generates its own identifiers on import and is completely
independent of the source Company afterwards. Nothing about loading a template
requires the source Company to exist, or to have ever existed.

## 3. How stable keys work

Account keys are **derived**, not hand-written, by a pure function in
`accounting-template.keys.ts`. Hand-maintained keys would drift from the Chart
of Accounts they name, and the drift would only surface when a new Company was
initialised with a mapping pointing at nothing.

The rule is `<ACCOUNT_TYPE>_<ACCOUNT_CLASS>` with one simplification and one
tie-break:

- **Simplification.** A class that merely repeats its own type is redundant, so
  a leading or trailing segment equal to the type word is dropped:
  `expense` + `driver_expense` → `EXPENSE_DRIVER`, `revenue` +
  `delivery_revenue` → `REVENUE_DELIVERY`. Only the *type* word is stripped —
  `vat_payable` keeps `payable`, giving `LIABILITY_VAT_PAYABLE`.
- **Tie-break.** Where two accounts share a class, **every** member of that
  class is suffixed with its account code, not just the later one. Suffixing
  only duplicates would mean an account's key changed the day a sibling was
  added, and a key that moves is not a stable key.

In v1 that produces one suffixed pair, because the source Chart of Accounts
classifies both `1110 Input VAT Receivable` and `1120 Other Receivable` as
`other_receivable`:

```
1110  ASSET_OTHER_RECEIVABLE_1110   Input VAT Receivable
1120  ASSET_OTHER_RECEIVABLE_1120   Other Receivable
```

`ASSET_OTHER_RECEIVABLE_1110` is less readable than `ASSET_VAT_INPUT` would be,
but it is what the source Company's own `account_class` says. Inventing a
tidier classification would mean the template no longer described the Company it
was exported from. If a clearer key is wanted, the fix is to reclassify the
account in the Chart of Accounts and re-export.

**Mapping keys are kept verbatim.** `delivery_revenue`, `trader_payable` and the
rest are the strings the posting engine looks up by name. Renaming them into a
prettier convention would silently break every posting rule on import.

## 4. What the template contains

| Section | Content |
| --- | --- |
| `accounts` | 27 accounts — code, EN/AR name, type, class, normal balance, parent **key**, posting/active/contra/control/system flags, control type, currency, description |
| `accountMappings` | 31 automatic-posting mappings, each with up to six account **keys** (debit, credit, VAT, fee, expense, payable) |
| `accountingConfiguration.standardDefaults` | Accounting on/off, automatic posting on/off, base currency, fiscal year start month, accounting method, segregation policy, automatic-posting areas |
| `accountingConfiguration.defaultAccountKeys` | The engine's 15 named account slots, as keys |
| `accountingConfiguration.companyDecisions` | Field **names** a new Company must decide — deliberately carrying no values |
| `balancePolicy` | Cash and bank negative-balance policy, overdraft limit, override permission |
| `defaultCashAccounts` | Code, name, type, GL **key**, currency — plus the fields a Company must supply |
| `defaultBankAccounts` | Code, shape, GL **key**, currency — **no bank identity at all** |
| `businessDay` | Timezone and start time, as a default the Company may override |
| `fiscalPolicy` | Start month, period model, periods per year, timezone — **policy, never dated periods** |
| `expenseTypes` | 5 reconciliation expense types |
| `generalExpenseCategories` | 1 category, pointing at a mapping **key** |
| `allowanceTypes` | 2 payroll allowance types |
| `referenceNumberPrefixes` | 17 document prefixes — **prefixes only, no counters** |
| `openingBalances` | Always `[]` |
| `requiredCompanyInputs` | 10 fields a new Company must supply |
| `excludedFromTemplate` | 12 documented exclusions with reasons |

## 5. What it excludes, and why

Recorded in the file itself under `excludedFromTemplate`, so the reasoning
travels with the artefact. In summary:

- **All transactional tables.** Orders, customers, traders, drivers, employees,
  journals, accounting events, settlements, collections, reconciliations,
  payroll, expenses, cash/bank movements, batch and recovery execution history.
- **Opening balances.** The source Company currently holds two validated
  opening balance batches totalling AED 30,000 across four lines. None of it is
  in the template. A new Company establishes its own.
- **Dated fiscal years and accounting periods.** Cloning them would hand a
  Company created in 2027 a calendar belonging to 2026, and every period-open
  check would refuse its first posting. Only the fiscal *policy* is reusable.
- **Bank identity** — bank name, account name, account number, IBAN, SWIFT.
  Commercially sensitive and specific to one Company. These fields are **omitted
  from the format entirely** rather than blanked, so there is no field for one
  Company's banking details to hide in.
- **Cash custodian and location** — names a physical office of the source
  Company.
- **Reference counter `next_value`.** A watermark counting the source Company's
  documents. Prefixes are reusable; every new sequence starts at 1.
- **Effective-from dates** on accounts and mappings — the source Company's
  adoption dates.
- **`accounting_configuration_history`** and the actor/reason columns on the
  configuration — an audit trail of one Company's changes.
- **Payment methods.** Audited and found *not* to be Company configuration:
  they are code-level enumerations enforced by CHECK constraints (for example
  `cash`/`visa` on driver collections). There is no per-Company payment-method
  table, so there is nothing to carry.
- **Areas and Emirates.** Operational geography, not Accounting setup. Emirates
  are global reference data; Areas have their own import tool.
- **Identity and security data.** Accounts, roles, permissions, sessions, audit
  events.

## 6. Determinism and the template hash

Running the exporter twice against unchanged configuration produces **byte-identical**
output. Collections are emitted in a fixed order (accounts by code, mappings by
mapping key, everything else by code), object keys are sorted, and there is no
`exportedAt`, no run identifier and no random value anywhere in the format — so
the question of excluding volatile fields from the hash never arises.

The file on disk **is** the canonical form, which means:

```bash
sha256sum apps/api/resources/accounting-templates/uae-delivery-standard-v1.json
```

reproduces the template hash exactly, with no BluelineGPT code involved. A hash
that could only be recomputed by re-running the exporter would be far weaker
evidence of what a Company was initialised from.

## 7. How to regenerate or version

Export (read-only; the source Company is never modified):

```bash
pnpm --filter @blueline/api accounting:template:export -- --company-id <uuid> --output resources/accounting-templates/uae-delivery-standard-v1.json
```

Verify the committed file still matches the Company, without rewriting it:

```bash
pnpm --filter @blueline/api accounting:template:export -- --company-id <uuid> --check
```

`--check` exits non-zero if the file is missing or out of date, so "is this
template still current?" is a question a build can answer.

**Versioning.** `templateVersion` is bumped and a **new file** is written; an
existing version is never edited in place, because a Company may have been
initialised from it and the recorded hash must keep resolving to the bytes that
were actually used. `schemaVersion` changes only when the *format* changes, and
the validator's supported-version set gates it. Changing the source Company's
configuration and re-exporting changes the hash — that is the point.

## 8. How to validate

- `validateAccountingTemplate(candidate)` in
  `apps/api/src/accounting-template/accounting-template.validator.ts`.
- The exporter runs it **before writing**, so a template that would be rejected
  on import never reaches disk.
- The importer, when built, must run the same function before loading anything.

It checks metadata and supported version; unique account keys and codes; valid
account types and normal balances; control accounts declaring a control type;
every `parentAccountKey` existing, no self-parent, no hierarchy cycle; every
mapping slot resolving to an exported account; no mapping referencing nothing at
all; every named account slot, Cash/Bank GL key and expense-category mapping key
resolving; business-day and fiscal-policy shape; **no database identifier
anywhere**; **no transactional or balance-bearing field anywhere**; and
`openingBalances` present and empty.

## 9. Zero-balance guarantee

Loading this template can only produce a Company with zero opening balance, zero
journal balance, zero accounting events, zero trader payable, zero driver
balance, zero payroll balance and no revenue or expense history — because the
template contains no amount of any kind. There is no field in the format capable
of carrying one, and the validator rejects any that appears.

## 10. Tests

`pnpm --filter @blueline/api test:accounting-template` — 62 tests, no database
required: key derivation, exclusion rules, ordering and determinism, hash
stability, CLI guards, the full validator rejection matrix, and assertions
against the committed artefact itself.

`RUN_ACCOUNTING_TEMPLATE_DATABASE=true pnpm --filter @blueline/api test:accounting-template:database`
— read-only against the real source Company: it is the Company that was asked
for, an unknown Company is refused, PostgreSQL itself refuses a write inside the
export transaction (SQLSTATE `25006`), the real bank identity does not travel,
opening balances exist in the database but not in the template, two exports are
identical, the committed file is current, and a fingerprint over the Company's
setup and transactional tables is unchanged afterwards.

## 11. Built since

The importer now exists — see section 12. It also generates the new Company's own
fiscal year and accounting periods from the template's fiscal policy.
`requiredCompanyInputs` are still collected after onboarding rather than during
it: a bank's real details are needed before the bank is used, not before the
tenant exists.

---

## 12. The importer (added in Platform Portal Phase 1, Prompt 3)

The exporter is unchanged. Its determinism, canonical hash, stable keys,
exclusion rules and no-UUID guarantee are exactly as documented above; nothing in
this section alters them, and the exporter was not turned into an importer.

`AccountingTemplateImporter` (`apps/api/src/accounting-template/accounting-template.importer.ts`)
applies an approved template to a **newly created** Company.

**Approved registry.** `accounting-template.registry.ts` is the only way a
template is loaded. A caller names a template by CODE and VERSION; the file name
comes from the catalogue, never from input. Four gates run in order: the
code/version pair must be approved, the file must parse, its canonical hash must
match the **pinned** hash, and it must pass `validateAccountingTemplate` — the
same function the exporter runs before writing.

The hash pin is why a version alone is not enough. The exporter is a command
anyone can run, so a regenerated v1 could otherwise initialise Companies
differently while every record still said `UAE_DELIVERY_STANDARD v1`. Changing
the file legitimately means changing the pinned constant in the same commit.

**Stable-key resolution.** The Chart of Accounts is created first, building a
runtime map from template key to the new account id. Every mapping slot, every
named configuration slot and every Cash/Bank GL link resolves through that map.
Template keys are never persisted in place of foreign keys.

**Never owns the transaction.** The caller passes one in; the importer only
returns or throws. A failure therefore removes the Company row too.

**`verifyImport`** runs before the caller may commit: expected row counts, every
mapping resolving to an account owned by this Company, named slots resolved
where the template fills them and left empty where it does not, Cash/Bank GL
links intact, reference counters at 1, and zero opening balances, journals,
accounting events, cash/bank movements, expenses and orders.

**The fiscal calendar is generated, not copied.** The template carries policy
only; the importer derives the fiscal year that CONTAINS the new Company's start
date and creates twelve monthly periods from it, all at `future`. Opening a
period is an accounting decision with a posting consequence and is left to the
Company.

**The business-day start may be overridden** by the Platform Administrator at
creation. Omitting it applies the template default, which is what a template
default is for.

**Two schema rules worth knowing.** Automatic posting is imported as OFF —
`accounting_configurations_automatic_shape_check` requires an accountable
Company user to enable it, and none exists at creation time; the template's
chosen areas are still carried. And `created_by_account_id` is left empty on
every setup row, because those columns are composite foreign keys to
`accounts(id, company_id)` that a Platform Administrator cannot satisfy; the
Platform audit trail records who acted.

Full detail: `Documentation/Architecture/PLATFORM_ADMINISTRATION_PORTAL.md` §19.
