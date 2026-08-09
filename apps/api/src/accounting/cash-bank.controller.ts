import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { CashBankManagementService } from "./cash-bank-management.service.js";
import { CashBankQueryService } from "./cash-bank-query.service.js";
// Imported as a value, not a type: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to runtime,
// so the new query contract is actually validated.
import { CashBankMovementPreviewQueryDto } from "./cash-bank.dto.js";
import type {
  BankAccountMutationDto,
  CashAccountMutationDto,
  CashBankAttachmentDto,
  CashBankBackfillPreviewDto,
  CashBankConfirmDto,
  CashBankListQueryDto,
  CashBankMovementMutationDto,
  CashBankReasonDto,
  CashBankReverseDto,
} from "./cash-bank.dto.js";

@ApiTags("cash-bank-management")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/accounting/cash-bank")
export class CashBankController {
  public constructor(
    @Inject(CashBankManagementService)
    private readonly management: CashBankManagementService,
    @Inject(CashBankQueryService)
    private readonly queries: CashBankQueryService,
  ) {}

  @Get("cash-accounts")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public cashAccounts(
    @Query("activeOnly", new ParseBoolPipe({ optional: true })) active?: boolean,
  ) {
    return this.management.cashAccounts(active);
  }

  @Post("cash-accounts")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public createCash(
    @Body() input: CashAccountMutationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.createCashAccount(input, key);
  }

  @Patch("cash-accounts/:id")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public updateCash(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CashAccountMutationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.updateCashAccount(id, input, key);
  }

  @Get("cash-accounts/:id/dependencies")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public cashDependencies(@Param("id", ParseUUIDPipe) id: string) {
    return this.management.dependencies("cash", id);
  }

  @Get("cash-accounts/:id")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public cashAccount(@Param("id", ParseUUIDPipe) id: string) {
    return this.management.account("cash", id);
  }

  @Post("cash-accounts/:id/activate")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public activateCash(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CashBankReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.setAccountActive("cash", id, true, input.reason, key);
  }

  @Post("cash-accounts/:id/deactivate")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public deactivateCash(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CashBankReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.setAccountActive("cash", id, false, input.reason, key);
  }

  @Get("bank-accounts")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public bankAccounts(
    @Query("activeOnly", new ParseBoolPipe({ optional: true })) active?: boolean,
  ) {
    return this.management.bankAccounts(active);
  }

  @Post("bank-accounts")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public createBank(
    @Body() input: BankAccountMutationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.createBankAccount(input, key);
  }

  @Patch("bank-accounts/:id")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public updateBank(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: BankAccountMutationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.updateBankAccount(id, input, key);
  }

  @Get("bank-accounts/:id/dependencies")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public bankDependencies(@Param("id", ParseUUIDPipe) id: string) {
    return this.management.dependencies("bank", id);
  }

  @Get("bank-accounts/:id")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public bankAccount(@Param("id", ParseUUIDPipe) id: string) {
    return this.management.account("bank", id);
  }

  @Post("bank-accounts/:id/activate")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public activateBank(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CashBankReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.setAccountActive("bank", id, true, input.reason, key);
  }

  @Post("bank-accounts/:id/deactivate")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public deactivateBank(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CashBankReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.setAccountActive("bank", id, false, input.reason, key);
  }

  @Get("summary")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public summary() {
    return this.queries.summary();
  }

  @Get("balances")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public balances() {
    return this.queries.balances();
  }

  @Get("reconciliation")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public reconciliation() {
    return this.queries.reconciliation();
  }

  @Post("reconciliation/preview-backfill")
  @RequireAnyPermission("accounting.manage", "accounting.post", "users_roles.manage")
  public previewBackfill(@Body() input: CashBankBackfillPreviewDto) {
    return this.queries.previewBackfill(input);
  }

  @Get("cash-accounts/:id/ledger")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public cashLedger(@Param("id", ParseUUIDPipe) id: string, @Query() query: CashBankListQueryDto) {
    return this.queries.ledger("cash", id, query);
  }

  @Get("bank-accounts/:id/ledger")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public bankLedger(@Param("id", ParseUUIDPipe) id: string, @Query() query: CashBankListQueryDto) {
    return this.queries.ledger("bank", id, query);
  }

  // Currency, Company today, active Cash/Bank Accounts, the Movement Types
  // this backend supports with the account shape each needs, and the Company
  // Segregation policy. Read-only.
  @Get("movement-context")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public movementContext() {
    return this.queries.movementContext();
  }

  // Read-only: describes the Journal confirmation WOULD post for a Movement
  // that need not exist yet. Creates no Movement, Journal or Accounting Event.
  @Get("movement-preview")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public movementPreview(@Query() query: CashBankMovementPreviewQueryDto) {
    return this.queries.movementPreview(query);
  }

  @Get("movements")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public list(@Query() query: CashBankListQueryDto) {
    return this.queries.list(query);
  }

  @Post("movements")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public create(
    @Body() input: CashBankMovementMutationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.createMovement(input, key);
  }

  @Get("movements/:id")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public detail(@Param("id", ParseUUIDPipe) id: string) {
    return this.queries.detail(id);
  }

  @Patch("movements/:id")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CashBankMovementMutationDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.updateMovement(id, input, key);
  }

  @Get("movements/:id/validate")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public validate(@Param("id", ParseUUIDPipe) id: string) {
    return this.management.validateMovement(id);
  }

  @Post("movements/:id/confirm")
  @RequireAnyPermission("accounting.approve", "users_roles.manage")
  public confirm(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CashBankConfirmDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.confirmMovement(id, input.note, key, input.balanceOverrideReason);
  }

  @Post("movements/:id/cancel")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CashBankReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.cancelMovement(id, input.reason, key);
  }

  @Post("movements/:id/reverse")
  @RequireAnyPermission("accounting.reverse", "users_roles.manage")
  public reverse(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CashBankReverseDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.reverseMovement(id, input.reversalDate, input.reason, key);
  }

  @Post("movements/:id/attachments")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public attachment(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CashBankAttachmentDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.management.linkMovementAttachment(id, input, key);
  }
}
