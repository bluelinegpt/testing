import { describe, expect, it } from "vitest";

import {
  deriveOrderWorkflowGuidance,
  orderNextActionPermissions,
  type OrderWorkflowInput,
} from "./order-workflow-guidance.js";

/**
 * Workflow guidance derivation.
 *
 * The risk this carries is not visual. The guidance tells a Finance user what
 * to do with money, so the expensive failures are: sending someone to collect
 * cash that was already collected, offering to pay a Trader twice, or calling
 * an Order complete while money is still outstanding.
 *
 * Every case below is written from the four authoritative statuses, exactly as
 * the Orders list supplies them.
 */
const base: OrderWorkflowInput = {
  accountingRequired: true,
  assignedDriverId: "driver-1",
  deliveryStatus: "delivered",
  driverReconciliationStatus: "pending",
  orderId: "order-1",
  orderNumber: "ORD-0001",
  returnStatus: null,
  traderId: "trader-1",
  traderSettlementStatus: "unsettled",
};

const derive = (overrides: Partial<OrderWorkflowInput> = {}) =>
  deriveOrderWorkflowGuidance({ ...base, ...overrides });

describe("delivery in progress", () => {
  it("asks for a Driver when a new Order has none", () => {
    const guidance = derive({
      assignedDriverId: null,
      deliveryStatus: "new",
      driverReconciliationStatus: "not_applicable",
    });
    expect(guidance.workflowState).toBe("awaiting_driver_assignment");
    expect(guidance.nextActionCode).toBe("assign_driver");
    // The LIST, not the detail page: the Assign Driver dialog lives on the row.
    expect(guidance.nextActionRoute).toBe("/orders");
    expect(guidance.isFinanciallyComplete).toBe(false);
  });

  it("keeps an existing unassigned Collect Order open for Driver assignment", () => {
    const guidance = derive({
      assignedDriverId: null,
      accountingRequired: false,
      deliveryStatus: "collect_order",
      driverReconciliationStatus: "not_applicable",
      traderSettlementStatus: "not_eligible",
    });
    expect(guidance.workflowState).toBe("awaiting_driver_assignment");
    expect(guidance.nextActionCode).toBe("assign_driver");
    expect(guidance.isFinanciallyComplete).toBe(false);
  });

  it("keeps an assigned Collect Order open until the Driver closes it", () => {
    const guidance = derive({
      assignedDriverId: "driver-1",
      accountingRequired: false,
      deliveryStatus: "collect_order",
      driverReconciliationStatus: "not_applicable",
      traderSettlementStatus: "not_eligible",
    });
    expect(guidance.workflowState).toBe("awaiting_collect_order_completion");
    expect(guidance.nextActionCode).toBe("close_order");
    expect(guidance.nextActionParams).toMatchObject({ suggestedStatus: "closed" });
    expect(guidance.isFinanciallyComplete).toBe(false);
  });

  it("asks for the delivery RESULT once a Driver holds the parcel", () => {
    const guidance = derive({ deliveryStatus: "out_for_delivery" });
    expect(guidance.workflowState).toBe("awaiting_delivery");
    // Not "Open Order": the operator already knows they can open the Order.
    expect(guidance.nextActionCode).toBe("mark_delivered");
    expect(guidance.nextActionParams).toMatchObject({
      openDialog: "change_status",
      suggestedStatus: "delivered",
    });
  });

  it("asks for the return to be PROCESSED at the branch", () => {
    const guidance = derive({ deliveryStatus: "returned_to_branch" });
    expect(guidance.workflowState).toBe("awaiting_return_processing");
    expect(guidance.nextActionCode).toBe("process_return");
    expect(guidance.isFinanciallyComplete).toBe(false);
  });

  it("treats a closed Order as past delivery, not as awaiting it", () => {
    // `closed` is terminal. Reported live on ORD-000024, which had a posted
    // Journal and still read as "waiting for the delivery result".
    const guidance = derive({
      accountingState: "journal_posted",
      deliveryStatus: "closed",
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "money_received_by_trader",
    });
    expect(guidance.workflowState).toBe("complete");
    expect(guidance.workflowState).not.toBe("awaiting_delivery");
  });

  it("treats a return that reached the Trader as finished", () => {
    const guidance = derive({ deliveryStatus: "returned_to_trader" });
    expect(guidance.workflowState).toBe("complete");
    expect(guidance.nextActionCode).toBe("none");
  });
});

