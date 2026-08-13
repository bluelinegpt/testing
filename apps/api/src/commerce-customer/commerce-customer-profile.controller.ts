import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import {
  CommerceCustomerAddressDto,
  UpdateCommerceCustomerAddressDto,
  UpdateCommerceCustomerProfileDto,
} from "./commerce-customer-auth.dto.js";
import {
  type CommerceCustomerAddress,
  CommerceCustomerProfileService,
  type CommerceCustomerProfile,
} from "./commerce-customer-profile.service.js";

/** §43/§44: authenticated Customer profile and address management. */
@ApiTags("commerce customer profile")
@RequireIdentityKinds("customer")
@Controller("commerce/customer")
export class CommerceCustomerProfileController {
  public constructor(
    @Inject(CommerceCustomerProfileService) private readonly profiles: CommerceCustomerProfileService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  @ApiOperation({ summary: "Return the authenticated Customer's profile" })
  @Get("profile")
  public profile(): Promise<CommerceCustomerProfile> {
    return this.profiles.profile(this.identities.current().identityId);
  }

  @ApiOperation({ summary: "Update the authenticated Customer's profile" })
  @Patch("profile")
  public updateProfile(
    @Body() input: UpdateCommerceCustomerProfileDto,
  ): Promise<CommerceCustomerProfile> {
    return this.profiles.updateProfile(this.identities.current().identityId, input);
  }

  @ApiOperation({ summary: "List the authenticated Customer's addresses" })
  @Get("addresses")
  public addresses(): Promise<readonly CommerceCustomerAddress[]> {
    return this.profiles.listAddresses(this.identities.current().identityId);
  }

  @ApiOperation({ summary: "Add a Customer address" })
  @HttpCode(201)
  @Post("addresses")
  public createAddress(@Body() input: CommerceCustomerAddressDto): Promise<CommerceCustomerAddress> {
    return this.profiles.createAddress(this.identities.current().identityId, input);
  }

  @ApiOperation({ summary: "Update a Customer address" })
  @Patch("addresses/:addressId")
  public updateAddress(
    @Param("addressId") addressId: string,
    @Body() input: UpdateCommerceCustomerAddressDto,
  ): Promise<CommerceCustomerAddress> {
    return this.profiles.updateAddress(this.identities.current().identityId, addressId, input);
  }

  @ApiOperation({ summary: "Set a Customer address as the default" })
  @HttpCode(200)
  @Post("addresses/:addressId/default")
  public setDefaultAddress(@Param("addressId") addressId: string): Promise<CommerceCustomerAddress> {
    return this.profiles.setDefaultAddress(this.identities.current().identityId, addressId);
  }

  @ApiOperation({ summary: "Delete a Customer address" })
  @HttpCode(204)
  @Delete("addresses/:addressId")
  public deleteAddress(@Param("addressId") addressId: string): Promise<void> {
    return this.profiles.deleteAddress(this.identities.current().identityId, addressId);
  }
}
