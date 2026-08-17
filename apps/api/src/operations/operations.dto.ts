import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  MinLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { OmitType } from "@nestjs/swagger";

import { NormalizeUaeMobile } from "../shared/uae-mobile.js";

const uaeMobileMessage = {
  message: "Enter a UAE mobile number, for example 0506468442 or 9715XXXXXXXX.",
};

// The fast Create Order path keeps Mobile required (non-empty) but stores it as
// flexible text: no UAE-format gate, exact entered value preserved (trimmed).
// Only empty, over-length, and control-character input are rejected — matching
// the `customers_mobile_safe` database constraint.
const mobileRequiredMessage = { message: "Enter a mobile number." };
const mobileMaxLength = 32;
// Rejects ASCII control characters (C0 range and DEL); every other printable
// character is allowed so international and formatted numbers pass.
// eslint-disable-next-line no-control-regex
const noControlChars = new RegExp("^[^\u0000-\u001f\u007f]+$");
const mobileCharsMessage = { message: "Enter a valid mobile number without control characters." };

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

/**
 * Every value `orders.delivery_status` can actually hold — `deliveryStatuses`
 * above is deliberately narrower (only the states this endpoint can be asked
 * to move an Order TO; "new"/"assigned_to_driver" are reached by creation and
 * assignment, never by a direct target here). `expectedStatus` (Prompt 16
 * offline sync) describes the CURRENT state a caller last observed, which can
 * legitimately be any of those wider values — most commonly
 * "assigned_to_driver" for a Driver who cached an Order before going offline.
 */
const allDeliveryStatuses = ["new", "assigned_to_driver", ...deliveryStatuses] as const;

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

  /**
   * Prompt 16 (Driver offline sync): the delivery status the caller last knew
   * to be current, captured before going offline. Optional and additive —
   * Operator web calls never send it and behave exactly as before. When
   * present, the server compares it against the row's ACTUAL current status
   * (never trusts the client's cached value as truth) to distinguish a queued
   * offline transition that is still valid from one whose Order changed while
   * the Driver was offline (reassigned, cancelled, already advanced by
   * another session) — see `OperationsService.changeOrderStatus`.
   */
  @IsOptional()
  @IsIn(allDeliveryStatuses)
  public readonly expectedStatus?: (typeof allDeliveryStatuses)[number];
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
  @IsIn(["active", "all", "hold", "closed", "cancelled", "accountant"])
  public readonly quickView?: "active" | "all" | "cancelled" | "closed" | "hold" | "accountant";

  @IsOptional()
  @IsString()
  public readonly deliveryStatus?: string;

  @IsOptional()
  @IsIn(["delivery", "collect_order"])
  public readonly orderType?: "collect_order" | "delivery";

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

export class ReactivateHoldOrderRowDto {
  @IsUUID() public readonly orderId!: string;
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(orderIdentifierPattern, orderIdentifierMessage)
  @TrimText()
  public readonly newSerialNumber!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) public readonly newSerialDate!: string;
  @IsIn(["in_branch", "assigned_to_driver", "out_for_delivery"])
  public readonly newStatus!: "assigned_to_driver" | "in_branch" | "out_for_delivery";
}
export class ReactivateHoldOrdersDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReactivateHoldOrderRowDto)
  public readonly orders!: readonly ReactivateHoldOrderRowDto[];
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

  // Optional business reason for the expense — the User may enter one, but
  // confirmation is never blocked on it being present.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly reason?: string;

  @IsOptional()
  @IsUUID()
  public readonly attachmentFileId?: string;
}

const collectionPaymentMethods = ["cash", "visa"] as const;

export class DriverFeeOffsetAllocationDto {
  @IsUUID()
  public readonly accrualId!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  public readonly amount!: number;
}

