import { render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";

import { StickyHorizontalScrollbar } from "./StickyHorizontalScrollbar.js";

/**
 * The sticky horizontal scrollbar.
 *
 * The claims worth pinning are the ones a defect would make expensive: that the
 * bar appears ONLY when the content really overflows, that it and the table
 * share one scroll position rather than drifting into two, and that mirroring
 * in both directions does not feed itself into a loop.
 *
 * jsdom reports 0 for every layout box, so `scrollWidth` and `clientWidth` are
 * defined per element here. That is the honest way to drive this component in a
 * unit test -- the alternative is asserting on the mock rather than on the
 * behaviour.
 */
function sizedTarget({
  scrollWidth,
  clientWidth,
}: {
  readonly clientWidth: number;
  readonly scrollWidth: number;
}) {
  const element = document.createElement("div");
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: clientWidth });
  document.body.append(element);
  return element;
}

beforeAll(() => {
  // jsdom has no ResizeObserver. The component only uses it to re-measure, and
  // every test here measures once on mount.
  globalThis.ResizeObserver = class {
    public observe() {
      /* no-op */
    }
    public disconnect() {
      /* no-op */
    }
    public unobserve() {
      /* no-op */
    }
  } as unknown as typeof ResizeObserver;
});

describe("StickyHorizontalScrollbar", () => {
  it("renders nothing when the content fits", () => {
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = sizedTarget({
      clientWidth: 900,
      scrollWidth: 900,
    });
    render(<StickyHorizontalScrollbar label="Scroll" targetRef={ref} />);
    // No overflow means no control: a scrollbar for content that fits is noise.
    expect(screen.queryByRole("scrollbar")).toBeNull();
  });

  it("ignores sub-pixel rounding rather than showing a spurious bar", () => {
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = sizedTarget({
      clientWidth: 900,
      scrollWidth: 901,
    });
    render(<StickyHorizontalScrollbar label="Scroll" targetRef={ref} />);
    expect(screen.queryByRole("scrollbar")).toBeNull();
  });

  it("appears when the content genuinely overflows", async () => {
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = sizedTarget({
      clientWidth: 900,
      scrollWidth: 1600,
    });
    render(<StickyHorizontalScrollbar label="Scroll the Orders table" targetRef={ref} />);
    const bar = await screen.findByRole("scrollbar");
    expect(bar).toBeInTheDocument();
    // Named for a screen reader, and reachable by keyboard.
    expect(bar).toHaveAccessibleName("Scroll the Orders table");
    expect(bar).toHaveAttribute("tabindex", "0");
    // The spacer carries the real content width, which is what gives the
    // proxy the same scrollable range as the table.
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("1600px");
  });

  it("moves the table when the proxy is scrolled", async () => {
    const ref = createRef<HTMLElement>();
    const target = sizedTarget({ clientWidth: 900, scrollWidth: 1600 });
    (ref as { current: HTMLElement }).current = target;
    render(<StickyHorizontalScrollbar label="Scroll" targetRef={ref} />);
    const bar = await screen.findByRole("scrollbar");

    bar.scrollLeft = 420;
    bar.dispatchEvent(new Event("scroll"));

    await waitFor(() => {
      expect(target.scrollLeft).toBe(420);
    });
  });

  it("moves the proxy when the table is scrolled", async () => {
    const ref = createRef<HTMLElement>();
    const target = sizedTarget({ clientWidth: 900, scrollWidth: 1600 });
    (ref as { current: HTMLElement }).current = target;
    render(<StickyHorizontalScrollbar label="Scroll" targetRef={ref} />);
    const bar = await screen.findByRole("scrollbar");

    target.scrollLeft = 300;
    target.dispatchEvent(new Event("scroll"));

    await waitFor(() => {
      expect(bar.scrollLeft).toBe(300);
    });
  });

  it("settles rather than oscillating when both ends move", async () => {
    // Each assignment fires a scroll event on the element written to. Without
    // the re-entrancy guard the two listeners feed each other; this asserts
    // they come to rest on one shared position.
    const ref = createRef<HTMLElement>();
    const target = sizedTarget({ clientWidth: 900, scrollWidth: 1600 });
    (ref as { current: HTMLElement }).current = target;
    render(<StickyHorizontalScrollbar label="Scroll" targetRef={ref} />);
    const bar = await screen.findByRole("scrollbar");

    // A frame between events, because that is how a browser delivers them: the
    // guard releases on rAF, so firing both ends synchronously in one tick is a
    // sequence no real scroll produces.
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    for (const position of [100, 250, 700, 0]) {
      target.scrollLeft = position;
      target.dispatchEvent(new Event("scroll"));
      await frame();
      bar.dispatchEvent(new Event("scroll"));
      await frame();
    }

    await waitFor(() => {
      expect(bar.scrollLeft).toBe(target.scrollLeft);
    });
    // And it came to rest on the LAST position, not on an earlier one.
    expect(target.scrollLeft).toBe(0);
  });
});
