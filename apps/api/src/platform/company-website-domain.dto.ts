import { IsInt, IsString, Matches, Min } from "class-validator";
export class AddCompanyWebsiteDomainDto {
  @IsString() @Matches(/^[^/:?#*\s]+$/u) public hostname!: string;
}
export class MutateCompanyWebsiteDomainDto {
  @IsInt() @Min(1) public expectedVersion!: number;
}
export class MakePrimaryCompanyWebsiteDomainDto extends MutateCompanyWebsiteDomainDto {
  @IsInt() @Min(1) public expectedWebsiteVersion!: number;
}
