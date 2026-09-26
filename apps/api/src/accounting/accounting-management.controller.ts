import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
// Imported as values, not types: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to runtime,
// so these query/body contracts are actually validated.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AccountingConfigurationDto,
  AccountingReasonDto,
  AccountMutationDto,
  AccountUpdateDto,
  CloseAccountMappingDto,
  CreateAccountMappingDto,
  CreateFiscalPeriodDto,
  CreateFiscalYearDto,
  GenerateFiscalPeriodsDto,
} from "./accounting.dto.js";
import { AccountingManagementService } from "./accounting-management.service.js";
import { AccountingQueryService } from "./accounting-query.service.js";
import { FiscalCalendarService } from "./fiscal-calendar.service.js";
import { AccountingSetupService } from "./accounting-setup.service.js";
// Imported as a value, not a type: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to runtime,
// so this query contract is actually validated.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AccountingActivationDto } from "./accounting-setup.dto.js";

@ApiTags("accounting")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/accounting")
export class AccountingManagementController {
  public constructor(
    @Inject(AccountingManagementService)
    private readonly management: AccountingManagementService,
    @Inject(AccountingQueryService)
    private readonly queries: AccountingQueryService,
    @Inject(FiscalCalendarService)
    private readonly calendar: FiscalCalendarService,
    @Inject(AccountingSetupService)
    private readonly setup: AccountingSetupService,
  ) {}

  @Post("configuration")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public createConfiguration(
    @Body() input: AccountingConfigurationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.createConfiguration(input, key);
  }

  @Patch("configuration")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public updateConfiguration(
    @Body() input: AccountingConfigurationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.updateConfiguration(input, key);
  }

  @Get("configuration/completeness")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public completeness() {
    return this.setup.configurationCompleteness();
  }

  @Post("configuration/enable-manual-accounting")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public enableManual(
    @Body() input: AccountingActivationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.setup.activateManualAccounting(input, key);
  }

  @Get("mappings")
  @RequireAnyPermission("accounting.view", "accounting.configuration.manage", "users_roles.manage")
  public mappings() {
    return this.management.mappings();
  }

  @Post("mappings")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public createMapping(
    @Body() input: CreateAccountMappingDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.createMapping(input, key);
  }

  @Patch("mappings/:mappingId")
  @RequireAnyPermission("accounting.configuration.manage", "users_roles.manage")
  public closeMapping(
    @Param("mappingId", new ParseUUIDPipe()) mappingId: string,
    @Body() input: CloseAccountMappingDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.closeMapping(mappingId, input, key);
  }

  @Get("accounts/hierarchy")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public accountHierarchy() {
    return this.management.accountHierarchy();
  }

  @Get("accounts/:accountId/dependencies")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public accountDependencies(@Param("accountId", new ParseUUIDPipe()) accountId: string) {
    return this.management.accountDependencies(accountId);
  }

  @Post("accounts")
  @RequireAnyPermission("accounting.chart_of_accounts.manage", "users_roles.manage")
  public createAccount(
    @Body() input: AccountMutationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.createAccount(input, key);
  }

  @Patch("accounts/:accountId")
  @RequireAnyPermission("accounting.chart_of_accounts.manage", "users_roles.manage")
  public updateAccount(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: AccountUpdateDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.updateAccount(accountId, input, key);
  }

  @Post("accounts/:accountId/activate")
  @RequireAnyPermission("accounting.chart_of_accounts.manage", "users_roles.manage")
  public activateAccount(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: AccountingReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.setAccountActive(accountId, true, input.reason, key);
  }

  @Post("accounts/:accountId/deactivate")
  @RequireAnyPermission("accounting.chart_of_accounts.manage", "users_roles.manage")
  public deactivateAccount(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: AccountingReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.setAccountActive(accountId, false, input.reason, key);
  }

  @Get("fiscal-years/:fiscalYearId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public fiscalYear(@Param("fiscalYearId", new ParseUUIDPipe()) fiscalYearId: string) {
    return this.queries.fiscalYear(fiscalYearId);
  }

