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
      // Outsourced only applies to driver roles; everyone else is salaried.
      const engagement =
        isDriverRole && input.engagement === "outsourced" ? "outsourced" : "employee";
      // Outsourced staff carry no salary.
      const salary = new Decimal(engagement === "outsourced" ? 0 : (input.basicSalary ?? 0)).toFixed(
        2,
      );
      const effectiveFrom = input.salaryEffectiveFrom ?? null;

      if (id === undefined) {
        employeeCode = await this.nextGeneratedCode(transaction, companyId, "employee", "EMP");
        await sql`insert into employees (
          id, company_id, company_user_id, employee_role_id, employee_number, name_en, mobile_number,
          second_mobile_number, email, address, area_id, date_of_birth, nationality,
          hired_on, job_title, department, basic_salary, notes
        ) values (
          ${employeeId}::uuid, ${companyId}::uuid, ${input.userId ?? null}::uuid,
          ${input.employeeRoleId}::uuid, ${employeeCode}, ${input.name.trim()}, ${input.mobileNumber.trim()},
          ${input.secondMobileNumber?.trim() || null}, ${input.email?.trim() || null},
          ${input.address?.trim() || null}, ${input.areaId ?? null}::uuid, ${input.dateOfBirth ?? null}::date,
          ${input.nationality?.trim() || null}, ${input.joiningDate ?? null}::date,
          ${input.jobTitle?.trim() || null}, ${input.department?.trim() || null},
          ${salary}, ${input.notes?.trim() || null}
        )`.execute(transaction);
      } else {
        await this.lockEmployee(transaction, companyId, employeeId);
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
          basic_salary=${salary}, notes=${input.notes?.trim() || null},
          updated_at=now(), version=version+1 where id=${employeeId}::uuid and company_id=${companyId}::uuid`.execute(
          transaction,
        );
        await sql`update employee_allowances set is_active=false, updated_at=now(), version=version+1
          where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid and is_active`.execute(
          transaction,
        );
      }

      // Record the salary as a version. If one already starts on this effective
      // date, update it in place; otherwise close any strictly-earlier open
      // version and open a new one. Closing is guarded by `effective_from <`
      // the new date so a version is never end-dated before its own start,
      // which would violate the date-range check.
      const sameDay = await sql<{ id: string }>`
        select id from employee_salary_versions
         where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
           and effective_from=coalesce(${effectiveFrom}::date, current_date)
      `.execute(transaction);
      if (sameDay.rows[0] !== undefined) {
        await sql`update employee_salary_versions set basic_salary=${salary}
           where id=${sameDay.rows[0].id}::uuid and company_id=${companyId}::uuid`.execute(
          transaction,
        );
      } else {
        await sql`update employee_salary_versions
           set effective_to=coalesce(${effectiveFrom}::date, current_date) - 1
           where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
             and effective_to is null
             and effective_from < coalesce(${effectiveFrom}::date, current_date)`.execute(transaction);
        await sql`insert into employee_salary_versions (company_id,employee_id,basic_salary,effective_from,created_by_account_id)
          values (${companyId}::uuid,${employeeId}::uuid,${salary},coalesce(${effectiveFrom}::date, current_date),${actorId}::uuid)`.execute(
          transaction,
        );
      }
      for (const allowance of input.allowances ?? []) {
        await sql`insert into employee_allowances (company_id,employee_id,allowance_type_id,amount,effective_from,effective_to,created_by_account_id)
          values (${companyId}::uuid,${employeeId}::uuid,${allowance.allowanceTypeId}::uuid,${new Decimal(allowance.amount).toFixed(2)},${allowance.effectiveFrom}::date,${allowance.effectiveTo ?? null}::date,${actorId}::uuid)`.execute(
          transaction,
        );
      }

      // A driver-role Employee is also an operational Driver.
      if (isDriverRole) {
        await this.linkDriverForEmployee(
          transaction,
          companyId,
          employeeId,
          input,
          engagement,
        );
      }

      await this.audit(transaction, {
        action: id === undefined ? "employee.create" : "employee.update",
        actorId,
        after: { code: employeeCode, engagement, name: input.name, salary },
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
    input: SaveEmployeeDto,
    engagement: "employee" | "outsourced",
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
      await sql`insert into drivers (company_id, employee_id, code, name_en, mobile_number,
        second_mobile_number, email, address, area_id, driver_type, account_status,
        outsourced_fee_per_delivered_order, notes)
        values (${companyId}::uuid, ${employeeId}::uuid, ${code}, ${input.name.trim()},
        ${input.mobileNumber.trim()}, ${input.secondMobileNumber?.trim() || null},
        ${input.email?.trim() || null}, ${input.address?.trim() || null}, ${input.areaId ?? null}::uuid,
        ${engagement}, 'active', ${outsourcedFee}, ${input.notes?.trim() || null})`.execute(
        transaction,
      );
    } else {
      await sql`update drivers set name_en=${input.name.trim()}, mobile_number=${input.mobileNumber.trim()},
        second_mobile_number=${input.secondMobileNumber?.trim() || null}, email=${input.email?.trim() || null},
        address=${input.address?.trim() || null}, area_id=${input.areaId ?? null}::uuid,
        driver_type=${engagement}, outsourced_fee_per_delivered_order=${outsourcedFee},
        notes=${input.notes?.trim() || null}, updated_at=now(), version=version+1
        where id=${existing.rows[0].id}::uuid and company_id=${companyId}::uuid`.execute(transaction);
    }
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
    // Derive a stable code from the name; the operator only types the name.
    const code =
      name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "ROLE";
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
          : (
              await sql<{ employeeId: string | null }>`
                select employee_id as "employeeId" from drivers
                 where id=${driverId}::uuid and company_id=${companyId}::uuid
              `.execute(transaction)
            ).rows[0]?.employeeId ?? undefined;

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
      const before = await this.lockEmployee(transaction, companyId, id);
      await sql`update employees set company_user_id=${input.userId ?? null}::uuid,
        name_en=${input.name.trim()}, mobile_number=${input.mobileNumber.trim()},
        second_mobile_number=${input.secondMobileNumber?.trim() || null},
        email=${input.email?.trim() || null}, address=${input.address?.trim() || null},
        area_id=${input.areaId ?? null}::uuid, job_title=${input.jobTitle?.trim() || null},
        department=${input.department?.trim() || null}, basic_salary=${salary},
        notes=${input.notes?.trim() || null}, updated_at=now(), version=version+1
        where id=${id}::uuid and company_id=${companyId}::uuid`.execute(transaction);
      if (!new Decimal(before.basicSalary).equals(salary)) {
        await sql`update employee_salary_versions
          set effective_to=coalesce(${effectiveFrom}::date, current_date) - 1
          where company_id=${companyId}::uuid and employee_id=${id}::uuid and effective_to is null`.execute(
          transaction,
        );
      }
      await sql`update employee_allowances set is_active=false, updated_at=now(), version=version+1
        where company_id=${companyId}::uuid and employee_id=${id}::uuid and is_active`.execute(
        transaction,
      );
    }

    const salaryExists = await sql<{ exists: boolean }>`
      select exists(
        select 1 from employee_salary_versions
         where company_id=${companyId}::uuid and employee_id=${id}::uuid
           and effective_from=coalesce(${effectiveFrom}::date, current_date)
      ) as exists
    `.execute(transaction);
    if (!salaryExists.rows[0]?.exists) {
      await sql`insert into employee_salary_versions (company_id,employee_id,basic_salary,effective_from,created_by_account_id)
        values (${companyId}::uuid,${id}::uuid,${salary},coalesce(${effectiveFrom}::date, current_date),${actorId}::uuid)`.execute(
        transaction,
      );
    }
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
        }>`update employees set is_active=${isActive},deactivated_at=case when ${isActive} then null else now() end,updated_at=now(),version=version+1 where id=${id}::uuid and company_id=${companyId}::uuid returning id`.execute(
          transaction,
        );
        if (result.rows[0] === undefined)
          throw new ApplicationException(
            "employee_not_found",
            "Employee not found",
            HttpStatus.NOT_FOUND,
          );
      } else {
        const result = await sql<{
          id: string;
        }>`update drivers set account_status=${isActive ? "active" : "disabled"},deactivated_at=case when ${isActive} then null else now() end,updated_at=now(),version=version+1 where id=${id}::uuid and company_id=${companyId}::uuid returning id`.execute(
          transaction,
        );
        if (result.rows[0] === undefined)
          throw new ApplicationException(
            "driver_not_found",
            "Driver not found",
            HttpStatus.NOT_FOUND,
          );
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
          >`select e.*,a.id as "linked_account_id",a.username as "linked_username",cu.display_name as "linked_user_name"
              from employees e left join company_users cu on cu.id=e.company_user_id and cu.company_id=e.company_id
              left join accounts a on a.id=cu.account_id and a.company_id=cu.company_id
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
  ): Promise<{ basicSalary: string }> {
    const result = await sql<{
      basicSalary: string;
    }>`select basic_salary::text as "basicSalary" from employees where id=${id}::uuid and company_id=${companyId}::uuid for update`.execute(
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
    }>`select basic_salary::text as amount from employee_salary_versions where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid and effective_from<=${end}::date and coalesce(effective_to,'infinity'::date)>=${end}::date order by effective_from desc limit 1`.execute(
      database,
    );
    const allowances = await sql<{
      amount: string;
    }>`select coalesce(sum(amount),0)::text as amount from employee_allowances where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid and is_active and effective_from<=${end}::date and coalesce(effective_to,'infinity'::date)>=${end}::date`.execute(
      database,
    );
    const basic = new Decimal(salary.rows[0]?.amount ?? 0);
    const allowance = new Decimal(allowances.rows[0]?.amount ?? 0);
    const period = await sql<{
      id: string;
    }>`insert into payroll_periods(company_id,period_start,period_end) values(${companyId}::uuid,${start}::date,${end}::date) on conflict(company_id,period_start,period_end) do update set period_start=excluded.period_start returning id`.execute(
      database,
    );
    const payrollId = randomUUID();
    await sql`insert into payroll_entries(id,company_id,payroll_number,payroll_period_id,employee_id,basic_salary,delivered_order_commission,allowances,deductions,advances,total_salary,status,created_by_account_id) values(${payrollId}::uuid,${companyId}::uuid,${`PAY-${start.slice(0, 7).replace("-", "")}-${employeeId.slice(0, 6).toUpperCase()}`},${period.rows[0]!.id}::uuid,${employeeId}::uuid,${basic.toFixed(2)},${commission.toFixed(2)},${allowance.toFixed(2)},0,0,${basic.plus(allowance).plus(commission).toFixed(2)},'draft',${actorId}::uuid) on conflict(company_id,payroll_period_id,employee_id) do update set delivered_order_commission=payroll_entries.delivered_order_commission+excluded.delivered_order_commission,total_salary=payroll_entries.total_salary+excluded.delivered_order_commission returning id`.execute(
      database,
    );
    const actual = await sql<{
      id: string;
    }>`select id from payroll_entries where company_id=${companyId}::uuid and payroll_period_id=${period.rows[0]!.id}::uuid and employee_id=${employeeId}::uuid`.execute(
      database,
    );
    await sql`insert into payroll_commission_links(company_id,payroll_entry_id,commission_calculation_id,amount) values(${companyId}::uuid,${actual.rows[0]!.id}::uuid,${calculationId}::uuid,${commission.toFixed(2)})`.execute(
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
