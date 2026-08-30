import { Body, Controller, Get, Headers, Inject, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { AccountingBatchService } from "./accounting-batch.service.js";
import { AccountingRecoveryService } from "./accounting-recovery.service.js";
// DTO classes must remain runtime values so Nest's global ValidationPipe can
// read their decorator metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateRecoveryBatchDto, RecoveryPreviewQueryDto } from "./accounting-recovery.dto.js";

/**
 * Historical Accounting recovery — preview only.
 *
 * One GET, no mutation and no write path of any kind. There is deliberately no
 * execute route: recovery execution is a later, separate decision, and the
 * preview's `metadata.executionAvailable: false` says so in the payload.
 *
 * Permissions match the posting authority rather than plain view, because the
 * preview reveals exactly which historical records posting would touch — the
 * audience is whoever could act on it.
 */
@ApiTags("accounting-recovery")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/accounting/recovery")
export class AccountingRecoveryController {
  public constructor(
    @Inject(AccountingBatchService) private readonly batches: AccountingBatchService,
    @Inject(AccountingRecoveryService) private readonly recovery: AccountingRecoveryService,
  ) {}

  @Get("preview")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public preview(@Query() query: RecoveryPreviewQueryDto) {
    return this.recovery.preview(query);
  }

  /**
   * Creates a `historical_accounting_recovery` batch from selected preview
   * rows. Every selection is reclassified server-side and only rows STILL
   * eligible are enrolled; the response reports accepted and rejected items
   * with reasons. Creates no Accounting Event, Journal or financial record,
   * and the batch cannot be executed — recovery execution does not exist yet.
   */
  @Post("batches")
  @RequireAnyPermission("accounting.post", "accounting.manage", "users_roles.manage")
  public createBatch(
    @Body() input: CreateRecoveryBatchDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.batches.createRecoveryBatch(input, idempotencyKey);
  }
}
