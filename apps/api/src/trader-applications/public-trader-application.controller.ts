import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common"; import { Throttle } from "@nestjs/throttler"; import type { Request } from "express"; import { Public } from "../authentication/authentication.decorators.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateTraderApplicationDto } from "./trader-application.dto.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TraderApplicationService } from "./trader-application.service.js";
@Controller("public/trader-applications") export class PublicTraderApplicationController{constructor(@Inject(TraderApplicationService) private readonly service:TraderApplicationService){} @Public() @Throttle({default:{limit:5,ttl:60000}}) @HttpCode(201) @Post() create(@Body() input:CreateTraderApplicationDto,@Req() request:Request){return this.service.create(input,{ip:request.ip??null,userAgent:request.headers["user-agent"]??null});}}
