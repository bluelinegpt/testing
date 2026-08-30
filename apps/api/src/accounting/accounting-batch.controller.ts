import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { AccountingBatchService } from "./accounting-batch.service.js";
// DTO classes must remain runtime values for Nest's global ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AccountingBatchItemQueryDto,
  AccountingBatchListQueryDto,
  AddAccountingBatchItemsDto,
  CancelAccountingBatchDto,
  CreateAccountingBatchDto,
  ExecuteAccountingBatchDto,
  RecoverAccountingBatchDto,
} from "./accounting-batch.dto.js";

/**
 * Accounting Batch Operations.
 *
 * Seven endpoints. Execute delegates every item to the single-item service
 * named in the detail response's `metadata.singleItemService` -- no accounting
 * action is implemented in the batch module itself.
 *
 * Every mutating route takes `x-idempotency-key`, matching the rest of the
 * Accounting module: a retried create, add, validate or cancel resolves to the
 * first outcome rather than a second batch or a second sweep.
 */
@ApiTags("accounting-batches")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/accounting/batches")
export class AccountingBatchController {
  public constructor(
    @Inject(AccountingBatchService) private readonly batches: AccountingBatchService,
  ) {}

  @Post()
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public create(
    @Body() input: CreateAccountingBatchDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.batches.create(input, idempotencyKey);
  }

  @Get()
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public list(@Query() query: AccountingBatchListQueryDto) {
    return this.batches.list(query);
  }

  @Get(":batchId")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public detail(
    @Param("batchId", new ParseUUIDPipe()) batchId: string,
    @Query() query: AccountingBatchItemQueryDto,
  ) {
    return this.batches.detail(batchId, query);
  }

  @Post(":batchId/items")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public addItems(
    @Param("batchId", new ParseUUIDPipe()) batchId: string,
    @Body() input: AddAccountingBatchItemsDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.batches.addItems(batchId, input, idempotencyKey);
  }

  /** Read-only. Creates no Accounting Event, Journal or financial record. */
  @Post(":batchId/validate")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public validate(
    @Param("batchId", new ParseUUIDPipe()) batchId: string,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.batches.validate(batchId, idempotencyKey);
  }

  /**
   * Controlled execution. Requires the batch version the caller last saw and
   * an idempotency key; each item is executed by the single-item reprocess
   * service, never by SQL in the batch module.
   */
  @Post(":batchId/execute")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public execute(
    @Param("batchId", new ParseUUIDPipe()) batchId: string,
    @Body() input: ExecuteAccountingBatchDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.batches.execute(batchId, input, idempotencyKey);
  }

  /**
   * Operator recovery for a batch stuck in `processing`. Elevated permission
   * only — accounting.manage (or the established Company Administrator
   * fallback), no posting-user fallback — because releasing a stuck control
   * record is an operator decision. Executes no accounting work; it reconciles
   * the batch with its item rows and leaves it retryable.
   */
  @Post(":batchId/recover-processing")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public recoverProcessing(
    @Param("batchId", new ParseUUIDPipe()) batchId: string,
    @Body() input: RecoverAccountingBatchDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.batches.recoverProcessing(batchId, input, idempotencyKey);
  }

  @Post(":batchId/cancel")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public cancel(
    @Param("batchId", new ParseUUIDPipe()) batchId: string,
    @Body() input: CancelAccountingBatchDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.batches.cancel(batchId, input, idempotencyKey);
  }
}
