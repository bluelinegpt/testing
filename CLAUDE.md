# Claude Code Instructions

Read `Documentation/CLAUDE_CODE_HANDOVER.md` before making changes.

This repository is BluelineGPT only. Do not introduce content or assumptions from another project.

## Driver Cash Reconciliation hold

The current Driver Cash Reconciliation phase has completed its required pre-execution review, but implementation is awaiting explicit approval of the business decisions listed in the handover. Do not modify Driver Cash Reconciliation code or its related database objects until those decisions are approved.

Scope of this hold — it is not a global database freeze:

- It blocks **only** Driver Cash Reconciliation implementation and the database objects belonging to that phase.
- It does **not** block unrelated schema work, including Trader Commerce and Storefront work.
- Unrelated database work is still subject to its own safety gates: live-schema verification, a verified backup before any write, correct migration ordering, deterministic backfill, and hard validation before any column is made mandatory.
- Regardless of phase, do not change reconciliation, Orders, settlements, Journal Entries, Accounting, or `file_objects` as a side effect of unrelated work.

Use these local ports:

- API: 3000
- Web: 5174

Do not use ports 5173 or 8787.

Never print or expose values from `.env` or `Bluelineconfig`.
