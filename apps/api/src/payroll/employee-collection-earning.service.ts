import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

type Database = Kysely<DatabaseSchema>;

/** How the collected-Order count was arrived at. */
export type CollectionCountSource = "auto_from_orders" | "manual";

/** One confirmed collection, as Payroll will later read it. */
export interface EmployeeDriverCollectionFact {
  readonly businessDate: string;
  readonly collectedOrderCount: number;
  readonly countSource: CollectionCountSource;
  readonly countsForCollectionEarning: boolean;
  readonly driverId: string;
  readonly employeeId: string;
  readonly id: string;
  readonly reconciliationId: string;
}

/** What the reconciliation knows at the moment it is confirmed. */
export interface CollectionFactInput {
  readonly businessDate: string;
  readonly confirmedAt?: string;
  /** The operator's decision. Absent or false records a non-counting fact. */
  readonly countsForCollectionEarning: boolean;
  readonly driverId: string;
  /** Operator-entered count, used only when no Order links are available. */
  readonly manualOrderCount?: number | undefined;
  /** Authoritative Order links from the reconciliation, when it has them. */
  readonly orderIds?: readonly { readonly id: string; readonly orderNumber: string }[];
  readonly reconciliationId: string;
}

/**
 * Records what happened at a confirmed Driver Collection, for Payroll.
 *
 * ---------------------------------------------------------------------------
 * THIS SERVICE PRICES NOTHING
 * ---------------------------------------------------------------------------
 *
 * There is no rate lookup here and no amount anywhere in what it writes. A
 * Driver Collection is a cash-handling operation; deciding what someone's
 * compensation is worth is Payroll's job, and putting that decision inside a
 * reconciliation would scatter the rule across two screens that can then
 * disagree.
 *
 * So this captures the FACT -- who, which collection, which date, how many
 * Orders, and whether the operator marked it as counting -- and stops. Payroll
 * multiplies it by the effective rule later.
 *
 * The counterpart to this asymmetry is that `EmployeeDeliveryEarningService`
 * DOES snapshot money: a delivery has an unambiguous rate at an unambiguous
 * instant, so freezing it there is what protects history. Collections have no
 * such moment, and their history is protected by the allocation columns instead.
 *
 * ---------------------------------------------------------------------------
 * A NON-COUNTING COLLECTION IS STILL A FACT
 * ---------------------------------------------------------------------------
 *
 * When the operator leaves the box unticked a row is still written, with
 * `counts_for_collection_earning = false` and a zero count. "We looked and
 * decided this one does not count" and "nobody considered it" are different
 * things, and only the first one is auditable.
 */
@Injectable()
export class EmployeeCollectionEarningService {
  public constructor(
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
  ) {}