describe("the money chain after delivery", () => {
  it("waits to collect from the Driver, and names the Driver to collect from", () => {
    const guidance = derive({ driverReconciliationStatus: "pending" });
    expect(guidance.workflowState).toBe("awaiting_driver_collection");
    expect(guidance.nextActionCode).toBe("collect_from_driver");
    expect(guidance.nextActionRoute).toBe("/drivers");
    // Prefilter context, so the target screen opens on the right Driver.
    expect(guidance.nextActionParams).toMatchObject({
      driverId: "driver-1",
      orderNumber: "ORD-0001",
    });
  });

  it("waits to pay the Trader once the Driver's cash is in", () => {
    const guidance = derive({
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "unsettled",
    });
    expect(guidance.workflowState).toBe("awaiting_trader_payment");
    expect(guidance.nextActionCode).toBe("pay_trader");
    expect(guidance.nextActionRoute).toBe("/trader-settlements");
    expect(guidance.nextActionParams).toMatchObject({ traderId: "trader-1" });
  });

  it("treats a partial settlement as still waiting to pay", () => {
    const guidance = derive({
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "partially_settled",
    });
    expect(guidance.workflowState).toBe("awaiting_trader_payment");
  });

  it("waits for receipt confirmation once payment has gone out", () => {
    const guidance = derive({
      // Direct confirmation now requires an authoritative, unique target.
      confirmableSettlementCount: 1,
      confirmableSettlementId: "settlement-1",
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "money_sent_to_trader",
    });
    expect(guidance.workflowState).toBe("awaiting_trader_receipt_confirmation");
    expect(guidance.nextActionCode).toBe("confirm_trader_received");
    expect(guidance.isFinanciallyComplete).toBe(false);
  });

  it("skips Driver collection entirely when there was no cash to collect", () => {
    // A prepaid or zero-COD Order: `not_applicable` is not "done", it is
    // "never applied", and the chain must move straight to settlement.
    const guidance = derive({
      driverReconciliationStatus: "not_applicable",
      traderSettlementStatus: "unsettled",
    });
    expect(guidance.workflowState).toBe("awaiting_trader_payment");
  });
});

describe("accounting", () => {
  it("asks for the Accounting posting once operational finance is done", () => {
    const guidance = derive({
      accountingRequired: true,
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "money_received_by_trader",
    });
    expect(guidance.workflowState).toBe("awaiting_accounting_posting");
    expect(guidance.nextActionCode).toBe("open_accounting");
    expect(guidance.nextActionRoute).toBe("/accounting/events");
  });

  it("never suggests an Event for an Order with no ledger impact", () => {
    const guidance = derive({
      accountingRequired: false,
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "money_received_by_trader",
    });
    expect(guidance.workflowState).toBe("no_accounting_required");
    expect(guidance.nextActionCode).toBe("none");
    expect(guidance.nextActionRoute).toBeNull();
    expect(guidance.isFinanciallyComplete).toBe(true);
  });
});

