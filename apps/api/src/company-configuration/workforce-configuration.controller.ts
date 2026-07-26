import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import type {
  EmployeeSummary,
  DriverSummary,
  WorkforcePage,
} from "./workforce-configuration.service.js";
import { WorkforceConfigurationService } from "./workforce-configuration.service.js";
// Runtime classes are required by Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ChangeWorkforceStatusDto,
  ConfirmOutsourcedPaymentDto,
  CreateAllowanceTypeDto,
  CreateEmployeeRoleDto,
  CreateCommissionRuleDto,
  CreateHrDocumentDto,
  RunCommissionCalculationDto,
  SaveDriverDto,
  SaveEmployeeDto,
} from "./workforce-configuration.dto.js";

@ApiTags("workforce-configuration")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequireAnyPermission("users_roles.manage")
@Controller("configuration")
export class WorkforceConfigurationController {
  public constructor(
    @Inject(WorkforceConfigurationService)
    private readonly workforce: WorkforceConfigurationService,
  ) {}

  @Get("employees")
  @ApiOperation({ summary: "List Company Employees" })
  public employees(
    @Query() query: Record<string, string>,
  ): Promise<WorkforcePage<EmployeeSummary>> {
    return this.workforce.employees(query);
  }

  @Post("employees")
  public createEmployee(
    @Body() input: SaveEmployeeDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.createEmployee(input, this.correlationId(request));
  }

  @Get("employees/:code")
  public employee(@Param("code") code: string): Promise<Record<string, unknown>> {
    return this.workforce.employee(code);
  }

  @Patch("employees/:employeeId")
  public updateEmployee(
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body() input: SaveEmployeeDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.updateEmployee(employeeId, input, this.correlationId(request));
  }

  @Patch("employees/:employeeId/status")
  public employeeStatus(
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body() input: ChangeWorkforceStatusDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.workforce.changeStatus(
      "employee",
      employeeId,
      input.isActive,
      input.reason,
      this.correlationId(request),
    );
  }

  @Post("employees/:employeeId/documents")
  public employeeDocument(
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body() input: CreateHrDocumentDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.createDocument(
      "employee",
      employeeId,
      input,
      this.correlationId(request),
    );
  }

  @Get("drivers")
  @ApiOperation({ summary: "List Company Drivers" })
  public drivers(@Query() query: Record<string, string>): Promise<WorkforcePage<DriverSummary>> {
    return this.workforce.drivers(query);
  }

  @Post("drivers")
  public createDriver(
    @Body() input: SaveDriverDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.createDriver(input, this.correlationId(request));
  }

  @Get("drivers/:code")
  public driver(@Param("code") code: string): Promise<Record<string, unknown>> {
    return this.workforce.driver(code);
  }

  @Patch("drivers/:driverId")
  public updateDriver(
    @Param("driverId", new ParseUUIDPipe()) driverId: string,
    @Body() input: SaveDriverDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.updateDriver(driverId, input, this.correlationId(request));
  }

  @Patch("drivers/:driverId/status")
  public driverStatus(
    @Param("driverId", new ParseUUIDPipe()) driverId: string,
    @Body() input: ChangeWorkforceStatusDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.workforce.changeStatus(
      "driver",
      driverId,
      input.isActive,
      input.reason,
      this.correlationId(request),
    );
  }

  @Post("drivers/:driverId/documents")
  public driverDocument(
    @Param("driverId", new ParseUUIDPipe()) driverId: string,
    @Body() input: CreateHrDocumentDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.createDocument("driver", driverId, input, this.correlationId(request));
  }

  @Post("drivers/:driverId/commission-rules")
  public commissionRule(
    @Param("driverId", new ParseUUIDPipe()) driverId: string,
    @Body() input: CreateCommissionRuleDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.createCommissionRule(driverId, input, this.correlationId(request));
  }

  @Post("drivers/:driverId/commission-calculations")
  public calculateCommission(
    @Param("driverId", new ParseUUIDPipe()) driverId: string,
    @Body() input: RunCommissionCalculationDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.runCommission(driverId, input, this.correlationId(request));
  }

  @Post("commission-calculations/:calculationId/pay")
  public payOutsourced(
    @Param("calculationId", new ParseUUIDPipe()) calculationId: string,
    @Body() input: ConfirmOutsourcedPaymentDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.confirmOutsourcedPayment(
      calculationId,
      input,
      this.correlationId(request),
    );
  }

  @Get("allowance-types")
  public allowanceTypes(): Promise<readonly Record<string, unknown>[]> {
    return this.workforce.allowanceTypes();
  }

  @Post("allowance-types")
  public createAllowanceType(
    @Body() input: CreateAllowanceTypeDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.createAllowanceType(input.code, input.name, this.correlationId(request));
  }

  @Get("employee-roles")
  public employeeRoles(): Promise<readonly Record<string, unknown>[]> {
    return this.workforce.employeeRoles();
  }

  @Post("employee-roles")
  public createEmployeeRole(
    @Body() input: CreateEmployeeRoleDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.workforce.createEmployeeRole(input, this.correlationId(request));
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
