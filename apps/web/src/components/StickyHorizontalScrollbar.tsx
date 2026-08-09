import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * A horizontal scrollbar that stays reachable while the list is scrolled
 * vertically.
 *
 * ===========================================================================
 * THE PROBLEM THIS SOLVES
 * ===========================================================================
 *
 * The Orders table is wider than the viewport, so its scroll container owns a
 * horizontal scrollbar. That scrollbar sits at the BOTTOM of the container --
 * which, on a full page of Orders, is hundreds of pixels below the fold. To
 * scroll sideways a user had to scroll all the way down, scroll across, then
 * scroll back up. The columns they wanted to compare were off-screen the whole
 * time.
 *
 * ===========================================================================
 * WHY A PROXY RATHER THAN A SECOND SCROLL CONTAINER
 * ===========================================================================
 *
 * This renders a sticky bar holding a spacer as wide as the real content. It
 * is a PROXY: the table still has exactly one authoritative scroll position,
 * `target.scrollLeft`. The proxy mirrors it and writes back to it. There is
 * never a second independent position to fall out of sync -- which is the
 * failure mode of duplicating the table or cloning its header.
 *
 * Both directions are guarded by `syncing`. Assigning `scrollLeft` fires
 * `scroll` on the element written to, so an unguarded pair of listeners feeds
 * each other and can stall a drag or jitter at the extremes.
 *
 * RTL: no axis maths anywhere. Both elements are laid out by the same
 * direction, so mirroring `scrollLeft` verbatim is correct in both -- whether
 * the browser reports the axis as negative, inverted or zero-based.
 */
export function StickyHorizontalScrollbar({
  targetRef,
  label,
}: {
  /** The element that actually scrolls. Its `scrollLeft` stays authoritative. */
  readonly targetRef: React.RefObject<HTMLElement | null>;
  /** Accessible name; defaults to a generic table description. */
  readonly label?: string | undefined;
}) {
  const { t } = useTranslation();
  const proxyRef = useRef<HTMLDivElement | null>(null);
  const syncing = useRef(false);
  const [width, setWidth] = useState(0);
  const [overflows, setOverflows] = useState(false);

  /** Re-measure. The bar exists only while the content genuinely overflows. */
  const measure = useCallback(() => {
    const target = targetRef.current;
    if (target === null) return;
    setWidth(target.scrollWidth);
    // A 1px tolerance: sub-pixel layout rounding otherwise shows a scrollbar
    // for content that fits.
    setOverflows(target.scrollWidth - target.clientWidth > 1);
  }, [targetRef]);

  useEffect(() => {
    const target = targetRef.current;
    if (target === null) return;
    measure();

    // The width changes for reasons unrelated to scrolling: a column toggled,
    // the window resized, rows replaced by a new page of results.
    //
    // Feature-detected rather than assumed. `ResizeObserver` is absent in jsdom,
    // and constructing it unguarded threw during render — which took out twelve
    // unrelated Orders and App tests that merely happen to mount this table. A
    // presentation aid must not be able to break the screen that hosts it.
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(target);
      const firstChild = target.firstElementChild;
      if (firstChild !== null) observer.observe(firstChild);
    } else {
      // Coarser, but it still tracks the case that matters most.
      globalThis.addEventListener("resize", measure);
    }

    const onTargetScroll = () => {
      if (syncing.current) return;
      const proxy = proxyRef.current;
      if (proxy === null) return;
      syncing.current = true;
      proxy.scrollLeft = target.scrollLeft;
      // Released on the next frame rather than synchronously: the scroll event
      // this assignment triggers is delivered asynchronously, so clearing the
      // guard immediately would let it through and start a feedback loop.
      requestAnimationFrame(() => {
        syncing.current = false;
      });
    };

    target.addEventListener("scroll", onTargetScroll, { passive: true });
    return () => {
      observer?.disconnect();
      globalThis.removeEventListener("resize", measure);
      target.removeEventListener("scroll", onTargetScroll);
    };
  }, [measure, targetRef]);

  const onProxyScroll = () => {
    if (syncing.current) return;
    const target = targetRef.current;
    const proxy = proxyRef.current;
    if (target === null || proxy === null) return;
    syncing.current = true;
    target.scrollLeft = proxy.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  // Nothing is rendered while the content fits. The effect above stays
  // mounted and keeps measuring, so the bar returns by itself the moment the
  // table starts to overflow again.
  if (!overflows) return null;

  return (
    <div
      aria-label={label ?? t("operations.ordersHorizontalScroll")}
      className="sticky-hscroll"
      onScroll={onProxyScroll}
      ref={proxyRef}
      role="scrollbar"
      // Focusable so the axis is reachable by keyboard: a div with overflow
      // scrolls with the arrow keys once it can hold focus.
      tabIndex={0}
    >
      <div className="sticky-hscroll-spacer" style={{ width }} />
    </div>
  );
}
