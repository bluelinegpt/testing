import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { OperationsModule } from "../operations/operations.module.js";

import { StoreOrderConversionController } from "./store-order-conversion.controller.js";
import { StoreOrderConversionService } from "./store-order-conversion.service.js";

/**
 * Customer Commerce Prompt C4 -- Store Order → Delivery Order conversion.
 *
 * `OperationsModule` is imported for exactly one export, `OperationsService`
 * (`createOrder`/`nextSerialNumber`) -- the single authoritative Delivery
 * Order creation path, reused rather than duplicated. `AuthenticationModule`
 * supplies `RequestSecurityContextStore` for the manually-constructed
 * tenant/identity context `createOrder` needs (see the service's own doc
 * comment), the same dependency every other module in this domain already
 * takes it for.
 */
@Module({
  controllers: [StoreOrderConversionController],
  imports: [AuthenticationModule, OperationsModule],
  providers: [StoreOrderConversionService],
})
export class StoreOrderConversionModule {}
