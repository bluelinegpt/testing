import type { ClipboardEvent } from "react";

/**
 * Multi-value search boxes accept "2383, 1523, 2447". Operators usually paste
 * that list as a column copied from Excel, and a single-line <input> silently
 * turns the line breaks into nothing (or spaces), gluing the values together.
 *
 * This paste handler keeps the values apart: when the pasted text has line
 * breaks, each non-empty line becomes one comma-separated value, inserted at
 * the caret. A paste without line breaks is left to the browser.
 */
export function listPasteHandler(onValue: (value: string) => void) {
  return (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[\r\n]/u.test(text)) return;
    event.preventDefault();
    const pasted = text
      .split(/\r\n|\r|\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join(", ");
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    onValue(input.value.slice(0, start) + pasted + input.value.slice(end));
  };
}
