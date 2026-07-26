import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  MinLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Transform, Type } from "class-transformer";

import { NormalizeUaeMobile } from "../shared/uae-mobile.js";

const uaeMobileMessage = {
  message: "Enter a UAE mobile number, for example 0506468442 or 9715XXXXXXXX.",
};

const deliveryStatuses = [
  "in_branch",
  "out_for_delivery",
  "hold",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "cancelled",
  "closed",
] as const;

const paymentMethods = ["cash", "bank_transfer"] as const;
const orderAttachmentTypes = ["delivery_photo", "expense", "waybill", "other"] as const;
const orderIdentifierPattern = /^[\p{L}\p{N} _/-]+$/u;
const orderIdentifierMessage = {
  message: "Use letters, numbers, spaces, hyphens, underscores or slashes only.",
};

const TrimText = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));
const OptionalTrimmedText = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  });

export class FinancialPaymentDto {
  @IsOptional()
  @IsIn(paymentMethods)
  public readonly paymentMethod?: (typeof paymentMethods)[number];

  @IsOptional()
  @IsUUID()
  public readonly bankAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly traderBankAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly bankReference?: string;
}

export class ChangeOrderStatusDto {
  @IsIn(deliveryStatuses)
  public readonly status!: (typeof deliveryStatuses)[number];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public readonly reason?: string;
}

export class OrderSelectionDto {
  @IsIn(["ids", "filter"])
  public readonly selectionMode!: "filter" | "ids";

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  public readonly orderIds?: readonly string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  public readonly excludedOrderIds?: readonly string[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly search?: string;

  @IsOptional()
  @IsIn(["active", "all", "hold", "closed", "cancelled"])
  public readonly quickView?: "active" | "all" | "cancelled" | "closed" | "hold";

  @IsOptional()
  @IsString()
  public readonly deliveryStatus?: string;

  @IsOptional()
  @IsString()
  public readonly cashStatus?: string;

  @IsOptional()
  @IsString()
  public readonly settlementStatus?: string;

  @IsOptional()
  @IsUUID()
  public readonly traderId?: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;

  @IsOptional()
  @IsUUID()
  public readonly areaId?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly dateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly dateTo?: string;
}

export class BulkAssignDriverDto extends OrderSelectionDto {
  @IsUUID()
  public readonly driverIdToAssign!: string;
}

const bulkTargetStatuses = [
  "in_branch",
  "out_for_delivery",
  "hold",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "cancelled",
  "closed",
] as const;

export class BulkChangeOrderStatusDto extends OrderSelectionDto {
  @IsIn(bulkTargetStatuses)
  public readonly targetStatus!: (typeof bulkTargetStatuses)[number];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public readonly reason?: string;

  @IsOptional()
  @IsBoolean()
  public readonly allowPartial?: boolean;
}

// Settles several delivered orders of ONE trader in a single "money out" settlement.
export class BulkSettleTraderDto extends OrderSelectionDto {
  @IsOptional()
  @IsIn(paymentMethods)
  public readonly paymentMethod?: (typeof paymentMethods)[number];

  @IsOptional()
  @IsUUID()
  public readonly bankAccountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly traderBankAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly bankReference?: string;
}

export class ReconciliationPaymentDto {
  @IsIn(paymentMethods)
  public readonly paymentMethod!: (typeof paymentMethods)[number];

  @IsNumber()
  @Min(0.01)
  public readonly amount!: number;

  @IsOptional()
  @IsUUID()
  public readonly bankAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly bankReference?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly paymentDate?: string;
}

export class ReconciliationExpenseDto {
  @IsUUID()
  public readonly expenseTypeId!: string;

  @IsNumber()
  @Min(0.01)
  public readonly amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly reference?: string;

  @IsOptional()
  @IsUUID()
  public readonly attachmentFileId?: string;
}

export class CreateDriverReconciliationDto extends OrderSelectionDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReconciliationPaymentDto)
  public readonly payments!: readonly ReconciliationPaymentDto[];

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReconciliationExpenseDto)
  public readonly expenses!: readonly ReconciliationExpenseDto[];
}

export class InlineOrderCustomerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @TrimText()
  public readonly name!: string;

  @IsString()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, uaeMobileMessage)
  @MaxLength(12)
  public readonly mobileNumber!: string;

  @IsOptional()
  @IsString()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, uaeMobileMessage)
  @MaxLength(12)
  public readonly secondMobileNumber?: string;

  @IsUUID()
  public readonly areaId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  @TrimText()
  public readonly address!: string;
}

export class CreateOrderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(orderIdentifierPattern, orderIdentifierMessage)
  @TrimText()
  public readonly serialNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(orderIdentifierPattern, orderIdentifierMessage)
  @OptionalTrimmedText()
  public readonly referenceNumber?: string;

  @IsOptional()
  @IsUUID()
  public readonly customerId?: string;

  @IsOptional()
  @IsUUID()
  public readonly customerAddressId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => InlineOrderCustomerDto)
  public readonly inlineCustomer?: InlineOrderCustomerDto;

  @IsUUID()
  public readonly traderId!: string;

  @IsUUID()
  public readonly areaId!: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly customerName!: string;

  @IsString()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, uaeMobileMessage)
  @MaxLength(12)
  public readonly customerMobileNumber!: string;

  @IsOptional()
  @IsString()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, uaeMobileMessage)
  @MaxLength(12)
  public readonly customerSecondMobileNumber?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly customerAddress!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly customerLocationLink?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  public readonly customerLatitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  public readonly customerLongitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly customerDeliveryNotes?: string;

  @IsNumber()
  @Min(0)
  public readonly codAmount!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  public readonly serviceFee?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  public readonly additionalFees?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly serviceFeeOverrideReason?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  public readonly packageCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;
}