  @Get("fiscal-years/:fiscalYearId/dependencies")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public fiscalYearDependencies(@Param("fiscalYearId", new ParseUUIDPipe()) fiscalYearId: string) {
    return this.calendar.yearDependencies(fiscalYearId);
  }

  @Post("fiscal-years")
  @RequireAnyPermission("accounting.periods.manage", "users_roles.manage")
  public createFiscalYear(
    @Body() input: CreateFiscalYearDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.calendar.createFiscalYear(input, key);
  }

  @Post("fiscal-years/:fiscalYearId/open")
  @RequireAnyPermission("accounting.periods.manage", "users_roles.manage")
  public openFiscalYear(
    @Param("fiscalYearId", new ParseUUIDPipe()) id: string,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.calendar.transitionFiscalYear(id, "open", undefined, key);
  }

  @Post("fiscal-years/:fiscalYearId/close")
  @RequireAnyPermission("accounting.periods.manage", "users_roles.manage")
  public closeFiscalYear(
    @Param("fiscalYearId", new ParseUUIDPipe()) id: string,
    @Body() input: AccountingReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.calendar.transitionFiscalYear(id, "closed", input.reason, key);
  }

  @Post("fiscal-years/:fiscalYearId/reopen")
  @RequireAnyPermission("accounting.periods.manage", "users_roles.manage")
  public reopenFiscalYear(
    @Param("fiscalYearId", new ParseUUIDPipe()) id: string,
    @Body() input: AccountingReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.calendar.transitionFiscalYear(id, "reopened", input.reason, key);
  }

  @Get("fiscal-periods/:periodId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public fiscalPeriod(@Param("periodId", new ParseUUIDPipe()) periodId: string) {
    return this.queries.fiscalPeriod(periodId);
  }

  @Get("fiscal-periods/:periodId/dependencies")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public fiscalPeriodDependencies(@Param("periodId", new ParseUUIDPipe()) periodId: string) {
    return this.calendar.periodDependencies(periodId);
  }

  @Post("fiscal-periods")
  @RequireAnyPermission("accounting.periods.manage", "users_roles.manage")
  public createFiscalPeriod(
    @Body() input: CreateFiscalPeriodDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.calendar.createFiscalPeriod(input, key);
  }

  @Post("fiscal-periods/generate")
  @RequireAnyPermission("accounting.periods.manage", "users_roles.manage")
  public generateFiscalPeriods(
    @Body() input: GenerateFiscalPeriodsDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.calendar.generateFiscalPeriods(input, key);
  }

  @Post("fiscal-periods/:periodId/open")
  @RequireAnyPermission("accounting.periods.manage", "users_roles.manage")
  public openPeriod(
    @Param("periodId", new ParseUUIDPipe()) id: string,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.calendar.transitionPeriod(id, "open", undefined, key);
  }

  @Post("fiscal-periods/:periodId/soft-close")
  @RequireAnyPermission("accounting.periods.manage", "users_roles.manage")
  public softClosePeriod(
    @Param("periodId", new ParseUUIDPipe()) id: string,
    @Body() input: AccountingReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.calendar.transitionPeriod(id, "soft_closed", input.reason, key);
  }

  @Post("fiscal-periods/:periodId/close")
  @RequireAnyPermission("accounting.periods.manage", "users_roles.manage")
  public closePeriod(
    @Param("periodId", new ParseUUIDPipe()) id: string,
    @Body() input: AccountingReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.calendar.transitionPeriod(id, "closed", input.reason, key);
  }

  @Post("fiscal-periods/:periodId/reopen")
  @RequireAnyPermission("accounting.periods.manage", "users_roles.manage")
  public reopenPeriod(
    @Param("periodId", new ParseUUIDPipe()) id: string,
    @Body() input: AccountingReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.calendar.transitionPeriod(id, "reopened", input.reason, key);
  }
}
