import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../../api/api-client.js";
import type { AccountingLoadState } from "./accounting-types.js";

function isCancellation(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof Error && error.message.toLowerCase().includes("signal is aborted"))
  );
}

export function useAccountingResource<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
): AccountingLoadState<T> & { readonly refresh: () => void } {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<AccountingLoadState<T>>({ loading: true });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((current) => ({ ...current, error: undefined, loading: true }));

    // Keep the rejection handling inside one async boundary. Apart from also
    // covering a synchronous loader failure, this prevents React development
    // remounts from leaving an aborted fetch visible as an unhandled Promise
    // rejection in the browser console.
    const load = async (): Promise<void> => {
      try {
        const data = await loaderRef.current(controller.signal);
        if (active && !controller.signal.aborted) {
          setState({ data, loading: false, refreshedAt: new Date().toISOString() });
        }
      } catch (error: unknown) {
        if (!active || controller.signal.aborted || isCancellation(error)) return;
        const code = error instanceof ApiError ? error.code : "request_failed";
        const errorMessage = error instanceof ApiError ? error.message : undefined;
        setState({ error: code, errorMessage, loading: false });
      }
    };
    void load();

    return () => {
      active = false;
      if (!controller.signal.aborted) controller.abort();
    };
  }, [key, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { ...state, refresh };
}
