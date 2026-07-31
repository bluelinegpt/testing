# Bank and Cash Management

Accounting Prompt 5 adds Company-owned Cash and Bank account masters and a controlled operational
movement ledger. It reuses the existing Accounting module, Chart of Accounts, Company Bank Account,
Fiscal Period, Accounting Event, Journal, reference-counter, idempotency, audit, attachment,
permission, and durable retry infrastructure. Trader beneficiary Bank Accounts remain a separate
subledger concept.

## Account masters

`company_bank_accounts` is extended additively. `company_cash_accounts` is new because no equivalent
Company Cash master existed. Every active master is Company-scoped, AED-only, effective-dated, and
linked to one active posting GL Account. Cash masters require an Asset/Cash Account; Bank masters
require an Asset/Bank Account. Dependency queries protect deactivation when draft movements or an
active Accounting configuration still references the master.

No permissions are introduced or granted. The routes reuse `accounting.view`,
`accounting.manage`, `accounting.approve`, `accounting.reverse`,
`accounting.configuration.manage`, `accounting.post`, and the existing administrator fallback.

## Movements

Movement references are allocated once, at persistent draft creation, through the atomic
Company reference counter and use `CBM-000001`. Supported types are Cash/Bank deposits and
withdrawals, Cash-to-Bank, Bank-to-Cash, Bank-to-Bank, and Cash-to-Cash transfers. Opening Balance
movement confirmation is deliberately blocked: opening values must use the approved Opening
Balance Batch and Journal workflow.

The database enforces the permitted source/destination shape. Confirmation additionally locks the
selected financial accounts in deterministic order, checks an open Fiscal Period, revalidates
effective active masters and mapping uniqueness, derives the source balance, includes fees in the
required outflow, and rejects insufficient Cash or Bank balances. There is no mutable authoritative
balance column and no overdraft model.

Operational balances are derived from posted Opening Balance Journal Lines plus confirmed movement
history. A reversed original and its confirmed linked reversal are both retained in history; their
net effect is zero. Cashbook and Bank-ledger queries expose the chronological inputs needed to
calculate running balances from the same foundations.

Manual deposits and withdrawals require one of the approved explicit mapping keys. Unsupported
classifications are rejected at DTO/database boundaries, and missing or overlapping effective
mappings block confirmation. General Expenses, Payroll, Trader Settlements, Driver Collections,
and Outsourced Driver payments continue to own their existing money movements; this module does not
recreate those transactions.

Internal transfers debit the destination linked GL Account and credit the source linked GL Account.
The principal arrives intact. A fee is a separate debit to the effective Bank Charge mapping and a
separate credit to the source account.

## Lifecycle, accounting, and recovery

Drafts may be edited or cancelled. A cancelled draft has no financial effect. Confirmation makes
financial facts immutable and creates a durable Accounting Event. Reversal requires a reason and
open period, creates a separately numbered opposite Movement, and creates a reversal Event linked to
the original Event. The existing Journal engine creates and links the separate reversal Journal.
Unique movement, idempotency, Event identity, and reversal constraints protect retries and
concurrency.

The practical segregation rule is used: the creator may confirm only when no other authorized
approver is available; the creator/confirmer may reverse only when no other authorized reverser is
available. This permits a single-user Company to operate. The administrator permission fallback
participates in determining whether an alternate authorized actor exists; it does not bypass the
segregation check.

Automatic posting remains disabled by default and was not enabled for any Company. Readiness checks
Accounting enablement, AED base currency, an open period, all required classification and Bank
Charge mappings, and active financial masters with valid linked posting GL Accounts. Accounting
failures remain durable in the existing Event queue and are visible/reprocessable through the
existing Accounting integration routes.

The reconciliation query compares operational movements, Events, and Journals. Historical backfill
is preview-only and never writes Events or Journals. Bank statement import and full Bank
reconciliation are deferred.

## API

The route root is `/operations/accounting/cash-bank`.

- Cash masters: `GET/POST /cash-accounts`, `PATCH /cash-accounts/:id`,
  `GET /cash-accounts/:id/dependencies`, `POST /cash-accounts/:id/{activate|deactivate}`,
  and `GET /cash-accounts/:id/ledger`.
- Bank masters: `GET/POST /bank-accounts`, `PATCH /bank-accounts/:id`,
  `GET /bank-accounts/:id/dependencies`, `POST /bank-accounts/:id/{activate|deactivate}`,
  and `GET /bank-accounts/:id/ledger`.
- Movements: `GET/POST /movements`, `GET/PATCH /movements/:id`,
  `GET /movements/:id/validate`, and
  `POST /movements/:id/{confirm|cancel|reverse|attachments}`.
- Operations: `GET /summary`, `GET /balances`, `GET /reconciliation`, and
  `POST /reconciliation/preview-backfill`.

File upload and download continue through the existing File infrastructure; movement attachment
rows retain immutable file metadata snapshots.

## Deferred

Accounting UI, Cashbook/Bank report PDFs, Bank statement import, full Bank reconciliation,
historical backfill execution, Supplier AP, financing, cheque management, financial reports,
period-closing Journals, year-end Journals, and multi-currency are outside Accounting Prompt 5.

No tests, typecheck, lint, build, migration validation, database verification, browser testing,
migration execution, or commit was performed.
