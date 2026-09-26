import { afterEach, describe, expect, it } from "vitest";

import { installNumberInputWheelGuard } from "./number-input-wheel-guard.js";

/**
 * The reported defect: 225.00 entered, 224.99 submitted.
 *
 * A focused `<input type="number">` applies a wheel scroll as a value change of
 * one `step`. Trader Settlements is a long form -- the operator types the amount
 * near the top, then scrolls to Payment Method and Cash Account below it, and on
 * the way past the amount loses a cent. Nothing is typed, nothing is warned
 * about, and the settlement then fails a balance rule over money nobody entered.
 *
 * jsdom does not implement the browser's own wheel-to-value behaviour, so these
 * assert the GUARD's contract -- which input loses focus and which does not --
 * rather than the value change it prevents. That is the part this module owns.
 */

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  document.body.innerHTML = "";
});

function fieldOfType(type: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = type;
  document.body.append(input);
  return input;
}

/** A real, bubbling wheel event, as a scroll over the field produces. */
function wheelOver(element: HTMLElement): void {
  element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
}

describe("number input wheel guard", () => {
  it("blurs a focused number input so the wheel cannot change it", () => {
    uninstall = installNumberInputWheelGuard();
    const amount = fieldOfType("number");
    amount.focus();
    expect(document.activeElement).toBe(amount);

    wheelOver(amount);

    // Unfocused, so the browser has nothing to apply the scroll to.
    expect(document.activeElement).not.toBe(amount);
  });

  it("leaves an unfocused number input alone", () => {
    uninstall = installNumberInputWheelGuard();
    const amount = fieldOfType("number");
    const other = fieldOfType("text");
    other.focus();

    wheelOver(amount);

    // Scrolling the page over a field nobody is editing must not steal focus
    // from whatever they ARE editing.
    expect(document.activeElement).toBe(other);
  });

  it("does not interfere with other input types", () => {
    uninstall = installNumberInputWheelGuard();
    const notes = fieldOfType("text");
    notes.focus();

    wheelOver(notes);

    // Only number inputs treat a wheel as an edit; blurring a text field on
    // scroll would be a new annoyance in place of the old one.
    expect(document.activeElement).toBe(notes);
  });

  it("stops guarding once uninstalled", () => {
    const stop = installNumberInputWheelGuard();
    const amount = fieldOfType("number");
    stop();
    amount.focus();

    wheelOver(amount);

    expect(document.activeElement).toBe(amount);
  });
});
