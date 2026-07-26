# Migration Policy

This directory contains reviewed PostgreSQL migrations created after new-schema design was
explicitly authorized on 2026-07-13.

Migration files must be immutable after shared use, reviewed with the related requirement IDs, tested against PostgreSQL, and accompanied by a safe correction or rollback plan. Destructive operations require explicit approval.

Current order:

1. `20260713230000_core_tenancy_security.ts`
2. `20260713230010_delivery_operations.ts`
3. `20260713230020_finance_accounting.ts`
4. `20260713230030_scope_and_financial_hardening.ts`
5. `20260713230040_authentication_sessions.ts`

The baseline has no destructive down migration. Use a forward correction migration if an
applied object must change.
