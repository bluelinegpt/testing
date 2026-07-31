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
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  CreateGeneralExpenseCategoryDto,
  CreateGeneralExpenseDto,
  CreateGeneralExpensePaymentDto,
  GeneralExpenseAttachmentDto,
  GeneralExpenseAttachmentUploadDto,
  GeneralExpenseBackfillPreviewDto,
  GeneralExpenseListQueryDto,
  GeneralExpensePaymentListQueryDto,
  GeneralExpenseReasonDto,
  UpdateGeneralExpenseCategoryDto,
  UpdateGeneralExpenseDto,
} from "./general-expense.dto.js";
import { GeneralExpensePaymentService } from "./general-expense-payment.service.js";
import { GeneralExpenseQueryService } from "./general-expense-query.service.js";
import { GeneralExpenseService } from "./general-expense.service.js";

interface UploadedExpenseEvidence {
  readonly buffer: Buffer;
  readonly mimetype?: string;
  readonly originalname?: string;
}

@ApiTags("general-expenses")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/accounting/general-expenses")
export class GeneralExpenseController {
  public constructor(
    @Inject(GeneralExpenseService)
    private readonly expenses: GeneralExpenseService,
    @Inject(GeneralExpensePaymentService)
    private readonly payments: GeneralExpensePaymentService,
    @Inject(GeneralExpenseQueryService)
    private readonly queries: GeneralExpenseQueryService,
  ) {}

  @Get("categories")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public categories(@Query("activeOnly", new ParseBoolPipe({ optional: true })) activeOnly?: boolean) {
    return this.queries.categories(activeOnly);
  }

  @Post("categories")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public createCategory(
    @Body() input: CreateGeneralExpenseCategoryDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.createCategory(input, key);
  }

  @Get("categories/:categoryId/dependencies")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public categoryDependencies(
    @Param("categoryId", new ParseUUIDPipe()) categoryId: string,
  ) {
    return this.queries.categoryDependencies(categoryId);
  }

  @Patch("categories/:categoryId")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public updateCategory(
    @Param("categoryId", new ParseUUIDPipe()) categoryId: string,
    @Body() input: UpdateGeneralExpenseCategoryDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.updateCategory(categoryId, input, key);
  }

  @Post("categories/:categoryId/deactivate")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public deactivateCategory(
    @Param("categoryId", new ParseUUIDPipe()) categoryId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.deactivateCategory(categoryId, input, key);
  }

  @Post("categories/:categoryId/activate")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public activateCategory(
    @Param("categoryId", new ParseUUIDPipe()) categoryId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.activateCategory(categoryId, input, key);
  }

  @Get("summary")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public summary() {
    return this.queries.summary();
  }

  @Get()
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public list(@Query() query: GeneralExpenseListQueryDto) {
    return this.queries.list(query);
  }

  @Post()
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public create(
    @Body() input: CreateGeneralExpenseDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.create(input, key);
  }

  @Get("payments")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public paymentList(@Query() query: GeneralExpensePaymentListQueryDto) {
    return this.queries.payments(query);
  }

  @Get("payments/:paymentId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public payment(@Param("paymentId", new ParseUUIDPipe()) paymentId: string) {
    return this.queries.payment(paymentId);
  }

  @Get("attachments/:attachmentId/content")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public async attachmentContent(
    @Param("attachmentId", new ParseUUIDPipe()) attachmentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const content = await this.expenses.attachmentContent(attachmentId);
    const safeName = content.fileName.replace(/[^A-Za-z0-9._ -]/g, "_");
    response.setHeader("Content-Type", content.mediaType);
    response.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, no-store");
    response.send(Buffer.from(content.bytes));
  }

  @Post("payments/:paymentId/reverse")
  @RequireAnyPermission("accounting.reverse", "users_roles.manage")
  public reversePayment(
    @Param("paymentId", new ParseUUIDPipe()) paymentId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.payments.reverse(paymentId, input, key);
  }

  @Get("reconciliation/summary")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public reconciliationSummary() {
    return this.queries.reconciliationSummary();
  }

  @Get("reconciliation")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public reconciliation() {
    return this.queries.reconciliation();
  }

  @Post("reconciliation/preview-backfill")
  @RequireAnyPermission("accounting.manage", "accounting.post", "users_roles.manage")
  public previewBackfill(@Body() input: GeneralExpenseBackfillPreviewDto) {
    return this.queries.previewBackfill(input);
  }

  @Get(":expenseId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public detail(@Param("expenseId", new ParseUUIDPipe()) expenseId: string) {
    return this.queries.detail(expenseId);
  }

  @Patch(":expenseId")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public update(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: UpdateGeneralExpenseDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.update(expenseId, input, key);
  }

  @Get(":expenseId/validate")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public validate(@Param("expenseId", new ParseUUIDPipe()) expenseId: string) {
    return this.expenses.validate(expenseId);
  }

  @Post(":expenseId/submit")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public submit(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.submit(expenseId, input, key);
  }

  @Post(":expenseId/withdraw")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public withdraw(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.withdraw(expenseId, input, key);
  }

  @Post(":expenseId/approve")
  @RequireAnyPermission("accounting.approve", "users_roles.manage")
  public approve(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.approve(expenseId, input, key);
  }

  @Post(":expenseId/reject")
  @RequireAnyPermission("accounting.approve", "users_roles.manage")
  public reject(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.reject(expenseId, input, key);
  }

  @Post(":expenseId/return-to-draft")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public returnToDraft(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.returnToDraft(expenseId, input, key);
  }

  @Post(":expenseId/cancel")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public cancel(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.cancel(expenseId, input, key);
  }

  @Post(":expenseId/reverse")
  @RequireAnyPermission("accounting.reverse", "users_roles.manage")
  public reverse(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.reverse(expenseId, input, key);
  }

  @Post(":expenseId/attachments")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public attach(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: GeneralExpenseAttachmentDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.attach(expenseId, input, key);
  }

  @Post(":expenseId/attachments/upload")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }),
  )
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public uploadAttachment(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: GeneralExpenseAttachmentUploadDto,
    @UploadedFile() file: UploadedExpenseEvidence | undefined,
    @Headers("x-idempotency-key") key?: string,
  ) {
    if (file === undefined) {
      throw new ApplicationException(
        "accounting_general_expense_attachment_required",
        "A General Expense attachment file is required",
        400,
      );
    }
    return this.expenses.uploadAttachment(expenseId, input, file, key);
  }

  @Post(":expenseId/attachments/:attachmentId/deactivate")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public deactivateAttachment(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Param("attachmentId", new ParseUUIDPipe()) attachmentId: string,
    @Body() input: GeneralExpenseReasonDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.expenses.deactivateAttachment(
      expenseId,
      attachmentId,
      input,
      key,
    );
  }

  @Post(":expenseId/payments")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public pay(
    @Param("expenseId", new ParseUUIDPipe()) expenseId: string,
    @Body() input: CreateGeneralExpensePaymentDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.payments.createAndConfirm(expenseId, input, key);
  }
}
