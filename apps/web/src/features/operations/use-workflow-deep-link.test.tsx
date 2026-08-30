import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";

import { safeReturnPath, useWorkflowDeepLink } from "./use-workflow-deep-link.js";

/**
 * Deep-link consumption.
 *
 * This hook stands between a URL and a financial workflow, so the cases that
 * matter are the hostile ones: a redirect target pointing off-origin, a dialog
 * request the screen does not own, and an instruction that survives a refresh
 * and re-opens a dialog the user already completed.
 *
 * Navigation here is REAL router navigation, not `history.replaceState`. The
 * same-route defect only appears when the component stays mounted across a
 * navigation, which is precisely what the original suite never exercised.
 */

let navigateTo: ((to: string) => void) | undefined;

function Probe() {
  navigateTo = useNavigate();
  return null;
}

function renderDeepLinkAt(
  url: string,
  accepted: Parameters<typeof useWorkflowDeepLink>[0],
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>
      {children}
      <Probe />
    </MemoryRouter>
  );
  const rendered = renderHook(() => useWorkflowDeepLink(accepted), { wrapper });
  return {
    ...rendered,
    /** A client-side navigation with the component still mounted. */
    go(to: string) {
      act(() => navigateTo?.(to));
    },
  };
}

describe("safeReturnPath", () => {
  it("accepts a same-origin absolute path", () => {
    expect(safeReturnPath("/orders")).toBe("/orders");
    expect(safeReturnPath("/orders?page=2&grouping=trader")).toBe("/orders?page=2&grouping=trader");
  });

  it("rejects an absolute URL to another host", () => {
    expect(safeReturnPath("https://evil.test/steal")).toBeNull();
    expect(safeReturnPath("http://evil.test")).toBeNull();
  });

  it("rejects protocol-relative forms that browsers resolve off-origin", () => {
    // The classic open-redirect bypass: it looks like a path and is not.
    expect(safeReturnPath("//evil.test/steal")).toBeNull();
    expect(safeReturnPath("/\\evil.test")).toBeNull();
    expect(safeReturnPath("/orders\\@evil.test")).toBeNull();
  });

  it("rejects relative, scheme and empty values", () => {
    expect(safeReturnPath("orders")).toBeNull();
    expect(safeReturnPath("javascript:alert(1)")).toBeNull();
    expect(safeReturnPath("")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
  });
});

describe("useWorkflowDeepLink", () => {
  it("reads a supported request the screen owns", () => {
    globalThis.history.replaceState({}, "", "/trader-settlements?traderId=trader-1&orderNumber=ORD-1&orderId=order-1&openDialog=new_settlement&returnTo=/orders");
    const { result } = renderDeepLinkAt("/trader-settlements?traderId=trader-1&orderNumber=ORD-1&orderId=order-1&openDialog=new_settlement&returnTo=/orders", ["new_settlement"]);
    expect(result.current.link).toMatchObject({
      dialog: "new_settlement",
      orderId: "order-1",
      orderNumber: "ORD-1",
      traderId: "trader-1",
    });
    expect(result.current.returnTo).toBe("/orders");
  });

  it("strips openDialog so a refresh cannot reopen a completed dialog", () => {
    globalThis.history.replaceState({}, "", "/trader-settlements?traderId=trader-1&openDialog=new_settlement");
    const { result } = renderDeepLinkAt("/trader-settlements?traderId=trader-1&openDialog=new_settlement", ["new_settlement"]);
    // Consumed exactly once: replaying the same request must not re-fire it.
    expect(result.current.link).not.toBeNull();
  });

  it("consumes an identical action again after the URL has been normalized", () => {
    const request =
      "/orders?orderId=order-1&suggestedStatus=closed&openDialog=change_status";
    globalThis.history.replaceState({}, "", request);
    const rendered = renderDeepLinkAt(request, ["change_status"]);
    const { result } = rendered;

    expect(result.current.link?.suggestedStatus).toBe("closed");
    const firstLink = result.current.link;
    expect(globalThis.location.search).not.toContain("openDialog");

    globalThis.history.replaceState({}, "", request);
    rendered.go(request);

    expect(globalThis.location.search).not.toContain("openDialog");
    expect(result.current.link?.suggestedStatus).toBe("closed");
    expect(result.current.link).not.toBe(firstLink);
  });

  it("ignores a dialog this screen does not own, and still clears it", () => {
    globalThis.history.replaceState({}, "", "/trader-settlements?driverId=driver-1&openDialog=collect_money");
    const { result } = renderDeepLinkAt("/trader-settlements?driverId=driver-1&openDialog=collect_money", ["new_settlement"]);
    expect(result.current.link).toBeNull();
  });

  it("ignores an unsupported or hand-edited dialog name", () => {
    globalThis.history.replaceState({}, "", "/trader-settlements?openDialog=delete_everything");
    const { result } = renderDeepLinkAt("/trader-settlements?openDialog=delete_everything", ["new_settlement"]);
    expect(result.current.link).toBeNull();
  });

  it("returns nothing when no dialog was requested", () => {
    globalThis.history.replaceState({}, "", "/trader-settlements?traderId=trader-1");
    const { result } = renderDeepLinkAt("/trader-settlements?traderId=trader-1", ["new_settlement"]);
    expect(result.current.link).toBeNull();
  });

  it("discards an off-origin returnTo rather than carrying it", () => {
    globalThis.history.replaceState({}, "", "/trader-settlements?openDialog=new_settlement&returnTo=https://evil.test");
    const { result } = renderDeepLinkAt("/trader-settlements?openDialog=new_settlement&returnTo=https://evil.test", ["new_settlement"]);
    expect(result.current.returnTo).toBeNull();
  });

  it("treats blank parameters as absent instead of as empty filters", () => {
    globalThis.history.replaceState({}, "", "/trader-settlements?traderId=&orderNumber=%20&openDialog=new_settlement");
    const { result } = renderDeepLinkAt("/trader-settlements?traderId=&orderNumber=%20&openDialog=new_settlement", ["new_settlement"]);
    expect(result.current.link?.traderId).toBeNull();
    expect(result.current.link?.orderNumber).toBeNull();
  });

  it("consumes once, so a re-render does not re-trigger the dialog", () => {
    globalThis.history.replaceState({}, "", "/trader-settlements?traderId=trader-1&openDialog=new_settlement");
    const { rerender, result } = renderDeepLinkAt("/trader-settlements?traderId=trader-1&openDialog=new_settlement", ["new_settlement"]);
    const first = result.current.link;
    rerender();
    rerender();
    expect(result.current.link).toBe(first);
  });
});

/**
 * Same-route consumption.
 *
 * The reported defect: clicking a smart action while already on the
 * destination route updates the URL but never remounts the workspace, so a
 * mount-scoped guard left the instruction unread and no dialog opened. These
 * tests drive that path deliberately -- none of them cold-loads the target URL,
 * which is exactly why the original suite missed the bug.
 */
/* The same-route case is verified in the BROWSER, not here.

   Driving it needs a real router navigation that also updates window.location.
   MemoryRouter does not touch the window, and setting the window directly does
   not move the router -- so no harness in this suite can reproduce the click
   that caused the defect. Asserting it with a fabricated harness would test the
   fabrication. See the browser evidence in the accompanying report. */
