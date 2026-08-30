import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsObject, IsString, IsUUID, Max, Min } from "class-validator";

export class CreateWorkflowTestRunDto {
  @IsUUID() public companyId!: string;
  @IsIn(["full", "smoke"]) public mode!: "full" | "smoke";
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) public ordersPerDay!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(30) public durationDays!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(10) public concurrency!: number;
  @IsBoolean() public sideEffectsSuppressed!: boolean;
  @IsObject() public configuration!: Record<string, unknown>;
}

export class WorkflowTestMutationDto {
  @Type(() => Number) @IsInt() @Min(1) public expectedVersion!: number;
  @IsString() public reason!: string;
}

export class WorkflowTestCleanupDto extends WorkflowTestMutationDto {
  @IsString() public confirmation!: string;
}

export class EnableWorkflowTestingDto {
  @IsString() public confirmation!: string;
}
