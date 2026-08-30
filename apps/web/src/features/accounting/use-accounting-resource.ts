import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../../api/api-client.js";
import type { AccountingLoadState } from "./accounting-types.js";

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
    setState((current) => ({ ...current, error: undefined, loading: true }));
    void loaderRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setState({ data, loading: false, refreshedAt: new Date().toISOString() });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          const code = error instanceof ApiError ? error.code : "request_failed";
          const errorMessage = error instanceof ApiError ? error.message : undefined;
          setState({ error: code, errorMessage, loading: false });
        }
      },
    );
    return () => controller.abort();
  }, [key, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { ...state, refresh };
}
