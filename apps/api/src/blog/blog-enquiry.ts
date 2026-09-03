import { BadRequestException, Body, Controller, Inject, Injectable, Param, Post, ServiceUnavailableException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Equals, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import nodemailer from "nodemailer";
import { Public } from "../authentication/authentication.decorators.js";
import { BlogService } from "./blog.service.js";

export class BlogEnquiryDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(10) @MaxLength(5000) message!: string;
  @IsIn(["en", "ar"]) language: string = "en";
  @Equals(true) consent!: boolean;
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}

@Injectable()
export class BlogEnquiryService {
  constructor(@Inject(BlogService) private readonly blog: BlogService) {}
  async send(slug:string, input:BlogEnquiryDto) {
    if(input.website) throw new BadRequestException("Unable to submit this enquiry.");
    const result=await this.blog.publicArticle(slug,input.language);
    if(!result.article)throw new BadRequestException("This article is no longer available.");
    const {SMTP_HOST:host,SMTP_USER:user,SMTP_PASSWORD:pass,SMTP_FROM:from}=process.env;
    const port=Number(process.env.SMTP_PORT??587);
    if(!host||!user||!pass||!from||![465,587,2525].includes(port))throw new ServiceUnavailableException("The enquiry email service is not configured. Please contact us on WhatsApp.");
    const transport=nodemailer.createTransport({host,port,secure:port===465,requireTLS:port!==465,auth:{user,pass},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,disableFileAccess:true,disableUrlAccess:true});
    try {
      const sent=await transport.sendMail({from,to:"aothman@gmail.com",replyTo:input.email,
        subject:`Tawseelhub blog enquiry: ${String(result.article.title).replace(/[\r\n]/g," ").slice(0,150)}`,
        text:`Article: ${result.article.title}\nSlug: ${slug}\nLanguage: ${input.language}\nName: ${input.name}\nEmail: ${input.email}\n\n${input.message}\n\nThe customer consented to being contacted about this enquiry.`});
      if(!sent.accepted?.length)throw new Error("recipient_rejected");
      return {sent:true};
    } catch {
      // Never expose SMTP credentials, provider response, or the visitor's message.
      // The shared ApiExceptionFilter centrally records this unexpected 503.
      throw new ServiceUnavailableException("Your enquiry could not be sent. Please try again later or contact us on WhatsApp.");
    } finally {transport.close()}
  }
}
@Controller("public/blog")
export class BlogEnquiryController {
  constructor(@Inject(BlogEnquiryService) private readonly enquiries:BlogEnquiryService){}
  @Public() @Post("articles/:slug/enquiry") @Throttle({default:{limit:3,ttl:60000}})
  send(@Param("slug") slug:string,@Body() input:BlogEnquiryDto){return this.enquiries.send(slug,input)}
}
