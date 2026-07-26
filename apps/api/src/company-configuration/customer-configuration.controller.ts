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
import {
  CustomerConfigurationService,
  type CustomerPage,
  type CustomerSummary,
} from "./customer-configuration.service.js";
// Runtime classes are required by Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ChangeCustomerAddressStatusDto,
  ChangeCustomerStatusDto,
  CreateCustomerDto,
  CustomerAddressDto,
  UpdateCustomerAddressDto,
  UpdateCustomerDto,
} from "./customer-configuration.dto.js";

@ApiTags("customer-configuration")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequireAnyPermission("users_roles.manage")
@Controller("configuration/customers")
export class CustomerConfigurationController {
  public constructor(
    @Inject(CustomerConfigurationService) private readonly customers: CustomerConfigurationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List Company Customers with server-side filtering" })
  public list(@Query() query: Record<string, string>): Promise<CustomerPage<CustomerSummary>> {
    return this.customers.customers(query);
  }

  @Get("search")
  @RequireAnyPermission("orders.create", "users_roles.manage")
  public search(@Query() query: Record<string, string>): Promise<Record<string, unknown>> {
    return this.customers.search(query);
  }

  @Post()
  public create(
    @Body() input: CreateCustomerDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.customers.create(input, this.correlationId(request));
  }

  @Get(":code")
  public detail(@Param("code") code: string): Promise<Record<string, unknown>> {
    return this.customers.customer(code);
  }

  @Patch(":customerId")
  public update(
    @Param("customerId", new ParseUUIDPipe()) customerId: string,
    @Body() input: UpdateCustomerDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.customers.update(customerId, input, this.correlationId(request));
  }

  @Patch(":customerId/status")
  public status(
    @Param("customerId", new ParseUUIDPipe()) customerId: string,
    @Body() input: ChangeCustomerStatusDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.customers.changeStatus(customerId, input, this.correlationId(request));
  }

  @Get(":customerId/addresses")
  public addresses(
    @Param("customerId", new ParseUUIDPipe()) customerId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    return this.customers.addresses(customerId);
  }

  @Post(":customerId/addresses")
  public createAddress(
    @Param("customerId", new ParseUUIDPipe()) customerId: string,
    @Body() input: CustomerAddressDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.customers.createAddress(customerId, input, this.correlationId(request));
  }

  @Patch(":customerId/addresses/:addressId")
  public updateAddress(
    @Param("customerId", new ParseUUIDPipe()) customerId: string,
    @Param("addressId", new ParseUUIDPipe()) addressId: string,
    @Body() input: UpdateCustomerAddressDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.customers.updateAddress(customerId, addressId, input, this.correlationId(request));
  }

  @Patch(":customerId/addresses/:addressId/status")
  public addressStatus(
    @Param("customerId", new ParseUUIDPipe()) customerId: string,
    @Param("addressId", new ParseUUIDPipe()) addressId: string,
    @Body() input: ChangeCustomerAddressStatusDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.customers.changeAddressStatus(
      customerId,
      addressId,
      input,
      this.correlationId(request),
    );
  }

  @Get(":customerId/orders")
  public orders(
    @Param("customerId", new ParseUUIDPipe()) customerId: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ): Promise<CustomerPage<Record<string, unknown>>> {
    return this.customers.relatedOrders(customerId, Number(page), Number(pageSize));
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
