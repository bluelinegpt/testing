import { IsOptional, IsString, MaxLength } from "class-validator";
export class BlogImportDto {
  @IsOptional() @IsString() @MaxLength(2048) googleDocUrl?: string;
}
