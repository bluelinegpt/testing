# Claude Code Instructions

Read `Documentation/CLAUDE_CODE_HANDOVER.md` before making changes.

This repository is BluelineGPT only. Do not introduce content or assumptions from another project.

The current Driver Cash Reconciliation phase has completed its required pre-execution review, but implementation is awaiting explicit approval of the business decisions listed in the handover. Do not modify reconciliation code or database objects until those decisions are approved.

Use these local ports:

- API: 3000
- Web: 5174

Do not use ports 5173 or 8787.

Never print or expose values from `.env` or `Bluelineconfig`.
