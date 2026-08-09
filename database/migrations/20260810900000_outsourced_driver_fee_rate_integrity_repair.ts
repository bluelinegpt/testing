import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Repairs orphaned outsourced-Driver fee accruals and closes the gap that
 * created them.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 *
 * `outsourced_driver_fee_versions` is effective-dated, and per
 * `Documentation/Payroll/PAYROLL_FOUNDATIONS.md`: "a rate used by an accrual is
 * immutable." `protect_outsourced_driver_fee_foundations` enforces exactly
 * that -- but only for `fee_per_order`, `driver_id` and `effective_from`. It
 * never protected `effective_to`.
 *
 * `WorkforceConfigurationService.syncOutsourcedDriverFeeVersion` narrows a
 * superseded version's `effective_to` to the day before the new version starts
 * whenever a Driver's fee is corrected. That narrowing never checked whether an
 * EXISTING accrual still depended on the wider window it was about to remove.
 * An accrual created while the old version was open-ended remained perfectly
 * valid at the time; a later correction could retroactively invalidate it
 * without anyone touching the accrual itself.
 *
 * ===========================================================================
 * THE REPAIR RULE -- DETERMINISTIC ONLY
 * ===========================================================================
 *
 * An orphaned accrual is repaired ONLY when the version it already references
 * priced it CORRECTLY (`fee_rate_snapshot = fee_per_order` on that same
 * version) and started on or before the accrual's own business date. That is
 * pure "the window closed under it" -- restoring the window to cover the
 * accrual's date changes NOTHING about the amount and requires no repricing.
 *
 * Any accrual whose referenced version's rate does NOT match its own snapshot
 * is a different, deeper kind of inconsistency and is deliberately left
 * untouched -- there is no safe automatic answer for "which rate was actually
 * right", and this migration does not guess.
 *
 * The window is extended to the LATEST business date among the version's own
 * dependent accruals, never further -- restoring exactly what was needed and
 * nothing more. A different, later version legitimately covering the same
 * calendar date (however briefly-lived) is not treated as a conflict: the
 * accrual's own `fee_rate_snapshot` is what the confirming trigger actually
 * matches against, so a same-day correction that was itself immediately
 * superseded creates no ambiguity for THIS accrual's validity.
 *
 * ===========================================================================
 * WHY A TRIGGER CHANGE, NOT JUST A SERVICE-LAYER CHECK
 * ===========================================================================
 *
 * The service layer gets an equivalent check in the same change (a clear,
 * specific `ApplicationException` instead of a raw constraint failure), but the
 * trigger is the one guarantee that survives every future caller -- a second
 * service, a script, a direct fix-up -- the way the rest of this table's
 * immutability already does.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  // --- 1. Repair: extend ONLY the deterministic, no-reprice-needed cases ----
  const repaired = await sql<{
    companyId: string;
    driverId: string;
    newEffectiveTo: string;
    oldEffectiveTo: string | null;
    versionId: string;
  }>`
    with orphaned as (
      select a.id as accrual_id, a.company_id, a.driver_id, a.fee_rate_version_id,
             a.accrual_business_date, a.fee_rate_snapshot,
             v.effective_from as v_from, v.effective_to as v_to, v.fee_per_order as v_amount
        from outsourced_driver_fee_accruals a
        join outsourced_driver_fee_versions v on v.id = a.fee_rate_version_id
       where a.status not in ('reversed','recovery_required')
         and not (
           v.effective_from <= a.accrual_business_date
           and coalesce(v.effective_to,'infinity'::date) >= a.accrual_business_date
         )
    ),
    safe as (
      select company_id, driver_id, fee_rate_version_id, v_to,
             max(accrual_business_date) as required_effective_to
        from orphaned
       where v_from <= accrual_business_date and v_amount = fee_rate_snapshot
       group by company_id, driver_id, fee_rate_version_id, v_to
    )
    update outsourced_driver_fee_versions target
       set effective_to = safe.required_effective_to,
           updated_at = now(),
           version = target.version + 1
      from safe
     where target.id = safe.fee_rate_version_id
    returning safe.company_id as "companyId", safe.driver_id as "driverId",
              safe.v_to as "oldEffectiveTo", safe.required_effective_to::text as "newEffectiveTo",
              target.id as "versionId"
  `.execute(database);

  for (const row of repaired.rows) {
    await sql`
      insert into audit_events (
        company_id, action, subject_type, subject_id, before_data, after_data,
        reason, correlation_id
      ) values (
        ${row.companyId}::uuid, 'outsourced_driver_fee_version.repair_effective_to',
        'outsourced_driver_fee_version', ${row.versionId},
        jsonb_build_object('effectiveTo', ${row.oldEffectiveTo}::text),
        jsonb_build_object('effectiveTo', ${row.newEffectiveTo}::text),
        'Repair orphaned outsourced Driver fee-rate reference',
        ${`migration:20260810900000:${row.versionId}`}
      )
    `.execute(database);
  }

  // --- 2. Prevention: extend the immutability trigger to cover effective_to -
  await sql`
    create or replace function protect_outsourced_driver_fee_foundations()
    returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        raise exception 'Outsourced Driver fee history cannot be deleted';
      end if;

      if tg_table_name = 'outsourced_driver_fee_versions' then
        if exists (
          select 1 from outsourced_driver_fee_accruals a
           where a.company_id = old.company_id and a.fee_rate_version_id = old.id
        ) and (
          new.fee_per_order is distinct from old.fee_per_order
          or new.driver_id is distinct from old.driver_id
          or new.effective_from is distinct from old.effective_from
        ) then
          raise exception 'Fee-rate versions used by an accrual are immutable';
        end if;
        /* The gap this migration repairs: narrowing effective_to used to be
           unchecked. A dependent accrual is any non-reversed accrual, on this
           SAME version, whose business date would fall outside the proposed
           window. */
        if new.effective_to is distinct from old.effective_to and exists (
          select 1 from outsourced_driver_fee_accruals a
           where a.company_id = old.company_id and a.fee_rate_version_id = old.id
             and a.status not in ('reversed','recovery_required')
             and a.accrual_business_date > coalesce(new.effective_to,'infinity'::date)
        ) then
          raise exception 'Narrowing this fee-rate version would leave an existing accrual without a valid rate for its business date';
        end if;
        return new;
      end if;

      if tg_table_name = 'outsourced_driver_fee_accruals' then
        if (
          new.company_id is distinct from old.company_id
          or new.driver_id is distinct from old.driver_id
          or new.order_id is distinct from old.order_id
          or new.fee_rate_version_id is distinct from old.fee_rate_version_id
          or new.fee_rate_snapshot is distinct from old.fee_rate_snapshot
          or new.earned_amount is distinct from old.earned_amount
        ) then
          raise exception 'Fee accrual source and earned snapshots are immutable';
        end if;
        if old.status in ('reversed','recovery_required') then
          raise exception 'Reversed or recovery-required fee accruals are immutable';
        end if;
        return new;
      end if;

      return new;
    end;
    $$;
  `.execute(database);
}

