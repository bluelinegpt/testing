import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Repair Center Phase 4, Prompt 2 -- ONE authoritative Accounting mode
 * timeline: "was GL Accounting required for Company X at timestamp T?"
 *
 * `accounting_enabled_at(company, at)` (20260984000000) answered from
 * `accounting_configuration_history` alone: the latest snapshot written at or
 * before T. The history writer fires on INSERT / UPDATE of
 * `accounting_configurations` only, so a configuration row that disappears
 * (no application path deletes one; only direct SQL or a whole-Company
 * deletion does) -- or a mode change written with triggers bypassed --
 * leaves the LAST snapshot reading ON forever. Company Health, Accounting
 * Health and every caller then believed Accounting was still ON.
 *
 * Rule (unchanged for every consistent Company):
 *
 *   - no snapshot at or before T                -> OFF (new Company default);
 *   - the snapshot in force at T says OFF       -> OFF;
 *   - it says ON and a LATER snapshot exists    -> ON (a closed, recorded
 *                                                  interval: legitimate
 *                                                  history is never erased);
 *   - it says ON and it is the LAST snapshot    -> ON only while the CURRENT
 *                                                  configuration row exists
 *                                                  and is ON. A missing row
 *                                                  means OFF now, and an
 *                                                  open-ended ON interval the
 *                                                  current state contradicts
 *                                                  is never extended over
 *                                                  activity it cannot prove.
 *
 * Boundaries: a snapshot is in force from its own `created_at` (inclusive),
 * so activity exactly at the enable instant is ON and exactly at the disable
 * instant is OFF.
 *
 * Signature, language and volatility are unchanged, so every existing caller
 * (Company Health, the Integrity Checker, Trader Credit capture, the expense
 * and cash-bank writers, cash-trail classification) gets the same answer as
 * Accounting Health. Additive and forward-only in effect; `down` restores the
 * previous body.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function accounting_enabled_at(target_company_id uuid, at_time timestamptz)
      returns boolean language sql stable as $$
      select coalesce((
        select (h.configuration_snapshot->>'accounting_enabled')::boolean
               and (
                 exists (select 1 from accounting_configuration_history later
                          where later.company_id = target_company_id
                            and later.configuration_version > h.configuration_version)
                 or coalesce((select c.accounting_enabled from accounting_configurations c
                               where c.company_id = target_company_id), false)
               )
          from accounting_configuration_history h
         where h.company_id = target_company_id and h.created_at <= at_time
         order by h.configuration_version desc
         limit 1
      ), false);
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function accounting_enabled_at(target_company_id uuid, at_time timestamptz)
      returns boolean language sql stable as $$
      select coalesce((
        select (h.configuration_snapshot->>'accounting_enabled')::boolean
          from accounting_configuration_history h
         where h.company_id = target_company_id and h.created_at <= at_time
         order by h.configuration_version desc
         limit 1
      ), false);
    $$;
  `.execute(database);
}
