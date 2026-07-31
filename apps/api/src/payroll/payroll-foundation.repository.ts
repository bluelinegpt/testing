import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

export interface EffectiveSalary {
  readonly basicSalary: string;
  readonly id: string;
}

export interface EffectiveAllowance {
  readonly allowanceCode: string;
  readonly allowanceName: string;
  readonly allowanceNameAr: string | null;
  readonly allowanceTypeId: string;
  readonly amount: string;
  readonly employeeAllowanceId: string;
}

/**
 * Read-only foundation queries shared by later Payroll services. They require
 * Company ID explicitly and expose no HTTP routes.
 */
@Injectable()
export class PayrollFoundationRepository {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async effectiveSalary(
    companyId: string,
    employeeId: string,
    effectiveOn: string,
  ): Promise<EffectiveSalary | undefined> {
    const result = await sql<EffectiveSalary>`
      select id, basic_salary::text as "basicSalary"
        from employee_salary_versions
       where company_id = ${companyId}::uuid and employee_id = ${employeeId}::uuid
         and effective_from <= ${effectiveOn}::date
         and coalesce(effective_to, 'infinity'::date) >= ${effectiveOn}::date
       order by effective_from desc
       limit 1
    `.execute(this.database);
    return result.rows[0];
  }

  public async effectiveAllowances(
    companyId: string,
    employeeId: string,
    effectiveOn: string,
  ): Promise<readonly EffectiveAllowance[]> {
    const result = await sql<EffectiveAllowance>`
      select a.id as "employeeAllowanceId", a.allowance_type_id as "allowanceTypeId",
             t.code as "allowanceCode", t.name as "allowanceName",
             t.name_ar as "allowanceNameAr", a.amount::text as amount
        from employee_allowances a
        join allowance_types t on t.id = a.allowance_type_id and t.company_id = a.company_id
       where a.company_id = ${companyId}::uuid and a.employee_id = ${employeeId}::uuid
         and a.is_active and a.effective_from <= ${effectiveOn}::date
         and coalesce(a.effective_to, 'infinity'::date) >= ${effectiveOn}::date
       order by t.code, a.id
    `.execute(this.database);
    return result.rows;
  }

  public async salaryVersionUsedByApprovedPayroll(
    companyId: string,
    salaryVersionId: string,
  ): Promise<boolean> {
    const result = await sql<{ used: boolean }>`
      select exists(
        select 1 from payroll_entries p
         where p.company_id = ${companyId}::uuid
           and p.salary_version_id = ${salaryVersionId}::uuid
           and p.status in ('approved','partially_paid','paid','held','reversed')
      ) as used
    `.execute(this.database);
    return result.rows[0]?.used ?? false;
  }

  public async employeeAllowanceUsedByApprovedPayroll(
    companyId: string,
    employeeAllowanceId: string,
  ): Promise<boolean> {
    const result = await sql<{ used: boolean }>`
      select exists(
        select 1
          from payroll_line_allowances a
          join payroll_entries p on p.id = a.payroll_line_id and p.company_id = a.company_id
         where a.company_id = ${companyId}::uuid
           and a.source_employee_allowance_id = ${employeeAllowanceId}::uuid
           and p.status in ('approved','partially_paid','paid','held','reversed')
      ) as used
    `.execute(this.database);
    return result.rows[0]?.used ?? false;
  }
}
