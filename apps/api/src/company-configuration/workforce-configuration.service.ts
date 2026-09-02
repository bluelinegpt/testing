import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { DriverRoleProvisioningService } from "../users/driver-role-provisioning.service.js";
import type {
  ConfirmOutsourcedPaymentDto,
  CreateCommissionRuleDto,
  CreateHrDocumentDto,
  RunCommissionCalculationDto,
  SaveDriverDto,
  SaveEmployeeDto,
} from "./workforce-configuration.dto.js";

export interface WorkforcePage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface EmployeeSummary {
  readonly basicSalary: string;
  readonly code: string;
  readonly commissionEnabled: boolean;
  readonly documentStatus: string;
  readonly employeeType: string | null;
  readonly id: string;
  readonly jobTitle: string | null;
  readonly mobileNumber: string | null;
  readonly name: string;
  readonly status: "active" | "disabled";
}

export interface DriverSummary {
  readonly code: string;
  readonly commissionMethod: string | null;
  readonly commissionRate: string | null;
  readonly documentStatus: string;
  readonly id: string;
  readonly linkedEmployee: string | null;
  readonly mobileNumber: string;
  readonly name: string;
  readonly status: "active" | "disabled";
  readonly type: "employee" | "outsourced";
  readonly vehicle: string | null;
}

interface CommissionOrder {
  readonly deliveredOn: string;
  readonly id: string;
  readonly serviceFee: string;
}

