export interface LoginResponse {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly identity: {
    readonly companyId: string;
    readonly displayName?: string;
    readonly id: string;
    readonly kind: string;
    readonly permissions: readonly string[];
    readonly username: string;
    readonly forcePasswordChange: boolean;
  };
  readonly tokenType: "Bearer";
}

export interface OperationsOrderQuote {
  readonly additionalFees: string;
  readonly additionalFeeVatAmount: string;
  readonly codAmount: string;
  readonly companyRevenue: string;
  readonly configuredServiceFee: string;
  readonly customerAmountDue: string;
  readonly orderProfit: string;
  readonly overrideApplied: boolean;
  readonly pricingProvenance: "manual" | "resolved";
  readonly pricingRuleId: string | null;
  readonly serviceFee: string;
  readonly serviceFeeVatAmount: string;
  readonly totalDeductions: string;
  readonly traderNetPayable: string;
  readonly vatAmount: string;
  readonly vatEnabled: boolean;
  readonly vatPriceMode: "exclusive" | "inclusive" | null;
  readonly vatRate: string;
}

export interface TraderSummary {
  readonly code: string;
  readonly contactPerson: string | null;
  readonly currentServiceFee: string | null;
  readonly id: string;
  readonly mobileNumber: string;
  readonly mobileWarning: boolean;
  readonly name: string;
  readonly outstandingAmount: string;
  readonly pickupArea: string | null;
  readonly pricingType: "configured" | null;
  readonly priceRuleCount: number | null;
  readonly status: "active" | "disabled";
}

export interface TraderPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface SearchPage<T> {
  readonly hasMore: boolean;
  readonly items: readonly T[];
  readonly total: number;
}

export interface OperationsTraderOption {
  readonly code: string;
  readonly id: string;
  readonly mobileNumber: string;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly pickupAreaId: string | null;
  readonly pickupAreaNameAr: string | null;
  readonly pickupAreaNameEn: string | null;
  readonly pickupEmirateId: string | null;
  readonly pickupEmirateNameAr: string | null;
  readonly pickupEmirateNameEn: string | null;
  readonly secondMobileNumber: string | null;
}

export interface Permission {
  readonly code: string;
  readonly description: string;
}

export interface Role {
  readonly code: string;
  readonly id: string;
  readonly isActive: boolean;
  readonly isSystem: boolean;
  readonly name: string;
  readonly permissions: readonly string[];
  readonly description: string | null;
  readonly assignedUserCount: number;
  readonly permissionCount: number;
  readonly scope: "company";
}

export interface CompanyUser {
  readonly accountKind: "company_user" | "driver" | "trader";
  readonly accountId: string;
  readonly email: string | null;
  readonly failedLoginAttempts: number;
  readonly lastLoginAt: string | null;
  readonly lockedUntil: string | null;
  readonly mobileNumber: string | null;
  readonly nameAr: string | null;
  readonly nameEn: string | null;
  readonly roleIds: readonly string[];
  readonly status: string;
  readonly username: string;
  readonly displayName: string;
  readonly employeeCode: string | null;
  readonly employeeName: string | null;
  readonly forcePasswordChange: boolean;
  readonly roleNames: readonly string[];
}

export interface AdministrationPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface EmployeeOption {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
  readonly jobTitle: string | null;
}

export interface UserDetails extends CompanyUser {
  readonly preferredLanguage: "en" | "ar";
  readonly lastFailedLoginAt: string | null;
  readonly passwordChangedAt: string | null;
  readonly temporaryPasswordExpiresAt: string | null;
  readonly lockReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly employeeId: string | null;
  readonly employeeJobTitle: string | null;
  readonly employeeStatus: string | null;
  /** The Driver identity this account operates as, if any -- either a
   *  driver-kind account's own linked Driver, or the backing Driver record
   *  of this account's linked Employee. Read-only. */
  readonly driverId: string | null;
  readonly driverCode: string | null;
  readonly roles: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly isActive: boolean;
  }[];
  readonly effectivePermissions: readonly {
    readonly code: string;
    readonly description: string;
    readonly sourceRoles: readonly string[];
  }[];
  readonly sessions: readonly AdministrationSession[];
  readonly audit: readonly AdministrationAuditEvent[];
  readonly linkedProfiles: readonly {
    readonly id: string;
    readonly profileType: "employee" | "driver" | "trader";
    readonly profileId: string;
    readonly accessStatus: string;
    readonly businessStatus: string | null;
    readonly code: string | null;
    readonly name: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
}

