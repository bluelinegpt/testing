# Stage 6 Checkpoint — 2026-07-19

Development is **paused** at this checkpoint. The project moves to user-led
functional testing. No further code changes until consolidated feedback arrives.

**Stage 6 is NOT approved for closure.**

---

## 1. Recorded observations

### 1.1 CreateOrderDialog full-suite flake

| Field | Value |
| --- | --- |
| Status | **Open observation — currently not reproducible** |
| Full-suite diagnostic runs | **25 consecutive passes** (min 40,716 ms / max 51,872 ms / mean 43,937 ms) |
| Suspected cause | Scheduler starvation under heavy host contention |
| Confidence | **Unconfirmed** |
| Instrumentation | **Retained** to capture the next failure |

**The original flake is NOT claimed as resolved.**

Failure signature (from preserved logs): trader listbox open, zero options,
`No Traders found`, and **no** `Loading…` text. Because `setLoading(true)` runs
*inside* the debounce callback, its absence means the callback had not executed
and the request was never issued — consistent with a `setTimeout(0)` starved
past the 1000 ms `findByRole` window. On an idle machine that same gap measures
~507 ms, so the margin is thin. This is an inference, not evidence.

Corrected earlier claim: the "two mounted dialogs" reported previously was an
artifact. Both failure logs contain two `Ignored nodes` blocks — Vitest printed
the same DOM snapshot twice (inline + summary) and merged stdout/stderr made it
look like duplicated DOM. There was one dialog and one trader input.
`cleanupRanAfterPreviousTest=true` in every trace.

Also note: several original failures, including the run-3 one, occurred while
other work (greps, a `psql` command that hung for two minutes) competed for CPU.
The 25 clean runs had no concurrent work. That may be the whole story, or luck.

### 1.2 SearchCombobox stale-response guard

**Fixed and regression-tested.** A superseded search could overwrite newer
results, because `abort()` does not reject a response that has already resolved.
All state writes are now gated on `controller.signal.aborted`.

This was a genuine production defect, but it is **not** established as the cause
of the flake above — a failure occurred after the guard landed.

### 1.3 Print report Company identity

The print report currently renders the hardcoded fallback `"BluelineGPT"`, not
the real Company name. **An authoritative authenticated Company name is required
before final Stage 6 acceptance.**

No client-reachable endpoint exposes it today: `LoginResponse.identity` carries
only `companyId`, and `configuration/settings` has no name field. The approach is
confirmed but unimplemented — `settings()` in
`apps/api/src/company-configuration/company-configuration.service.ts:63` already
derives `companyId` from `tenants.current()`, so joining `companies` there gives
real identity with tenant isolation intact and no client-supplied Company ID.

---

## 2. Working-tree changes

The repository has **no commits**; all paths are untracked, so `git diff` shows
nothing. Files created or modified during the reconciliation phase:

### Database
- `database/migrations/20260718020000_driver_cash_reconciliation_integrity.ts`
- `database/migrations/20260718030000_reconciliation_expense_types.ts`

### API
- `apps/api/src/operations/driver-cash-reconciliation.service.ts` (authoritative service)
- `apps/api/src/operations/operations-history.writer.ts`
- `apps/api/src/operations/reconciliation-status.ts`
- `apps/api/src/operations/concurrency-harness.ts`
- `apps/api/src/platform/reconciliation-demo-seed.ts`
- `apps/api/src/platform/development-company-bootstrap.ts`
- Tests: `operations-history.regression.test.ts`, `reconciliation-http.database.test.ts`,
  `company-defaults.database.test.ts`, `reconciliation-demo-seed.database.test.ts`,
  `concurrency-isolation.test.ts`

### Web
- `apps/web/src/features/operations/DriverReconciliationWorkspace.tsx`
- `apps/web/src/features/operations/ReconciliationPrintReport.tsx`
- `apps/web/src/features/operations/DriverCashStatus.tsx`
- `apps/web/src/features/operations/useIdempotencyKey.ts`
- `apps/web/src/features/operations/OperationsWorkspace.tsx`
- `apps/web/src/components/SearchCombobox.tsx` (stale-response guard)
- `apps/web/src/styles.css` (print block rewritten)
- Tests: `ReconciliationPrintReport.test.tsx`, `ReconciliationList.test.tsx`,
  `DriverCashStatus.test.tsx`, `SearchCombobox.test.tsx`,
  `CreateOrderDialog.test.tsx` (**contains retained diagnostics**)