describe("blockers", () => {
  it("reports a reversed collection rather than asking for another one", () => {
    // The expensive mistake: a reversed collection still reads as "not
    // collected" on the raw status, so an order-of-evaluation bug here sends a
    // user to collect the same cash twice.
    const guidance = derive({ driverReconciliationStatus: "reversed" });
    expect(guidance.workflowState).toBe("blocked");
    expect(guidance.completionBlockerCode).toBe("collection_reversed");
    expect(guidance.nextActionCode).toBe("view_collection");
    expect(guidance.nextActionCode).not.toBe("collect_from_driver");
  });

  it("reports a reversed settlement rather than offering to pay again", () => {
    const guidance = derive({
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "reversed",
    });
    expect(guidance.workflowState).toBe("blocked");
    expect(guidance.completionBlockerCode).toBe("settlement_reversed");
    expect(guidance.nextActionCode).not.toBe("pay_trader");
  });

  it("flags a cancelled Order that had already moved money", () => {
    const guidance = derive({
      deliveryStatus: "cancelled",
      driverReconciliationStatus: "reconciled",
    });
    expect(guidance.workflowState).toBe("blocked");
    expect(guidance.completionBlockerCode).toBe("cancelled_after_financial_activity");
    expect(guidance.isFinanciallyComplete).toBe(false);
  });

  it("treats a clean cancellation as simply finished", () => {
    const guidance = derive({
      deliveryStatus: "cancelled",
      driverReconciliationStatus: "not_applicable",
      traderSettlementStatus: "not_eligible",
    });
    expect(guidance.workflowState).toBe("complete");
    expect(guidance.completionBlockerCode).toBeNull();
  });
});

describe("route and parameter safety", () => {
  it("never emits a blank identifier as a filter", () => {
    // An empty traderId in a URL filters to nothing and reads as an empty
    // result rather than as a missing parameter.
    const guidance = derive({
      driverReconciliationStatus: "reconciled",
      traderId: "",
      traderSettlementStatus: "unsettled",
    });
    expect(guidance.nextActionParams.traderId).toBeUndefined();
    expect(Object.values(guidance.nextActionParams)).not.toContain("");
  });

  it("passes an awkward Order Number as a parameter rather than in the path", () => {
    // Status actions target the list, so the number travels as a query value
    // and URLSearchParams encodes it; no path injection is possible.
    const guidance = derive({ deliveryStatus: "out_for_delivery", orderNumber: "ORD/01 02" });
    expect(guidance.nextActionRoute).toBe("/orders");
    expect(guidance.nextActionParams.orderNumber).toBe("ORD/01 02");
  });

  it("emits only routes that exist, and none at all when nothing is due", () => {
    const known = new Set([
      "/drivers",
      "/trader-settlements",
      "/accounting/events",
      "/orders",
      "/orders/ORD-0001",
    ]);
    const cases: Partial<OrderWorkflowInput>[] = [
      { deliveryStatus: "new", assignedDriverId: null },
      { deliveryStatus: "out_for_delivery" },
      { deliveryStatus: "returned_to_branch" },
      { driverReconciliationStatus: "pending" },
      { driverReconciliationStatus: "reconciled" },
      { driverReconciliationStatus: "reversed" },
      { traderSettlementStatus: "reversed", driverReconciliationStatus: "reconciled" },
      { driverReconciliationStatus: "reconciled", traderSettlementStatus: "money_sent_to_trader" },
      {
        driverReconciliationStatus: "reconciled",
        traderSettlementStatus: "money_received_by_trader",
      },
    ];
    for (const overrides of cases) {
      const route = derive(overrides).nextActionRoute;
      if (route !== null) expect(known).toContain(route);
    }
    expect(
      derive({
        accountingRequired: false,
        driverReconciliationStatus: "reconciled",
        traderSettlementStatus: "money_received_by_trader",
      }).nextActionRoute,
    ).toBeNull();
  });

  it("declares a permission for every action code it can emit", () => {
    // The frontend renders a disabled control from this map, so a missing
    // entry would silently produce an always-enabled button.
    const codes: OrderWorkflowInput[] = [];
    void codes;
    for (const code of Object.keys(orderNextActionPermissions)) {
      expect(
        orderNextActionPermissions[code as keyof typeof orderNextActionPermissions],
      ).toBeDefined();
    }
    expect(orderNextActionPermissions.none).toStrictEqual([]);
    expect(orderNextActionPermissions.pay_trader.length).toBeGreaterThan(0);
  });
});

