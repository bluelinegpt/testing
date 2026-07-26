import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { vi } from "vitest";

import type { ApiClient } from "../api/api-client.js";
import { i18nInstance } from "../localization/i18n.js";

import { SearchCombobox, defaultSearchDebounceMs } from "./SearchCombobox.js";

interface Trader {
  readonly id: string;
  readonly name: string;
}

function page(items: readonly Trader[]) {
  return { hasMore: false, items, total: items.length };
}

/** Renders the real component with controlled state, never a stand-in. */
function Harness({ api, debounceMs }: { api: ApiClient; debounceMs?: number }) {
  const [value, setValue] = useState<Trader | undefined>();
  return (
    <SearchCombobox<Trader>
      api={api}
      {...(debounceMs === undefined ? {} : { debounceMs })}
      emptyText="No matches"
      getLabel={(option) => option.name}
      label="Trader"
      onChange={setValue}
      path="operations/traders/search"
      placeholder="Search traders"
      value={value}
    />
  );
}

describe("SearchCombobox", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("waits for the default debounce before searching", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const get = vi.fn().mockResolvedValue(page([{ id: "t1", name: "Alpha Trader" }]));
      render(<Harness api={{ get } as unknown as ApiClient} />);
      const input = screen.getByPlaceholderText("Search traders");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "Alpha" } });

      // Nothing is requested before the debounce elapses.
      await vi.advanceTimersByTimeAsync(defaultSearchDebounceMs - 50);
      expect(get).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60);
      expect(get).toHaveBeenCalledTimes(1);
      expect(String(get.mock.calls[0]?.[0])).toContain("search=Alpha");
    } finally {
      vi.useRealTimers();
    }
  });

  it("searches without a real-time delay when debounceMs is 0", async () => {
    const get = vi.fn().mockResolvedValue(page([{ id: "t1", name: "Alpha Trader" }]));
    render(<Harness api={{ get } as unknown as ApiClient} debounceMs={0} />);
    const input = screen.getByPlaceholderText("Search traders");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Alpha" } });

    expect(await screen.findByRole("option", { name: "Alpha Trader" })).toBeInTheDocument();
  });

  it("does not let a stale response replace newer results", async () => {
    // The component cancels superseded requests with an AbortController, so the
    // mock honours the signal exactly as the real ApiClient does. A transport
    // that ignored the signal would let a late response overwrite newer results.
    const get = vi.fn(
      (path: string, signal?: AbortSignal) =>
        new Promise((resolveValue, rejectValue) => {
          signal?.addEventListener("abort", () =>
            rejectValue(new DOMException("Aborted", "AbortError")),
          );
          if (path.includes("search=second")) {
            resolveValue(page([{ id: "t2", name: "Second Trader" }]));
          }
        }),
    );

    render(<Harness api={{ get } as unknown as ApiClient} debounceMs={0} />);
    const input = screen.getByPlaceholderText("Search traders");
    fireEvent.focus(input);

    // Let the first query genuinely reach the transport before superseding it.
    fireEvent.change(input, { target: { value: "first" } });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "second" } });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    // The newer query wins and the superseded one was aborted, not applied.
    expect(await screen.findByRole("option", { name: "Second Trader" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Stale Trader" })).not.toBeInTheDocument();
    const firstSignal = get.mock.calls[0]?.[1] as AbortSignal | undefined;
    expect(firstSignal?.aborted).toBe(true);
  });

  it("clears results when the input is cleared", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("search=Alpha") ? page([{ id: "t1", name: "Alpha Trader" }]) : page([]),
    );
    render(<Harness api={{ get } as unknown as ApiClient} debounceMs={0} />);
    const input = screen.getByPlaceholderText("Search traders");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Alpha" } });
    await screen.findByRole("option", { name: "Alpha Trader" });

    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: "Alpha Trader" })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("No matches")).toBeInTheDocument();
  });

  it("keeps keyboard navigation and option selection working", async () => {
    const get = vi.fn().mockResolvedValue(
      page([
        { id: "t1", name: "Alpha Trader" },
        { id: "t2", name: "Beta Trader" },
      ]),
    );
    render(<Harness api={{ get } as unknown as ApiClient} debounceMs={0} />);
    const input = screen.getByPlaceholderText("Search traders");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Trader" } });
    await screen.findByRole("option", { name: "Alpha Trader" });

    // Arrow down moves the active option, Enter selects it.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("Beta Trader"));
    expect(screen.queryByRole("option", { name: "Alpha Trader" })).not.toBeInTheDocument();

    // Clicking an option also selects it.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Trader" } });
    fireEvent.click(await screen.findByRole("option", { name: "Alpha Trader" }));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("Alpha Trader"));
  });

  /**
   * Regression: the superseded search must not blank a newer result set.
   *
   * Reproduces the observed full-suite flake, where focusing the input issued a
   * search for "" and the subsequent keystroke issued one for "TR-1". When the
   * empty-query reply resolved last it overwrote the real options and the list
   * rendered "No matches", so keyboard selection had nothing to select.
   * Deterministic here: the stale reply is keyed by its query and released by
   * hand, strictly after the fresh one has already rendered.
   */
  it("ignores a superseded search that resolves after a newer one", async () => {
    let releaseStale: ((value: unknown) => void) | undefined;
    const get = vi.fn().mockImplementation((url: string) => {
      // The abandoned empty-query search is held open so it can resolve last.
      if (url.includes("search=&")) {
        return new Promise((resolve) => {
          releaseStale = resolve;
        });
      }
      return Promise.resolve(page([{ id: "t1", name: "TR-1 Trader" }]));
    });

    render(<Harness api={{ get } as unknown as ApiClient} debounceMs={0} />);
    const input = screen.getByPlaceholderText("Search traders");

    // Let the empty-query search actually reach the client before typing,
    // otherwise its debounce timer is cleared and there is no stale request.
    fireEvent.focus(input);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(releaseStale).toBeDefined();

    fireEvent.change(input, { target: { value: "TR-1" } });
    const option = await screen.findByRole("option", { name: "TR-1 Trader" });

    // Only now does the abandoned first search complete, with no results.
    releaseStale?.(page([]));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    // The newer result must survive; the stale empty reply is discarded.
    expect(option).toBeInTheDocument();
    expect(screen.queryByText("No matches")).not.toBeInTheDocument();
  });

});