export interface AdministrationSession {
  readonly id: string;
  readonly createdAt: string;
  readonly lastActivity: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly isCurrent: boolean;
}

export interface AdministrationAuditEvent {
  readonly id: string;
  readonly eventType: string;
  readonly actor: string | null;
  readonly occurredAt: string;
  readonly reason: string | null;
  readonly previousValue: unknown;
  readonly newValue: unknown;
}

export interface RoleDetails extends Role {
  readonly assignedUsers: readonly {
    readonly accountId: string;
    readonly username: string;
    readonly displayName: string;
    readonly status: string;
  }[];
  readonly audit: readonly AdministrationAuditEvent[];
}

export interface SupportCase {
  readonly caseNumber: string;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly description: string;
  readonly id: string;
  readonly priority: string;
  readonly resolutionNotes: string | null;
  readonly resolvedAt: string | null;
  readonly status: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface Emirate {
  readonly code: string;
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string;
}

export interface CompanyArea {
  readonly code: string;
  readonly emirateCode: string;
  readonly emirateId: string;
  readonly emirateNameAr: string;
  readonly emirateNameEn: string;
  readonly id: string;
  readonly isActive: boolean;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly notes: string | null;
  readonly updatedAt: string;
}

export interface AreaPage {
  readonly items: readonly CompanyArea[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface BusinessDayConfiguration {
  readonly businessDayStart: string;
  readonly changeReason: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
  /** Null means the rule has always applied. */
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly id: string;
  readonly isCurrent: boolean;
  readonly timezone: string;
}

/**
 * What the backend actually applied, returned with each activity list.
 *
 * Every field is resolved server-side. The browser renders these values and
 * never recomputes them.
 */
export interface AppliedReportDateMode {
  readonly authoritativeTimestamp: string | null;
  readonly businessDateFrom: string | null;
  readonly businessDateTo: string | null;
  readonly businessDayStart: string | null;
  readonly dateMode: "accounting_date" | "business_date" | "calendar_date";
  /** Inclusive instant to display. Never the value to filter on. */
  readonly displayEnd: string | null;
  readonly endUtc: string | null;
  /** Rows without an authoritative timestamp were left out. */
  readonly excludesHistoricalRows: boolean;
  readonly segments: readonly BusinessDayWindowSegment[];
  readonly spansRuleChange: boolean;
  readonly startUtc: string | null;
  readonly timezone: string | null;
}

/** One rule's slice of a range. Segments are contiguous: each ends where the next begins. */
export interface BusinessDayWindowSegment {
  readonly businessDateFrom: string;
  readonly businessDateTo: string;
  readonly businessDayStart: string;
  readonly configurationId: string;
  readonly displayEnd: string;
  readonly endUtc: string;
  readonly startUtc: string;
  readonly timezone: string;
}

/** Resolved by the backend. `endUtc` is exclusive; `displayEnd` is for reading. */
export interface BusinessDayWindow {
  readonly businessDateFrom: string;
  readonly businessDateTo: string;
  readonly businessDayStart: string;
  readonly displayEnd: string;
  readonly endUtc: string;
  /** The windows that define the range. Filter on these, not the outer span. */
  readonly segments: readonly BusinessDayWindowSegment[];
  /** True when the range crosses a rule change. */
  readonly spansRuleChange: boolean;
  readonly startUtc: string;
  readonly timezone: string;
}

export interface CompanySettings {
  readonly baseCurrency: string;
  readonly defaultLanguage: string;
  readonly documentExpiryAlertDays: number | null;
  readonly orderPendingAlertHours: number | null;
  readonly timezone: string;
  readonly vatEnabled: boolean;
  readonly vatPriceMode: string | null;
  readonly vatRate: string | null;
}

export interface CompanyBankAccount {
  readonly accountName: string;
  readonly accountNumberMasked: string | null;
  readonly bankName: string;
  readonly currency: string;
  readonly iban: string | null;
  readonly id: string;
  readonly isActive: boolean;
  readonly swiftCode: string | null;
}

export interface CompanyLogoMetadata {
  readonly fileId: string;
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly sizeBytes: number;
  readonly updatedAt: string;
}

export interface CompanyProfile {
  readonly logo: CompanyLogoMetadata | null;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly subtitleAr: string | null;
  readonly subtitleEn: string | null;
  readonly telephone: string | null;
}

export interface CompanyBranding {
  readonly dataQuality: {
    readonly nameArMissing: boolean;
    readonly subtitleArMissing: boolean;
    readonly subtitleEnMissing: boolean;
  };
  readonly hasLogo: boolean;
  readonly logoFileId: string | null;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly subtitleAr: string | null;
  readonly subtitleEn: string | null;
  readonly telephone: string | null;
}

export interface AccountPreferences {
  readonly textLanguage: "en" | "ar";
  readonly theme: "light" | "dark" | "system";
}

export interface WorkforcePage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface EmployeeSummary {
  readonly basicSalary: string;
  readonly code: string;
  readonly commissionEnabled: boolean;
  readonly documentStatus: string;
  readonly employeeType: string | null;
  readonly id: string;
  readonly jobTitle: string | null;
  readonly mobileNumber: string | null;
  readonly name: string;
  readonly status: "active" | "disabled";
}

export interface DriverSummary {
  readonly code: string;
  readonly commissionMethod: string | null;
  readonly commissionRate: string | null;
  readonly documentStatus: string;
  readonly id: string;
  readonly linkedEmployee: string | null;
  readonly mobileNumber: string;
  readonly name: string;
  readonly status: "active" | "disabled";
  readonly type: "employee" | "outsourced";
  readonly vehicle: string | null;
}

export interface OperationsOverview {
  readonly counts: {
    readonly activeDrivers: number;
    readonly activeTraders: number;
    readonly orders: number;
    readonly pendingCashOrders: number;
    readonly unsettledTraderOrders: number;
  };
  readonly deliveryStatuses: readonly { readonly count: number; readonly status: string }[];
  readonly financials: {
    readonly codAmount: string;
    readonly companyRevenue: string;
    readonly customerAmountDue: string;
    readonly orderProfit: string;
    readonly traderNetPayable: string;
    readonly vatAmount: string;
  };
}

export interface OperationsExportFile {
  readonly content: string;
  readonly contentType: "text/csv";
  readonly filename: string;
}

export interface OperationsBillingSummary {
  readonly billableOrders: number;
  readonly commercialStatus: string;
  readonly currentPeriodStart: string;
  readonly lastUsageAt: string | null;
  readonly planName: string;
}

export interface OperationsOrder {
  /** Server-computed: the Order carries COD, Fee, Additional Fees or VAT. */
  readonly accountingRequired?: boolean;
  /** Delivery instant. Null until delivered. */
  readonly deliveredAt?: string | null;
  /**
   * Business Date of the delivery, backend-derived. Delivery Activity only.
   * Not `confirmationBusinessDate` — that comes from a confirmation, this from
   * a delivery.
   */
  readonly deliveryBusinessDate?: string | null;
  readonly additionalFees?: string | null;
  readonly additionalFeeVatAmount?: string | null;
  readonly amountCollected: string;
  readonly areaName: string;
  /** Present on Order detail responses. */
  readonly areaId?: string;
  readonly areaNameEn?: string | null;
  readonly areaNameAr?: string | null;
  readonly emirateId?: string | null;
  /** Present only on the single-order detail fetch, not the list. */
  readonly emirateNameEn?: string;
  readonly emirateNameAr?: string;
  readonly assignedDriverId: string | null;
  readonly assignedDriverMobile: string | null;
  readonly assignedDriverName: string | null;
  /** Present on list and detail responses; identifier only. */
  readonly traderId?: string;
  /** Deliberate free delivery: COD and every fee are fixed at zero. */
  readonly isFreeOrder?: boolean;
  readonly codAmount: string;
  readonly companyRevenue: string;
  readonly customerAmountDue: string;
  readonly customerAddress: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly deliveryStatus: string;
  readonly driverReconciliationStatus: string;
  readonly id: string;
  readonly orderDate: string;
  readonly orderNumber: string;
  readonly orderType?: "collect_order" | "delivery";
  readonly orderProfit: string;
  readonly outsourcedDriverFeeAmount: string | null;
  readonly outsourcedDriverFeeOutstanding: string | null;
  readonly outsourcedDriverFeePaid: string | null;
  readonly outsourcedDriverFeePaymentNumbers: string | null;
  readonly outsourcedDriverFeeStatus: string;
  readonly referenceNumber?: string | null;
  readonly returnStatus: string;
  readonly serviceFee: string;
  readonly serviceFeeOverrideReason?: string | null;
  readonly serviceFeeVatAmount?: string | null;
  readonly serialNumber?: string | null;
  readonly totalDeductions?: string | null;
  readonly traderNetPayable: string;
  readonly traderReceivableId?: string | null;
  readonly traderReceivableNumber?: string | null;
  readonly traderReceivableOutstanding?: string | null;
  readonly traderReceivableStatus?: string | null;
  readonly traderName: string;
  readonly traderSettlementStatus: string;
  /** Ledger-derived Accounting state for this Order. */
  readonly accountingState?: string;
  /** Server-derived workflow guidance. Presentation only; never persisted. */
  readonly workflowGuidance?: {
    readonly completionBlockerCode: string | null;
    readonly isFinanciallyComplete: boolean;
    readonly nextActionCode: string;
    readonly nextActionParams: Readonly<Record<string, string>>;
    readonly nextActionRoute: string | null;
    readonly waitingFor: string;
    readonly workflowState: string;
  };
  readonly vatAmount: string;
}

export interface OperationsOrderPage {
  /** Present on Delivery Activity responses. */
  readonly appliedDateMode?: AppliedReportDateMode;
  readonly filteredCount: number;
  readonly matchingCount?: number;
  readonly items: readonly OperationsOrder[];
  readonly page: number;
  readonly pageSize: 25 | 50 | 100;
  readonly totalCount: number;
  readonly tabTotalCount?: number;
}

export interface OperationsOrderDetail extends OperationsOrder {
  readonly attachments: readonly OperationsOrderAttachment[];
  readonly history: readonly {
    readonly changedBy: string;
    readonly fromStatus: string | null;
    readonly occurredAt: string;
    readonly reason: string | null;
    readonly statusDimension: string;
    readonly toStatus: string;
  }[];
  readonly internationalShipment: OperationsInternationalShipment | null;
  readonly metadata: {
    readonly closedAt: string | null;
    readonly createdAt: string;
    readonly createdBy: string;
    readonly customerSecondMobileNumber: string | null;
    readonly driverCost: string;
    readonly notes: string | null;
    readonly operationalCompletedAt: string | null;
    readonly orderExpensesTotal: string;
    readonly packageCount: number;
    readonly paymentCondition: string;
    readonly returnDriverFee: string;
    readonly traderNetPayable: string;
  };
  readonly events: readonly {
    readonly actor: string;
    readonly actorRole: string;
    readonly category: string;
    readonly correlationId: string;
    readonly eventType: string;
    readonly fieldName: string | null;
    readonly id: string;
    readonly newValue: unknown;
    readonly occurredAt: string;
    readonly previousValue: unknown;
    readonly reason: string | null;
    readonly source: string;
  }[];
}

export interface OperationsOrderAttachment {
  readonly attachmentType: string;
  readonly createdAt: string;
  readonly fileId: string;
  readonly fileName: string;
  readonly id: string;
  readonly mediaType: string;
  readonly scanStatus: string;
  readonly sizeBytes: string;
  readonly uploadedBy: string;
}

export interface OperationsInternationalShipment {
  readonly currentStatus: string;
  readonly customerCharge: string;
  readonly destinationCountryCode: string;
  readonly expectedDeliveryDate: string | null;
  readonly id: string;
  readonly internationalDeliveryCost: string;
  readonly notes: string | null;
  readonly providerName: string;
  readonly providerReferenceNumber: string | null;
  readonly shipmentDate: string | null;
}

export interface OperationsTrackingLink {
  readonly expiresAt: string;
  readonly token: string;
  readonly url: string;
}

export interface PublicOrderTracking {
  readonly areaName: string;
  readonly assignedDriverName: string | null;
  readonly companyName: string;
  readonly customerName: string;
  readonly deliveredAt: string | null;
  readonly deliveryStatus: string;
  readonly lastUpdatedAt: string;
  readonly orderNumber: string;
}

export interface PortalOrder {
  readonly amountCollected: string;
  readonly areaId: string;
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerAmountDue: string;
  readonly customerAddress: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly deliveryStatus: string;
  readonly id: string;
  readonly notes: string | null;
  readonly orderDate: string;
  readonly orderNumber: string;
  readonly packageCount: number;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
  readonly serviceFee: string;
  readonly traderName: string;
  readonly traderSettlementStatus: string;
}

/** One Order row from the searchable Trader Orders list — an explicit
    allow-list, distinct from the Company `OperationsOrder` shape. */
export interface TraderPortalOrderSummary {
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerAddress: string;
  readonly customerAmountDue: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  /** Present only from the cross-Company `trader/orders/search/all-companies` route. */
  readonly deliveryCompanyId?: string;
  readonly deliveryCompanyName?: string;
  readonly deliveryStatus: string;
  readonly id: string;
  readonly orderDate: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly serviceFee: string;
}

export interface TraderPortalOrderPage {
  readonly filteredCount: number;
  readonly items: readonly TraderPortalOrderSummary[];
  readonly page: number;
  readonly pageSize: 25 | 50 | 100;
  readonly totalCount: number;
}

/** One row's outcome. Optional throughout: an older API build omits it. */
export interface OperationsOrderImportRow {
  readonly accountingRequired: boolean | null;
  readonly errorField: string | null;
  readonly errorMessage: string | null;
  readonly feeSource: "configured_price" | "manual_override" | "zero_configured_price" | null;
  readonly orderNumber: string | null;
  readonly referenceNumber: string | null;
  readonly resolvedServiceFee: string | null;
  readonly rowNumber: number;
  readonly status: "imported" | "invalid";
  readonly zeroFeeReason: string | null;
}

export interface OperationsOrderImportResult {
  readonly errors: readonly string[];
  readonly importNumber: string;
  readonly importedRows: number;
  readonly invalidRows: number;
  /** Added alongside `errors`, never replacing it. */
  readonly rows?: readonly OperationsOrderImportRow[];
  readonly totalRows: number;
}

export interface OperationsTrader {
  readonly code: string;
  readonly id: string;
  readonly mobileNumber: string;
  readonly name: string;
  readonly openOrders: number;
  readonly status: string;
  readonly totalOrders: number;
  readonly unsettledNetPayable: string;
}

export interface OperationsDriver {
  readonly activeOrders: number;
  readonly code: string;
  readonly deliveredOrders: number;
  readonly id: string;
  readonly mobileNumber: string;
  readonly name: string;
  readonly pendingCashOrders: number;
  readonly status: string;
  readonly type: string;
}

export interface OperationsPendingCashOrder {
  readonly amountCollected: string;
  readonly assignedDriverName: string;
  readonly codAmount: string;
  readonly customerAmountDue: string;
  readonly customerName: string;
  readonly driverId: string;
  readonly id: string;
  readonly orderNumber: string;
  readonly serviceFee: string;
  readonly vatAmount: string;
}

/** Approved page sizes for the Driver Cash Reconciliation module. */
export const reconciliationPageSizes = [25, 50, 100] as const;
export type ReconciliationPageSize = (typeof reconciliationPageSizes)[number];

export interface PagedResponse<T> {
  /** Present on activity lists that support Date Mode; absent elsewhere. */
  readonly appliedDateMode?: AppliedReportDateMode;
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface OperationsDriverReconciliation {
  /** The reconciliation's own date-only field. NOT the Company Business Date. */
  readonly businessDate: string;
  /**
   * Company Business Date, derived by the backend from `confirmedAt`.
   *
   * Null when no authoritative confirmation timestamp was recorded. Optional so
   * an older API build simply omits it. Never computed in the browser.
   */
  readonly confirmationBusinessDate?: string | null;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string;
  readonly driverName: string;
  readonly driverType: string;
  readonly expenseTotal: string;
  readonly grossCollections: string;
  readonly id: string;
  readonly netAmountReceived: string;
  readonly orderCount: number;
  readonly paymentTotal: string;
  readonly reconciliationNumber: string;
  readonly status: string;
  readonly statusLabel: string;
}

export interface OperationsDriverReconciliationDetail {
  readonly audit: readonly {
    readonly action: string;
    readonly actor: string;
    readonly occurredAt: string;
  }[];
  readonly expenses: readonly {
    readonly amount: string;
    readonly description: string | null;
    readonly expenseType: string;
    readonly id: string;
    readonly recordedAt: string;
    readonly recordedBy: string;
    readonly reference: string | null;
  }[];
  readonly orders: readonly {
    readonly amountCollected: string;
    readonly cashStatus: string;
    readonly cashStatusLabel: string;
    readonly customerName: string;
    readonly driverPayableDeduction: string;
    readonly id: string;
    readonly orderNumber: string;
  }[];
  readonly overview: OperationsDriverReconciliation;
  readonly payments: readonly {
    readonly amount: string;
    readonly bankAccountName: string | null;
    readonly bankName: string | null;
    readonly bankReference: string | null;
    readonly id: string;
    readonly paymentAt: string;
    readonly paymentMethod: string;
    readonly paymentMethodLabel: string;
    readonly recordedBy: string;
  }[];
}

export interface OperationsPendingSettlementOrder {
  readonly customerName: string;
  readonly grossPayable: string;
  readonly id: string;
  readonly netPayable: string;
  readonly orderNumber: string;
  readonly serviceFee: string;
  readonly traderId: string;
  readonly traderName: string;
}

export interface OperationsTraderSettlement {
  readonly businessDate: string;
  readonly confirmedAt: string | null;
  readonly grossPayable: string;
  readonly id: string;
  readonly netPayable: string;
  readonly orderCount: number;
  readonly serviceFeeDeductions: string;
  readonly settlementNumber: string;
  readonly status: string;
  readonly traderName: string;
}

export interface OperationsTraderSettlementDetail extends OperationsTraderSettlement {
  readonly orders: readonly {
    readonly customerName: string;
    readonly grossPayable: string;
    readonly netPayable: string;
    readonly orderId: string;
    readonly orderNumber: string;
    readonly serviceFee: string;
  }[];
  readonly payments: readonly {
    readonly amount: string;
    readonly bankAccountName: string | null;
    readonly bankReference: string | null;
    readonly method: string;
  }[];
}

export interface CustomerSummary {
  readonly area: string | null;
  readonly code: string;
  readonly id: string;
  readonly lastOrderDate: string | null;
  readonly mobileNumber: string;
  readonly name: string;
  readonly orderCount: number;
  readonly primaryAddress: string | null;
  readonly status: "active" | "disabled";
}

export interface CustomerPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface CustomerOption {
  readonly address: string;
  readonly addressId: string;
  readonly areaCode: string;
  readonly areaId: string;
  readonly areaName: string;
  readonly areaNameAr: string | null;
  readonly code: string;
  readonly customerReference: string | null;
  readonly deliveryInstructions: string | null;
  readonly deliveryNotes: string | null;
  readonly email: string | null;
  readonly emirateId: string;
  readonly emirateNameAr: string;
  readonly emirateNameEn: string;
  readonly id: string;
  readonly latitude: string | null;
  readonly locationLink: string | null;
  readonly longitude: string | null;
  readonly mobileNumber: string;
  readonly name: string;
  readonly secondMobileNumber: string | null;
}
export interface CommunicationConversation {
  readonly id: string;
  readonly type: "order" | "support";
  readonly orderNumber: string | null;
  readonly status: "active" | "waiting" | "resolved";
  readonly priority: "normal" | "high" | "urgent";
  readonly lastActivityAt: string;
  readonly lastMessagePreview: string | null;
  readonly unreadCount: number;
}

export interface CommunicationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly senderRole: "operator" | "trader" | "driver" | "customer" | "system";
  readonly type: "text" | "voice" | "system";
  readonly body: string | null;
  readonly createdAt: string;
  readonly state: "sent" | "delivered" | "read";
}
