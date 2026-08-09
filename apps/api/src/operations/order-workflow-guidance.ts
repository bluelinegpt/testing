/**
 * "What is this Order waiting for?" — derived, never stored.
 *
 * ===========================================================================
 * THIS IS NOT A SECOND STATUS MODEL
 * ===========================================================================
 *
 * Nothing here is persisted and nothing here decides anything. Every value is
 * computed from state the Orders list ALREADY selects, and the four existing
 * statuses remain the only authority:
 *
 *   delivery_status              -- where the parcel is
 *   driver_reconciliation_status -- whether the Driver's cash came in
 *   trader_settlement_status     -- whether the Trader has been paid
 *   accountingRequired           -- whether this Order touches the ledger
 *
 * If those four disagree with anything below, they are right and this is
 * wrong. The guidance exists to explain them, not to compete with them.
 *
 * ===========================================================================
 * WHY A PURE FUNCTION OVER ALREADY-SELECTED COLUMNS
 * ===========================================================================
 *
 * The alternative was extra joins, or worse a per-row lookup from the browser.
 * Every field consumed here is already in the list `select`, so the guidance
 * costs one function call per row and no additional database work at all. An
 * N+1 is not merely avoided; it is impossible to introduce without changing
 * this signature.
 *
 * ===========================================================================
 * ORDER OF EVALUATION MATTERS
 * ===========================================================================
 *
 * Blockers are tested FIRST. A reversed collection on a delivered Order must
 * not be reported as "waiting to collect money from Driver" -- that would send
 * a user to create a second collection for money that was already collected
 * and then reversed. Terminal lifecycle states come next, then the financial
 * chain in the order the business actually performs it.
 */

/** Stable codes. The frontend localizes these; they are never shown raw. */
export type OrderWorkflowState =
  | "awaiting_driver_assignment"
  | "awaiting_delivery"
  | "awaiting_delivery_start"
  | "awaiting_return_processing"
  | "awaiting_driver_collection"
  | "awaiting_trader_payment"
  | "awaiting_trader_receipt_confirmation"
  | "awaiting_accounting_posting"
  | "no_accounting_required"
  | "complete"
  | "blocked";

/**
 * The ledger's own answer for this Order, from the Accounting Event and its
 * Journal. Distinct from `accountingRequired`, which only says an Event SHOULD
 * exist -- it never says one posted.
 */
export type OrderAccountingState =
  | "accounting_not_required"
  | "accounting_event_missing"
  | "accounting_event_waiting"
  | "accounting_event_failed"
  | "accounting_event_posted"
  | "journal_pending"
  | "journal_posted"
  | "accounting_blocked_closed_period"
  | "accounting_blocked_missing_mapping"
  | "accounting_blocked_duplicate";

export type OrderNextActionCode =
  | "assign_driver"
  | "open_order"
  | "collect_from_driver"
  | "pay_trader"
  | "confirm_trader_received"
  | "open_settlement"
  | "open_accounting"
  | "review_return"
  | "view_collection"
  | "open_journal"
  | "start_delivery"
  | "mark_delivered"
  | "process_return"
  | "confirm_return_to_trader"
  | "review_settlement"
  | "review_fiscal_period"
  | "review_account_mapping"
  | "review_duplicate_posting"
  | "none";

export type OrderCompletionBlockerCode =
  | "collection_reversed"
  | "settlement_reversed"
  | "cancelled_after_financial_activity"
  | "multiple_confirmable_settlements"
  | "accounting_event_failed"
  | "accounting_closed_period"
  | "accounting_missing_mapping"
  | "accounting_duplicate_posting";

export interface OrderWorkflowGuidance {
  readonly workflowState: OrderWorkflowState;
  /** Sentence code for "waiting for X". Localized in the frontend. */
  readonly waitingFor: OrderWorkflowState;
  readonly nextActionCode: OrderNextActionCode;
  /** An EXISTING route, or null when no action applies. Never fabricated. */
  readonly nextActionRoute: string | null;
  /** Safe, non-secret identifiers the target screen can prefilter on. */
  readonly nextActionParams: Readonly<Record<string, string>>;
  readonly completionBlockerCode: OrderCompletionBlockerCode | null;
  readonly isFinanciallyComplete: boolean;
}

