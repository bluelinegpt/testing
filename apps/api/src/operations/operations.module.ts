import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import {
  OperationsController,
  PortalController,
  PublicTrackingController,
} from "./operations.controller.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { OperationsService } from "./operations.service.js";
import { OrdersWorkflowService } from "./orders-workflow.service.js";

@Module({
  imports: [AuthenticationModule],
  controllers: [OperationsController, PortalController, PublicTrackingController],
  providers: [
    DriverCashReconciliationService,
    OperationsHistoryWriter,
    OperationsService,
    OrdersWorkflowService,
    PasswordHasher,
  ],
})
export class OperationsModule {}
