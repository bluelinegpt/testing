import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import { storeI18n } from "../localization/i18n.js";

import { ShareControl } from "./ShareControl.js";

/**
 * The share control.
 *
 * The cases that matter are the ones a manual click-through never reaches: a
 * cancelled share sheet, a denied clipboard, and a browser with no Web Share
 * API at all. Each has a different correct outcome and only one of them is the
 * happy path.
 */

function renderControl() {
  return render(
    <I18nextProvider i18n={storeI18n}>
      <ShareControl text="A sample" title="Dev Embroidered Abaya" />
    </I18nextProvider>,
  );
}

const originalShare = Object.getOwnPropertyDescriptor(navigator, "share");
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function stub(property: "clipboard" | "share", value: unknown) {
  Object.defineProperty(navigator, property, { configurable: true, value, writable: true });
}

afterEach(() => {
  if (originalShare === undefined) Reflect.deleteProperty(navigator, "share");
  else Object.defineProperty(navigator, "share", originalShare);
  if (originalClipboard === undefined) Reflect.deleteProperty(navigator, "clipboard");
  else Object.defineProperty(navigator, "clipboard", originalClipboard);
});

describe("ShareControl", () => {
  it("hands the current URL to the operating system share sheet", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stub("share", share);
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => undefined);

    expect(share).toHaveBeenCalledWith({
      text: "A sample",
      title: "Dev Embroidered Abaya",
      // The address bar, so the locale prefix travels with the shared link.
      url: window.location.href,
    });
  });

  it("says nothing when the shopper cancels the share sheet", async () => {
    // A cancelled share is a decision, not a failure. Showing "link copied" or
    // an error here would both be lies.
    stub("share", vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError")));
    const writeText = vi.fn().mockResolvedValue(undefined);
    stub("clipboard", { writeText });
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => undefined);

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("copies the link when the browser has no share sheet", async () => {
    Reflect.deleteProperty(navigator, "share");
    const writeText = vi.fn().mockResolvedValue(undefined);
    stub("clipboard", { writeText });
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => undefined);

    expect(writeText).toHaveBeenCalledWith(window.location.href);
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Link copied");
    });
  });

  it("falls back to copying when the share sheet fails for a real reason", async () => {
    stub("share", vi.fn().mockRejectedValue(new Error("not allowed")));
    const writeText = vi.fn().mockResolvedValue(undefined);
    stub("clipboard", { writeText });
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => undefined);

    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });

  it("admits it when the clipboard is denied instead of claiming success", async () => {
    Reflect.deleteProperty(navigator, "share");
    stub("clipboard", { writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => undefined);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Copy the link from the address bar");
    });
  });
});
