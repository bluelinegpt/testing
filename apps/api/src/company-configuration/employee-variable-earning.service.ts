import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

/** One dated rule, delivery or collection, as the Employee screen shows it. */
export interface VariableEarningRule {
  readonly amount: string;
  readonly createdAt: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly id: string;
  readonly isActive: boolean;
  readonly isCurrent: boolean;
  readonly paymentType?: string;
}

export interface VariableEarningRules {
  readonly collection: readonly VariableEarningRule[];
  readonly delivery: readonly VariableEarningRule[];
}

export const collectionPaymentTypes = ["none", "per_collected_order"] as const;

/**
 * Employee Driver variable earnings — the management surface for rules that
 * Payroll already consumes.
 *
 * ---------------------------------------------------------------------------
 * A NEW RATE IS A NEW ROW, NEVER AN EDIT
 * ---------------------------------------------------------------------------
 *
 * Both rule tables carry a gist exclusion constraint forbidding overlapping
 * periods for one Employee, so "change the rate to 3" cannot mean UPDATE. It
 * means: end the rule in force on the day the new one starts, then insert the
 * new one. That is what keeps history honest — the old rate is still there,
 * still readable, and still the rate that priced everything before the change.
 *
 * Delivery earnings depend on this literally: `employee_order_earnings` stores
 * the `rule_id` that produced each snapshot, so mutating a rule in place would
 * silently restate what an old payslip claims to have paid.
 *
 * Ending the previous rule at the new rule's `effective_from` also leaves no
 * uncovered day, because both tables use half-open `[)` ranges: the old rule
 * covers up to but not including that date, and the new one takes over exactly
 * there.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT AN ALLOWANCE
 * ---------------------------------------------------------------------------
 *
 * Allowances are monthly amounts prorated by payable days. These are earned per
 * event — a delivery, a collection — and are deliberately not prorated. Filing
 * them under Allowances would make a mid-month joiner's per-delivery pay depend
 * on their start date, which is not what the Company agreed to pay.
 */
