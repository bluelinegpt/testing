import { Module } from "@nestjs/common";
import { CompanyCustomerQuoteController,PublicCustomerQuoteController } from "./customer-quote.controller.js";
import { CustomerQuoteService } from "./customer-quote.service.js";
import { AuthenticationModule } from "../authentication/authentication.module.js";
@Module({imports:[AuthenticationModule],controllers:[PublicCustomerQuoteController,CompanyCustomerQuoteController],providers:[CustomerQuoteService],exports:[CustomerQuoteService]}) export class CustomerQuotesModule{}