### Tooling
- `scripts/repeat-suite.mjs` (self-describing failure header, separate stderr capture)

---

## 3. Completed fixes

- **DEF-17 (partial)** — dedicated print report; portal-rendered document under
  `body > #print-root`, so print CSS hides the app structurally rather than via
  class-name selectors that previously matched nothing
- **DEF-07** — running summary with `data-running` attributes
- **DEF-11** — single-owner `blockedReasonKey` chain; `aria-describedby` on Confirm
- **DEF-12** — withdrawn; confirmed false positive (`Modal.tsx:86` sets `aria-label`)
- **SearchCombobox** — stale-response guard
- **Test harness** — failure preservation with full metadata

---

## 4. Test and repeat-run results

| Check | Result |
| --- | --- |
| Full web suite | **65 passed / 18 files** |
| Print report focused tests | **4 passed** |
| Web typecheck | **0 errors** |
| API typecheck | **0 errors** |
| Lint | **clean** |
| Web build | **succeeds** (chunk-size warning only) |
| CreateOrderDialog isolated | **20/20** (min 9,368 / max 12,922 / mean 11,210 ms) |
| Full suite, diagnostic | **25/25** (min 40,716 / max 51,872 / mean 43,937 ms) |
| New failure logs | **0** |

Mutation checks with real teeth:
- Print tests fail when the `data-print` attribute collision is reintroduced
- SearchCombobox regression test fails when the `aborted` guard is removed
- Diagnostic dump verified to fire on a forced failure

---

## 5. Open Stage 6 defects

| ID | Description | Status |
| --- | --- | --- |
| DEF-17 | Real Company identity in print report | **Open** — fallback in place |
| DEF-09 | Early Other-description validation (`aria-invalid`, `aria-describedby`) | Open |
| DEF-13 | View Details must navigate to the exact created record | Open |
| DEF-15 | Map server domain values to translation keys (Arabic) | Open |
| DEF-16 | Field-linked errors, page-level error summary, focus movement | Open |
| Scenario 5 | Filter-change selection behaviour | Open |

Deferred to later phases: login without Company selection / `GET /auth/companies`
exposure (DEF-05); admin override for all transitions with audit attribution;
VAT testing.

---

## 6. Unverified browser changes

**None of the corrective-cycle changes have been verified in a real browser.**
The authenticated session was destroyed by dev-server restarts, and web edits
trigger Vite HMR. Specifically unverified:

- DEF-07 running summary and DEF-11 blocked-reason chain in a live session
- Print preview via real `Ctrl+P` in **English**
- Print preview via real `Ctrl+P` in **Arabic / RTL**
- Save-as-PDF evidence

Original pre-fix evidence (19 screenshots) is preserved. **No after-fix evidence
exists yet.**

---

## 7. Print-report limitations

1. **Company identity is a hardcoded fallback** — see 1.3
2. Real browser print output is unverified; only jsdom-level structure is tested
3. Arabic print layout is untested in a browser (translations are unit-tested)
4. Earlier user feedback not yet re-validated: totals placement, alignment,
   congested data density, and the popup/wizard suggestion

---

## 8. DEV-DEMO database state

Verified read-only on 2026-07-19 against the development database.

| Metric | Value |
| --- | --- |
| Companies | 1 |
| Orders | 32 |

### REC-000001

| Field | Value |
| --- | --- |
| Status | `confirmed` |
| Gross collections | 102.25 |
| **Driver payable deduction** | **0.00** (approved rule holds) |
| Reconciliation expenses | 14.75 |
| Net amount received | 87.50 |
| Business date | 2026-07-18 |
| Orders covered | 2 |

### Remaining Pending Collection orders

| `driver_reconciliation_status` | `delivery_status` | Orders | Amount collected |
| --- | --- | --- | --- |
| `pending` | `delivered` | **30** | **1,685.75** |
| `reconciled` | `delivered` | 2 | 102.25 |

**30 delivered orders totalling AED 1,685.75 remain available for reconciliation
testing.**

---

## 9. Next actions (after user feedback)

1. Implement authoritative Company identity (DEF-17 completion)
2. Resume the flake investigation **only if it reproduces** with the retained diagnostics
3. DEF-09, DEF-13, DEF-15, DEF-16, Scenario 5
4. Browser re-verification with EN + AR print preview and after-fix evidence
5. Remove the CreateOrderDialog diagnostics once the flake is closed