export class CreateDriverReconciliationDto extends OrderSelectionDto {
  // One payment method for the whole collection: Cash or Visa (Visa = customer paid
  // by card/bank). Optional at the DTO level so a missing value produces the
  // friendlier `reconciliation_payment_method_required` service error rather than
  // a generic validation failure; §5 makes it mandatory to confirm.
  @IsOptional()
  @IsIn(collectionPaymentMethods)
  public readonly collectionPaymentMethod?: (typeof collectionPaymentMethods)[number];

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

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;

  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0)
  public readonly driverFeeOffsetAmount?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DriverFeeOffsetAllocationDto)
  public readonly driverFeeAllocations?: readonly DriverFeeOffsetAllocationDto[];

  /*
   * Employee Driver collection earnings -- operational fact capture only.
   *
   * Neither field carries or implies money. They record what the operator
   * observed: whether this collection counts towards the Driver's collection
   * earnings, and how many Orders it covered when the reconciliation itself
   * cannot say. What that is worth is decided by Payroll from the effective
   * rule, which is why no rate appears anywhere in this request or its response.
   *
   * Absent means "does not count", so every existing caller -- web, mobile and
   * any integration -- keeps its current behaviour untouched.
   */
  @IsOptional()
  @IsBoolean()
  public readonly countsForCollectionEarning?: boolean;

  /*
   * Fallback only. When the reconciliation carries Order links they are
   * authoritative and this is ignored, because a typed number that disagrees
   * with the linked Orders would be a silent correction of the reconciliation.
   * The upper bound matches the 100-Order cap the selection DTO already applies.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  public readonly manualCollectedOrderCount?: number;
}

// Reversal of a confirmed Driver collection (§8): controlled, reason-required,
// audited; never a destructive delete.
export class ReverseDriverReconciliationDto {
  @IsString()
  @TrimText()
  @MinLength(1, { message: "A reason is required to reverse a Driver collection." })
  @MaxLength(500)
  public readonly reason!: string;
}

// Driver Shipment Manifest (§6-§9): built from selected Orders assigned to one
// Driver, entirely independent of Driver cash reconciliation — no financial
// eligibility is required. Explicit historical selections may include an Order
// whose status later became cancelled; its status is displayed in the report.
export class GenerateShipmentManifestDto extends OrderSelectionDto {}

export class InlineOrderCustomerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @TrimText()
  public readonly name!: string;

  @IsString()
  @TrimText()
  @MinLength(1, mobileRequiredMessage)
  @MaxLength(mobileMaxLength)
  @Matches(noControlChars, mobileCharsMessage)
  public readonly mobileNumber!: string;

  @IsOptional()
  @IsString()
  @OptionalTrimmedText()
  @MaxLength(mobileMaxLength)
  @Matches(noControlChars, mobileCharsMessage)
  public readonly secondMobileNumber?: string;

  @IsUUID()
  public readonly areaId!: string;

  /*
   * Optional, matching `customerAddress` on the Order itself. A new Customer
   * captured without one simply gets no saved address record rather than a
   * placeholder; see `resolveCreateOrderCustomer`.
   */
  @IsOptional()
  @IsString()
  @OptionalTrimmedText()
  @MaxLength(500)
  public readonly address?: string;
}

export class CreateOrderDto {
  @IsOptional()
  @IsIn(["delivery", "collect_order"])
  public readonly orderType?: "collect_order" | "delivery";

  /*
   * A deliberate free delivery. Never inferred from zero amounts -- a
   * zero-valued Order can equally be a pricing gap, and the two must stay
   * distinguishable in reporting and in audit.
   *
   * When true the server forces COD and Service Fee to zero and skips Trader
   * pricing resolution entirely, so an unpriced Area cannot block an Order the
   * operator has already decided is free. Trader pricing itself is untouched.
   */
  @IsOptional()
  @IsBoolean()
  public readonly isFreeOrder?: boolean;

  /*
   * Required whenever `isFreeOrder` is true, and rejected when it is not, so a
   * stale reason cannot linger on an Order that is no longer free. Enforced
   * again by `orders_free_order_shape_check`, because a validation rule the
   * database does not share is a rule a second caller can miss.
   */
  @ValidateIf((dto: CreateOrderDto) => dto.isFreeOrder === true)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  @TrimText()
  public readonly freeOrderReason?: string;

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

  @ValidateIf((dto: CreateOrderDto) => dto.orderType !== "collect_order" || dto.areaId !== undefined)
  @IsUUID()
  public readonly areaId?: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;