/**
 * The ledger-derived Accounting states.
 *
 * The failure this guards against is specific: before the Accounting Event was
 * joined, an Order whose Event and Journal had both posted still reported
 * "Accounting posting pending", because the guidance predicted the ledger from
 * the Order's money fields instead of reading it.
 */
describe("accounting state from the ledger", () => {
  const settled = {
    driverReconciliationStatus: "reconciled",
    traderSettlementStatus: "money_received_by_trader",
  } as const;

  it("completes the Order when the Event and its Journal have both posted", () => {
    const guidance = derive({ ...settled, accountingState: "journal_posted" });
    expect(guidance.workflowState).toBe("complete");
    expect(guidance.isFinanciallyComplete).toBe(true);
    expect(guidance.nextActionCode).toBe("none");
  });

  it("asks for the Journal when the Event posted but the Journal has not", () => {
    const guidance = derive({
      ...settled,
      accountingJournalId: "journal-7",
      accountingState: "journal_pending",
    });
    expect(guidance.workflowState).toBe("awaiting_accounting_posting");
    expect(guidance.nextActionCode).toBe("open_journal");
    // The EXACT Journal, not the list: the id belongs in the path.
    expect(guidance.nextActionRoute).toBe("/accounting/journals/journal-7");
    expect(guidance.nextActionParams).toMatchObject({ journalId: "journal-7" });
  });

  it("still reports pending when no Event exists yet", () => {
    const guidance = derive({ ...settled, accountingState: "accounting_event_missing" });
    expect(guidance.workflowState).toBe("awaiting_accounting_posting");
    expect(guidance.nextActionCode).toBe("open_accounting");
  });

  it("still reports pending while the Event is being processed", () => {
    const guidance = derive({ ...settled, accountingState: "accounting_event_waiting" });
    expect(guidance.workflowState).toBe("awaiting_accounting_posting");
  });

  it("sends a failed Event to the Event screen as a blocker", () => {
    const guidance = derive({
      ...settled,
      accountingEventId: "event-1",
      accountingState: "accounting_event_failed",
    });
    expect(guidance.workflowState).toBe("blocked");
    expect(guidance.completionBlockerCode).toBe("accounting_event_failed");
    expect(guidance.nextActionRoute).toBe("/accounting/events/event-1");
    expect(guidance.nextActionParams).toMatchObject({ eventId: "event-1" });
    expect(guidance.isFinanciallyComplete).toBe(false);
  });

  it("sends a closed-period block to Fiscal Periods, not to the Event", () => {
    // Each blocker has a different remedy, so they must not collapse into one
    // generic "something failed" action.
    const guidance = derive({
      ...settled,
      accountingState: "accounting_blocked_closed_period",
    });
    expect(guidance.completionBlockerCode).toBe("accounting_closed_period");
    expect(guidance.nextActionCode).toBe("review_fiscal_period");
    expect(guidance.nextActionRoute).toBe("/accounting/fiscal-periods");
  });

  it("sends a missing-mapping block to Account Mappings", () => {
    const guidance = derive({
      ...settled,
      accountingState: "accounting_blocked_missing_mapping",
    });
    expect(guidance.completionBlockerCode).toBe("accounting_missing_mapping");
    expect(guidance.nextActionCode).toBe("review_account_mapping");
    expect(guidance.nextActionRoute).toBe("/accounting/mappings");
  });

  it("names a duplicate posting as a duplicate rather than a failure", () => {
    const guidance = derive({
      ...settled,
      accountingEventId: "event-2",
      accountingState: "accounting_blocked_duplicate",
    });
    expect(guidance.completionBlockerCode).toBe("accounting_duplicate_posting");
    expect(guidance.nextActionCode).toBe("review_duplicate_posting");
  });

  it("does not claim No Accounting Required when a Journal has actually posted", () => {
    // Observed on three live Orders: `accountingRequired` predicted no ledger
    // impact, yet a Journal was posted. The ledger is the fact.
    const guidance = derive({
      ...settled,
      accountingRequired: false,
      accountingState: "journal_posted",
    });
    expect(guidance.workflowState).not.toBe("no_accounting_required");
    expect(guidance.workflowState).toBe("complete");
  });

  it("offers no Accounting action at all when the Order never reaches the ledger", () => {
    const guidance = derive({
      ...settled,
      accountingRequired: false,
      // Even if a stale ledger state were present, No Accounting Required wins.
      accountingState: "accounting_event_missing",
    });
    expect(guidance.workflowState).toBe("no_accounting_required");
    expect(guidance.nextActionRoute).toBeNull();
    expect(guidance.isFinanciallyComplete).toBe(true);
  });

  it("does not let a posted ledger complete an Order whose money is outstanding", () => {
    // Accounting is only the LAST step; a posted Journal must not paper over an
    // uncollected delivery.
    const guidance = derive({
      accountingState: "journal_posted",
      driverReconciliationStatus: "pending",
      traderSettlementStatus: "unsettled",
    });
    expect(guidance.workflowState).toBe("awaiting_driver_collection");
    expect(guidance.isFinanciallyComplete).toBe(false);
  });

  it("routes a duplicate posting to the exact Event that recorded it", () => {
    const g = derive({
      ...settled,
      accountingEventId: "event-dup",
      accountingState: "accounting_blocked_duplicate",
    });
    expect(g.nextActionCode).toBe("review_duplicate_posting");
    expect(g.nextActionRoute).toBe("/accounting/events/event-dup");
  });

  it("falls back to the list only when no authoritative id exists", () => {
    // Without an id there is nothing exact to open; the list is honest.
    const missing = derive({ ...settled, accountingState: "accounting_event_missing" });
    expect(missing.nextActionRoute).toBe("/accounting/events");
    const noJournal = derive({ ...settled, accountingState: "journal_pending" });
    expect(noJournal.nextActionRoute).toBe("/accounting/journals");
  });

  it("escapes an id before putting it in the path", () => {
    const g = derive({
      ...settled,
      accountingEventId: "ev/1 2",
      accountingState: "accounting_event_failed",
    });
    expect(g.nextActionRoute).toBe("/accounting/events/ev%2F1%202");
  });

  it("carries the Orders list as the return target on Accounting actions", () => {
    const g = derive({
      ...settled,
      accountingEventId: "event-1",
      accountingState: "accounting_event_failed",
    });
    expect(g.nextActionParams).toMatchObject({ returnTo: "/orders" });
  });

  it("emits only Accounting routes that exist", () => {
    // Exact-record routes are a prefix match; the list routes are exact.
    const known = [
      "/accounting/events",
      "/accounting/journals",
      "/accounting/fiscal-periods",
      "/accounting/mappings",
    ];
    for (const state of [
      "accounting_event_missing",
      "accounting_event_waiting",
      "accounting_event_failed",
      "accounting_event_posted",
      "journal_pending",
      "accounting_blocked_closed_period",
      "accounting_blocked_missing_mapping",
      "accounting_blocked_duplicate",
    ]) {
      const route = derive({ ...settled, accountingState: state }).nextActionRoute as string;
      expect(route).not.toBeNull();
      expect(known.some((base) => route === base || route.startsWith(`${base}/`))).toBe(true);
    }
  });
});

