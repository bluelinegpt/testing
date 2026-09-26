import { Module } from "@nestjs/common";
import { PublicTraderApplicationController } from "./public-trader-application.controller.js";
import { TraderApplicationService } from "./trader-application.service.js";
@Module({controllers:[PublicTraderApplicationController],providers:[TraderApplicationService],exports:[TraderApplicationService]}) export class TraderApplicationsModule{}
