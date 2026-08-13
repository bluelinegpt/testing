import "@testing-library/jest-dom/vitest";

import { configure } from "@testing-library/react";

// jsdom does not implement <dialog>'s showModal()/close() — every Platform
// confirmation dialog (Close Company and any future typed-confirmation
// flow) relies on the real element, so tests need the same minimal
// polyfill jsdom itself is expected to eventually ship.
if (typeof HTMLDialogElement !== "undefined") {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement): void {
      this.removeAttribute("open");
    };
  }
}

// Mirrors the Delivery Portal and the Store: the constrained forks pool can
// briefly deschedule a worker while a fetch settles, and 1s is then
// occasionally too tight for an element that does arrive. Patience, not a
// weaker assertion.
configure({ asyncUtilTimeout: 5000 });