@Injectable()
export class WorkforceConfigurationService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(DriverRoleProvisioningService)
    private readonly driverRoles: DriverRoleProvisioningService,
  ) {}

  public async employees(input: {
    documentExpiry?: string;
    employeeType?: string;
    jobTitle?: string;
    page?: string;
    pageSize?: string;
    search?: string;
    status?: string;
  }): Promise<WorkforcePage<EmployeeSummary>> {
    const { companyId } = this.tenants.current();
    const { page, pageSize, offset } = this.page(input.page, input.pageSize);
    const search = input.search?.trim().toLowerCase() ?? "";
    const status = input.status ?? "active";
    const expiry = input.documentExpiry ?? "all";
    const result = await sql<EmployeeSummary & { total: number }>`
      select e.id, e.employee_number as code, e.name_en as name,
             e.mobile_number as "mobileNumber", e.job_title as "jobTitle",
             e.employee_type as "employeeType", e.basic_salary::text as "basicSalary",
             case when exists (
               select 1 from drivers d join driver_commission_rules r on r.driver_id=d.id and r.company_id=d.company_id
               where d.employee_id=e.id and d.company_id=e.company_id and r.is_active
             ) then true else false end as "commissionEnabled",
             case
               when exists (select 1 from hr_documents h where h.employee_id=e.id and h.company_id=e.company_id
                 and h.status='active' and h.expiry_date < current_date) then 'expired'
               when exists (select 1 from hr_documents h left join company_settings s on s.company_id=h.company_id
                 where h.employee_id=e.id and h.company_id=e.company_id and h.status='active'
                   and h.expiry_date between current_date and current_date + coalesce(s.document_expiry_alert_days, 30)) then 'expiring_soon'
               else 'valid' end as "documentStatus",
             case when e.is_active then 'active' else 'disabled' end as status,
             count(*) over ()::int as total
      from employees e
      where e.company_id=${companyId}::uuid
        and (${status}='all' or (${status}='active' and e.is_active) or (${status}='disabled' and not e.is_active))
        and (${input.employeeType ?? ""}='' or e.employee_type=${input.employeeType ?? ""})
        and (${input.jobTitle ?? ""}='' or e.job_title=${input.jobTitle ?? ""})
        and (${search}='' or lower(coalesce(e.employee_number,'')) like ${`%${search}%`}
          or lower(e.name_en) like ${`%${search}%`} or e.mobile_number like ${`%${search}%`})
        and (${expiry}='all'
          or (${expiry}='expired' and exists (select 1 from hr_documents h where h.employee_id=e.id and h.company_id=e.company_id and h.status='active' and h.expiry_date < current_date))
          or (${expiry}='expiring_soon' and exists (select 1 from hr_documents h left join company_settings s on s.company_id=h.company_id where h.employee_id=e.id and h.company_id=e.company_id and h.status='active' and h.expiry_date between current_date and current_date + coalesce(s.document_expiry_alert_days,30))))
      order by lower(e.name_en), e.employee_number
      limit ${pageSize} offset ${offset}
    `.execute(this.database);
    return { items: result.rows, page, pageSize, total: result.rows[0]?.total ?? 0 };
  }

  public async drivers(input: {
    commissionEnabled?: string;
    documentExpiry?: string;
    driverType?: string;
    page?: string;
    pageSize?: string;
    search?: string;
    status?: string;
  }): Promise<WorkforcePage<DriverSummary>> {
    const { companyId } = this.tenants.current();
    const { page, pageSize, offset } = this.page(input.page, input.pageSize);
    const search = input.search?.trim().toLowerCase() ?? "";
    const status = input.status ?? "active";
    const expiry = input.documentExpiry ?? "all";
    const commission = input.commissionEnabled ?? "all";
    const result = await sql<DriverSummary & { total: number }>`
      select d.id, d.code, d.name_en as name, d.mobile_number as "mobileNumber",
             d.driver_type as type, case when d.account_status='active' then 'active' else 'disabled' end as status,
             e.name_en as "linkedEmployee", v.registration_number as vehicle,
             cr.commission_method as "commissionMethod", cr.commission_rate::text as "commissionRate",
             case
               when exists (select 1 from hr_documents h where h.driver_id=d.id and h.company_id=d.company_id and h.status='active' and h.expiry_date < current_date) then 'expired'
               when exists (select 1 from hr_documents h left join company_settings s on s.company_id=h.company_id where h.driver_id=d.id and h.company_id=d.company_id and h.status='active' and h.expiry_date between current_date and current_date + coalesce(s.document_expiry_alert_days,30)) then 'expiring_soon'
               else 'valid' end as "documentStatus",
             count(*) over ()::int as total
      from drivers d
      left join employees e on e.id=d.employee_id and e.company_id=d.company_id
      left join vehicles v on v.id=d.vehicle_id and v.company_id=d.company_id
      left join lateral (
        select r.commission_method, r.commission_rate from driver_commission_rules r
        where r.driver_id=d.id and r.company_id=d.company_id and r.is_active
          and current_date between r.effective_from and coalesce(r.effective_to, 'infinity'::date)
        order by r.effective_from desc limit 1
      ) cr on true
      where d.company_id=${companyId}::uuid
        and (${status}='all' or d.account_status=${status})
        and (${input.driverType ?? ""}='' or d.driver_type=${input.driverType ?? ""})
        and (${commission}='all' or (${commission}='true' and cr.commission_method is not null) or (${commission}='false' and cr.commission_method is null))
        and (${search}='' or lower(d.code) like ${`%${search}%`} or lower(d.name_en) like ${`%${search}%`} or d.mobile_number like ${`%${search}%`})
        and (${expiry}='all'
          or (${expiry}='expired' and exists (select 1 from hr_documents h where h.driver_id=d.id and h.company_id=d.company_id and h.status='active' and h.expiry_date < current_date))
          or (${expiry}='expiring_soon' and exists (select 1 from hr_documents h left join company_settings s on s.company_id=h.company_id where h.driver_id=d.id and h.company_id=d.company_id and h.status='active' and h.expiry_date between current_date and current_date + coalesce(s.document_expiry_alert_days,30))))
      order by lower(d.name_en), d.code
      limit ${pageSize} offset ${offset}
    `.execute(this.database);
    return { items: result.rows, page, pageSize, total: result.rows[0]?.total ?? 0 };
  }

  public async employee(code: string): Promise<Record<string, unknown>> {
    return this.entityDetail("employee", code);
  }

  public async driver(code: string): Promise<Record<string, unknown>> {
    return this.entityDetail("driver", code);
  }

  public async createEmployee(
    input: SaveEmployeeDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    return this.saveEmployee(undefined, input, correlationId);
  }

  public async updateEmployee(
    id: string,
    input: SaveEmployeeDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    return this.saveEmployee(id, input, correlationId);
  }

  /**
   * The master workforce save. An Employee has a configurable role; when that
   * role is a driver role the Employee is also made an operational Driver, with
   * "employee" engagement salaried and "outsourced" engagement paid a fixed fee
   * per delivered order. Employee number and Driver code are backend-generated.
   */
  private async saveEmployee(
    id: string | undefined,
    input: SaveEmployeeDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const employeeId = id ?? randomUUID();
    let employeeCode = "";

    await this.transactions.execute(async (transaction) => {
      await this.validateCommonLinks(transaction, companyId, input.areaId, input.userId);

      const role = await sql<{ isDriverRole: boolean }>`
        select is_driver_role as "isDriverRole" from employee_roles
         where id=${input.employeeRoleId}::uuid and company_id=${companyId}::uuid and is_active
      `.execute(transaction);
      if (role.rows[0] === undefined)
        throw new ApplicationException(
          "employee_role_not_found",
          "The selected role does not exist",
          HttpStatus.BAD_REQUEST,
        );
      const isDriverRole = role.rows[0].isDriverRole;
      if (isDriverRole && input.mobileNumber.trim() === "") {
        throw new ApplicationException(
          "driver_employee_mobile_required",
          "Mobile number is required when the employee role is Driver.",
          HttpStatus.BAD_REQUEST,
        );
      }
      // Outsourced only applies to driver roles; everyone else is salaried.
      const engagement =
        isDriverRole && input.engagement === "outsourced" ? "outsourced" : "employee";
      // Outsourced staff carry no salary.
      const salary = new Decimal(
        engagement === "outsourced" ? 0 : (input.basicSalary ?? 0),
      ).toFixed(2);
      const effectiveFrom = input.salaryEffectiveFrom ?? null;
      const salaryHold = input.salaryHold ?? false;
      const salaryHoldReason = input.salaryHoldReason?.trim() || null;
      const requestedPayrollEligible =
        engagement === "outsourced" ? false : (input.payrollEligible ?? false);
      let effectivePayrollEligible = requestedPayrollEligible;
      let effectiveSalaryHold = engagement === "outsourced" ? false : salaryHold;
      if (salaryHold && (salaryHoldReason === null || input.salaryHoldFrom === undefined)) {
        throw new ApplicationException(
          "salary_hold_details_required",
          "A reason and start date are required to activate Salary Hold",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (
        input.salaryHoldFrom !== undefined &&
        input.salaryHoldTo !== undefined &&
        input.salaryHoldTo < input.salaryHoldFrom
      ) {
        throw new ApplicationException(
          "salary_hold_dates_invalid",
          "Salary Hold end date cannot be earlier than its start date",
          HttpStatus.BAD_REQUEST,
        );
      }

      if (id === undefined) {
        employeeCode = await this.nextGeneratedCode(transaction, companyId, "employee", "EMP");
        await sql`insert into employees (
          id, company_id, company_user_id, employee_role_id, employee_number, name_en, mobile_number,
          second_mobile_number, email, address, area_id, date_of_birth, nationality,
          hired_on, job_title, department, basic_salary, payroll_eligible,
          salary_hold, salary_hold_reason, salary_hold_from, salary_hold_to, notes
        ) values (
          ${employeeId}::uuid, ${companyId}::uuid, ${input.userId ?? null}::uuid,
          ${input.employeeRoleId}::uuid, ${employeeCode}, ${input.name.trim()}, ${input.mobileNumber.trim()},
          ${input.secondMobileNumber?.trim() || null}, ${input.email?.trim() || null},
          ${input.address?.trim() || null}, ${input.areaId ?? null}::uuid, ${input.dateOfBirth ?? null}::date,
          ${input.nationality?.trim() || null}, ${input.joiningDate ?? null}::date,
          ${input.jobTitle?.trim() || null}, ${input.department?.trim() || null},
          ${salary}, ${requestedPayrollEligible}, ${effectiveSalaryHold}, ${salaryHoldReason},
          ${input.salaryHoldFrom ?? null}::date, ${input.salaryHoldTo ?? null}::date,
          ${input.notes?.trim() || null}
        )`.execute(transaction);
      } else {
        const beforeEmployee = await this.lockEmployee(transaction, companyId, employeeId);
        const targetPayrollEligible =
          engagement === "outsourced"
            ? false
            : (input.payrollEligible ?? beforeEmployee.payrollEligible);
        const targetSalaryHold =
          engagement === "outsourced" ? false : (input.salaryHold ?? beforeEmployee.salaryHold);
        effectivePayrollEligible = targetPayrollEligible;
        effectiveSalaryHold = targetSalaryHold;
        const current = await sql<{ code: string }>`
          select employee_number as code from employees
           where id=${employeeId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        employeeCode = current.rows[0]?.code ?? "";
        await sql`update employees set company_user_id=${input.userId ?? null}::uuid,
          employee_role_id=${input.employeeRoleId}::uuid, name_en=${input.name.trim()},
          mobile_number=${input.mobileNumber.trim()}, second_mobile_number=${input.secondMobileNumber?.trim() || null},
          email=${input.email?.trim() || null}, address=${input.address?.trim() || null}, area_id=${input.areaId ?? null}::uuid,
          date_of_birth=${input.dateOfBirth ?? null}::date, nationality=${input.nationality?.trim() || null},
          hired_on=${input.joiningDate ?? null}::date, job_title=${input.jobTitle?.trim() || null},
          department=${input.department?.trim() || null},
          basic_salary=${salary},
          payroll_eligible=${targetPayrollEligible},
          salary_hold=${targetSalaryHold},
          salary_hold_reason=case when ${input.salaryHold ?? null}::boolean is true then ${salaryHoldReason}
            else coalesce(salary_hold_reason, ${salaryHoldReason}) end,
          salary_hold_from=case when ${input.salaryHold ?? null}::boolean is true then ${input.salaryHoldFrom ?? null}::date
            else coalesce(salary_hold_from, ${input.salaryHoldFrom ?? null}::date) end,
          salary_hold_to=case when ${input.salaryHold ?? null}::boolean is true then ${input.salaryHoldTo ?? null}::date
            else coalesce(salary_hold_to, ${input.salaryHoldTo ?? null}::date) end,
          notes=${input.notes?.trim() || null},
          updated_at=now(), version=version+1 where id=${employeeId}::uuid and company_id=${companyId}::uuid`.execute(
          transaction,
        );
        if (beforeEmployee.payrollEligible !== targetPayrollEligible) {
          await this.audit(transaction, {
            action: targetPayrollEligible
              ? "employee.payroll_eligibility_enabled"
              : "employee.payroll_eligibility_disabled",
            actorId,
            after: { payrollEligible: targetPayrollEligible },
            companyId,
            correlationId,
            subjectId: employeeId,
            subjectType: "employee",
          });
        }
        if (beforeEmployee.salaryHold !== targetSalaryHold) {
          await this.audit(transaction, {
            action: targetSalaryHold
              ? "employee.salary_hold_activated"
              : "employee.salary_hold_removed",
            actorId,
            after: {
              salaryHold: targetSalaryHold,
              salaryHoldFrom: input.salaryHoldFrom ?? beforeEmployee.salaryHoldFrom,
              salaryHoldReason: salaryHoldReason ?? beforeEmployee.salaryHoldReason,
              salaryHoldTo: input.salaryHoldTo ?? beforeEmployee.salaryHoldTo,
            },
            companyId,
            correlationId,
            ...(salaryHoldReason == null ? {} : { reason: salaryHoldReason }),
            subjectId: employeeId,
            subjectType: "employee",
          });
        }
        await sql`update employee_allowances set is_active=false,
          updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
          where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid and is_active`.execute(
          transaction,
        );
      }

      if (engagement !== "outsourced") {
        await this.writeSalaryVersion(
          transaction,
          companyId,
          employeeId,
          actorId,
          salary,
          effectiveFrom,
        );
        for (const allowance of input.allowances ?? []) {
          await sql`insert into employee_allowances (company_id,employee_id,allowance_type_id,amount,effective_from,effective_to,created_by_account_id)
            values (${companyId}::uuid,${employeeId}::uuid,${allowance.allowanceTypeId}::uuid,${new Decimal(allowance.amount).toFixed(2)},${allowance.effectiveFrom}::date,${allowance.effectiveTo ?? null}::date,${actorId}::uuid)`.execute(
            transaction,
          );
        }
      }

      // A driver-role Employee is also an operational Driver.
      if (isDriverRole) {
        await this.linkDriverForEmployee(
          transaction,
          companyId,
          employeeId,
          actorId,
          input,
          engagement,
          effectiveFrom,
        );
      }

      await this.audit(transaction, {
        action: id === undefined ? "employee.create" : "employee.update",
        actorId,
        after: {
          code: employeeCode,
          engagement,
          name: input.name,
          payrollEligible: effectivePayrollEligible,
          salary,
          salaryEffectiveFrom: effectiveFrom,
          salaryHold: effectiveSalaryHold,
        },
        companyId,
        correlationId,
        subjectId: employeeId,
        subjectType: "employee",
      });
    });
    return this.employee(employeeCode);
  }

  /**
   * Creates or updates the operational Driver record that a driver-role
   * Employee needs to be assigned deliveries. The Driver reuses the Employee's
   * identity; its type follows the Employee's engagement.
   */
  private async linkDriverForEmployee(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
    employeeId: string,
    actorId: string,
    input: SaveEmployeeDto,
    engagement: "employee" | "outsourced",
    effectiveFrom: string | null,
  ): Promise<void> {
    const outsourcedFee =
      engagement === "outsourced"
        ? new Decimal(input.outsourcedFeePerDeliveredOrder ?? 0).toFixed(2)
        : null;
    const existing = await sql<{ id: string }>`
      select id from drivers where employee_id=${employeeId}::uuid and company_id=${companyId}::uuid
    `.execute(transaction);

    if (existing.rows[0] === undefined) {
      const code = await this.nextGeneratedCode(transaction, companyId, "driver", "DRV");
      const created = await sql<{
        id: string;
      }>`insert into drivers (company_id, employee_id, code, name_en, mobile_number,
        second_mobile_number, email, address, area_id, driver_type, account_status,
        outsourced_fee_per_delivered_order, notes)
        values (${companyId}::uuid, ${employeeId}::uuid, ${code}, ${input.name.trim()},
        ${input.mobileNumber.trim()}, ${input.secondMobileNumber?.trim() || null},
        ${input.email?.trim() || null}, ${input.address?.trim() || null}, ${input.areaId ?? null}::uuid,
        ${engagement}, 'active', ${outsourcedFee}, ${input.notes?.trim() || null})
        returning id`.execute(transaction);
      if (engagement === "outsourced" && outsourcedFee !== null) {
        await this.syncOutsourcedDriverFeeVersion(
          transaction,
          companyId,
          created.rows[0]!.id,
          actorId,
          outsourcedFee,
          effectiveFrom,
        );
      }
      if (engagement === "outsourced" && input.outsourcedCollectionPaymentType !== undefined) {
        await this.syncOutsourcedCollectionEarningRule(
          transaction,
          companyId,
          created.rows[0]!.id,
          actorId,
          input.outsourcedCollectionPaymentType,
          input.outsourcedCollectionAmount ?? 0,
          effectiveFrom,
        );
      }
    } else {
      await sql`update drivers set name_en=${input.name.trim()}, mobile_number=${input.mobileNumber.trim()},
        second_mobile_number=${input.secondMobileNumber?.trim() || null}, email=${input.email?.trim() || null},
        address=${input.address?.trim() || null}, area_id=${input.areaId ?? null}::uuid,
        driver_type=${engagement}, outsourced_fee_per_delivered_order=${outsourcedFee},
        notes=${input.notes?.trim() || null}, updated_at=now(), version=version+1
        where id=${existing.rows[0].id}::uuid and company_id=${companyId}::uuid`.execute(
        transaction,
      );
      if (engagement === "outsourced" && outsourcedFee !== null) {
        await this.syncOutsourcedDriverFeeVersion(
          transaction,
          companyId,
          existing.rows[0].id,
          actorId,
          outsourcedFee,
          effectiveFrom,
        );
      }
      if (engagement === "outsourced" && input.outsourcedCollectionPaymentType !== undefined) {
        await this.syncOutsourcedCollectionEarningRule(
          transaction,
          companyId,
          existing.rows[0].id,
          actorId,
          input.outsourcedCollectionPaymentType,
          input.outsourcedCollectionAmount ?? 0,
          effectiveFrom,
        );
      }
    }
  }

  /**
   * Employee setup exposes the outsourced Driver's Collect Order / collection
   * earning rate, reusing `outsourced_driver_collection_earning_rules` --
   * the same table `OutsourcedDriverFeeService.createForConfirmedCollection`
   * already reads for a confirmed cash reconciliation, and the same table
   * `capture_outsourced_collect_order_earning` reads for a closed Collect
   * Order. One rate, two triggers -- matching the Employee side's own
   * design of one "collection earning" rule for both.
   */
  private async syncOutsourcedCollectionEarningRule(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
    driverId: string,
    actorId: string,
    paymentType: "none" | "per_collected_order",
    amount: number,
    effectiveFrom: string | null,
  ): Promise<void> {
    const requestedAmount = new Decimal(amount);
    const none = paymentType === "none";
    if ((none && !requestedAmount.isZero()) || (!none && requestedAmount.lessThanOrEqualTo(0))) {
      throw new ApplicationException(
        "outsourced_collection_rate_invalid",
        "The collection payment type and amount do not agree",
        HttpStatus.BAD_REQUEST,
      );
    }

    const effective = await sql<{ value: string }>`
      select coalesce(${effectiveFrom}::date, current_date)::text as value
    `.execute(transaction);
    const requestedEffectiveFrom = effective.rows[0]!.value;

    const active = await sql<{
      readonly amount: string;
      readonly effectiveFrom: string;
      readonly id: string;
      readonly paymentType: string;
    }>`
      select id, collection_payment_type as "paymentType", amount::text,
             effective_from::text as "effectiveFrom"
        from outsourced_driver_collection_earning_rules
       where company_id=${companyId}::uuid and driver_id=${driverId}::uuid
         and is_active and effective_to is null
       order by effective_from desc
       for update
    `.execute(transaction);
    const current = active.rows[0];
    if (
      current !== undefined &&
      current.paymentType === paymentType &&
      new Decimal(current.amount).equals(requestedAmount)
    ) {
      return;
    }

    if (current !== undefined) {
      await sql`
        update outsourced_driver_collection_earning_rules
           set effective_to=${requestedEffectiveFrom}::date, updated_at=now(), version=version+1
         where id=${current.id}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
    }
    await sql`
      insert into outsourced_driver_collection_earning_rules(
        company_id, driver_id, collection_payment_type, amount, effective_from, is_active,
        created_by_account_id
      ) values (
        ${companyId}::uuid, ${driverId}::uuid, ${paymentType}, ${requestedAmount.toFixed(2)},
        ${requestedEffectiveFrom}::date, true, ${actorId}::uuid
      )
    `.execute(transaction);
  }

  /**
   * Employee setup exposes the outsourced Driver's per-delivery fee, while the
   * Payroll fee engine accrues from effective-dated fee versions. Keep those
   * two records aligned so a delivered Order can become payable without the
   * operator having to maintain a separate hidden rate screen.
   */
  private async syncOutsourcedDriverFeeVersion(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
    driverId: string,
    actorId: string,
    feePerOrder: string,
    effectiveFrom: string | null,
  ): Promise<void> {
    const requestedFee = new Decimal(feePerOrder);
    if (requestedFee.isNegative()) {
      throw new ApplicationException(
        "outsourced_driver_fee_invalid",
        "Outsourced Driver fee cannot be negative",
        HttpStatus.BAD_REQUEST,
      );
    }

    const effective = await sql<{ value: string }>`
      select coalesce(${effectiveFrom}::date, current_date)::text as value
    `.execute(transaction);
    const requestedEffectiveFrom = effective.rows[0]!.value;

    const active = await sql<{
      readonly effectiveFrom: string;
      readonly effectiveTo: string | null;
      readonly feePerOrder: string;
      readonly id: string;
    }>`
      select id,
             effective_from::text as "effectiveFrom",
             effective_to::text as "effectiveTo",
             fee_per_order::text as "feePerOrder"
        from outsourced_driver_fee_versions
       where company_id=${companyId}::uuid
         and driver_id=${driverId}::uuid
         and status='active'
       order by effective_from desc
       for update
    `.execute(transaction);

    const matching = active.rows.find((row) => {
      const startsBeforeRequested = row.effectiveFrom <= requestedEffectiveFrom;
      const endsAfterRequested =
        row.effectiveTo === null || row.effectiveTo >= requestedEffectiveFrom;
      return (
        startsBeforeRequested &&
        endsAfterRequested &&
        new Decimal(row.feePerOrder).equals(requestedFee)
      );
    });

    if (matching !== undefined) return;

    /* Once an accrual exists, "a rate used by an accrual is immutable"
       (Documentation/Payroll/PAYROLL_FOUNDATIONS.md) — narrowing the version's
       effective_to must never leave that accrual's own business date outside
       the window it was priced from. The database trigger enforces this too
       and is what actually protects every caller, but failing here first turns
       a raw constraint violation into a business answer the operator can act
       on, matching how the rest of this service reports conflicts. */
    const orphaning = await sql<{ orderNumber: string }>`
      select o.order_number as "orderNumber"
        from outsourced_driver_fee_accruals a
        join outsourced_driver_fee_versions v
          on v.id = a.fee_rate_version_id and v.company_id = a.company_id
        join orders o on o.id = a.order_id and o.company_id = a.company_id
       where v.company_id=${companyId}::uuid
         and v.driver_id=${driverId}::uuid
         and v.status='active'
         and v.effective_from < ${requestedEffectiveFrom}::date
         and a.status not in ('reversed','recovery_required')
         and a.accrual_business_date >= ${requestedEffectiveFrom}::date
       order by o.order_number
       limit 5
    `.execute(transaction);
    if (orphaning.rows.length > 0) {
      throw new ApplicationException(
        "outsourced_driver_fee_narrowing_would_orphan_accrual",
        `This effective date would leave an already-accrued Driver fee (${orphaning.rows
          .map((row) => row.orderNumber)
          .join(
            ", ",
          )}) without a valid rate for its date. Choose a later effective date, or resolve those accruals first.`,
        HttpStatus.CONFLICT,
      );
    }

    await sql`
      update outsourced_driver_fee_versions
         set status='superseded',
             effective_to=least(coalesce(effective_to, ${requestedEffectiveFrom}::date - interval '1 day')::date,
                                (${requestedEffectiveFrom}::date - interval '1 day')::date),
             updated_by_account_id=${actorId}::uuid,
             updated_at=now(),
             version=version+1
       where company_id=${companyId}::uuid
         and driver_id=${driverId}::uuid
         and status='active'
         and effective_from < ${requestedEffectiveFrom}::date
    `.execute(transaction);

    await sql`
      update outsourced_driver_fee_versions
         set status='superseded',
             updated_by_account_id=${actorId}::uuid,
             updated_at=now(),
             version=version+1
       where company_id=${companyId}::uuid
         and driver_id=${driverId}::uuid
         and status='active'
         and effective_from >= ${requestedEffectiveFrom}::date
    `.execute(transaction);

    await sql`
      insert into outsourced_driver_fee_versions (
        company_id,
        driver_id,
        effective_from,
        fee_per_order,
        status,
        notes,
        created_by_account_id
      )
      values (
        ${companyId}::uuid,
        ${driverId}::uuid,
        ${requestedEffectiveFrom}::date,
        ${requestedFee.toFixed(2)},
        'active',
        'Created from Employee outsourced Driver setup',
        ${actorId}::uuid
      )
    `.execute(transaction);
  }

  public async employeeRoles(): Promise<readonly Record<string, unknown>[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<Record<string, unknown>>`
      select id, code, name_en as "nameEn", name_ar as "nameAr", is_driver_role as "isDriverRole"
        from employee_roles
       where company_id=${companyId}::uuid and is_active
       order by is_driver_role desc, lower(name_en)
    `.execute(this.database);
    return result.rows;
  }

  public async createEmployeeRole(
    input: { isDriverRole?: boolean; name: string },
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const name = input.name.trim();
    if (name.length === 0)
      throw new ApplicationException(
        "role_name_required",
        "Role name is required",
        HttpStatus.BAD_REQUEST,
      );
    // Derive a code from the name for readability, then append a short
    // random suffix so it stays unique even when the name carries no A-Z/0-9
    // characters at all -- e.g. an Arabic-only name like "مندوب" strips to
    // nothing, so without this every Arabic-named Role would collapse onto
    // the same "ROLE" code and the next one would fail as a duplicate.
    const base = name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
    const code = `${base || "ROLE"}_${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    try {
      const result = await sql<Record<string, unknown>>`
        insert into employee_roles (company_id, code, name_en, is_driver_role)
        values (${companyId}::uuid, ${code}, ${name}, ${input.isDriverRole ?? false})
        returning id, code, name_en as "nameEn", name_ar as "nameAr",
                  is_driver_role as "isDriverRole"
      `.execute(this.database);
      const role = result.rows[0]!;
      await this.audit(this.database, {
        action: "employee_role.create",
        actorId,
        after: { code, isDriverRole: input.isDriverRole ?? false, name },
        companyId,
        correlationId,
        subjectId: String(role.id),
        subjectType: "employee_role",
      });
      return role;
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new ApplicationException(
          "role_exists",
          "A role with this name already exists",
          HttpStatus.CONFLICT,
        );
      throw error;
    }
  }

  // Deactivating a Role only removes it from employeeRoles() -- the picker
  // for new/changed assignments. It never touches any Employee already on
  // this Role: their employee_role_id keeps pointing at the same row, which
  // still exists, just excluded from is_active-filtered lists. Reversible by
  // reactivating (isActive: true), unlike a hard delete.
  public async setEmployeeRoleStatus(
    roleId: string,
    isActive: boolean,
    correlationId: string,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const result = await sql<{ id: string; nameEn: string }>`
      update employee_roles
         set is_active=${isActive}, updated_at=now(), version=version+1
       where id=${roleId}::uuid and company_id=${companyId}::uuid
      returning id, name_en as "nameEn"
    `.execute(this.database);
    const role = result.rows[0];
    if (role === undefined)
      throw new ApplicationException("role_not_found", "Role not found", HttpStatus.NOT_FOUND);
    await this.audit(this.database, {
      action: isActive ? "employee_role.reactivate" : "employee_role.deactivate",
      actorId,
      after: { isActive, name: role.nameEn },
      companyId,
      correlationId,
      subjectId: role.id,
      subjectType: "employee_role",
    });
  }

  public async createDriver(
    input: SaveDriverDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    return this.saveDriver(undefined, input, correlationId);
  }

  public async updateDriver(
    id: string,
    input: SaveDriverDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    return this.saveDriver(id, input, correlationId);
  }

  /**
   * The unified Driver save. Employee-type Drivers carry salary and allowances
   * on a backing Employee record created here, so the operator never manages a
   * separate Employee. Outsourced Drivers carry only a fixed fee per delivered
   * order. The Driver code and Employee number are both backend-generated.
   */
  private async saveDriver(
    id: string | undefined,
    input: SaveDriverDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const driverId = id ?? randomUUID();
    const outsourcedFee =
      input.driverType === "outsourced"
        ? new Decimal(input.outsourcedFeePerDeliveredOrder ?? 0).toFixed(2)
        : null;

    let driverCode = "";
    await this.transactions.execute(async (transaction) => {
      await this.validateCommonLinks(transaction, companyId, input.areaId, input.userId);

      // Reuse the existing backing Employee on update, if this Driver already
      // had one; otherwise create it for employee-type Drivers.
      const existingEmployeeId =
        id === undefined
          ? undefined
          : ((
              await sql<{ employeeId: string | null }>`
                select employee_id as "employeeId" from drivers
                 where id=${driverId}::uuid and company_id=${companyId}::uuid
              `.execute(transaction)
            ).rows[0]?.employeeId ?? undefined);

      const employeeId =
        input.driverType === "employee"
          ? await this.writeBackingEmployee(
              transaction,
              companyId,
              actorId,
              existingEmployeeId,
              input,
            )
          : null;

      if (id === undefined) {
        driverCode = await this.nextGeneratedCode(transaction, companyId, "driver", "DRV");
        await sql`insert into drivers (id,company_id,account_id,employee_id,vehicle_id,code,name_en,mobile_number,second_mobile_number,email,address,area_id,driver_type,account_status,third_party_company_id,outsourced_fee_per_delivered_order,notes)
        values (${driverId}::uuid,${companyId}::uuid,${input.userId ?? null}::uuid,${employeeId}::uuid,${input.vehicleId ?? null}::uuid,${driverCode},${input.name.trim()},${input.mobileNumber.trim()},${input.secondMobileNumber?.trim() || null},${input.email?.trim() || null},${input.address?.trim() || null},${input.areaId ?? null}::uuid,${input.driverType},'active',${input.thirdPartyCompanyId ?? null}::uuid,${outsourcedFee},${input.notes?.trim() || null})`.execute(
          transaction,
        );
      } else {
        const current = await sql<{ code: string }>`
          select code from drivers where id=${driverId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        if (current.rows[0] === undefined)
          throw new ApplicationException(
            "driver_not_found",
            "The Driver was not found",
            HttpStatus.NOT_FOUND,
          );
        driverCode = current.rows[0].code;
        await sql`update drivers set account_id=${input.userId ?? null}::uuid,employee_id=${employeeId}::uuid,vehicle_id=${input.vehicleId ?? null}::uuid,name_en=${input.name.trim()},mobile_number=${input.mobileNumber.trim()},second_mobile_number=${input.secondMobileNumber?.trim() || null},email=${input.email?.trim() || null},address=${input.address?.trim() || null},area_id=${input.areaId ?? null}::uuid,driver_type=${input.driverType},third_party_company_id=${input.thirdPartyCompanyId ?? null}::uuid,outsourced_fee_per_delivered_order=${outsourcedFee},notes=${input.notes?.trim() || null},updated_at=now(),version=version+1 where id=${driverId}::uuid and company_id=${companyId}::uuid`.execute(
          transaction,
        );
      }
      if (input.driverType === "outsourced" && outsourcedFee !== null) {
        await this.syncOutsourcedDriverFeeVersion(
          transaction,
          companyId,
          driverId,
          actorId,
          outsourcedFee,
          null,
        );
      }
      await this.audit(transaction, {
        action: id === undefined ? "driver.create" : "driver.update",
        actorId,
        after: { code: driverCode, name: input.name, type: input.driverType },
        companyId,
        correlationId,
        subjectId: driverId,
        subjectType: "driver",
      });
    });
    return this.driver(driverCode);
  }

  /**
   * Writes the backing Employee that carries an employee-type Driver's salary
   * and allowances, so payroll continues to key off Employees. Mirrors the
   * standalone employee save but with a backend-generated Employee number.
   */
  private async writeBackingEmployee(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
    actorId: string,
    employeeId: string | undefined,
    input: SaveDriverDto,
  ): Promise<string> {
    const id = employeeId ?? randomUUID();
    const salary = new Decimal(input.basicSalary ?? 0).toFixed(2);
    const effectiveFrom = input.salaryEffectiveFrom ?? null;

    if (employeeId === undefined) {
      const code = await this.nextGeneratedCode(transaction, companyId, "employee", "EMP");
      await sql`insert into employees (
        id, company_id, company_user_id, employee_number, name_en, mobile_number,
        second_mobile_number, email, address, area_id, job_title, department,
        basic_salary, notes
      ) values (
        ${id}::uuid, ${companyId}::uuid, ${input.userId ?? null}::uuid, ${code},
        ${input.name.trim()}, ${input.mobileNumber.trim()},
        ${input.secondMobileNumber?.trim() || null}, ${input.email?.trim() || null},
        ${input.address?.trim() || null}, ${input.areaId ?? null}::uuid,
        ${input.jobTitle?.trim() || null}, ${input.department?.trim() || null},
        ${salary}, ${input.notes?.trim() || null}
      )`.execute(transaction);
    } else {
      await this.lockEmployee(transaction, companyId, id);
      await sql`update employees set company_user_id=${input.userId ?? null}::uuid,
        name_en=${input.name.trim()}, mobile_number=${input.mobileNumber.trim()},
        second_mobile_number=${input.secondMobileNumber?.trim() || null},
        email=${input.email?.trim() || null}, address=${input.address?.trim() || null},
        area_id=${input.areaId ?? null}::uuid, job_title=${input.jobTitle?.trim() || null},
        department=${input.department?.trim() || null}, basic_salary=${salary},
        notes=${input.notes?.trim() || null}, updated_at=now(), version=version+1
        where id=${id}::uuid and company_id=${companyId}::uuid`.execute(transaction);
      await sql`update employee_allowances set is_active=false,
        updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
        where company_id=${companyId}::uuid and employee_id=${id}::uuid and is_active`.execute(
        transaction,
      );
    }

    await this.writeSalaryVersion(transaction, companyId, id, actorId, salary, effectiveFrom);
    for (const allowance of input.allowances ?? []) {
      await sql`insert into employee_allowances (company_id,employee_id,allowance_type_id,amount,effective_from,effective_to,created_by_account_id)
        values (${companyId}::uuid,${id}::uuid,${allowance.allowanceTypeId}::uuid,${new Decimal(allowance.amount).toFixed(2)},${allowance.effectiveFrom}::date,${allowance.effectiveTo ?? null}::date,${actorId}::uuid)`.execute(
        transaction,
      );
    }
    return id;
  }

  /** Allocates the next Company-scoped code for a generated identifier. */
  private async nextGeneratedCode(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
    type: "driver" | "employee",
    prefix: "DRV" | "EMP",
  ): Promise<string> {
    const result = await sql<{ nextValue: string; prefix: string }>`
      insert into company_reference_counters (company_id, reference_type, next_value, prefix)
      values (${companyId}::uuid, ${type}, 2, ${prefix})
      on conflict (company_id, reference_type)
      do update set next_value = company_reference_counters.next_value + 1, updated_at = now()
      returning prefix, (next_value - 1)::text as "nextValue"
    `.execute(transaction);
    const counter = result.rows[0]!;
    return `${counter.prefix}-${counter.nextValue.padStart(6, "0")}`;
  }

  /**
   * Adds an effective-dated salary without rewriting a later historical
   * version. A retroactive version is bounded by the next known version, while
   * a preceding version is closed immediately before the requested date.
   */
  private async writeSalaryVersion(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
    employeeId: string,
    actorId: string,
    salary: string,
    effectiveFrom: string | null,
  ): Promise<void> {
    try {
      const versions = await sql<{
        basicSalary: string;
        effectiveFrom: string;
        effectiveTo: string | null;
        id: string;
        usedByApprovedPayroll: boolean;
      }>`
        select s.id,s.basic_salary::text as "basicSalary",
               s.effective_from::text as "effectiveFrom",
               s.effective_to::text as "effectiveTo",
               exists(
                 select 1 from payroll_entries p
                  where p.company_id=s.company_id and p.salary_version_id=s.id
                    and p.status in ('approved','partially_paid','paid','held','reversed')
               ) as "usedByApprovedPayroll"
          from employee_salary_versions s
         where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
         order by effective_from
         for update
      `.execute(transaction);
      const requestedDate =
        effectiveFrom ??
        (await sql<{ today: string }>`select current_date::text as today`.execute(transaction))
          .rows[0]!.today;

      // Repeated edits from the Employee form may have produced several
      // contiguous versions with the same salary. Treat a date-only edit as a
      // correction of that unapproved tail: keep one version, move any
      // draft/calculated Payroll references to it, and remove only the
      // redundant unused versions. Approved history is never consolidated.
      let trailingStart = versions.rows.length;
      while (trailingStart > 0 && versions.rows[trailingStart - 1]?.basicSalary === salary) {
        trailingStart -= 1;
      }
      const trailingSameSalary = versions.rows.slice(trailingStart);
      const precedingDifferentSalary = versions.rows[trailingStart - 1];
      if (
        trailingSameSalary.length > 1 &&
        (precedingDifferentSalary === undefined ||
          precedingDifferentSalary.effectiveFrom < requestedDate)
      ) {
        if (trailingSameSalary.some((version) => version.usedByApprovedPayroll)) {
          throw new ApplicationException(
            "employee_salary_history_immutable",
            "This salary history is already used by approved Payroll and its effective date cannot be changed",
            HttpStatus.CONFLICT,
          );
        }
        const targetVersion =
          trailingSameSalary.find((version) => version.effectiveFrom === requestedDate) ??
          trailingSameSalary.at(-1)!;
        for (const redundantVersion of trailingSameSalary) {
          if (redundantVersion.id === targetVersion.id) continue;
          await sql`
            update payroll_entries
               set salary_version_id=${targetVersion.id}::uuid,
                   updated_at=now(),version=version+1
             where company_id=${companyId}::uuid
               and salary_version_id=${redundantVersion.id}::uuid
               and status in ('draft','calculated')
          `.execute(transaction);
          await sql`
            delete from employee_salary_versions
             where id=${redundantVersion.id}::uuid and company_id=${companyId}::uuid
          `.execute(transaction);
        }

        const moveLater = requestedDate > targetVersion.effectiveFrom;
        if (moveLater) {
          await sql`
            update employee_salary_versions
               set effective_from=${requestedDate}::date,effective_to=null,
                   updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
             where id=${targetVersion.id}::uuid and company_id=${companyId}::uuid
          `.execute(transaction);
        }
        if (precedingDifferentSalary !== undefined) {
          await sql`
            update employee_salary_versions
               set effective_to=${requestedDate}::date - 1,
                   updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
             where id=${precedingDifferentSalary.id}::uuid and company_id=${companyId}::uuid
          `.execute(transaction);
        }
        if (!moveLater) {
          await sql`
            update employee_salary_versions
               set effective_from=${requestedDate}::date,effective_to=null,
                   updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
             where id=${targetVersion.id}::uuid and company_id=${companyId}::uuid
          `.execute(transaction);
        }
        return;
      }

      const sameDay = versions.rows.find((version) => version.effectiveFrom === requestedDate);
      if (sameDay !== undefined) {
        if (sameDay.basicSalary === salary) return;
        if (sameDay.usedByApprovedPayroll) {
          throw new ApplicationException(
            "employee_salary_history_immutable",
            "This salary version is already used by approved Payroll and cannot be changed",
            HttpStatus.CONFLICT,
          );
        }
        await sql`
          update employee_salary_versions
             set basic_salary=${salary},updated_by_account_id=${actorId}::uuid,
                 updated_at=now(),version=version+1
           where id=${sameDay.id}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        return;
      }

      // Changing only the date in the Employee form is a correction of the
      // latest salary version, not a request to create a duplicate historical
      // salary with the same amount. Preserve approved Payroll snapshots and
      // adjust the preceding range without creating an overlap.
      const latestVersion = versions.rows.at(-1);
      const previousVersion = versions.rows.at(-2);
      if (
        latestVersion !== undefined &&
        latestVersion.basicSalary === salary &&
        (previousVersion === undefined || previousVersion.effectiveFrom < requestedDate)
      ) {
        if (latestVersion.usedByApprovedPayroll) {
          throw new ApplicationException(
            "employee_salary_history_immutable",
            "This salary version is already used by approved Payroll and its effective date cannot be changed",
            HttpStatus.CONFLICT,
          );
        }
        const moveLater = requestedDate > latestVersion.effectiveFrom;
        if (moveLater) {
          await sql`
            update employee_salary_versions
               set effective_from=${requestedDate}::date,
                   updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
             where id=${latestVersion.id}::uuid and company_id=${companyId}::uuid
          `.execute(transaction);
        }
        if (previousVersion !== undefined) {
          await sql`
            update employee_salary_versions
               set effective_to=${requestedDate}::date - 1,
                   updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
             where id=${previousVersion.id}::uuid and company_id=${companyId}::uuid
          `.execute(transaction);
        }
        if (!moveLater) {
          await sql`
            update employee_salary_versions
               set effective_from=${requestedDate}::date,
                   updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
             where id=${latestVersion.id}::uuid and company_id=${companyId}::uuid
          `.execute(transaction);
        }
        return;
      }

      const nextVersion = versions.rows.find((version) => version.effectiveFrom > requestedDate);
      await sql`
        update employee_salary_versions
           set effective_to=${requestedDate}::date - 1,
               updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
         where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
           and effective_from < ${requestedDate}::date
           and (effective_to is null or effective_to >= ${requestedDate}::date)
      `.execute(transaction);
      await sql`
        insert into employee_salary_versions (
          company_id,employee_id,basic_salary,effective_from,effective_to,created_by_account_id
        ) values (
          ${companyId}::uuid,${employeeId}::uuid,${salary},${requestedDate}::date,
          ${nextVersion?.effectiveFrom ?? null}::date - 1,${actorId}::uuid
        )
      `.execute(transaction);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : "";
      if (["23505", "23P01"].includes(code) && message.toLowerCase().includes("salary")) {
        throw new ApplicationException(
          "employee_salary_effective_date_overlap",
          "The selected salary effective date overlaps an existing salary period",
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  public async changeStatus(
    kind: "employee" | "driver",
    id: string,
    isActive: boolean,
    reason: string,
    correlationId: string,
  ): Promise<void> {
    if (reason.trim().length === 0)
      throw new ApplicationException(
        "reason_required",
        "A reason is required",
        HttpStatus.BAD_REQUEST,
      );
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    await this.transactions.execute(async (transaction) => {
      if (kind === "employee") {
        const result = await sql<{
          id: string;
          companyUserId: string | null;
        }>`update employees set is_active=${isActive},deactivated_at=case when ${isActive} then null else now() end,updated_at=now(),version=version+1 where id=${id}::uuid and company_id=${companyId}::uuid returning id, company_user_id as "companyUserId"`.execute(
          transaction,
        );
        if (result.rows[0] === undefined)
          throw new ApplicationException(
            "employee_not_found",
            "Employee not found",
            HttpStatus.NOT_FOUND,
          );
        await sql`
          update drivers
             set account_status=${isActive ? "active" : "disabled"},
                 deactivated_at=case when ${isActive} then null else coalesce(deactivated_at, now()) end,
                 updated_at=now(),
                 version=version+1
           where employee_id=${id}::uuid
             and company_id=${companyId}::uuid
             and account_status is distinct from ${isActive ? "active" : "disabled"}
        `.execute(transaction);
        if (result.rows[0].companyUserId !== null) {
          await sql`
            update company_users
               set is_active=${isActive},
                   deactivated_at=case when ${isActive} then null else coalesce(deactivated_at, now()) end,
                   updated_at=now(),
                   version=version+1
             where id=${result.rows[0].companyUserId}::uuid
               and company_id=${companyId}::uuid
          `.execute(transaction);
          await sql`
            update accounts a
               set status=${isActive ? "active" : "disabled"},
                   updated_at=now(),
                   version=a.version+1
              from company_users cu
             where cu.id=${result.rows[0].companyUserId}::uuid
               and cu.company_id=${companyId}::uuid
               and a.id=cu.account_id
               and a.company_id=cu.company_id
               and (${isActive} or a.status <> 'locked')
          `.execute(transaction);
          await sql`
            update account_sessions s
               set revoked_at=coalesce(s.revoked_at, now())
              from company_users cu
             where cu.id=${result.rows[0].companyUserId}::uuid
               and cu.company_id=${companyId}::uuid
               and s.account_id=cu.account_id
               and s.company_id=cu.company_id
               and s.revoked_at is null
          `.execute(transaction);
        }
      } else {
        const result = await sql<{
          employeeId: string | null;
          id: string;
        }>`update drivers set account_status=${isActive ? "active" : "disabled"},deactivated_at=case when ${isActive} then null else now() end,updated_at=now(),version=version+1 where id=${id}::uuid and company_id=${companyId}::uuid returning id, employee_id as "employeeId"`.execute(
          transaction,
        );
        const driver = result.rows[0];
        if (driver === undefined)
          throw new ApplicationException(
            "driver_not_found",
            "Driver not found",
            HttpStatus.NOT_FOUND,
          );
        // The Driver record was deactivated directly (not via its Employee,
        // whose own deactivation above already disables the whole account).
        // The linked Employee's account otherwise stays fully active, so the
        // auto-provisioned Driver role must be revoked explicitly here or a
        // no-longer-a-Driver User would keep Order self-service access
        // indefinitely.
        if (!isActive && driver.employeeId !== null) {
          const account = await sql<{ accountId: string }>`
            select cu.account_id as "accountId"
              from employees e
              join company_users cu on cu.id = e.company_user_id and cu.company_id = e.company_id
             where e.id = ${driver.employeeId}::uuid and e.company_id = ${companyId}::uuid
          `.execute(transaction);
          const accountId = account.rows[0]?.accountId;
          if (accountId !== undefined) {
            const revoked = await this.driverRoles.revoke(transaction, companyId, accountId);
            if (revoked) {
              await this.audit(transaction, {
                action: "driver.role_revoked_on_deactivation",
                actorId,
                after: { accountId },
                companyId,
                correlationId,
                reason: reason.trim(),
                subjectId: id,
                subjectType: "driver",
              });
            }
          }
        }
      }
      await this.audit(transaction, {
        action: `${kind}.${isActive ? "activate" : "disable"}`,
        actorId,
        after: { status: isActive ? "active" : "disabled" },
        companyId,
        correlationId,
        reason: reason.trim(),
        subjectId: id,
        subjectType: kind,
      });
    });
  }

  public async createDocument(
    kind: "employee" | "driver",
    ownerId: string,
    input: CreateHrDocumentDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    if (
      input.issueDate !== undefined &&
      input.expiryDate !== undefined &&
      input.expiryDate < input.issueDate
    )
      throw new ApplicationException(
        "document_dates_invalid",
        "Expiry date cannot be earlier than issue date",
        HttpStatus.BAD_REQUEST,
      );
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const id = randomUUID();
    await this.transactions.execute(async (transaction) => {
      await sql`insert into hr_documents (id,company_id,employee_id,driver_id,document_type,document_number,issue_date,expiry_date,issuing_authority,description,licence_category,restrictions,created_by_account_id,updated_by_account_id) values (${id}::uuid,${companyId}::uuid,${kind === "employee" ? ownerId : null}::uuid,${kind === "driver" ? ownerId : null}::uuid,${input.documentType},${input.documentNumber?.trim() || null},${input.issueDate ?? null}::date,${input.expiryDate ?? null}::date,${input.issuingAuthority?.trim() || null},${input.description?.trim() || null},${input.licenceCategory?.trim() || null},${input.restrictions?.trim() || null},${actorId}::uuid,${actorId}::uuid)`.execute(
        transaction,
      );
      await this.audit(transaction, {
        action: "hr_document.create",
        actorId,
        after: input,
        companyId,
        correlationId,
        subjectId: id,
        subjectType: "hr_document",
      });
    });
    return { id, ...input, status: "active" };
  }

  public async createCommissionRule(
    driverId: string,
    input: CreateCommissionRuleDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const id = randomUUID();
    await this.transactions.execute(async (transaction) => {
      await sql`insert into driver_commission_rules (id,company_id,driver_id,name,commission_method,commission_basis,commission_rate,calculation_frequency,effective_from,effective_to,created_by_account_id) values (${id}::uuid,${companyId}::uuid,${driverId}::uuid,${input.name.trim()},${input.method},${input.method === "percentage" ? "service_fee" : null},${new Decimal(input.rate).toFixed(4)},${input.frequency},${input.effectiveFrom}::date,${input.effectiveTo ?? null}::date,${actorId}::uuid)`.execute(
        transaction,
      );
      await this.audit(transaction, {
        action: "driver_commission_rule.create",
        actorId,
        after: { ...input, basis: input.method === "percentage" ? "service_fee" : null },
        companyId,
        correlationId,
        subjectId: id,
        subjectType: "driver_commission_rule",
      });
    });
    return { basis: input.method === "percentage" ? "service_fee" : null, id, ...input };
  }

  public async runCommission(
    driverId: string,
    input: RunCommissionCalculationDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    if (input.periodEnd < input.periodStart)
      throw new ApplicationException(
        "commission_period_invalid",
        "Period end cannot be before period start",
        HttpStatus.BAD_REQUEST,
      );
    if (
      input.frequency === "monthly" &&
      (input.periodStart.slice(8) !== "01" ||
        new Date(`${input.periodEnd}T00:00:00Z`).getUTCDate() !==
          new Date(
            Date.UTC(Number(input.periodEnd.slice(0, 4)), Number(input.periodEnd.slice(5, 7)), 0),
          ).getUTCDate())
    )
      throw new ApplicationException(
        "commission_month_invalid",
        "Monthly calculations must use a complete calendar month",
        HttpStatus.BAD_REQUEST,
      );
    const additions = new Decimal(input.additions ?? 0);
    const deductions = new Decimal(input.deductions ?? 0);
    if ((!additions.isZero() || !deductions.isZero()) && !input.adjustmentReason?.trim())
      throw new ApplicationException(
        "adjustment_reason_required",
        "A reason is required for commission adjustments",
        HttpStatus.BAD_REQUEST,
      );
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const driverResult = await sql<{
        employeeId: string | null;
        type: string;
      }>`select employee_id as "employeeId",driver_type as type from drivers where id=${driverId}::uuid and company_id=${companyId}::uuid and account_status='active' for update`.execute(
        transaction,
      );
      const driver = driverResult.rows[0];
      if (driver === undefined)
        throw new ApplicationException(
          "driver_not_found",
          "Active Driver not found",
          HttpStatus.NOT_FOUND,
        );
      const ruleResult = await sql<{
        basis: string | null;
        id: string;
        method: "fixed" | "percentage";
        rate: string;
      }>`select id,commission_method as method,commission_basis as basis,commission_rate::text as rate from driver_commission_rules where company_id=${companyId}::uuid and driver_id=${driverId}::uuid and calculation_frequency=${input.frequency} and is_active and effective_from<=${input.periodStart}::date and coalesce(effective_to,'infinity'::date)>=${input.periodEnd}::date order by effective_from desc limit 1`.execute(
        transaction,
      );
      const rule = ruleResult.rows[0];
      if (rule === undefined)
        throw new ApplicationException(
          "commission_rule_not_found",
          "No effective commission rule covers this period",
          HttpStatus.CONFLICT,
        );
      const allocationKind =
        driver.type === "employee" && input.frequency === "daily" ? "accrual" : "payment";
      const ordersResult =
        await sql<CommissionOrder>`select o.id,o.delivered_at::date::text as "deliveredOn",o.service_fee::text as "serviceFee" from orders o where o.company_id=${companyId}::uuid and o.assigned_driver_id=${driverId}::uuid and o.delivered_at::date between ${input.periodStart}::date and ${input.periodEnd}::date and not exists(select 1 from driver_commission_orders co where co.company_id=o.company_id and co.driver_id=${driverId}::uuid and co.order_id=o.id and co.allocation_kind=${allocationKind}) order by o.delivered_at,o.id`.execute(
          transaction,
        );
      const amounts = ordersResult.rows.map((order) =>
        rule.method === "fixed"
          ? new Decimal(rule.rate)
          : new Decimal(order.serviceFee).mul(rule.rate).div(100),
      );
      const gross = amounts.reduce((sum, value) => sum.plus(value), new Decimal(0));
      const net = gross.plus(additions).minus(deductions);
      if (net.isNegative())
        throw new ApplicationException(
          "commission_negative_net",
          "Commission net payable cannot be negative",
          HttpStatus.BAD_REQUEST,
        );
      const calculationId = randomUUID();
      const reference = `COM-${randomUUID().slice(0, 8).toUpperCase()}`;
      const status =
        driver.type === "employee"
          ? input.frequency === "daily"
            ? "accrued"
            : "consumed"
          : "payable";
      await sql`insert into driver_commission_calculations (id,company_id,driver_id,commission_rule_id,calculation_reference,calculation_frequency,period_start,period_end,eligible_order_count,commission_method,commission_basis,commission_rate,gross_commission,additions,deductions,adjustment_reason,net_payable,status,created_by_account_id) values (${calculationId}::uuid,${companyId}::uuid,${driverId}::uuid,${rule.id}::uuid,${reference},${input.frequency},${input.periodStart}::date,${input.periodEnd}::date,${ordersResult.rows.length},${rule.method},${rule.basis},${rule.rate},${gross.toFixed(2)},${additions.toFixed(2)},${deductions.toFixed(2)},${input.adjustmentReason?.trim() || null},${net.toFixed(2)},${status},${actorId}::uuid)`.execute(
        transaction,
      );
      for (let index = 0; index < ordersResult.rows.length; index++) {
        const order = ordersResult.rows[index]!;
        await sql`insert into driver_commission_orders (company_id,calculation_id,driver_id,order_id,allocation_kind,delivery_date,service_fee_snapshot,commission_amount) values (${companyId}::uuid,${calculationId}::uuid,${driverId}::uuid,${order.id}::uuid,${allocationKind},${order.deliveredOn}::date,${order.serviceFee},${amounts[index]!.toFixed(2)})`.execute(
          transaction,
        );
      }
      if (
        driver.type === "employee" &&
        input.frequency === "monthly" &&
        driver.employeeId !== null
      ) {
        await this.createPayrollDraft(
          transaction,
          companyId,
          driver.employeeId,
          calculationId,
          input.periodStart,
          input.periodEnd,
          net,
          actorId,
        );
        await sql`update driver_commission_calculations set status='consumed' where company_id=${companyId}::uuid and driver_id=${driverId}::uuid and calculation_frequency='daily' and status='accrued' and period_start>=${input.periodStart}::date and period_end<=${input.periodEnd}::date`.execute(
          transaction,
        );
      }
      await this.audit(transaction, {
        action: "driver_commission.calculate",
        actorId,
        after: {
          frequency: input.frequency,
          gross: gross.toFixed(2),
          net: net.toFixed(2),
          orderCount: ordersResult.rows.length,
          reference,
          status,
        },
        companyId,
        correlationId,
        subjectId: calculationId,
        subjectType: "driver_commission_calculation",
      });
      return {
        calculationId,
        frequency: input.frequency,
        grossCommission: gross.toFixed(2),
        netPayable: net.toFixed(2),
        orderCount: ordersResult.rows.length,
        reference,
        status,
      };
    });
  }

  public async confirmOutsourcedPayment(
    calculationId: string,
    input: ConfirmOutsourcedPaymentDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const existing = await sql<{
        id: string;
      }>`select id from outsourced_driver_payments where company_id=${companyId}::uuid and idempotency_key=${input.idempotencyKey}`.execute(
        transaction,
      );
      if (existing.rows[0] !== undefined) return { paymentId: existing.rows[0].id, status: "paid" };
      const calc = await sql<{
        driverType: string;
        status: string;
      }>`select d.driver_type as "driverType",c.status from driver_commission_calculations c join drivers d on d.id=c.driver_id and d.company_id=c.company_id where c.id=${calculationId}::uuid and c.company_id=${companyId}::uuid for update`.execute(
        transaction,
      );
      if (calc.rows[0]?.driverType !== "outsourced" || calc.rows[0].status !== "payable")
        throw new ApplicationException(
          "commission_not_payable",
          "Only a payable Outsourced Driver calculation can be paid",
          HttpStatus.CONFLICT,
        );
      const payment = await sql<{
        id: string;
      }>`insert into outsourced_driver_payments (company_id,commission_calculation_id,payment_method,payment_date,company_bank_account_id,payment_reference,paid_by_account_id,idempotency_key) values (${companyId}::uuid,${calculationId}::uuid,${input.paymentMethod},${input.paymentDate}::date,${input.bankAccountId ?? null}::uuid,${input.reference?.trim() || null},${actorId}::uuid,${input.idempotencyKey}) returning id`.execute(
        transaction,
      );
      await sql`update driver_commission_calculations set status='paid',paid_by_account_id=${actorId}::uuid,paid_at=now() where id=${calculationId}::uuid and company_id=${companyId}::uuid`.execute(
        transaction,
      );
      await this.audit(transaction, {
        action: "outsourced_driver_payment.confirm",
        actorId,
        after: { method: input.paymentMethod, paymentDate: input.paymentDate },
        companyId,
        correlationId,
        subjectId: payment.rows[0]!.id,
        subjectType: "outsourced_driver_payment",
      });
      return { paymentId: payment.rows[0]!.id, status: "paid" };
    });
  }

  public async allowanceTypes(): Promise<readonly Record<string, unknown>[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<
      Record<string, unknown>
    >`select id,code,name,is_active as "isActive" from allowance_types where company_id=${companyId}::uuid order by lower(name)`.execute(
      this.database,
    );
    return result.rows;
  }
  public async createAllowanceType(
    code: string,
    name: string,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const result = await this.transactions.execute(async (transaction) => {
      const inserted = await sql<
        Record<string, unknown>
      >`insert into allowance_types(company_id,code,name) values(${companyId}::uuid,${code.trim().toUpperCase()},${name.trim()}) returning id,code,name,is_active as "isActive"`.execute(
        transaction,
      );
      await this.audit(transaction, {
        action: "allowance_type.create",
        actorId,
        after: { code, name },
        companyId,
        correlationId,
        subjectId: String(inserted.rows[0]!.id),
        subjectType: "allowance_type",
      });
      return inserted.rows[0]!;
    });
    return result;
  }

  private async entityDetail(
    kind: "employee" | "driver",
    code: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const entity =
      kind === "employee"
        ? await sql<
            Record<string, unknown>
          >`select e.*,a.id as "linked_account_id",a.username as "linked_username",
                     cu.display_name as "linked_user_name",
                     salary.effective_from::text as salary_effective_from,
                     d.driver_type,d.outsourced_fee_per_delivered_order,
                     ocr.collection_payment_type as outsourced_collection_payment_type,
                     ocr.amount::text as outsourced_collection_amount
               from employees e left join company_users cu on cu.id=e.company_user_id and cu.company_id=e.company_id
               left join accounts a on a.id=cu.account_id and a.company_id=cu.company_id
               left join drivers d on d.employee_id=e.id and d.company_id=e.company_id
               left join lateral (
                select effective_from from employee_salary_versions
                 where company_id=e.company_id and employee_id=e.id
                 order by effective_from desc limit 1
              ) salary on true
               left join lateral (
                select collection_payment_type, amount from outsourced_driver_collection_earning_rules
                 where company_id=d.company_id and driver_id=d.id and is_active and effective_to is null
                 order by effective_from desc limit 1
              ) ocr on true
             where e.company_id=${companyId}::uuid and lower(e.employee_number)=lower(${code})`.execute(
            this.database,
          )
        : await sql<
            Record<string, unknown>
          >`select * from drivers where company_id=${companyId}::uuid and lower(code)=lower(${code})`.execute(
            this.database,
          );
    const row = entity.rows[0];
    if (row === undefined)
      throw new ApplicationException(
        `${kind}_not_found`,
        `${kind === "employee" ? "Employee" : "Driver"} not found`,
        HttpStatus.NOT_FOUND,
      );
    const id = String(row.id);
    const [documents, history, rules, calculations, allowances] = await Promise.all([
      sql<
        Record<string, unknown>
      >`select h.*,case when h.expiry_date is null then 'no_expiry' when h.expiry_date<current_date then 'expired' when h.expiry_date<=current_date+coalesce(s.document_expiry_alert_days,30) then 'expiring_soon' else 'valid' end as "expiryStatus" from hr_documents h left join company_settings s on s.company_id=h.company_id where h.company_id=${companyId}::uuid and ${kind === "employee" ? sql`h.employee_id` : sql`h.driver_id`}=${id}::uuid order by h.created_at desc`.execute(
        this.database,
      ),
      sql<
        Record<string, unknown>
      >`select action,before_data as "before",after_data as "after",reason,occurred_at as "occurredAt" from audit_events where company_id=${companyId}::uuid and subject_type in (${kind},'hr_document','driver_commission_rule','driver_commission_calculation') and (subject_id=${id} or after_data->>'ownerId'=${id}) order by occurred_at desc limit 200`.execute(
        this.database,
      ),
      kind === "driver"
        ? sql<
            Record<string, unknown>
          >`select * from driver_commission_rules where company_id=${companyId}::uuid and driver_id=${id}::uuid order by effective_from desc`.execute(
            this.database,
          )
        : Promise.resolve({ rows: [] }),
      kind === "driver"
        ? sql<
            Record<string, unknown>
          >`select * from driver_commission_calculations where company_id=${companyId}::uuid and driver_id=${id}::uuid order by period_start desc`.execute(
            this.database,
          )
        : Promise.resolve({ rows: [] }),
      kind === "employee"
        ? sql<
            Record<string, unknown>
          >`select a.*,t.name as "allowanceName" from employee_allowances a join allowance_types t on t.id=a.allowance_type_id and t.company_id=a.company_id where a.company_id=${companyId}::uuid and a.employee_id=${id}::uuid order by a.effective_from desc`.execute(
            this.database,
          )
        : Promise.resolve({ rows: [] }),
    ]);
    return {
      ...row,
      allowances: allowances.rows,
      calculations: calculations.rows,
      documents: documents.rows,
      history: history.rows,
      rules: rules.rows,
    };
  }

  private page(pageValue?: string, pageSizeValue?: string) {
    const page = Math.max(1, Number.parseInt(pageValue ?? "1", 10) || 1);
    const pageSize = [25, 50, 100].includes(Number(pageSizeValue)) ? Number(pageSizeValue) : 25;
    return { offset: (page - 1) * pageSize, page, pageSize };
  }
  private async validateCommonLinks(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    areaId?: string,
    userId?: string,
  ) {
    if (areaId !== undefined) {
      const area =
        await sql`select id from areas where id=${areaId}::uuid and company_id=${companyId}::uuid and is_active`.execute(
          database,
        );
      if (area.rows[0] === undefined)
        throw new ApplicationException(
          "area_not_found",
          "Area is not active in this Company",
          HttpStatus.BAD_REQUEST,
        );
    }
    if (userId !== undefined) {
      const user =
        await sql`select id from company_users where id=${userId}::uuid and company_id=${companyId}::uuid and is_active`.execute(
          database,
        );
      if (user.rows[0] === undefined)
        throw new ApplicationException(
          "user_not_found",
          "User is not active in this Company",
          HttpStatus.BAD_REQUEST,
        );
    }
  }
  private async lockEmployee(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    id: string,
  ): Promise<{
    basicSalary: string;
    payrollEligible: boolean;
    salaryHold: boolean;
    salaryHoldFrom: string | null;
    salaryHoldReason: string | null;
    salaryHoldTo: string | null;
  }> {
    const result = await sql<{
      basicSalary: string;
      payrollEligible: boolean;
      salaryHold: boolean;
      salaryHoldFrom: string | null;
      salaryHoldReason: string | null;
      salaryHoldTo: string | null;
    }>`select basic_salary::text as "basicSalary", payroll_eligible as "payrollEligible",
              salary_hold as "salaryHold", salary_hold_reason as "salaryHoldReason",
              salary_hold_from::text as "salaryHoldFrom", salary_hold_to::text as "salaryHoldTo"
         from employees where id=${id}::uuid and company_id=${companyId}::uuid for update`.execute(
      database,
    );
    if (result.rows[0] === undefined)
      throw new ApplicationException(
        "employee_not_found",
        "Employee not found",
        HttpStatus.NOT_FOUND,
      );
    return result.rows[0];
  }
  private async createPayrollDraft(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    employeeId: string,
    calculationId: string,
    start: string,
    end: string,
    commission: Decimal,
    actorId: string,
  ) {
    const salary = await sql<{
      amount: string;
      id: string;
    }>`select id,basic_salary::text as amount from employee_salary_versions where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid and effective_from<=${end}::date and coalesce(effective_to,'infinity'::date)>=${end}::date order by effective_from desc limit 1`.execute(
      database,
    );
    const allowances = await sql<{
      amount: string;
    }>`select coalesce(sum(amount),0)::text as amount from employee_allowances where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid and is_active and effective_from<=${end}::date and coalesce(effective_to,'infinity'::date)>=${end}::date`.execute(
      database,
    );
    const basic = new Decimal(salary.rows[0]?.amount ?? 0);
    const allowance = new Decimal(allowances.rows[0]?.amount ?? 0);
    const employee = await sql<{
      employeeNumber: string;
      employeeType: string | null;
      nameAr: string | null;
      nameEn: string;
      salaryHold: boolean;
    }>`select employee_number as "employeeNumber",name_en as "nameEn",name_ar as "nameAr",
              employee_type as "employeeType",salary_hold as "salaryHold"
         from employees where id=${employeeId}::uuid and company_id=${companyId}::uuid`.execute(
      database,
    );
    const employeeSnapshot = employee.rows[0]!;
    const gross = basic.plus(allowance).plus(commission);
    const period = await sql<{
      id: string;
    }>`insert into payroll_periods(company_id,period_reference,payroll_month,period_start,period_end,created_by_account_id)
       values(${companyId}::uuid,${`PAY-${start.slice(0, 7)}`},date_trunc('month',${start}::date)::date,${start}::date,${end}::date,${actorId}::uuid)
       on conflict(company_id,period_start,period_end) do update set period_start=excluded.period_start
       returning id`.execute(database);
    const payrollId = randomUUID();
    await sql`insert into payroll_entries(
      id,company_id,payroll_number,payroll_period_id,employee_id,
      employee_number_snapshot,employee_name_snapshot,employee_name_ar_snapshot,
      employment_type_snapshot,salary_version_id,basic_salary_snapshot,
      employee_driver_commission,allowance_total,earning_adjustments_total,
      deduction_adjustments_total,advances,gross_earnings,net_salary,amount_paid,
      outstanding_amount,salary_hold_snapshot,status,source_marker,
      created_by_account_id,calculated_by_account_id,calculated_at
    ) values(
      ${payrollId}::uuid,${companyId}::uuid,
      ${`PAY-${start.slice(0, 7).replace("-", "")}-${employeeId.slice(0, 6).toUpperCase()}`},
      ${period.rows[0]!.id}::uuid,${employeeId}::uuid,
      ${employeeSnapshot.employeeNumber},${employeeSnapshot.nameEn},${employeeSnapshot.nameAr},
      ${employeeSnapshot.employeeType},${salary.rows[0]?.id ?? null}::uuid,${basic.toFixed(2)},
      ${commission.toFixed(2)},${allowance.toFixed(2)},0,0,0,${gross.toFixed(2)},
      ${gross.toFixed(2)},0,${gross.toFixed(2)},${employeeSnapshot.salaryHold},
      'draft','legacy',${actorId}::uuid,${actorId}::uuid,now()
    ) on conflict(company_id,payroll_period_id,employee_id) do update set
      employee_driver_commission=payroll_entries.employee_driver_commission+excluded.employee_driver_commission,
      gross_earnings=payroll_entries.gross_earnings+excluded.employee_driver_commission,
      net_salary=payroll_entries.net_salary+excluded.employee_driver_commission,
      outstanding_amount=payroll_entries.outstanding_amount+excluded.employee_driver_commission,
      updated_at=now(),version=payroll_entries.version+1
    returning id`.execute(database);
    const actual = await sql<{
      id: string;
    }>`select id from payroll_entries where company_id=${companyId}::uuid and payroll_period_id=${period.rows[0]!.id}::uuid and employee_id=${employeeId}::uuid`.execute(
      database,
    );
    await sql`insert into payroll_commission_links(company_id,payroll_entry_id,commission_calculation_id,amount,source_marker) values(${companyId}::uuid,${actual.rows[0]!.id}::uuid,${calculationId}::uuid,${commission.toFixed(2)},'legacy')`.execute(
      database,
    );
  }
  private async audit(
    database: Kysely<DatabaseSchema>,
    input: {
      action: string;
      actorId: string;
      after: unknown;
      companyId: string;
      correlationId: string;
      reason?: string;
      subjectId: string;
      subjectType: string;
    },
  ) {
    await sql`insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,reason,after_data,correlation_id) values(${input.companyId}::uuid,${input.actorId}::uuid,${input.action},${input.subjectType},${input.subjectId},${input.reason ?? null},${JSON.stringify(input.after)}::jsonb,${input.correlationId})`.execute(
      database,
    );
  }
}