/**
 * Restores the pre-repair trigger definition only.
 *
 * The data repair is NOT reversed here. It corrected two already-accrued,
 * already-relied-upon financial records back to their originally-intended
 * validity; reversing it on a routine migration rollback would recreate the
 * exact defect this migration exists to close, for no operational reason. If a
 * true rollback of the repaired rows is ever needed, it must be a deliberate,
 * separately-authorized action, not an automatic `down()`.
 */
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function protect_outsourced_driver_fee_foundations()
    returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        raise exception 'Outsourced Driver fee history cannot be deleted';
      end if;

      if tg_table_name = 'outsourced_driver_fee_versions' then
        if exists (
          select 1 from outsourced_driver_fee_accruals a
           where a.company_id = old.company_id and a.fee_rate_version_id = old.id
        ) and (
          new.fee_per_order is distinct from old.fee_per_order
          or new.driver_id is distinct from old.driver_id
          or new.effective_from is distinct from old.effective_from
        ) then
          raise exception 'Fee-rate versions used by an accrual are immutable';
        end if;
        return new;
      end if;

      if tg_table_name = 'outsourced_driver_fee_accruals' then
        if (
          new.company_id is distinct from old.company_id
          or new.driver_id is distinct from old.driver_id
          or new.order_id is distinct from old.order_id
          or new.fee_rate_version_id is distinct from old.fee_rate_version_id
          or new.fee_rate_snapshot is distinct from old.fee_rate_snapshot
          or new.earned_amount is distinct from old.earned_amount
        ) then
          raise exception 'Fee accrual source and earned snapshots are immutable';
        end if;
        if old.status in ('reversed','recovery_required') then
          raise exception 'Reversed or recovery-required fee accruals are immutable';
        end if;
        return new;
      end if;

      return new;
    end;
    $$;
  `.execute(database);
}
