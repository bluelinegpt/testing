# Order Reference Number and Zero-Value Order Policy

Covers two related pieces of Order behaviour delivered in Prompts 1A, 1B, 1B-1, 1B-2 and 1B-3:

1. Searching Orders by the Trader's own **External Reference Number**.
2. What happens when an Order carries **no money** — a zero Service Fee, and the
   wider question of whether the Order belongs in the ledger at all.

---

## 1. External Reference Number search

`orders.reference_number` holds the Trader's own identifier for a shipment. It is
free text, not unique, and frequently the only number a Trader can quote when
they call.

**Where it is searchable:** the Orders list and the Orders CSV export, via the
`referenceNumber` filter on `OperationsOrderFilters`. Matching is
case-insensitive and partial (`ilike`).

**Why a dedicated filter and not a general `search` parameter:** the global
`ValidationPipe` runs with `forbidNonWhitelisted: true`
(`apps/api/src/bootstrap/create-application.ts`). Any query parameter that is not
declared on the DTO is rejected with a 400 before the handler is reached. A
filter has to be declared to exist.

**Where it is displayed:** as its own column in the Orders list and its own row
on the Order detail screen. Orders without one show the localized
"Not provided" — never a blank cell, which reads as a rendering fault.

---

## 2. Zero-value Orders

### 2.1 The problem

Two different things were both called "a zero", and treating them the same broke
in both directions.

- A **zero Service Fee** is a pricing decision. It may be an exceptional
  concession that somebody must justify, or it may be the Trader's ordinary
  contracted price.
- A **zero-value Order** is an Order with no financial substance at all. Raising
  an Accounting Event for one produces a Journal with nothing in it, or a
  failure, because a Journal with no lines cannot balance.

### 2.2 Fee Source — why a Service Fee is what it is

| Fee Source | Meaning | Reason required? |
| --- | --- | --- |
| **Configured Price** | The Trader/Area price was applied unchanged. | No |
| **Manual Override** | Somebody applied a fee different from the configured price. | **Yes** |
| **Zero Configured Price** | The Trader/Area is priced at zero and no fee was requested. | No — a system explanation is recorded instead |

The distinguishing test is **whether the zero was requested**, not whether the
final fee happens to be zero:

```
requestedZero = a fee was supplied AND it is zero
```

- `requestedZero` → a reason is mandatory (`service_fee_zero_reason_required`),
  and `orders.override_service_fee` remains the authoritative permission gate.
- Configured zero, nothing requested → ordinary pricing. The Order records the
  system marker `Configured Trader/Area price is zero`.

**This distinction is what keeps Trader mobile working.** The mobile client sends
no Service Fee and has no field for a reason. If the reason were demanded
whenever the final fee is zero, every Order against a zero-priced Area would be
rejected. It is also why the marker is *system-generated* and never presented as
a user's words — nobody made an exceptional decision, so nobody's justification
should be invented.

Fee Source is **derived**, not stored. There is no `fee_source` column and none
is needed: the persisted reason already distinguishes all three cases. Orders
created before `service_fee_override_reason` existed report `Configured Price`,
which is the honest answer for a row whose origin was never recorded.

Implementations:
- `orderFeeSource()` — `apps/api/src/operations/order-accounting-classification.ts`
- `orderFeeSource()` — `apps/web/src/features/operations/order-accounting-policy.ts`

### 2.3 Persistence and the historical constraint

`orders.service_fee_override_reason` (migration
`20260805100000_order_service_fee_override_reason`) holds the reason on the Order
itself, not only in the pricing audit trail, so the Order screen can answer
"this fee is zero — why?" without a join.

```sql
check (
  service_fee is null
  or service_fee <> 0
  or (service_fee_override_reason is not null
      and btrim(service_fee_override_reason) <> '')
)
not valid
```

`NOT VALID` is deliberate. PostgreSQL enforces the rule on every insert and
update from that point on but does **not** scan the existing table. Orders
already carrying a zero fee with no reason stay valid and untouched — no
backfill, no invented reasons, no rewriting of financial history.

Validation is deferred on purpose. Running `VALIDATE CONSTRAINT` would fail while
any legacy zero-fee Order lacks a reason, and that failure is the correct signal:
those rows need a person to review them, not a migration to quietly amend them.

### 2.4 Accounting Required / No Accounting Required

An Order is **No Accounting Required** only when *all four* of these are zero:

```
|COD| + |Service Fee| + |Additional Fees| + |VAT|  =  0
```

Both zero COD and zero Service Fee is **necessary but not sufficient**. An Order
with neither can still carry Additional Fees or VAT, and suppressing its Event
would lose real revenue recognition.

