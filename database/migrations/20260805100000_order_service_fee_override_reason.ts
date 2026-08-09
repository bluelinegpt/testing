import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Persist the Service Fee override reason ON the Order.
 *
 * Until now the reason travelled only as far as the pricing-audit trail
 * (`resolveServiceFee` -> `overrideReason`). That records WHY a fee was
 * changed, but it does not let the Order screen answer the question an
 * Operator or auditor actually asks: "this Order has a zero Service Fee —
 * why?" The reason therefore belongs on the Order itself, not only in a
 * side table.
 *
 * It also closes a real gap in the existing rule. `resolveServiceFee` demands
 * a reason only when the applied fee DIFFERS from the configured price. If a
 * Trader/Area is priced at zero, entering zero is not an override, so no
 * reason was ever required — the exact case this policy exists to control.
 *
 * ---------------------------------------------------------------------------
 * HISTORICAL SAFETY
 * ---------------------------------------------------------------------------
 *
 * The constraint is added `NOT VALID` deliberately.
 *
 * `NOT VALID` means PostgreSQL enforces the rule on every INSERT and UPDATE
 * from this moment on, but does NOT scan the existing table. Orders already
 * carrying a zero Service Fee with no recorded reason therefore remain valid
 * and untouched — no backfill, no invented reasons, no rewriting of financial
 * history.
 *
 * Validation is deliberately deferred. Running `VALIDATE CONSTRAINT` later
 * would fail while any legacy zero-fee Order lacks a reason, and that failure
 * is the correct signal: it means those Orders must be reviewed by a person,
 * not silently amended by a migration. A future migration may validate this
 * constraint once the business has decided how to treat those rows.
 *
 * The check uses a strict numeric comparison (`= 0`), never a truthy test, so
 * `0.00` and `0` behave identically and NULL is handled explicitly.
 */

const columnAndConstraint = `
  alter table orders
    add column if not exists service_fee_override_reason text;

  comment on column orders.service_fee_override_reason is
    'Why the applied Service Fee differs from the configured price, or why it is zero. Mandatory whenever service_fee = 0.';

  alter table orders
    add constraint orders_zero_service_fee_reason_check
    check (
      service_fee is null
      or service_fee <> 0
      or (
        service_fee_override_reason is not null
        and btrim(service_fee_override_reason) <> ''
      )
    )
    not valid;
`;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql.raw(columnAndConstraint).execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  // The column is dropped last: the constraint depends on it.
  await sql
    .raw(
      `
      alter table orders drop constraint if exists orders_zero_service_fee_reason_check;
      alter table orders drop column if exists service_fee_override_reason;
    `,
    )
    .execute(database);
}