/**
 * The smart action hierarchy.
 *
 * One primary action per Order, chosen by workflow order. The property under
 * test throughout is that the action names the NEXT STEP rather than a generic
 * door -- "Open Order" told an operator nothing they did not already know.
 */
describe("smart next action", () => {
  it("asks for a Driver on a new Order", () => {
    const g = derive({
      assignedDriverId: null,
      deliveryStatus: "new",
      driverReconciliationStatus: "not_applicable",
    });
    expect(g.nextActionCode).toBe("assign_driver");
  });

  it("asks to start the delivery once a Driver holds it", () => {
    const g = derive({ deliveryStatus: "assigned_to_driver" });
    expect(g.workflowState).toBe("awaiting_delivery_start");
    expect(g.nextActionCode).toBe("start_delivery");
    expect(g.nextActionParams).toMatchObject({ suggestedStatus: "out_for_delivery" });
  });

  it("asks to confirm the return reached the Trader once processed", () => {
    const g = derive({ deliveryStatus: "returned" });
    expect(g.nextActionCode).toBe("confirm_return_to_trader");
    expect(g.nextActionParams).toMatchObject({ suggestedStatus: "returned_to_trader" });
  });

  it("skips collection entirely when no Driver cash is due", () => {
    // The operator must never be told to collect money that is not owed.
    const g = derive({
      driverReconciliationStatus: "not_applicable",
      traderSettlementStatus: "unsettled",
    });
    expect(g.nextActionCode).toBe("pay_trader");
    expect(g.nextActionCode).not.toBe("collect_from_driver");
  });

  it("opens the collection workflow, not the Drivers master page", () => {
    const g = derive({ driverReconciliationStatus: "pending" });
    expect(g.nextActionCode).toBe("collect_from_driver");
    expect(g.nextActionParams).toMatchObject({
      driverId: "driver-1",
      openDialog: "collect_money",
    });
  });

  it("opens New Settlement with the Trader and Order already carried", () => {
    const g = derive({
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "unsettled",
    });
    expect(g.nextActionCode).toBe("pay_trader");
    expect(g.nextActionParams).toMatchObject({
      openDialog: "new_settlement",
      orderNumber: "ORD-0001",
      traderId: "trader-1",
    });
  });

  it("does not offer Pay Trader for a zero or negative signed Trader position", () => {
    for (const traderNetPayable of ["0.00", "-25.00"]) {
      const guidance = derive({
        accountingRequired: false,
        driverReconciliationStatus: "not_applicable",
        traderNetPayable,
        traderSettlementStatus: "unsettled",
      });
      expect(guidance.nextActionCode).not.toBe("pay_trader");
      expect(guidance.isFinanciallyComplete).toBe(true);
    }
  });

  it("closes a delivered Free Order instead of offering Trader or Driver money workflows", () => {
    const g = derive({
      accountingRequired: false,
      accountingState: "accounting_event_missing",
      deliveryStatus: "delivered",
      driverReconciliationStatus: "not_applicable",
      isFreeOrder: true,
      traderSettlementStatus: "not_eligible",
    });
    expect(g.workflowState).toBe("no_accounting_required");
    expect(g.isFinanciallyComplete).toBe(true);
    expect(g.nextActionCode).toBe("close_order");
    expect(g.nextActionRoute).toBe("/orders");
    expect(g.nextActionParams).toMatchObject({
      openDialog: "change_status",
      suggestedStatus: "closed",
    });
    expect(g.nextActionCode).not.toBe("pay_trader");
    expect(g.nextActionCode).not.toBe("collect_from_driver");
  });

  it("has no next action after the same Free Order is already closed", () => {
    const g = derive({
      accountingRequired: false,
      accountingState: "accounting_event_missing",
      deliveryStatus: "closed",
      driverReconciliationStatus: "not_applicable",
      isFreeOrder: true,
      traderSettlementStatus: "not_eligible",
    });
    expect(g.workflowState).toBe("complete");
    expect(g.nextActionCode).toBe("none");
    expect(g.nextActionRoute).toBeNull();
  });

  it("normalizes an existing Serial 7/9-like Free Order that was already stored as unsettled", () => {
    const g = derive({
      accountingRequired: false,
      accountingState: "accounting_event_missing",
      customerAmountDue: "0.00",
      deliveryStatus: "delivered",
      driverReconciliationStatus: "not_applicable",
      isFreeOrder: true,
      traderNetPayable: "0.00",
      traderSettlementStatus: "unsettled",
    });
    expect(g.nextActionCode).toBe("close_order");
    expect(g.nextActionCode).not.toBe("pay_trader");
    expect(g.workflowState).toBe("no_accounting_required");
  });

  it("asks for receipt confirmation once payment has gone out", () => {
    const g = derive({
      confirmableSettlementCount: 1,
      confirmableSettlementId: "settlement-1",
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "money_sent_to_trader",
    });
    expect(g.nextActionCode).toBe("confirm_trader_received");
    expect(g.nextActionParams).toMatchObject({ openDialog: "confirm_receipt" });
  });

  it("routes a cancelled Order with a settlement to the settlement", () => {
    const g = derive({
      deliveryStatus: "cancelled",
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "money_sent_to_trader",
    });
    expect(g.completionBlockerCode).toBe("cancelled_after_financial_activity");
    expect(g.nextActionCode).toBe("review_settlement");
    expect(g.nextActionRoute).toBe("/trader-settlements");
  });

  it("routes a cancelled Order with only a collection to the collection", () => {
    const g = derive({
      deliveryStatus: "cancelled",
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "unsettled",
    });
    expect(g.nextActionCode).toBe("view_collection");
    expect(g.nextActionRoute).toBe("/drivers");
  });

  it("reviews a reversed settlement rather than offering to pay again", () => {
    const g = derive({
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "reversed",
    });
    expect(g.nextActionCode).toBe("review_settlement");
    expect(g.nextActionCode).not.toBe("pay_trader");
  });

  it("resolves a blocker before anything else in the chain", () => {
    // Priority 1 beats priority 3: a reversed collection on an unsettled
    // delivered Order is a review, not a collection and not a payment.
    const g = derive({
      driverReconciliationStatus: "reversed",
      traderSettlementStatus: "unsettled",
    });
    expect(g.workflowState).toBe("blocked");
    expect(g.nextActionCode).toBe("view_collection");
  });

  it("completes delivery before asking for money", () => {
    // Priority 2 beats priority 3.
    const g = derive({
      deliveryStatus: "out_for_delivery",
      driverReconciliationStatus: "pending",
      traderSettlementStatus: "unsettled",
    });
    expect(g.nextActionCode).toBe("mark_delivered");
  });

  it("offers exactly one action, never a list", () => {
    const cases: Partial<OrderWorkflowInput>[] = [
      { assignedDriverId: null, deliveryStatus: "new" },
      { deliveryStatus: "assigned_to_driver" },
      { deliveryStatus: "out_for_delivery" },
      { driverReconciliationStatus: "pending" },
      { driverReconciliationStatus: "reconciled" },
      { driverReconciliationStatus: "reconciled", traderSettlementStatus: "money_sent_to_trader" },
    ];
    for (const overrides of cases) {
      const g = derive(overrides);
      expect(typeof g.nextActionCode).toBe("string");
      expect(g.nextActionCode).not.toBe("none");
    }
  });

  it("carries the Orders list as the return target on every action", () => {
    // Browser Back has to land on the list the user came from, with its URL
    // state intact.
    for (const overrides of [
      { assignedDriverId: null, deliveryStatus: "new" },
      { deliveryStatus: "out_for_delivery" },
      { driverReconciliationStatus: "pending" },
      { driverReconciliationStatus: "reconciled" },
    ] as Partial<OrderWorkflowInput>[]) {
      expect(derive(overrides).nextActionParams).toMatchObject({ returnTo: "/orders" });
    }
  });

  it("declares a permission for every action code", () => {
    const codes = new Set(Object.keys(orderNextActionPermissions));
    for (const overrides of [
      { assignedDriverId: null, deliveryStatus: "new" },
      { deliveryStatus: "assigned_to_driver" },
      { deliveryStatus: "out_for_delivery" },
      { deliveryStatus: "returned_to_branch" },
      { deliveryStatus: "returned" },
      { driverReconciliationStatus: "pending" },
      { driverReconciliationStatus: "reversed" },
      { driverReconciliationStatus: "reconciled" },
      { driverReconciliationStatus: "reconciled", traderSettlementStatus: "reversed" },
    ] as Partial<OrderWorkflowInput>[]) {
      expect(codes).toContain(derive(overrides).nextActionCode);
    }
  });
});

