import { fireEvent, render, screen } from "@testing-library/react";

import { i18nInstance } from "../../localization/i18n.js";
import {
  OrderWorkflowIndicator,
  type OrderWorkflowGuidance,
} from "./OrderWorkflowIndicator.js";

/**
 * The Orders-row workflow indicator.
 *
 * The claims worth pinning: that the popover is reachable without a mouse,
 * that it says what the SERVER said rather than guessing, that an action the
 * user may not perform is never presented as available, and that clicking
 * anything here navigates rather than submits.
 */

const guidance: OrderWorkflowGuidance = {
  completionBlockerCode: null,
  isFinanciallyComplete: false,
  nextActionCode: "collect_from_driver",
  nextActionParams: { driverId: "driver-1", orderNumber: "ORD-0001" },
  nextActionRoute: "/drivers",
  waitingFor: "awaiting_driver_collection",
  workflowState: "awaiting_driver_collection",
};

const statuses = {
  accounting: "expected",
  delivery: "delivered",
  driverCash: "pending",
  return: null,
  settlement: "unsettled",
};

function setup(
  overrides: Partial<OrderWorkflowGuidance> = {},
  permissions: readonly string[] = ["reconciliations.create"],
) {
  const navigations: string[] = [];
  render(
    <OrderWorkflowIndicator
      guidance={{ ...guidance, ...overrides }}
      onNavigate={(path) => navigations.push(path)}
      orderNumber="ORD-0001"
      permissions={permissions}
      statuses={statuses}
    />,
  );
  return { navigations };
}

beforeEach(async () => {
  await i18nInstance.changeLanguage("en");
});