// Partial edit of an existing order's business fields before delivery. Every field is
// optional; only the provided fields change. Changing the Trader, or the Customer + address
// (which sets the Area), re-prices the order.
export class UpdateOrderDto {
  @IsOptional()
  @IsUUID()
  public readonly traderId?: string;

  @IsOptional()
  @IsUUID()
  public readonly customerId?: string;

  @IsOptional()
  @IsUUID()
  public readonly customerAddressId?: string;

  @IsOptional()
  @IsUUID()
  public readonly areaId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly customerName?: string;

  @IsOptional()
  @IsString()
  @NormalizeUaeMobile()
  @Matches(/^9715[0-9]{8}$/, uaeMobileMessage)
  @MaxLength(12)
  public readonly customerMobileNumber?: string;

  @IsOptional()
  @IsString()
  @NormalizeUaeMobile()
  @Matches(/^(9715[0-9]{8})?$/, uaeMobileMessage)
  @MaxLength(12)
  public readonly customerSecondMobileNumber?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly customerAddress?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  public readonly codAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  public readonly serviceFee?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly serviceFeeReason?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(999)
  public readonly packageCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;
}

export class OrderQuoteDto {
  @IsUUID()
  public readonly traderId!: string;

  @IsUUID()
  public readonly areaId!: string;

  @IsNumber()
  @Min(0)
  public readonly codAmount!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  public readonly serviceFee?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  public readonly additionalFees?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly serviceFeeOverrideReason?: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;
}

export class OrderIdentifierAvailabilityQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly serialNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly referenceNumber?: string;
}

export class ImportOrdersCsvDto {
  @IsString()
  @MaxLength(100000)
  public readonly csv!: string;
}

export class RegisterOrderAttachmentDto {
  @IsIn(orderAttachmentTypes)
  public readonly attachmentType!: (typeof orderAttachmentTypes)[number];

  @IsString()
  @MaxLength(180)
  public readonly fileName!: string;

  @IsString()
  @MaxLength(100)
  public readonly mediaType!: string;

  @IsNumber()
  @Min(0)
  public readonly sizeBytes!: number;
}

export class RegisterInternationalShipmentDto {
  @IsString()
  @MaxLength(160)
  public readonly providerName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly providerReferenceNumber?: string;

  @Matches(/^[A-Z]{2}$/)
  public readonly destinationCountryCode!: string;

  @IsNumber()
  @Min(0)
  public readonly internationalDeliveryCost!: number;

  @IsNumber()
  @Min(0)
  public readonly customerCharge!: number;

  @IsString()
  @MaxLength(80)
  public readonly currentStatus!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public readonly notes?: string;
}

export class CreateTraderDto {
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{2,32}$/)
  public readonly code?: string;

  @IsString()
  @MaxLength(160)
  public readonly nameEn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly contactPerson?: string;

  @IsString()
  @MaxLength(32)
  public readonly mobileNumber!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  public readonly email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public readonly pickupAddress?: string;
}

export class CreateDriverDto {
  @Matches(/^[A-Za-z0-9_-]{2,32}$/)
  public readonly code!: string;

  @IsString()
  @MaxLength(160)
  public readonly nameEn!: string;

  @IsString()
  @MaxLength(32)
  public readonly mobileNumber!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  public readonly outsourcedFeePerDeliveredOrder?: number;
}

export const reconciliationPageSizes = [25, 50, 100] as const;

const driverSearchStatuses = ["active", "all"] as const;
const eligibleOrderSorts = ["orderNumber", "deliveredAt", "amountCollected"] as const;
const reconciliationSorts = ["businessDate", "reconciliationNumber", "netAmountReceived"] as const;
const sortDirections = ["asc", "desc"] as const;

class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  public readonly page?: number;

  // Approved page sizes for the reconciliation module.
  @IsOptional()
  @Type(() => Number)
  @IsIn(reconciliationPageSizes)
  public readonly pageSize?: (typeof reconciliationPageSizes)[number];

  @IsOptional()
  @IsIn(sortDirections)
  public readonly sortDirection?: (typeof sortDirections)[number];
}

export class DriverSearchQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly search?: string;

  @IsOptional()
  @IsIn(driverSearchStatuses)
  public readonly status?: (typeof driverSearchStatuses)[number];
}

export class EligibleOrdersQueryDto extends PaginationQueryDto {
  @IsUUID()
  public readonly driverId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly search?: string;

  @IsOptional()
  @IsUUID()
  public readonly traderId?: string;

  @IsOptional()
  @IsUUID()
  public readonly areaId?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly deliveredFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly deliveredTo?: string;

  @IsOptional()
  @IsIn(eligibleOrderSorts)
  public readonly sortBy?: (typeof eligibleOrderSorts)[number];
}

export class ReconciliationListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly search?: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly dateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly dateTo?: string;

  @IsOptional()
  @IsIn(["draft", "confirmed"])
  public readonly status?: "draft" | "confirmed";

  @IsOptional()
  @IsIn(paymentMethods)
  public readonly paymentMethod?: (typeof paymentMethods)[number];

  @IsOptional()
  @IsIn(reconciliationSorts)
  public readonly sortBy?: (typeof reconciliationSorts)[number];
}
