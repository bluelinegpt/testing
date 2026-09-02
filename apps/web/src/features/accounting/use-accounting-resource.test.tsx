// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { render, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { useAccountingResource } from "./use-accounting-resource.js";

function Probe({ loader }: { loader: (signal: AbortSignal) => Promise<string> }) {
  const state = useAccountingResource("probe", loader);
  useEffect(() => undefined, [state]);
  return <span>{state.data ?? (state.loading ? "loading" : state.error)}</span>;
}

describe("useAccountingResource", () => {
  it("consumes request cancellation during a React development remount", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const loader = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          const timer = window.setTimeout(() => resolve("ready"), 5);
          signal.addEventListener(
            "abort",
            () => {
              window.clearTimeout(timer);
              reject(new DOMException("signal is aborted without reason", "AbortError"));
            },
            { once: true },
          );
        }),
    );

    const view = render(
      <StrictMode>
        <Probe loader={loader} />
      </StrictMode>,
    );
    await waitFor(() => expect(view.getByText("ready")).toBeInTheDocument());

    expect(loader).toHaveBeenCalledTimes(2);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("still exposes genuine loader failures to the page", async () => {
    const loader = vi.fn(async () => {
      throw new Error("network failed");
    });

    const view = render(<Probe loader={loader} />);
    await waitFor(() => expect(view.getByText("request_failed")).toBeInTheDocument());
  });
});