  @ValidateIf(
    (dto: CreateOrderDto) => dto.orderType !== "collect_order" || dto.customerName !== undefined,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly customerName?: string;

  @ValidateIf(
    (dto: CreateOrderDto) =>
      dto.orderType !== "collect_order" || dto.customerMobileNumber !== undefined,
  )
  @IsString()
  @TrimText()
  @MinLength(1, mobileRequiredMessage)
  @MaxLength(mobileMaxLength)
  @Matches(noControlChars, mobileCharsMessage)
  public readonly customerMobileNumber?: string;

  @IsOptional()
  @IsString()
  @OptionalTrimmedText()
  @MaxLength(mobileMaxLength)
  @Matches(noControlChars, mobileCharsMessage)
  public readonly customerSecondMobileNumber?: string;

  /*
   * Optional. Plenty of deliveries are arranged by phone against a landmark or
   * a pin rather than a written address, and forcing a value there produced
   * placeholder text that was worse than an empty field. The column is NOT NULL
   * with no non-empty check, so an absent address is stored as '' and no
   * migration is needed.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly customerAddress?: string;

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
  @IsInt()
  @Min(1)
  public readonly packageCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;
}

// The authenticated Trader is always resolved from the active portal profile.
// Accepting a Trader identifier from the browser would allow an unsafe
// cross-profile selection, so it is deliberately absent from this contract.
export class CreateTraderPortalOrderDto extends OmitType(CreateOrderDto, ["traderId"] as const) {
  /**
   * Which of the Trader's linked Delivery Companies this Order belongs to
   * (Trader Portal Prompt 3T-C, Part D). Optional: absent (or matching the
   * caller's own session Company) keeps today's behaviour unchanged. See
   * `OperationsService.resolveTraderPortalDeliveryCompany` for how this is
   * validated -- an unrelated or inactive Company is rejected server-side
   * regardless of what the client sends.
   */
  @IsOptional()
  @IsUUID()
  public readonly deliveryCompanyId?: string;
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

  // Blank is allowed, as on create: an Order may legitimately have no written
  // address, and clearing a wrong one must not be forbidden.
  @IsOptional()
  @IsString()
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
  @IsInt()
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

export class ImportTraderPortalOrdersCsvDto extends ImportOrdersCsvDto {
  /**
   * Which Delivery Company the WHOLE batch belongs to (Trader Portal Prompt
   * 3T-C, Part D) — one selection for the entire CSV, not a per-row column;
   * every row resolves to that Company's own Trader record. Same validation
   * as `CreateTraderPortalOrderDto.deliveryCompanyId`.
   */
  @IsOptional()
  @IsUUID()
  public readonly deliveryCompanyId?: string;
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
const driverTypeFilters = ["employee", "outsourced"] as const;
// Collection method filter domain (§3): distinct from `paymentMethods` above, which
// is the bank-tender method on a settlement payment line.
const collectionPaymentMethodFilters = ["cash", "visa", "not_assigned"] as const;
const reconciliationStatusFilters = ["pending", "reconciled", "reversed", "all"] as const;
// Outsourced Driver Fee payment state for a Collection. Employee drivers accrue
// no fee, so their Collections match neither 'paid' nor 'unpaid'.
const driverFeeStatusFilters = ["paid", "unpaid", "all"] as const;
const orderStatusFilters = [
  "new",
  "assigned_to_driver",
  "out_for_delivery",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "cancelled",
  "closed",
] as const;

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
  @IsUUID()
  public readonly emirateId?: string;

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

// Shared filter fields (§3) reused by both the reconciliation list and the
// summary-cards endpoint so the cards always describe the same slice the list
// shows. Every field is optional; the service applies each only when present.
/**
 * Business Date filtering, shared by every operational activity screen.
 *
 * Mixed into each filter DTO rather than inherited, because these DTOs already
 * extend other shapes and a second base class is not available.
 *
 * Deliberately absent: any UTC boundary. The window is resolved server-side by
 * `ReportDateModeService` — a range computed in the browser would be built from
 * the viewer's own clock and zone, and the backend could not tell a wrong one
 * from a right one.
 */
export class BusinessDateFilterDto {
  /** Omitted means the screen's existing calendar behaviour, unchanged. */
  @IsOptional()
  @IsIn(["calendar_date", "business_date"])
  public readonly dateMode?: "business_date" | "calendar_date";

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDateTo?: string;
}

export class DriverCollectionsFilterDto {
  @IsOptional()
  @IsIn(["calendar_date", "business_date"])
  public readonly dateMode?: "business_date" | "calendar_date";

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDateTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly search?: string;

  @IsOptional()
  @IsUUID()
  public readonly driverId?: string;

  @IsOptional()
  @IsIn(driverTypeFilters)
  public readonly driverType?: (typeof driverTypeFilters)[number];

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly orderSerialNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly referenceNumber?: string;

  @IsOptional()
  @IsUUID()
  public readonly traderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly customerName?: string;

  @IsOptional()
  @IsUUID()
  public readonly emirateId?: string;

  @IsOptional()
  @IsUUID()
  public readonly areaId?: string;

  // Delivery Date range (Order.delivered_at) — distinct from Collection Date
  // (the reconciliation's business_date, `dateFrom`/`dateTo` below).
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly deliveredFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly deliveredTo?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly dateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly dateTo?: string;

  // Cash/Visa/Not Assigned — the collection method (§5), distinct from
  // `paymentMethod` below (the bank-tender method on a payment line).
  @IsOptional()
  @IsIn(collectionPaymentMethodFilters)
  public readonly collectionPaymentMethod?: (typeof collectionPaymentMethodFilters)[number];

  @IsOptional()
  @IsIn(reconciliationStatusFilters)
  public readonly reconciliationStatus?: (typeof reconciliationStatusFilters)[number];

  @IsOptional()
  @IsIn(driverFeeStatusFilters)
  public readonly driverFeeStatus?: (typeof driverFeeStatusFilters)[number];

  @IsOptional()
  @IsIn(orderStatusFilters)
  public readonly orderStatus?: (typeof orderStatusFilters)[number];

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  public readonly outstandingOnly?: boolean;
}

export class ReconciliationListQueryDto extends DriverCollectionsFilterDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  public readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsIn(reconciliationPageSizes)
  public readonly pageSize?: (typeof reconciliationPageSizes)[number];

  @IsOptional()
  @IsIn(sortDirections)
  public readonly sortDirection?: (typeof sortDirections)[number];

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

// Summary-cards endpoint (§2): no pagination, same filter vocabulary as the list.
export class DriverCollectionsSummaryQueryDto extends DriverCollectionsFilterDto {}

// ---------------------------------------------------------------------------
// Trader Settlement (Phase 4 Checkpoint 4) — eligibility, allocation, payment
// creation, Money Sent/Received, reversal, list/summary/detail/report-data.
// ---------------------------------------------------------------------------

export const traderSettlementPageSizes = [25, 50, 100] as const;

// The per-Order trader_settlement_status domain (unchanged from the existing schema).
const traderOrderSettlementStatuses = [
  "not_eligible",
  "unsettled",
  "partially_settled",
  "settled",
  "money_sent_to_trader",
  "money_received_by_trader",
  "reversed",
] as const;

// The settlement HEADER's own life-cycle, distinct from the per-Order status above.
const traderSettlementHeaderStatuses = ["confirmed", "reversed", "all"] as const;
const moneyReceivedStatusFilters = ["received", "not_received", "all"] as const;
const traderEligibleOrderSorts = ["deliveredAt", "serialNumber", "outstandingBalance"] as const;
const traderSettlementListSorts = ["paymentDate", "settlementNumber"] as const;

export class TraderSettlementEligibleOrdersQueryDto extends PaginationQueryDto {
  @IsUUID()
  public readonly traderId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly serialNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly referenceNumber?: string;

  @IsOptional()
  @IsUUID()
  public readonly emirateId?: string;

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
  @IsIn(traderOrderSettlementStatuses)
  public readonly settlementStatus?: (typeof traderOrderSettlementStatuses)[number];

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  public readonly outstandingOnly?: boolean;

  @IsOptional()
  @IsIn(traderEligibleOrderSorts)
  public readonly sortBy?: (typeof traderEligibleOrderSorts)[number];
}

// Oldest-first allocation proposal (§6): read-only, writes nothing.
export class ProposeTraderAllocationDto {
  @IsUUID()
  public readonly traderId!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Max(9999999999999.99)
  @Min(0.01)
  public readonly amount!: number;
}

export class TraderSettlementAllocationLineDto {
  @IsUUID()
  public readonly orderId!: string;

  // Zero-value rows are accepted at the DTO level (§7: "may be omitted from
  // persistence") and filtered out by the service before writing.
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Max(9999999999999.99)
  @Min(0)
  public readonly amount!: number;
}

export class CreateTraderSettlementDto {
  /**
   * Company CASH account funding a cash settlement.
   *
   * A separate field from `bankAccountId` rather than one polymorphic id,
   * matching how the table stores them: two columns, so the foreign key
   * itself prevents a Bank account being recorded as the source of a cash
   * payment. Optional here and conditional in the service -- required for
   * cash, rejected for bank transfer.
   */
  @IsOptional()
  @IsUUID()
  public readonly cashAccountId?: string;
  @IsUUID()
  public readonly traderId!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Max(9999999999999.99)
  @Min(0.01)
  public readonly amount!: number;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TraderSettlementAllocationLineDto)
  public readonly allocations!: readonly TraderSettlementAllocationLineDto[];

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

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly paymentDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;

  /**
   * Why this settlement may take its funding account below the permitted floor.
   *
   * Applies to both methods -- a cash settlement draws on a Cash account and a
   * bank transfer on a Bank account, and either can be taken negative.
   *
   * Optional here and conditional in the backend, which is the only place the
   * condition can be evaluated: whether an override is needed depends on the
   * balance at confirmation and the Company policy in force.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly balanceOverrideReason?: string;
}

export class TraderAccountStatementQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/)
  public readonly month?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly to?: string;

  @IsOptional()
  @IsIn(["all", "order", "payment", "reversal"])
  public readonly transactionType?: "all" | "order" | "payment" | "reversal";

  @IsOptional()
  @IsIn(["all", "confirmed", "reversed"])
  public readonly settlementStatus?: "all" | "confirmed" | "reversed";

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  public readonly paidOnly?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  public readonly outstandingOnly?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  public readonly reversedOnly?: boolean;

  @IsOptional()
  @IsIn(["en", "ar"])
  public readonly language?: "en" | "ar";
}

// Money Received confirmation (§12): separate from Money Sent (payment creation).
export class ConfirmTraderSettlementReceiptDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly receivedDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;
}

// Reversal (§13): reason-required, never a destructive delete.
export class ReverseTraderSettlementDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  @TrimText()
  public readonly reason!: string;
}

export class TraderSettlementFilterDto {
  @IsOptional()
  @IsIn(["calendar_date", "business_date"])
  public readonly dateMode?: "business_date" | "calendar_date";

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDateTo?: string;

  @IsOptional()
  @IsUUID()
  public readonly traderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly settlementNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly orderSerialNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly referenceNumber?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly paymentDateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly paymentDateTo?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly deliveredFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly deliveredTo?: string;

  @IsOptional()
  @IsIn(paymentMethods)
  public readonly paymentMethod?: (typeof paymentMethods)[number];

  @IsOptional()
  @IsIn(traderSettlementHeaderStatuses)
  public readonly settlementStatus?: (typeof traderSettlementHeaderStatuses)[number];

  @IsOptional()
  @IsIn(moneyReceivedStatusFilters)
  public readonly moneyReceivedStatus?: (typeof moneyReceivedStatusFilters)[number];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public readonly paymentReference?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  public readonly outstandingOnly?: boolean;
}

export class TraderSettlementListQueryDto extends TraderSettlementFilterDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  public readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsIn(traderSettlementPageSizes)
  public readonly pageSize?: (typeof traderSettlementPageSizes)[number];

  @IsOptional()
  @IsIn(sortDirections)
  public readonly sortDirection?: (typeof sortDirections)[number];

  @IsOptional()
  @IsIn(traderSettlementListSorts)
  public readonly sortBy?: (typeof traderSettlementListSorts)[number];
}

// Summary-cards endpoint (§16): no pagination, same filter vocabulary as the list.
export class TraderSettlementSummaryQueryDto extends TraderSettlementFilterDto {}

// ---------------------------------------------------------------------------
// Trader Receivable (Collect Money from Trader) — the reverse money-flow
// direction from Trader Settlement. Kept fully separate: its own page-size
// list, status/source-type domains, and DTOs, none shared with Trader
// Settlement, Money Sent/Received, or Driver Collections.
// ---------------------------------------------------------------------------

export const traderReceivablePageSizes = [25, 50, 100] as const;

const traderReceivableSourceTypes = [
  "manual_adjustment",
  "trader_penalty",
  "overpayment_recovery",
  "refund_due",
  "service_charge",
  "damaged_or_lost_shipment_recovery",
  "other",
] as const;

const traderReceivableStatuses = [
  "outstanding",
  "partially_collected",
  "collected",
  "cancelled",
  "reversed",
] as const;

const traderCollectionHeaderStatuses = ["confirmed", "reversed", "all"] as const;
const traderReceivableEligibleSorts = [
  "businessDate",
  "receivableNumber",
  "outstandingAmount",
] as const;
const traderCollectionListSorts = ["paymentDate", "collectionNumber"] as const;

export class CreateTraderReceivableDto {
  @IsUUID()
  public readonly traderId!: string;

  @IsIn(traderReceivableSourceTypes)
  public readonly sourceType!: (typeof traderReceivableSourceTypes)[number];

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly sourceReference?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDate!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Max(9999999999999.99)
  @Min(0.01)
  public readonly amountDue!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  @TrimText()
  public readonly reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;
}

export class CancelTraderReceivableDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  @TrimText()
  public readonly reason!: string;
}

export class TraderReceivableEligibleQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  public readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsIn(traderReceivablePageSizes)
  public readonly pageSize?: (typeof traderReceivablePageSizes)[number];

  @IsOptional()
  @IsIn(sortDirections)
  public readonly sortDirection?: (typeof sortDirections)[number];

  @IsOptional()
  @IsIn(traderReceivableEligibleSorts)
  public readonly sortBy?: (typeof traderReceivableEligibleSorts)[number];

  @IsOptional()
  @IsUUID()
  public readonly traderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly receivableNumber?: string;

  @IsOptional()
  @IsIn(traderReceivableSourceTypes)
  public readonly sourceType?: (typeof traderReceivableSourceTypes)[number];

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly sourceReference?: string;

  @IsOptional()
  @IsIn(traderReceivableStatuses)
  public readonly status?: (typeof traderReceivableStatuses)[number];

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDateTo?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  public readonly outstandingOnly?: boolean;
}

// Oldest-first allocation proposal: read-only, writes nothing.
export class ProposeTraderReceivableAllocationDto {
  @IsUUID()
  public readonly traderId!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Max(9999999999999.99)
  @Min(0.01)
  public readonly amount!: number;
}

export class TraderCollectionAllocationLineDto {
  @IsUUID()
  public readonly receivableId!: string;

  // Zero-value rows are accepted at the DTO level and filtered out by the
  // service before writing, matching the Trader Settlement allocation shape.
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Max(9999999999999.99)
  @Min(0)
  public readonly amount!: number;
}

export class CreateTraderCollectionDto {
  @IsUUID()
  public readonly traderId!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Max(9999999999999.99)
  @Min(0.01)
  public readonly amountReceived!: number;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TraderCollectionAllocationLineDto)
  public readonly allocations!: readonly TraderCollectionAllocationLineDto[];

  @IsOptional()
  @IsIn(paymentMethods)
  public readonly paymentMethod?: (typeof paymentMethods)[number];

  @IsOptional()
  @IsUUID()
  public readonly bankAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly paymentReference?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly paymentDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly notes?: string;
}

export class ReverseTraderCollectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  @TrimText()
  public readonly reason!: string;
}

export class TraderCollectionFilterDto {
  @IsOptional()
  @IsIn(["calendar_date", "business_date"])
  public readonly dateMode?: "business_date" | "calendar_date";

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly businessDateTo?: string;

  @IsOptional()
  @IsUUID()
  public readonly traderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly collectionNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly receivableNumber?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly paymentDateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public readonly paymentDateTo?: string;

  @IsOptional()
  @IsIn(paymentMethods)
  public readonly paymentMethod?: (typeof paymentMethods)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly paymentReference?: string;

  @IsOptional()
  @IsIn(traderCollectionHeaderStatuses)
  public readonly status?: (typeof traderCollectionHeaderStatuses)[number];
}

export class TraderCollectionListQueryDto extends TraderCollectionFilterDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  public readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsIn(traderReceivablePageSizes)
  public readonly pageSize?: (typeof traderReceivablePageSizes)[number];

  @IsOptional()
  @IsIn(sortDirections)
  public readonly sortDirection?: (typeof sortDirections)[number];

  @IsOptional()
  @IsIn(traderCollectionListSorts)
  public readonly sortBy?: (typeof traderCollectionListSorts)[number];
}

// Summary-cards endpoint: no pagination, same filter vocabulary as the list.
export class TraderCollectionSummaryQueryDto extends TraderCollectionFilterDto {}

/**
 * A Trader editing its own portal profile.
 *
 * Deliberately excludes `name` and `mobileNumber`: those are the primary
 * identity fields already referenced by Delivery Orders and settlements, and
 * changing them from the portal without a verification step is out of scope
 * here (Trader Workspace Prompt 3T-A, §42).
 */
export class UpdateTraderPortalProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public contactPerson?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  public telephone?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  public email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  public commercialNumber?: string | null;

  @IsOptional()
  @IsIn(["en", "ar"])
  public preferredLanguage?: string;
}
