import { Module } from "@nestjs/common";
import { DemoRequestService } from "./demo-request.service.js";
import { PublicDemoRequestController } from "./public-demo-request.controller.js";

@Module({ controllers:[PublicDemoRequestController], exports:[DemoRequestService], providers:[DemoRequestService] })
export class DemoRequestsModule {}