  /**
   * Record the collection fact for one confirmed reconciliation.
   *
   * Returns `null` when the Driver is not an employee Driver — outsourced
   * Drivers are compensated through their own fee-accrual flow, and writing a
   * Payroll fact for them would set up the same work to be paid twice under two
   * models. That is an ordinary outcome, not a failure.
   *
   * Idempotent on `(company_id, reconciliation_id, employee_id)`: a retried
   * confirmation returns the existing fact rather than adding a second one or
   * counting the same Orders again. The guarantee is the constraint, not a
   * prior read — check-then-insert would still race.
   */
  public async captureForConfirmedCollection(
    database: Database,
    input: CollectionFactInput,
    actorId: string,
  ): Promise<EmployeeDriverCollectionFact | null> {
    const { companyId } = this.tenants.current();
    const employeeId = await this.employeeDriver(database, companyId, input.driverId);
    if (employeeId === null) return null;

    const { count, source } = this.resolveCount(input);

    const inserted = await sql<EmployeeDriverCollectionFact>`
      insert into employee_driver_collection_facts (
        company_id, employee_id, driver_id, reconciliation_id, business_date,
        confirmed_at, counts_for_collection_earning, collected_order_count,
        count_source, created_by_account_id
      ) values (
        ${companyId}::uuid, ${employeeId}::uuid, ${input.driverId}::uuid,
        ${input.reconciliationId}::uuid, ${input.businessDate}::date,
        -- The column is NOT NULL and the caller's timestamp is optional, so the
        -- moment of capture stands in when it is absent. Inside the confirming
        -- transaction the two are the same instant.
        coalesce(${input.confirmedAt ?? null}::timestamptz, now()),
        ${input.countsForCollectionEarning},
        ${count}, ${source}, ${actorId}::uuid
      )
      -- Already captured for this reconciliation and Employee. A no-op UPDATE of
      -- a conflict-target column so the EXISTING row is returned: DO NOTHING
      -- returns nothing, which a caller cannot tell apart from "not an employee
      -- Driver". Nothing about the stored fact changes -- a confirmed collection
      -- is immutable, and a retry must not restate it.
      on conflict (company_id, reconciliation_id, employee_id)
        do update set reconciliation_id = employee_driver_collection_facts.reconciliation_id
      returning id, employee_id as "employeeId", driver_id as "driverId",
                reconciliation_id as "reconciliationId",
                business_date::text as "businessDate",
                counts_for_collection_earning as "countsForCollectionEarning",
                collected_order_count as "collectedOrderCount",
                count_source as "countSource",
                (xmax = 0) as "isNew"
    `.execute(database);
    const fact = inserted.rows[0];
    if (fact === undefined) return null;

    // Order links only for a fresh, auto-counted fact. Re-linking on a retry
    // would be a no-op thanks to the unique constraint, but skipping it keeps
    // the immutability rule literal: a confirmed fact is never rewritten.
    const isNew = (fact as unknown as { isNew: boolean }).isNew;
    if (isNew && source === "auto_from_orders" && (input.orderIds?.length ?? 0) > 0) {
      for (const order of input.orderIds ?? []) {
        await sql`
          insert into employee_driver_collection_fact_orders (
            company_id, fact_id, order_id, order_number
          ) values (
            ${companyId}::uuid, ${fact.id}::uuid, ${order.id}::uuid, ${order.orderNumber}
          )
          on conflict (company_id, fact_id, order_id) do nothing
        `.execute(database);
      }
    }
    return fact;
  }

  /**
   * The count, and where it came from.
   *
   * Order links win whenever the reconciliation has them: they are the
   * authoritative record of what was collected, and a typed number that
   * disagrees with them would be a silent correction of the reconciliation
   * itself. The manual path exists only for collections that carry no links.
   */
  private resolveCount(input: CollectionFactInput): {
    readonly count: number;
    readonly source: CollectionCountSource;
  } {
    if (!input.countsForCollectionEarning) {
      // The schema requires zero here: a non-counting collection must not carry
      // a number that a later reader could mistake for something payable.
      return { count: 0, source: "auto_from_orders" };
    }
    const linked = input.orderIds?.length ?? 0;
    if (linked > 0) return { count: linked, source: "auto_from_orders" };

    const manual = input.manualOrderCount;
    if (manual === undefined || !Number.isInteger(manual) || manual < 1) {
      throw new ApplicationException(
        "collection_order_count_required",
        "Enter the number of Orders collected, or untick the collection earnings option",
        HttpStatus.BAD_REQUEST,
      );
    }
    return { count: manual, source: "manual" };
  }

  /**
   * The Employee behind this Driver, or null when there is not one.
   *
   * Only `driver_type = 'employee'` resolves. Outsourced Drivers deliberately
   * return null rather than throwing: asking is a normal question.
   */
  private async employeeDriver(
    database: Database,
    companyId: string,
    driverId: string,
  ): Promise<string | null> {
    const result = await sql<{ employeeId: string | null }>`
      select case when driver_type = 'employee' then employee_id else null end as "employeeId"
        from drivers
       where id = ${driverId}::uuid and company_id = ${companyId}::uuid
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException("driver_not_found", "Driver not found", HttpStatus.NOT_FOUND);
    }
    return row.employeeId;
  }
}