export interface OrderWorkflowInput {
  readonly accountingRequired: boolean;
  /** Settlements this Order could lawfully have its receipt confirmed on. */
  readonly confirmableSettlementCount?: number;
  /** Set only when exactly one confirmable settlement exists. */
  readonly confirmableSettlementId?: string | null;
  /** Accounting Event id, when one exists, so the Event can be opened. */
  readonly accountingEventId?: string | null;
  /** Journal id, when the Event produced one. */
  readonly accountingJournalId?: string | null;
  /** Ledger state from the list query's lateral. */
  readonly accountingState?: string | null;
  readonly assignedDriverId: string | null;
  readonly deliveryStatus: string;
  readonly driverReconciliationStatus: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly returnStatus: string | null;
  readonly traderId: string;
  readonly traderSettlementStatus: string;
}

/** Delivery states that end the Order without a delivery outcome. */
const cancelledStates = new Set(["cancelled"]);
/** Delivery states meaning the parcel is on its way back, not delivered. */
const returnStates = new Set(["returned", "returned_to_branch", "returned_to_trader"]);
/** Delivery states before the parcel has left with a Driver. */
const preDispatchStates = new Set(["new", "hold", "in_branch"]);

/** Settlement values that mean the Trader has been paid and confirmed. */
const settlementComplete = new Set(["money_received_by_trader", "not_eligible"]);
/** Settlement values that mean money has gone out but is not confirmed. */
const settlementSent = new Set(["money_sent_to_trader"]);