describe("OrderWorkflowIndicator", () => {
  it("resolves the Close Order action label in English and Arabic", async () => {
    await i18nInstance.changeLanguage("en");
    expect(i18nInstance.t("orderWorkflow.action.close_order")).toBe("Close Order");
    expect(i18nInstance.t("orderWorkflow.action.close_order")).not.toBe(
      "orderWorkflow.action.close_order",
    );

    await i18nInstance.changeLanguage("ar");
    expect(i18nInstance.t("orderWorkflow.action.close_order")).toBe("إغلاق الطلب");
    expect(i18nInstance.t("orderWorkflow.action.close_order")).not.toBe(
      "orderWorkflow.action.close_order",
    );
  });

  it("shows the state on the chip without opening anything", () => {
    setup();
    expect(screen.getByRole("button", { name: /Collect from Driver/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on hover", () => {
    setup();
    fireEvent.mouseEnter(screen.getByRole("button").parentElement as HTMLElement);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("clicking the status chip navigates directly to the next action, same as its inner button", () => {
    const { navigations } = setup();
    const trigger = screen.getByRole("button", { name: /Collect from Driver/i });
    const wrapper = trigger.parentElement as HTMLElement;

    fireEvent.mouseEnter(wrapper);
    fireEvent.pointerDown(trigger);
    fireEvent.mouseLeave(wrapper);

    // The chip itself is the shortcut: one click reaches the same destination
    // the panel's own action button would, without pinning the panel open.
    expect(navigations).toStrictEqual([
      "/drivers?driverId=driver-1&orderNumber=ORD-0001&returnTo=%2Forders",
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("still pins the panel open on click when there is no next action to jump to", () => {
    const { navigations } = setup({
      isFinanciallyComplete: true,
      nextActionCode: "none",
      nextActionRoute: null,
      waitingFor: "complete",
      workflowState: "complete",
    });
    const trigger = screen.getByRole("button", { name: /Complete/i });
    const wrapper = trigger.parentElement as HTMLElement;

    fireEvent.mouseEnter(wrapper);
    fireEvent.pointerDown(trigger);
    fireEvent.mouseLeave(wrapper);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(navigations).toStrictEqual([]);
  });

  it("still pins the panel open on click without permission to act", () => {
    const { navigations } = setup({}, ["orders.view"]);
    const trigger = screen.getByRole("button", { name: /Collect from Driver/i });
    const wrapper = trigger.parentElement as HTMLElement;

    fireEvent.mouseEnter(wrapper);
    fireEvent.pointerDown(trigger);
    fireEvent.mouseLeave(wrapper);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(navigations).toStrictEqual([]);
  });

  it("keeps the portalled panel open while focus moves to one of its actions", () => {
    setup();
    const trigger = screen.getByRole("button", { name: /Collect from Driver/i });
    fireEvent.focus(trigger);
    const action = screen.getByRole("button", { name: "Collect Money from Driver" });

    fireEvent.blur(trigger, { relatedTarget: action });
    fireEvent.focus(action);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens on keyboard focus, so it is not hover-only", () => {
    setup();
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Collect from Driver/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("closes on Escape and returns focus to the trigger", () => {
    setup();
    const trigger = screen.getByRole("button", { name: /Collect from Driver/i });
    fireEvent.focus(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows every current status and the waiting-for sentence", () => {
    setup();
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByText("Delivery")).toBeInTheDocument();
    expect(screen.getByText("Pending collection")).toBeInTheDocument();
    expect(screen.getByText("Trader settlement")).toBeInTheDocument();
    expect(screen.getByText("Posting expected")).toBeInTheDocument();
    // The NEXT STEP leads, not the "waiting for" state sentence.
    expect(screen.getByText("Next step")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collect Money from Driver" }),
    ).toBeInTheDocument();
    // And the reason it cannot complete yet.
    expect(screen.getByText(/cash has not been confirmed as received/i)).toBeInTheDocument();
  });

  it("navigates to the prefiltered route rather than submitting anything", () => {
    const { navigations } = setup();
    fireEvent.focus(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: "Collect Money from Driver" }));
    expect(navigations).toStrictEqual([
      "/drivers?driverId=driver-1&orderNumber=ORD-0001&returnTo=%2Forders",
    ]);
  });

  it("explains the action but disables it without permission", () => {
    const { navigations } = setup({}, ["orders.view"]);
    fireEvent.focus(screen.getByRole("button"));
    // The user still learns what the required step IS...
    expect(screen.getByText("Next step")).toBeInTheDocument();
    expect(screen.getByText("Collect Money from Driver")).toBeInTheDocument();
    // ...but is not offered a control that would fail.
    expect(screen.queryByRole("button", { name: "Collect Money from Driver" })).toBeNull();
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
    expect(navigations).toStrictEqual([]);
  });

  it("grants the action to a Company administrator", () => {
    setup({}, ["users_roles.manage"]);
    fireEvent.focus(screen.getByRole("button"));
    expect(
      screen.getByRole("button", { name: "Collect Money from Driver" }),
    ).toBeInTheDocument();
  });

  it("offers no action at all when the Order is complete", () => {
    setup({
      isFinanciallyComplete: true,
      nextActionCode: "none",
      nextActionRoute: null,
      waitingFor: "complete",
      workflowState: "complete",
    });
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByText(/This Order is complete/i)).toBeInTheDocument();
    expect(screen.queryByText(/do not have permission/i)).toBeNull();
  });

  it("explains a reversed collection instead of offering to collect again", () => {
    setup({
      completionBlockerCode: "collection_reversed",
      nextActionCode: "view_collection",
      nextActionRoute: "/drivers",
      waitingFor: "blocked",
      workflowState: "blocked",
    });
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByText(/collection was reversed/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collect Money from Driver" })).toBeNull();
  });

  it("never renders a raw backend code", () => {
    setup();
    fireEvent.focus(screen.getByRole("button"));
    const text = (screen.getByRole("dialog").textContent ?? "") + document.body.textContent;
    for (const code of [
      "awaiting_driver_collection",
      "collect_from_driver",
      "not_applicable",
      "money_sent_to_trader",
    ]) {
      expect(text).not.toContain(code);
    }
  });

  it("renders Arabic without leaking English state names", async () => {
    await i18nInstance.changeLanguage("ar");
    setup();
    fireEvent.focus(screen.getByRole("button"));
    const panel = screen.getByRole("dialog");
    expect(panel.textContent).toMatch(/[؀-ۿ]/);
    expect(panel.textContent).not.toContain("awaiting_driver_collection");
    await i18nInstance.changeLanguage("en");
  });
});

/**
 * Positioning.
 *
 * jsdom reports every box as 0x0, so the trigger and panel rectangles are
 * defined explicitly here. That is the honest way to drive geometry in a unit
 * test: the assertions are on where the component DECIDES to put the panel,
 * given known boxes and a known viewport.
 */
describe("collision-aware positioning", () => {
  const PANEL_WIDTH = 380;
  const PANEL_HEIGHT = 260;

  function withGeometry(trigger: Partial<DOMRect>) {
    const rect = {
      bottom: 0,
      height: 20,
      left: 0,
      right: 0,
      top: 0,
      width: 90,
      x: 0,
      y: 0,
      ...trigger,
    } as DOMRect;

    // The wrapper <span> is the trigger box; the portalled panel is the other.
    Element.prototype.getBoundingClientRect = function getRect(this: Element) {
      if (this.classList.contains("order-workflow-panel")) {
        return {
          bottom: PANEL_HEIGHT,
          height: PANEL_HEIGHT,
          left: 0,
          right: PANEL_WIDTH,
          top: 0,
          width: PANEL_WIDTH,
          x: 0,
          y: 0,
        } as DOMRect;
      }
      return rect;
    };
  }

  const original = Element.prototype.getBoundingClientRect;
  afterEach(() => {
    Element.prototype.getBoundingClientRect = original;
  });

  const openPanel = () => {
    fireEvent.focus(screen.getByRole("button"));
    return screen.getByRole("dialog");
  };

  it("renders outside the table, on document.body", () => {
    withGeometry({ bottom: 320, left: 200, right: 290, top: 300 });
    const { container } = render(
      <OrderWorkflowIndicator
        guidance={guidance}
        onNavigate={() => undefined}
        permissions={["reconciliations.create"]}
        statuses={statuses}
      />,
    );
    const panel = openPanel();
    // Not a descendant of the component's own markup -- which is precisely what
    // makes it immune to the table's overflow clipping.
    expect(container.contains(panel)).toBe(false);
    expect(document.body.contains(panel)).toBe(true);
    // Positioned in viewport coordinates by the component. The `position:
    // fixed` declaration itself lives in the stylesheet, which jsdom does not
    // load, so asserting the computed value here would test nothing.
    expect(panel.style.left).not.toBe("");
    expect(panel.style.top).not.toBe("");
  });

  it("shifts left rather than overflowing the right edge", () => {
    // Trigger near the right edge of a 1280px viewport.
    globalThis.innerWidth = 1280;
    globalThis.innerHeight = 900;
    withGeometry({ bottom: 320, left: 1200, right: 1270, top: 300 });
    setup();
    const panel = openPanel();
    const left = Number.parseFloat(panel.style.left);
    // Pulled back so the whole panel fits, with the safe padding respected.
    expect(left).toBeLessThan(1200);
    expect(left + PANEL_WIDTH).toBeLessThanOrEqual(1280 - 12);
    expect(left).toBeGreaterThanOrEqual(12);
  });

  it("does not shift a left-edge popover off the left of the viewport", () => {
    globalThis.innerWidth = 1280;
    globalThis.innerHeight = 900;
    withGeometry({ bottom: 320, left: 2, right: 92, top: 300 });
    setup();
    const panel = openPanel();
    expect(Number.parseFloat(panel.style.left)).toBeGreaterThanOrEqual(12);
  });

  it("opens above the trigger when there is not enough room below", () => {
    globalThis.innerWidth = 1280;
    globalThis.innerHeight = 900;
    // Only ~60px below the trigger, but plenty above.
    withGeometry({ bottom: 840, left: 300, right: 390, top: 820 });
    setup();
    const panel = openPanel();
    const top = Number.parseFloat(panel.style.top);
    expect(top).toBeLessThan(820);
    expect(top).toBeGreaterThanOrEqual(12);
  });

  it("opens below when there is room, leaving the row it describes visible", () => {
    globalThis.innerWidth = 1280;
    globalThis.innerHeight = 900;
    withGeometry({ bottom: 220, left: 300, right: 390, top: 200 });
    setup();
    const panel = openPanel();
    expect(Number.parseFloat(panel.style.top)).toBeGreaterThanOrEqual(220);
  });

  it("caps its height to the space available instead of running off-screen", () => {
    globalThis.innerWidth = 1280;
    globalThis.innerHeight = 400;
    withGeometry({ bottom: 220, left: 300, right: 390, top: 200 });
    setup();
    const panel = openPanel();
    const maxHeight = Number.parseFloat(panel.style.maxHeight);
    expect(maxHeight).toBeGreaterThan(0);
    expect(maxHeight).toBeLessThanOrEqual(400);
  });

  it("keeps the panel open while the pointer travels from the trigger into it", () => {
    withGeometry({ bottom: 320, left: 200, right: 290, top: 300 });
    setup();
    const panel = openPanel();
    // Leaving the trigger schedules a close; entering the panel cancels it.
    // Named, because the action button also exists once the panel is open.
    const chip = screen.getByRole("button", { name: /Collect from Driver/i });
    fireEvent.mouseLeave(chip.parentElement as HTMLElement);
    fireEvent.mouseEnter(panel);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on an outside pointer press", () => {
    withGeometry({ bottom: 320, left: 200, right: 290, top: 300 });
    setup();
    openPanel();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("smart primary action", () => {
  it("offers Change Status to Delivered, not Open Order, for a parcel in transit", () => {
    // The screenshot case. "Open Order" told the operator nothing.
    setup(
      {
        nextActionCode: "mark_delivered",
        nextActionParams: {
          openDialog: "change_status",
          orderNumber: "ORD-0001",
          returnTo: "/orders",
          suggestedStatus: "delivered",
        },
        nextActionRoute: "/orders/ORD-0001",
        waitingFor: "awaiting_delivery",
        workflowState: "awaiting_delivery",
      },
      ["orders.update_delivery_status"],
    );
    fireEvent.focus(screen.getByRole("button", { name: /Out for delivery/i }));
    expect(
      screen.getByRole("button", { name: "Change Status to Delivered" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Order" })).toBeNull();
  });

  it("keeps View Order as a secondary control", () => {
    const { navigations } = setup();
    fireEvent.focus(screen.getByRole("button", { name: /Collect from Driver/i }));
    const secondary = screen.getByRole("button", { name: "View Order" });
    expect(secondary.className).toContain("order-workflow-secondary");
    // Primary and secondary are visually distinct classes, not two equals.
    expect(
      screen.getByRole("button", { name: "Collect Money from Driver" }).className,
    ).toContain("order-workflow-action");
    fireEvent.click(secondary);
    expect(navigations).toStrictEqual(["/orders/ORD-0001"]);
  });

  it("carries the dialog request and return target into the URL", () => {
    const { navigations } = setup({
      nextActionCode: "pay_trader",
      nextActionParams: {
        openDialog: "new_settlement",
        orderNumber: "ORD-0001",
        returnTo: "/orders",
        traderId: "trader-1",
      },
      nextActionRoute: "/trader-settlements",
      waitingFor: "awaiting_trader_payment",
      workflowState: "awaiting_trader_payment",
    }, ["settlements.create"]);
    // The chip and the action share this label, so the action is taken from
    // inside the panel rather than by name alone.
    const chips = screen.getAllByRole("button", { name: /Pay Trader/i });
    fireEvent.focus(chips[0] as HTMLElement);
    const action = screen
      .getByRole("dialog")
      .querySelector(".order-workflow-action") as HTMLElement;
    fireEvent.click(action);
    expect(navigations[0]).toContain("openDialog=new_settlement");
    expect(navigations[0]).toContain("traderId=trader-1");
    expect(navigations[0]).toContain("returnTo=%2Forders");
  });

  it("routes Trader-paid service fees to Trader Receivables", () => {
    const { navigations } = setup(
      {
        nextActionCode: "collect_trader_receivable",
        nextActionParams: {
          orderNumber: "ORD-0001",
          receivableId: "receivable-1",
          returnTo: "/orders",
        },
        nextActionRoute: "/trader-receivables/receivable-1",
        waitingFor: "awaiting_trader_receivable_collection",
        workflowState: "awaiting_trader_receivable_collection",
      },
      ["trader_receivables.create"],
    );
    fireEvent.focus(screen.getByRole("button", { name: /Collect from Trader/i }));
    const action = screen
      .getByRole("dialog")
      .querySelector(".order-workflow-action") as HTMLElement;
    fireEvent.click(action);
    expect(navigations).toStrictEqual([
      "/trader-receivables?orderNumber=ORD-0001&returnTo=%2Forders&collectReceivableId=receivable-1",
    ]);
  });
  it("shows no primary action on a complete Order, but still offers View Order", () => {
    setup({
      isFinanciallyComplete: true,
      nextActionCode: "none",
      nextActionRoute: null,
      waitingFor: "complete",
      workflowState: "complete",
    });
    fireEvent.focus(screen.getByRole("button", { name: /Complete/i }));
    expect(screen.queryByText("Next step")).toBeNull();
    expect(screen.getByRole("button", { name: "View Order" })).toBeInTheDocument();
  });
});