/**
 * Receipt-confirmation target resolution.
 *
 * Confirmation is SETTLEMENT-level -- `confirmMoneyReceived(settlementId)` --
 * so a settlement id is the only authoritative target. The expensive mistake
 * would be picking one settlement when several are confirmable: that confirms
 * receipt of a payment the user never chose.
 */
describe("receipt confirmation target", () => {
  const sent = {
    driverReconciliationStatus: "reconciled",
    traderSettlementStatus: "money_sent_to_trader",
  } as const;

  it("offers direct confirmation against a single authoritative settlement", () => {
    const g = derive({
      ...sent,
      confirmableSettlementCount: 1,
      confirmableSettlementId: "settlement-1",
    });
    expect(g.workflowState).toBe("awaiting_trader_receipt_confirmation");
    expect(g.nextActionCode).toBe("confirm_trader_received");
    expect(g.nextActionParams).toMatchObject({
      openDialog: "confirm_receipt",
      settlementId: "settlement-1",
    });
    expect(g.completionBlockerCode).toBeNull();
  });

  it("refuses to guess when several settlements are confirmable", () => {
    // Observed live on ORD-000027, which is allocated across two.
    const g = derive({
      ...sent,
      confirmableSettlementCount: 2,
      confirmableSettlementId: null,
    });
    expect(g.nextActionCode).toBe("review_settlement");
    expect(g.nextActionCode).not.toBe("confirm_trader_received");
    expect(g.nextActionParams.settlementId).toBeUndefined();
    expect(g.completionBlockerCode).toBe("multiple_confirmable_settlements");
  });

  it("reviews rather than inventing a target when none is confirmable", () => {
    const g = derive({ ...sent, confirmableSettlementCount: 0, confirmableSettlementId: null });
    expect(g.nextActionCode).toBe("review_settlement");
    expect(g.nextActionParams.settlementId).toBeUndefined();
  });

  it("ignores a stale id when the count says the target is ambiguous", () => {
    // The count is authoritative; an id alongside count>1 must never win.
    const g = derive({
      ...sent,
      confirmableSettlementCount: 3,
      confirmableSettlementId: "settlement-9",
    });
    expect(g.nextActionCode).toBe("review_settlement");
    expect(g.nextActionParams.settlementId).toBeUndefined();
  });

  it("never emits a paymentId on any path", () => {
    // One settlement carries many payment rows and none is a confirmation
    // target, so a paymentId would name something the action cannot accept.
    for (const overrides of [
      { ...sent, confirmableSettlementCount: 1, confirmableSettlementId: "settlement-1" },
      { ...sent, confirmableSettlementCount: 2, confirmableSettlementId: null },
      { ...sent, confirmableSettlementCount: 0, confirmableSettlementId: null },
      { driverReconciliationStatus: "reconciled", traderSettlementStatus: "unsettled" },
      { driverReconciliationStatus: "pending" },
    ] as Partial<OrderWorkflowInput>[]) {
      expect(derive(overrides).nextActionParams.paymentId).toBeUndefined();
    }
  });

  it("resolves a target only for an Order actually awaiting receipt", () => {
    // An unsettled Order must still be asked to pay, never to confirm.
    const g = derive({
      driverReconciliationStatus: "reconciled",
      traderSettlementStatus: "unsettled",
      confirmableSettlementCount: 1,
      confirmableSettlementId: "settlement-1",
    });
    expect(g.nextActionCode).toBe("pay_trader");
  });
});
