import type {
  AccountingComponentType,
  AccountingCurrency,
  AccountingEventType,
} from "./accounting.constants.js";

export interface AccountingFinancialComponent {
  readonly amount: string;
  readonly componentType: AccountingComponentType;
  readonly description?: string;
  readonly entryIntent: "debit" | "credit";
  readonly mappingKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly sourceReference?: string;
  readonly subledgerId?: string;
  readonly subledgerType?: string;
  readonly vatTreatment?: string;
}

/**
 * Facts emitted by operational modules in a later Accounting prompt.
 * It deliberately contains mapping keys rather than General Ledger accounts.
 */
export interface AccountingEventContract {
  readonly actorId: string;
  readonly actorType: string;
  readonly companyId: string;
  readonly components: readonly AccountingFinancialComponent[];
  readonly correlationId: string;
  readonly createdAt: string;
  readonly currency: AccountingCurrency;
  readonly description: string;
  readonly effectiveAccountingDate: string;
  readonly eventType: AccountingEventType;
  readonly eventVersion: number;
  readonly idempotencyKey: string;
  readonly reversalOfEventId?: string;
  readonly sourceEntityId: string;
  readonly sourceEntityType: string;
  readonly sourceReference?: string;
  readonly supplementaryMetadata?: Readonly<Record<string, unknown>>;
}

export interface AccountingMappingIssue {
  readonly accountId?: string;
  readonly code:
    | "missing"
    | "inactive_account"
    | "summary_account"
    | "effective_date_gap"
    | "overlap"
    | "incompatible_account";
  readonly mappingKey: string;
}

export interface AccountingMappingAreaReadiness {
  readonly area: string;
  readonly configuredMappingKeys: readonly string[];
  readonly issues: readonly AccountingMappingIssue[];
  readonly missingMappingKeys: readonly string[];
  readonly ready: boolean;
  readonly requiredMappingKeys: readonly string[];
}