@Injectable()
export class EmployeeVariableEarningService {
  public constructor(
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  /** Both timelines for one Employee, newest first. */
  public async rules(
    database: Kysely<DatabaseSchema>,
    employeeId: string,
  ): Promise<VariableEarningRules> {
    const { companyId } = this.tenants.current();
    await this.assertEmployee(database, companyId, employeeId);
    const delivery = await sql<VariableEarningRule>`
      select id, amount_per_order::text as amount,
             effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
             is_active as "isActive", created_at as "createdAt",
             (is_active and effective_from <= current_date
              and (effective_to is null or current_date < effective_to)) as "isCurrent"
        from employee_delivery_earning_rules
       where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
       order by effective_from desc, created_at desc
    `.execute(database);
    const collection = await sql<VariableEarningRule>`
      select id, amount::text as amount, collection_payment_type as "paymentType",
             effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
             is_active as "isActive", created_at as "createdAt",
             (is_active and effective_from <= current_date
              and (effective_to is null or current_date < effective_to)) as "isCurrent"
        from employee_collection_earning_rules
       where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
       order by effective_from desc, created_at desc
    `.execute(database);
    return { collection: collection.rows, delivery: delivery.rows };
  }

  /** Start a new per-delivered-Order rate from a date. */
  public async setDeliveryRule(
    employeeId: string,
    input: { amountPerOrder: number; effectiveFrom: string; effectiveTo?: string },
    correlationId: string,
  ): Promise<VariableEarningRule> {
    if (input.amountPerOrder <= 0) {
      throw new ApplicationException(
        "employee_delivery_rate_invalid",
        "The fee per delivered Order must be greater than zero",
        HttpStatus.BAD_REQUEST,
      );
    }
    const corrected = await this.correctCurrentRule(
      employeeId,
      input.effectiveFrom,
      input.effectiveTo,
      correlationId,
      {
        audit: "employee.delivery_earning_rule.corrected",
        table: "employee_delivery_earning_rules",
        valuePredicate: sql`amount_per_order=${input.amountPerOrder}`,
      },
    );
    if (corrected) return corrected;
    return this.replaceRule(employeeId, input.effectiveFrom, input.effectiveTo, correlationId, {
      audit: "employee.delivery_earning_rule.set",
      insert: (database, companyId, actorId) =>
        sql<VariableEarningRule>`
        insert into employee_delivery_earning_rules (
          company_id, employee_id, amount_per_order, effective_from, effective_to,
          created_by_account_id
        ) values (
          ${companyId}::uuid, ${employeeId}::uuid, ${input.amountPerOrder},
          ${input.effectiveFrom}::date, ${input.effectiveTo ?? null}::date, ${actorId}::uuid
        )
        returning id, amount_per_order::text as amount,
                  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
                  is_active as "isActive", created_at as "createdAt", true as "isCurrent"
      `.execute(database),
      table: "employee_delivery_earning_rules",
    });
  }

  /** Start a new collection payment rule from a date. */
  public async setCollectionRule(
    employeeId: string,
    input: {
      amount: number;
      collectionPaymentType: (typeof collectionPaymentTypes)[number];
      effectiveFrom: string;
      effectiveTo?: string;
    },
    correlationId: string,
  ): Promise<VariableEarningRule> {
    if (!collectionPaymentTypes.includes(input.collectionPaymentType)) {
      throw new ApplicationException(
        "employee_collection_payment_type_unsupported",
        "Collection Payment Type must be None or Per Collected Order",
        HttpStatus.BAD_REQUEST,
      );
    }
    const none = input.collectionPaymentType === "none";
    // Mirrors `employee_collection_earning_rules_amount_check`. Checked here so
    // the operator gets a sentence rather than an integrity error.
    if (none && input.amount !== 0) {
      throw new ApplicationException(
        "employee_collection_rate_invalid",
        "A collection payment type of None must have an amount of zero",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!none && input.amount <= 0) {
      throw new ApplicationException(
        "employee_collection_rate_invalid",
        "The collection amount must be greater than zero",
        HttpStatus.BAD_REQUEST,
      );
    }
    const corrected = await this.correctCurrentRule(
      employeeId,
      input.effectiveFrom,
      input.effectiveTo,
      correlationId,
      {
        audit: "employee.collection_earning_rule.corrected",
        table: "employee_collection_earning_rules",
        valuePredicate: sql`collection_payment_type=${input.collectionPaymentType} and amount=${input.amount}`,
      },
    );
    if (corrected) return corrected;
    return this.replaceRule(employeeId, input.effectiveFrom, input.effectiveTo, correlationId, {
      audit: "employee.collection_earning_rule.set",
      insert: (database, companyId, actorId) =>
        sql<VariableEarningRule>`
        insert into employee_collection_earning_rules (
          company_id, employee_id, collection_payment_type, amount, effective_from,
          effective_to, created_by_account_id
        ) values (
          ${companyId}::uuid, ${employeeId}::uuid, ${input.collectionPaymentType},
          ${input.amount}, ${input.effectiveFrom}::date, ${input.effectiveTo ?? null}::date,
          ${actorId}::uuid
        )
        returning id, amount::text as amount,
                  collection_payment_type as "paymentType",
                  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
                  is_active as "isActive", created_at as "createdAt", true as "isCurrent"
      `.execute(database),
      table: "employee_collection_earning_rules",
    });
  }

  /**
   * A profile edit that changes only the dates is a correction of the rule
   * already shown in the form, not a new rate. Update that one row and retain
   * the before/after values in the audit trail. The exclusion constraint still
   * prevents the corrected dates from colliding with any other history.
   */
  private async correctCurrentRule(
    employeeId: string,
    effectiveFrom: string,
    effectiveTo: string | undefined,
    correlationId: string,
    rule: { audit: string; table: string; valuePredicate: ReturnType<typeof sql> },
  ): Promise<VariableEarningRule | undefined> {
    if (effectiveTo !== undefined && effectiveTo <= effectiveFrom) return undefined;
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    try {
      return await this.transactions.execute(async (transaction) => {
        await this.assertEmployee(transaction, companyId, employeeId);
        const current = await sql<VariableEarningRule>`
          select id,
                 ${sql.raw(rule.table === "employee_delivery_earning_rules" ? "amount_per_order" : "amount")}::text as amount,
                 effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
                 is_active as "isActive", created_at as "createdAt"
            from ${sql.raw(rule.table)}
           where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
             and is_active and effective_from <= current_date
             and (effective_to is null or current_date < effective_to)
             and ${rule.valuePredicate}
           order by effective_from desc, created_at desc
           limit 1
        `.execute(transaction);
        const before = current.rows[0];
        if (!before) return undefined;
        if (
          before.effectiveFrom === effectiveFrom &&
          (before.effectiveTo ?? undefined) === effectiveTo
        ) {
          return before;
        }
        const updated = await sql<VariableEarningRule>`
          update ${sql.raw(rule.table)}
             set effective_from=${effectiveFrom}::date,
                 effective_to=${effectiveTo ?? null}::date,
                 updated_at=now(), version=version+1
           where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
             and id=${before.id}::uuid
           returning id,
             ${sql.raw(rule.table === "employee_delivery_earning_rules" ? "amount_per_order" : "amount")}::text as amount,
             effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
             is_active as "isActive", created_at as "createdAt", true as "isCurrent"
        `.execute(transaction);
        const after = updated.rows[0]!;
        await this.history.audit(transaction, {
          action: rule.audit,
          actorId,
          after: { ...after, correctedFrom: before, employeeId },
          companyId,
          correlationId,
          subjectId: employeeId,
          subjectType: "employee",
        });
        return after;
      });
    } catch (error) {
      this.rethrowOverlap(error);
    }
  }

  private rethrowOverlap(error: unknown): never {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code === "23P01") {
      throw new ApplicationException(
        "employee_earning_period_overlap",
        "The selected effective period overlaps an existing earning rule",
        HttpStatus.CONFLICT,
      );
    }
    throw error;
  }

  /**
   * End the open rule, then insert the new one — the shared half of both paths.
   *
   * The close is deliberately narrow: only a rule that is still open-ended AND
   * started before the new one. A rule that already ends earlier needs no
   * change, and one starting later is a future rate the operator scheduled
   * on purpose. Anything still overlapping after that is a genuine conflict,
   * and the exclusion constraint rejects it rather than this code guessing.
   */
  private async replaceRule(
    employeeId: string,
    effectiveFrom: string,
    effectiveTo: string | undefined,
    correlationId: string,
    rule: {
      audit: string;
      insert: (
        database: Kysely<DatabaseSchema>,
        companyId: string,
        actorId: string,
      ) => Promise<{ rows: VariableEarningRule[] }>;
      table: string;
    },
  ): Promise<VariableEarningRule> {
    if (effectiveTo !== undefined && effectiveTo <= effectiveFrom) {
      throw new ApplicationException(
        "employee_earning_period_invalid",
        "Effective To must be after Effective From",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    try {
      return await this.transactions.execute(async (transaction) => {
        await this.assertEmployee(transaction, companyId, employeeId);
        const previous = await sql<{ effectiveFrom: string; id: string }>`
          update ${sql.raw(rule.table)}
             set effective_to=${effectiveFrom}::date, updated_at=now(), version=version+1
           where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
             and is_active and effective_to is null and effective_from < ${effectiveFrom}::date
           returning id, effective_from::text as "effectiveFrom"
        `.execute(transaction);
        const inserted = await rule.insert(transaction, companyId, actorId);
        const created = inserted.rows[0]!;
      /* The superseded rule travels inside `after` because the shared writer
         persists `after_data` only — every caller in the module does the same.
         Recording it matters: "rate became 3 on 1 September, replacing the 2
         that had run since 1 January" is the auditable fact, and the new row
         alone does not say what it displaced. */
        await this.history.audit(transaction, {
          action: rule.audit,
          actorId,
          after: {
            ...created,
            employeeId,
            supersededRule: previous.rows[0] ?? null,
          },
          companyId,
          correlationId,
          subjectId: employeeId,
          subjectType: "employee",
        });
        return created;
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      if (code === "23P01") {
        throw new ApplicationException(
          "employee_earning_period_overlap",
          "The selected effective period overlaps an existing earning rule",
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /** Company-scoped existence check; a neighbour's Employee is simply not found. */
  private async assertEmployee(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    employeeId: string,
  ): Promise<void> {
    const result = await sql<{ id: string }>`
      select id from employees
       where id=${employeeId}::uuid and company_id=${companyId}::uuid
    `.execute(database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "employee_not_found",
        "The Employee was not found",
        HttpStatus.NOT_FOUND,
      );
    }
  }
}
