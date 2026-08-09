import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";

import { TraderForm } from "./TraderConfigurationWorkspace.js";

/**
 * What the Create Trader form does when it refuses to save.
 *
 * Written after a report that the form "does not accept and shows no error".
 * The number in that report was `050556677` -- nine digits, one short of a UAE
 * mobile -- so the question these cases answer is not whether the rejection is
 * correct, but whether the operator is actually told about it. Reasoning about
 * the JSX was not enough to settle that; rendering the real component is.
 */

function apiStub(overrides: Partial<Record<"get" | "patch" | "post", unknown>> = {}) {
  return {
    get: vi.fn().mockResolvedValue({ hasMore: false, items: [], total: 0 }),
    patch: vi.fn(),
    post: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

function renderForm(api: ApiClient, onSaved = vi.fn()) {
  render(<TraderForm api={api} onClose={vi.fn()} onSaved={onSaved} />);
  return { onSaved };
}

/** Fills the two required fields and presses Save. */
function fillAndSubmit(mobile: string, name = "Cools") {
  fireEvent.change(screen.getByRole("textbox", { name: /name/i }), { target: { value: name } });
  const mobileField = document.querySelector<HTMLInputElement>('input[name="mobileNumber"]')!;
  fireEvent.change(mobileField, { target: { value: mobile } });
  fireEvent.submit(mobileField.closest("form")!);
}

describe("Create Trader validation feedback", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("shows a visible error for the nine-digit number from the report", async () => {
    const post = vi.fn();
    renderForm(apiStub({ post }));

    fillAndSubmit("050556677");

    // The message must reach the screen, not just the state.
    const error = await screen.findByRole("alert");
    expect(error.textContent ?? "").toMatch(/not a valid UAE mobile number/i);
    // It must read as a rejection, not as a hint shown before typing.
    expect(error.textContent ?? "").not.toMatch(/^Enter a UAE mobile number/i);
    // And nothing may be sent while the number is rejected.
    expect(post).not.toHaveBeenCalled();
  });

  it("moves focus to the field that blocked the save", async () => {
    renderForm(apiStub());
    fillAndSubmit("050556677");

    const mobileField = document.querySelector<HTMLInputElement>('input[name="mobileNumber"]')!;
    await waitFor(() => expect(document.activeElement).toBe(mobileField));
  });

  it("points at the second mobile when that is the field at fault", async () => {
    renderForm(apiStub());
    const second = document.querySelector<HTMLInputElement>('input[name="secondMobileNumber"]')!;
    fireEvent.change(second, { target: { value: "12345" } });
    fillAndSubmit("0505566771");

    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  it("ties the error to the mobile field for assistive technology", async () => {
    renderForm(apiStub());
    fillAndSubmit("050556677");

    const mobileField = document.querySelector<HTMLInputElement>('input[name="mobileNumber"]')!;
    await waitFor(() => expect(mobileField.getAttribute("aria-invalid")).toBe("true"));
    expect(mobileField.getAttribute("aria-describedby")).toBe("trader-mobile-error");
  });

  it("accepts the corrected ten-digit number and posts the canonical form", async () => {
    const post = vi.fn().mockResolvedValue({ code: "TRD-1", id: "t1", name: "Cools" });
    const { onSaved } = renderForm(apiStub({ post }));

    fillAndSubmit("0505566771");

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("configuration/traders");
    expect(body.mobileNumber).toBe("971505566771");
    expect(onSaved).toHaveBeenCalled();
  });

  it("surfaces what the server said instead of a generic sentence", async () => {
    const post = vi.fn().mockRejectedValue(
      Object.assign(new Error("The selected Area is not active in this Company"), {
        code: "area_not_found",
        status: 400,
      }),
    );
    renderForm(apiStub({ post }));

    fillAndSubmit("0505566771");

    expect(await screen.findByText(/The selected Area is not active in this Company/i)).toBeTruthy();
  });

  it("appends the status when the reply carried no error envelope", async () => {
    /* `request_failed` is the client's fallback code, so the message is the
       client's own placeholder rather than anything the API said. Without the
       status there is nothing to act on and nothing to report. */
    const post = vi.fn().mockRejectedValue(
      Object.assign(new Error("The request could not be completed"), {
        code: "request_failed",
        status: 502,
      }),
    );
    renderForm(apiStub({ post }));

    fillAndSubmit("0505566771");

    expect(await screen.findByText(/The request could not be completed \(HTTP 502\)/i)).toBeTruthy();
  });

  it("does not clutter a real API message with the status", async () => {
    const post = vi.fn().mockRejectedValue(
      Object.assign(new Error("A Trader with this mobile number already exists"), {
        code: "trader_mobile_exists",
        status: 409,
      }),
    );
    renderForm(apiStub({ post }));

    fillAndSubmit("0505566771");

    const banner = await screen.findByText(/already exists/i);
    expect(banner.textContent ?? "").not.toMatch(/HTTP/);
  });

  it("puts a server-side mobile rejection against the field", async () => {
    const post = vi.fn().mockRejectedValue(
      Object.assign(new Error("Enter the mobile number in the format 9715XXXXXXXX."), {
        code: "trader_mobile_invalid",
        status: 400,
      }),
    );
    renderForm(apiStub({ post }));

    fillAndSubmit("0505566771");

    const error = await screen.findByRole("alert");
    expect(error.getAttribute("id")).toBe("trader-mobile-error");
  });

  it("does not fail silently when the response carries no record", async () => {
    // A 204 or empty body resolves to undefined; the Order flow used to return
    // quietly on that, leaving the dialog open with nothing saved and no message.
    const post = vi.fn().mockResolvedValue(undefined);
    const { onSaved } = renderForm(apiStub({ post }));

    fillAndSubmit("0505566771");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