`abs()` is applied per component, not to the sum, so a positive and a negative
can never cancel out and disguise real money as nothing. Comparison is a strict
numeric `<> 0` against `coalesce(..., 0)` — never a truthy test — so `0`, `0.00`
and `NULL` behave identically.

**The rule is enforced in one place: the capture trigger.**
`capture_order_accounting_event` (migration
`20260805110000_order_capture_skips_zero_value_orders`) is the single gate every
delivered Order passes through. Spreading the check across the writer, the
processor and the posting service would give four chances to disagree.

The **reversal branch is intentionally ungated**.
`enqueue_operational_accounting_event` already returns early when a reversal
finds no original Event, and a zero-value Order never created one. A second
guard would be redundant and would risk the two drifting apart.

### 2.5 Accounting Status on screen

| Status | Shown when | Meaning |
| --- | --- | --- |
| **Not Applicable** | no financial substance | No Event will ever exist. An empty Accounting panel is correct. |
| **Pending Delivery** | real money, not yet `delivered` | Capture has not fired yet. |
| **Recorded in Accounting** | real money, delivered | An Event should exist. |

`Recorded in Accounting` is a claim about what *should* be there, not proof that
it is. The Accounting Event remains the source of truth; this only tells the
reader whether an absence is normal.

Where it appears:
- **Orders list** — a dedicated *Accounting* column between Delivery Status and
  Financial Status.
- **Order detail** — *Accounting* and *Accounting Status* rows in the Financial
  Status section; *Fee Source* and *Service Fee Reason* in Financial Details.

When the API does not return `accountingRequired` — an older build, or a payload
predating the field — the UI renders **nothing** rather than guessing. Showing
"No Accounting Required" for a value nobody supplied would be a confident answer
to an unanswered question.

### 2.6 Related Records must not offer broken links

A No Accounting Required Order has no Event and no Journal by design. The
Accounting Related Records panel is therefore **replaced**, not merely emptied,
by a plain statement of why there is nothing to show. An empty panel reads as a
missing record, and any link it offered would fail to resolve.

`showsAccountingRelatedRecords()` —
`apps/web/src/features/operations/order-accounting-policy.ts`.

### 2.7 Zero amounts display as `AED 0.00`

A valid zero is a fact, not a missing value. `formatCurrency` renders `0` as
`AED 0.00` with no special-casing, and the Order screens pass amounts through it
directly. Dashes are reserved for genuinely absent data.

### 2.8 Audit trail

| Event type | Written when | Category |
| --- | --- | --- |
| `order.service_fee_override` | the applied fee differs from the configured price | `financial_change` |
| `order.zero_service_fee` | the fee is zero and it is **not** an override | `financial_change` |

The second is a separate event type on purpose. Filing a configured zero price
under `order.service_fee_override` would misattribute ordinary pricing to a
person's decision. Both carry the previous and new fee and the recorded reason.

---

## 3. Where the rule lives

| Concern | File |
| --- | --- |
| Authoritative Event-capture rule | `database/migrations/20260805110000_order_capture_skips_zero_value_orders.ts` |
| Reason column and `NOT VALID` constraint | `database/migrations/20260805100000_order_service_fee_override_reason.ts` |
| Zero-fee policy, reason persistence | `apps/api/src/operations/operations.service.ts` (`resolveServiceFee`) |
| Backend classification, shared by every query | `apps/api/src/operations/order-accounting-classification.ts` |
| Frontend labels and panel visibility | `apps/web/src/features/operations/order-accounting-policy.ts` |
| Order list and detail rendering | `apps/web/src/features/operations/OrdersModuleWorkspace.tsx` |
| Labels (EN/AR) | `apps/web/src/localization/resources/{en,ar}.ts` |

The frontend deliberately does **not** recompute the money rule. The API returns
`accountingRequired`; the browser only chooses a label. Recomputing it in two
languages is how a UI ends up disagreeing with its own database.

---

## 3a. Creation-source matrix

Every Order in the system is inserted by `insertOrder`, and every fee is decided
by `resolveServiceFee`. There is no second pricing path, and no source can opt
out of the policy.

