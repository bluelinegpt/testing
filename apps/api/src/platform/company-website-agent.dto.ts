import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
const clean = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
export class StartCompanyWebsiteAgentDto {
  @IsOptional() @IsIn(["en", "ar"]) public language?: "en" | "ar";
}
export class CompanyWebsiteAgentMessageDto {
  @Transform(clean) @IsString() @MinLength(1) @MaxLength(1000) public message!: string;
  @IsOptional() @IsIn(["en", "ar"]) public language?: "en" | "ar";
}
export class CompanyWebsiteAgentTokenDto {
  @Matches(/^[A-Za-z0-9_-]{43}$/u) public token!: string;
}