export function deriveOrderWorkflowGuidance(
  input: OrderWorkflowInput,
): OrderWorkflowGuidance {
  const {
    accountingRequired,
    accountingEventId = null,
    confirmableSettlementCount = 0,
    confirmableSettlementId = null,
    accountingJournalId = null,
    accountingState = null,
    assignedDriverId,
    deliveryStatus,
    driverReconciliationStatus,
    orderId,
    orderNumber,
    traderId,
    traderSettlementStatus,
  } = input;

  const orderRoute = `/orders/${encodeURIComponent(orderNumber)}`;
  /* Status and Assign actions target the Orders LIST, because the row dialogs
     they open live there. The detail page cannot open them, which is why these
     actions previously fell back to simply viewing the Order. */
  const orderListRoute = "/orders";
  /* A blank identifier must never reach a URL: it would send the target screen
     a filter matching nothing and look like an empty result rather than a
     missing parameter. */
  const traderParams = traderId === "" ? {} : { traderId };
  /* Carried on every action: the id and number identify the Order on the
     target screen, and `returnTo` lets it send the user back to the Orders
     list with its filters, grouping, page and sort intact. */
  const orderParams: Record<string, string> = {
    orderId,
    orderNumber,
    returnTo: "/orders",
  };

  // ---------------------------------------------------------------- blockers
  //
  // A reversal is not a step backwards in the chain; it is a state a human has
  // to look at. Offering "collect money" here would invite a duplicate.
  if (driverReconciliationStatus === "reversed") {
    return {
      completionBlockerCode: "collection_reversed",
      isFinanciallyComplete: false,
      nextActionCode: "view_collection",
      nextActionParams: { ...orderParams },
      nextActionRoute: "/drivers",
      waitingFor: "blocked",
      workflowState: "blocked",
    };
  }

  if (traderSettlementStatus === "reversed") {
    return {
      completionBlockerCode: "settlement_reversed",
      isFinanciallyComplete: false,
      nextActionCode: "review_settlement",
      nextActionParams: { ...orderParams, ...traderParams },
      nextActionRoute: "/trader-settlements",
      waitingFor: "blocked",
      workflowState: "blocked",
    };
  }

  // A cancelled Order that already moved money is not simply "cancelled": the
  // money still has to be accounted for, and silence here would hide that.
  if (cancelledStates.has(deliveryStatus)) {
    const movedMoney =
      driverReconciliationStatus === "reconciled" ||
      settlementSent.has(traderSettlementStatus) ||
      traderSettlementStatus === "partially_settled";
    if (movedMoney) {
      /* Route to whichever transaction actually holds the money, rather than
         to the Order, which cannot resolve it. Settlement outranks collection:
         it is the later step, so it is the one that has to be unwound first. */
      const settlementTouched =
        settlementSent.has(traderSettlementStatus) ||
        traderSettlementStatus === "partially_settled";
      return {
        completionBlockerCode: "cancelled_after_financial_activity",
        isFinanciallyComplete: false,
        nextActionCode: settlementTouched ? "review_settlement" : "view_collection",
        nextActionParams: settlementTouched
          ? { ...orderParams, ...traderParams }
          : {
              ...orderParams,
              ...(assignedDriverId === null ? {} : { driverId: assignedDriverId }),
            },
        nextActionRoute: settlementTouched ? "/trader-settlements" : "/drivers",
        waitingFor: "blocked",
        workflowState: "blocked",
      };
    }
    return complete("complete");
  }

  // ------------------------------------------------------------- in delivery
  if (returnStates.has(deliveryStatus)) {
    // A return that has reached the Trader is finished; anything earlier is
    // still being processed.
    if (deliveryStatus === "returned_to_trader") return complete("complete");
    // At the branch the return still has to be processed; once processed it is
    // waiting to go back to the Trader. Two different steps, two labels.
    const atBranch = deliveryStatus === "returned_to_branch";
    return {
      completionBlockerCode: null,
      isFinanciallyComplete: false,
      nextActionCode: atBranch ? "process_return" : "confirm_return_to_trader",
      nextActionParams: {
        ...orderParams,
        openDialog: "change_status",
        /* Both carry the SAME lawful target. An Order already sitting at
           `returned_to_branch` moves FORWARD to the Trader -- suggesting
           `returned_to_branch` again would name the state it is already in. */
        suggestedStatus: "returned_to_trader",
      },
      nextActionRoute: orderListRoute,
      waitingFor: "awaiting_return_processing",
      workflowState: "awaiting_return_processing",
    };
  }

  /* `closed` is a POST-delivery terminal state, not a stage before it. Testing
     only for `delivered` reported a closed Order with a posted Journal as
     "waiting for the delivery result", which is the opposite of true. */
  if (deliveryStatus !== "delivered" && deliveryStatus !== "closed") {
    /* The next STEP, not a generic door.

       Every one of these previously resolved to "Open Order", which told the
       operator nothing they did not already know. Each now names the actual
       transition the Order is waiting for, and carries the status to suggest so
       the existing status dialog can open pointed at it. Nothing is applied
       here: the suggestion is a default in a form the user still confirms, and
       the lawful-transition rules on that screen remain authoritative. */
    const needsDriver = assignedDriverId === null && preDispatchStates.has(deliveryStatus);
    if (needsDriver) {
      return {
        completionBlockerCode: null,
        isFinanciallyComplete: false,
        nextActionCode: "assign_driver",
        nextActionParams: { ...orderParams, openDialog: "assign_driver" },
        nextActionRoute: orderListRoute,
        waitingFor: "awaiting_driver_assignment",
        workflowState: "awaiting_driver_assignment",
      };
    }
    if (deliveryStatus === "assigned_to_driver") {
      return {
        completionBlockerCode: null,
        isFinanciallyComplete: false,
        nextActionCode: "start_delivery",
        nextActionParams: {
          ...orderParams,
          openDialog: "change_status",
          suggestedStatus: "out_for_delivery",
        },
        nextActionRoute: orderListRoute,
        waitingFor: "awaiting_delivery_start",
        workflowState: "awaiting_delivery_start",
      };
    }
    if (deliveryStatus === "out_for_delivery") {
      return {
        completionBlockerCode: null,
        isFinanciallyComplete: false,
        nextActionCode: "mark_delivered",
        nextActionParams: {
          ...orderParams,
          openDialog: "change_status",
          suggestedStatus: "delivered",
        },
        nextActionRoute: orderListRoute,
        waitingFor: "awaiting_delivery",
        workflowState: "awaiting_delivery",
      };
    }
    // hold, in_branch and anything else still on the delivery side.
    return {
      completionBlockerCode: null,
      isFinanciallyComplete: false,
      nextActionCode: "open_order",
      nextActionParams: { ...orderParams },
      nextActionRoute: orderRoute,
      waitingFor: "awaiting_delivery",
      workflowState: "awaiting_delivery",
    };
  }

  // ------------------------------------------------- delivered: the money now
  //
  // `not_applicable` means there was never Driver cash to collect (a prepaid or
  // zero-COD Order), so the chain skips straight to settlement.
  if (driverReconciliationStatus === "pending") {
    return {
      completionBlockerCode: null,
      isFinanciallyComplete: false,
      nextActionCode: "collect_from_driver",
      nextActionParams: {
        ...orderParams,
        ...(assignedDriverId === null ? {} : { driverId: assignedDriverId }),
        // Asks the Driver Collections screen to open its Money Received
        // workflow already pointed at this Driver and Order.
        openDialog: "collect_money",
      },
      nextActionRoute: "/drivers",
      waitingFor: "awaiting_driver_collection",
      workflowState: "awaiting_driver_collection",
    };
  }

  if (traderSettlementStatus === "unsettled" || traderSettlementStatus === "partially_settled") {
    return {
      completionBlockerCode: null,
      isFinanciallyComplete: false,
      nextActionCode: "pay_trader",
      // Opens New Settlement with the Trader and this Order already carried in,
      // so the user does not search for either again.
      nextActionParams: { ...orderParams, ...traderParams, openDialog: "new_settlement" },
      nextActionRoute: "/trader-settlements",
      waitingFor: "awaiting_trader_payment",
      workflowState: "awaiting_trader_payment",
    };
  }

  if (settlementSent.has(traderSettlementStatus)) {
    return {
      isFinanciallyComplete: false,
      /* Direct confirmation is offered ONLY against an authoritative, unique
         settlement. With several candidates the target is genuinely ambiguous,
         and guessing one would confirm receipt of a payment the user never
         chose -- so the action degrades to reviewing the filtered workspace
         and says so. No paymentId is ever emitted: confirmation is
         settlement-level and a payment id would name nothing the action
         accepts. */
      ...(confirmableSettlementCount > 1
        ? {
            nextActionCode: "review_settlement" as const,
            nextActionParams: { ...orderParams, ...traderParams },
          }
        : confirmableSettlementId === null
          ? {
              // Nothing lawfully confirmable yet: review rather than invent a
              // direct-confirm action against no target.
              nextActionCode: "review_settlement" as const,
              nextActionParams: { ...orderParams, ...traderParams },
            }
          : {
              nextActionCode: "confirm_trader_received" as const,
              nextActionParams: {
                ...orderParams,
                ...traderParams,
                openDialog: "confirm_receipt",
                settlementId: confirmableSettlementId,
              },
            }),
      completionBlockerCode:
        confirmableSettlementCount > 1 ? ("multiple_confirmable_settlements" as const) : null,
      nextActionRoute: "/trader-settlements",
      waitingFor: "awaiting_trader_receipt_confirmation",
      workflowState: "awaiting_trader_receipt_confirmation",
    };
  }

  // ------------------------------------------------------------- accounting
  //
  // Operational finance is done. `accountingRequired` is the SAME expression
  // the database trigger uses to decide whether an Event is ever raised (see
  // `order-accounting-classification.ts`), so "No Accounting Required" here is
  // not a guess about the ledger -- it is the ledger's own rule.
  /* `accountingRequired` PREDICTS whether the trigger raises an Event. When the
     ledger already holds one, the ledger is right and the prediction is stale:
     three live Orders had a posted Journal while this branch was announcing
     "No Accounting Required", which flatly contradicts the Journal. The claim
     is therefore only made when the ledger has nothing. */
  const ledgerHasEvent =
    accountingState !== null &&
    accountingState !== "accounting_event_missing" &&
    accountingState !== "accounting_not_required";

  if (!accountingRequired && !ledgerHasEvent) {
    return {
      completionBlockerCode: null,
      isFinanciallyComplete: true,
      nextActionCode: "none",
      nextActionParams: {},
      nextActionRoute: null,
      waitingFor: "no_accounting_required",
      workflowState: "no_accounting_required",
    };
  }

  if (settlementComplete.has(traderSettlementStatus)) {
    /* The ledger decides, not the Order's money fields.

       Previously this branch reported "Accounting pending" whenever the Order
       was Accounting Required and settled -- including for Orders whose Event
       and Journal had both posted, because it never asked the ledger. */
    /* Route to the EXACT record, not to the list.

       `parseAccountingRoute` already resolves `/accounting/<section>/<id>` to
       that section's detail view, so the id belongs in the PATH. Emitting
       `/accounting/events?eventId=…` landed the operator on the list with a
       query parameter nothing consumed -- the id was carried and then ignored.
       No new screen or consumer is needed; the route was always there. */
    const eventRoute =
      accountingEventId === null
        ? "/accounting/events"
        : `/accounting/events/${encodeURIComponent(accountingEventId)}`;
    const journalRoute =
      accountingJournalId === null
        ? "/accounting/journals"
        : `/accounting/journals/${encodeURIComponent(accountingJournalId)}`;
    const eventParams = {
      orderNumber,
      returnTo: "/orders",
      ...(accountingEventId === null ? {} : { eventId: accountingEventId }),
    };

    switch (accountingState) {
      case "accounting_blocked_duplicate":
        return blocked("accounting_duplicate_posting", "review_duplicate_posting", {
          params: eventParams,
          route: eventRoute,
        });
      case "accounting_blocked_closed_period":
        return blocked("accounting_closed_period", "review_fiscal_period", {
          params: {},
          route: "/accounting/fiscal-periods",
        });
      case "accounting_blocked_missing_mapping":
        return blocked("accounting_missing_mapping", "review_account_mapping", {
          params: {},
          route: "/accounting/mappings",
        });
      case "accounting_event_failed":
        return blocked("accounting_event_failed", "open_accounting", {
          params: eventParams,
          route: eventRoute,
        });
      case "journal_posted":
        // Event posted AND Journal posted: the ledger is finished, so with
        // collection and settlement already complete the Order is complete.
        return complete("complete");
      case "journal_pending":
        return {
          completionBlockerCode: null,
          isFinanciallyComplete: false,
          nextActionCode: "open_journal",
          nextActionParams:
            accountingJournalId === null
              ? { orderNumber, returnTo: "/orders" }
              : { journalId: accountingJournalId, orderNumber, returnTo: "/orders" },
          nextActionRoute: journalRoute,
          waitingFor: "awaiting_accounting_posting",
          workflowState: "awaiting_accounting_posting",
        };
      default:
        // missing, waiting, or an Event posted with no Journal yet.
        return {
          completionBlockerCode: null,
          isFinanciallyComplete: false,
          nextActionCode: "open_accounting",
          nextActionParams: eventParams,
          nextActionRoute: eventRoute,
          waitingFor: "awaiting_accounting_posting",
          workflowState: "awaiting_accounting_posting",
        };
    }
  }

  return complete("complete");

  function blocked(
    code: OrderCompletionBlockerCode,
    action: OrderNextActionCode,
    target: { readonly params: Readonly<Record<string, string>>; readonly route: string },
  ): OrderWorkflowGuidance {
    return {
      completionBlockerCode: code,
      isFinanciallyComplete: false,
      nextActionCode: action,
      nextActionParams: target.params,
      nextActionRoute: target.route,
      waitingFor: "blocked",
      workflowState: "blocked",
    };
  }

  function complete(state: OrderWorkflowState): OrderWorkflowGuidance {
    return {
      completionBlockerCode: null,
      isFinanciallyComplete: true,
      nextActionCode: "none",
      nextActionParams: {},
      nextActionRoute: null,
      waitingFor: state,
      workflowState: state,
    };
  }
}

/**
 * The permission each action needs, so the frontend can render a disabled
 * control with an explanation instead of a dead link.
 *
 * This is metadata for presentation only. The backend still enforces the real
 * check when the action is actually performed -- a client that ignored this map
 * entirely would gain nothing.
 */
export const orderNextActionPermissions: Readonly<
  Record<OrderNextActionCode, readonly string[]>
> = {
  // Navigation-only actions are NOT gated here: the destination screen already
  // enforces its own permissions, and hiding a read-only link would leave the
  // user with an explanation and no way to look at the record.
  assign_driver: ["orders.assign_driver"],
  collect_from_driver: ["reconciliations.create"],
  confirm_trader_received: ["settlements.create"],
  none: [],
  open_accounting: [],
  open_order: [],
  confirm_return_to_trader: ["orders.update_delivery_status"],
  mark_delivered: ["orders.update_delivery_status"],
  open_journal: [],
  process_return: ["orders.update_delivery_status"],
  review_settlement: [],
  start_delivery: ["orders.update_delivery_status"],
  open_settlement: [],
  review_account_mapping: [],
  review_duplicate_posting: [],
  review_fiscal_period: [],
  pay_trader: ["settlements.create"],
  review_return: [],
  view_collection: [],
};