| Source | Endpoint | Authenticated as | Fee supplied by client? | Zero-fee reason in request? | Manual override possible? |
| --- | --- | --- | --- | --- | --- |
| Operator web (single) | `POST operations/orders` | Account, `orders.create` | Optional | Yes | Yes, with `orders.override_service_fee` |
| Operator API (direct) | same endpoint | same | Optional | Yes | Identical — there is no separate API path |
| Operator web (fast entry) | same endpoint, one call per row | same | Optional | Yes | Same rules |
| Bulk CSV import | `POST operations/orders/import-csv` | Account, `orders.create` | Optional column | Optional column | Yes, with the same permission |
| Trader portal / mobile | `POST operations/trader/orders` | Trader session (`RequireIdentityKinds("trader")`) | **No — stripped server-side** | **No — stripped server-side** | **No** |
| Trader portal edit | `PATCH operations/trader/orders/:id` | Trader session | **No — stripped** | **No — stripped** | **No** |
| Order quote (preview) | `POST operations/orders/quote` | Account | Optional | Yes | Preview only; creates nothing |

**Trusted source is derived server-side, never sent.** The Trader endpoints are
gated by identity kind and the Trader is resolved from the session profile. No
request field names a role, a source or a trust level, and none would be believed
if it did.

---

## 3b. Trader mobile

`CreateTraderPortalOrderDto` is derived from the Operator DTO and therefore
inherits `serviceFee` and `serviceFeeOverrideReason`. Both are now **stripped in
`createTraderPortalOrder` before the request reaches `createOrder`** — the same
treatment `traderId` already received, and for the same reason: pricing is the
Company's decision, not the Trader's.

Stripped, not rejected. An existing mobile build that still sends the fields keeps
working; the values are simply ignored and the Order is priced from the
authoritative Trader/Area table. **No mobile release is required**, and no new
mandatory request field was introduced.

Consequences:

- A **configured zero price succeeds** for Trader mobile with no reason demanded.
  The system explanation is recorded server-side.
- A Trader **cannot** apply a manual Service Fee, cannot override configured
  pricing, and cannot reach the manual-fee path at all.
- A Trader **cannot fabricate** the system marker (see below).
- COD = 0 is accepted, as it always was.
- The create response carries `accountingRequired` and `serviceFeeOverrideReason`
  as additive fields. Older clients ignore unknown keys.

**Behaviour change worth noting:** previously a Trader could supply a fee for an
Area with no configured price, and it was accepted. That path is now closed — such
a request fails with `pricing_not_configured`, which is the correct outcome (the
Company must price the Area) but is a change in observable behaviour for any
Trader operating against an unpriced Area.

### The marker cannot be spoofed

Fee Source is derived from the stored reason, so accepting the marker string from
a client would let any caller make a manual override present itself as ordinary
configured pricing. `resolveServiceFee` **discards** a caller-supplied reason that
equals the marker: it is not a user's reason, so the correct reading is "no reason
was given". A manual zero then fails the normal reason check with the normal
message, and a genuine configured zero has the marker re-applied by the server.

### Zero fee on an unpriced Area now requires the override permission

The manual-fee branch runs when no configured price exists at any level. There is
nothing to override, so `overrideApplied` is false and the permission gate never
fired — yet a zero fee is exactly the decision that gate exists to control. The
check is now explicit for that case.

Deliberately limited to zero. Entering a **non-zero** fee for an unpriced Area
remains open to any User who can create Orders; that is the existing approved
behaviour and was not changed.

---

## 3c. Bulk CSV import

### Contract (after this phase)

| Column | Required | Notes |
| --- | --- | --- |
| `serialNumber` | Yes | |
| `traderId` | Yes | UUID |
| `customerName`, `customerMobileNumber`, `customerAddress` | Yes | mobile must match `9715XXXXXXXX` |
| `codAmount` | Yes | `0` valid; blank is an error, not a zero |
| `serviceFee` | **No — changed** | blank means "use configured pricing" |
| `serviceFeeOverrideReason` | **No — new** | required when `serviceFee` is `0` |
| `referenceNumber` | No | preserved as text |
| `areaId`, `driverId`, `additionalFees`, `packageCount` | No | |

There is **no** Emirate, service-type or preferred-delivery-date column, and there
was none before; the import addresses an Area directly by `areaId`.

**What was actually there before:** `serviceFee` was a *required* column and there
was no reason column at all. Every imported Order therefore supplied an explicit
fee, and an imported zero fee against a priced Area threw
`service_fee_override_reason_required` — aborting the entire file with a message
that never said which row caused it. That is the concrete gap this phase closes.

Making `serviceFee` optional is backward compatible: existing files that carry the
column behave exactly as before.

### Zero-value behaviour

- **COD `0`** — valid, imports normally.
- **COD blank** — a row error. `Number("")` is `0`, so blank is checked against the
  raw text, never the parsed number; a forgotten cell must not become a legitimate
  zero-COD Order.
