/**
 * Stops a mouse wheel from silently editing money.
 *
 * A focused `<input type="number">` treats a wheel scroll as a value change, one
 * `step` per notch. On a long form -- Trader Settlements is the worst of them --
 * the operator clicks into Payment Amount, scrolls down to reach Payment Method,
 * and the amount quietly moves by 0.01 under the cursor on the way past. The
 * reported case was 225.00 becoming 224.99: one notch, no keystroke, no warning,
 * and the settlement then fails a balance rule for a cent nobody typed.
 *
 * Blur rather than `preventDefault`: the browser only applies a wheel change to
 * the FOCUSED control, so removing focus during dispatch cancels the edit while
 * leaving the page free to scroll. Cancelling the event instead would fix the
 * amount and trap the scroll, which trades one surprise for another.
 *
 * Installed once for the whole application rather than per field. There are ~54
 * number inputs across the app and every one of them has this behaviour; a fix
 * applied field by field is a fix that the 55th will not get.
 */
export function installNumberInputWheelGuard(target: Document = document): () => void {
  const onWheel = (event: Event) => {
    const element = event.target;
    if (!(element instanceof HTMLInputElement)) return;
    if (element.type !== "number") return;
    // Only the focused input is at risk, and only that one should lose focus --
    // blurring on any passing wheel event would fight the user's own scrolling.
    if (element.ownerDocument.activeElement !== element) return;
    element.blur();
  };
  // Capture phase: the guard must run before the value change is applied, and
  // passive because it never calls preventDefault.
  target.addEventListener("wheel", onWheel, { capture: true, passive: true });
  return () => target.removeEventListener("wheel", onWheel, { capture: true });
}
