import { IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export class CreateMockCommerceConnectionDto {
  @IsUUID() public readonly companyId!: string;
  @IsUUID() public readonly traderId!: string;
  @IsOptional() @IsUUID() public readonly traderCommerceId?: string;
  @IsString() @MinLength(2) @MaxLength(120) public readonly externalStoreName!: string;
  @IsOptional() @IsString() @MaxLength(120) public readonly externalStoreId?: string;
  @IsOptional() @IsIn(["inbound_only", "bidirectional"]) public readonly connectionMode?: "inbound_only" | "bidirectional";
}

export class MockCommerceOrderDto {
  @IsOptional() @IsString() @MaxLength(120) public readonly externalOrderId?: string;
  @IsOptional() @IsString() @MaxLength(120) public readonly externalOrderNumber?: string;
  @IsOptional() @IsString() @MaxLength(120) public readonly customerName?: string;
  @IsOptional() @IsString() @MaxLength(40) public readonly customerMobile?: string;
  @IsOptional() @IsString() @MaxLength(120) public readonly customerEmail?: string;
  @IsOptional() @IsString() @MaxLength(10) public readonly countryCode?: string;
  @IsOptional() @IsString() @MaxLength(80) public readonly emirate?: string;
  @IsOptional() @IsString() @MaxLength(120) public readonly area?: string;
  @IsOptional() @IsString() @MaxLength(500) public readonly address?: string;
  @IsOptional() @IsString() @MaxLength(10) public readonly currency?: string;
  @IsOptional() @IsNumber() @Min(0) public readonly codAmount?: number;
  @IsOptional() @IsNumber() @Min(1) public readonly packageCount?: number;
  @IsOptional() @IsString() @MaxLength(1000) public readonly notes?: string;
}

export class SimulateCommerceEventDto {
  @IsOptional() @IsString() @MaxLength(120) public readonly externalEventId?: string;
  @IsIn(["order.created", "order.updated", "order.cancelled", "fulfillment.updated", "connection.revoked", "sync.requested"])
  public readonly eventType!: "order.created" | "order.updated" | "order.cancelled" | "fulfillment.updated" | "connection.revoked" | "sync.requested";
  @IsOptional() @ValidateNested() @Type(() => MockCommerceOrderDto) public readonly order?: MockCommerceOrderDto;
  @IsOptional() @IsIn(["healthy", "degraded", "unauthorized"]) public readonly providerState?: "healthy" | "degraded" | "unauthorized";
  @IsOptional() @IsIn(["timeout", "processing_failure"]) public readonly simulateFailure?: "timeout" | "processing_failure";
  @IsOptional() @IsIn([true, false]) public readonly invalidSignature?: boolean;
}

export class CommerceAreaMappingDto {
  @IsOptional() @IsUUID() public readonly connectionId?: string;
  @IsString() @MinLength(1) @MaxLength(160) public readonly externalValue!: string;
  @IsUUID() public readonly areaId!: string;
}

export class DisconnectCommerceConnectionDto {
  @IsOptional() @IsString() @MaxLength(300) public readonly reason?: string;
}

export class StartSallaConnectionDto {
  @IsUUID() public readonly companyId!: string;
  @IsUUID() public readonly traderId!: string;
  @IsUUID() public readonly traderCommerceId!: string;
  @IsOptional() @IsString() @MaxLength(500) public readonly redirectAfter?: string;
}

export class StartShopifyConnectionDto {
  @IsUUID() public readonly companyId!: string;
  @IsUUID() public readonly traderId!: string;
  @IsUUID() public readonly traderCommerceId!: string;
  @IsString() @MinLength(6) @MaxLength(255) public readonly shopDomain!: string;
  @IsOptional() @IsString() @MaxLength(500) public readonly redirectAfter?: string;
}
