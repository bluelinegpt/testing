import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

const supportPriorities = ["low", "normal", "high", "urgent"] as const;
const supportStatuses = ["open", "in_progress", "resolved", "closed"] as const;

export class CreateSupportCaseDto {
  @IsString()
  @MaxLength(160)
  public readonly title!: string;

  @IsString()
  @MaxLength(2000)
  public readonly description!: string;

  @IsOptional()
  @IsIn(supportPriorities)
  public readonly priority?: (typeof supportPriorities)[number];
}

export class UpdateSupportCaseDto {
  @IsIn(supportStatuses)
  public readonly status!: (typeof supportStatuses)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public readonly resolutionNotes?: string;
}