- **COD negative or non-numeric** — row errors, separately worded.
- **`serviceFee` blank** — configured Trader/Area pricing is resolved. A configured
  zero imports normally with the system explanation recorded and no reason
  demanded.
- **`serviceFee` explicitly `0`** — an explicitly imported zero is a *requested*
  zero, so it is a manual override: it requires a reason in the row and the
  importing User must hold `orders.override_service_fee`.

### Where each rule is enforced

The **reason** check is a row-level parse check — no database access, so every bad
row in the file is reported at once.

The **permission** check is *not* duplicated in the parser. `resolveServiceFee`
holds the single gate and already receives the importing User's real permissions
via `this.identities.current()`. Copying it into the parser would create two places
that could disagree about who may do this.

### Row-level results

`OperationsOrderImportResult` gained an additive `rows` array — `errors` is
unchanged and remains the summary, so an older client renders exactly as before.
Each entry carries: row number, Reference Number, status, resolved Service Fee, Fee
Source, zero-fee reason, Accounting Requirement, error field and a friendly error
message.

Error messages are written for people. A mid-import failure is re-thrown with the
row number and Reference Number attached; only an `ApplicationException` message is
reused, because anything else may name a table, a constraint or a query. The
original is preserved as `cause` for the log. **No SQL, stack trace or constraint
name reaches the user.**

Reference Numbers are read as raw text and never through `Number()`, so leading
zeros survive: `0042` stays `0042`.

### Atomicity — unchanged

The import was atomic and **remains atomic**. Validation runs entirely before the
transaction opens: if any row fails, nothing is written and every failing row is
reported together. A failure during insertion re-throws and rolls the whole batch
back rather than leaving a partial import behind.

Duplicate protection is unchanged: `assertOrderIdentifiersAvailable` rejects a
duplicate Serial or Reference Number, so resubmitting the same file does not create
a second set of Orders.

**There is no preview endpoint.** Validation blockers are returned by the import
call itself, which for an atomic import means the same information arrives one step
later than a dedicated preview would provide it. See Known gaps.

---

## 3d. Audit by source

| Source | Event | Attribution |
| --- | --- | --- |
| Operator web/API manual zero | `order.service_fee_override` | actor, configured fee, applied fee, user reason, permission-authorized |
| Operator web/API configured zero | `order.zero_service_fee` | actor, configured fee, applied fee, system explanation |
| Bulk import | `order.import_create` per row, plus the fee event above | importing actor, import number, Order number |
| Trader mobile configured zero | `order.zero_service_fee` | Trader session actor, configured fee zero, system explanation |

A configured zero is **never** recorded as a user override. The two event types
exist precisely so the audit does not attribute an ordinary price list to a
person's decision.

---

### No Accounting Required Orders in Delivery Activity

A delivered Order classified **No Accounting Required** remains fully visible in
the Orders Delivery Activity view.

- Its zero monetary values are valid data and display as `AED 0.00`.
- Its Accounting Status shows **Not Applicable**.
- It exposes **no** Accounting Event or Journal link, because neither exists —
  there is nothing broken to click.
- Inclusion in Delivery Activity depends on `orders.delivered_at`, **not** on
  accounting impact. A delivery happened; whether it moved money is a separate
  question.

---

## 4. Known gaps

Two areas were explicitly **not** examined and are scheduled for a following
phase:

- **No import preview endpoint.** Blockers are returned by the import call itself.
  Because the import is atomic nothing is written when it fails, so this is a
  usability gap rather than a correctness one, but a dedicated preview would let an
  importer check a file without submitting it.
- **Import authorization failures are batch-fatal.** A row whose zero fee the
  importing User is not permitted to apply aborts the whole file with a
  row-attributed message. That is correct for an atomic import, but it means such a
  file is fixed one authorization error at a time unless a preview is added.
- **The Order quote endpoint does not return `accountingRequired`.** The Create
  Order form therefore cannot show "No Accounting Required" before submission.
  Additive and straightforward, but out of scope for this phase.
- **The Flutter client was not opened or changed.** Compatibility is argued from the
  server contract — the mobile request is ignored where it oversteps, and no new
  mandatory field was added — not from running the app.
- **Behaviour change:** a Trader can no longer supply a fee for an Area with no
  configured price. Such requests now fail with `pricing_not_configured`.

No migration was created or executed in this phase, and the two migrations this
policy depends on remain unexecuted. No historical Order has been read, backfilled
or amended. No real Order, Accounting Event or Journal was created. No runtime,
browser, mobile or database verification was performed, and production readiness is
not claimed.
