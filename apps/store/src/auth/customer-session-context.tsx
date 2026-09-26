import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { fetchCustomerSession, type CustomerSession } from "../api/customer-auth-client.js";

/**
 * Whether the Store's cookie-based Customer session is signed in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CONTEXT, NOT A ROUTE-LEVEL LOADER
 * ---------------------------------------------------------------------------
 *
 * Both the header (Sign In vs My Account — §52) and the `/account` route
 * guard (§51) need to know the current auth state, and the header renders
 * on every page, not only `/account`. One shared session check avoids two
 * independent `me` calls racing each other on first paint.
 *
 * `status: "loading"` is a real, distinct state (not folded into
 * "anonymous"): the header must not flash "Sign In" for a page load and
 * then jump to "My Account" a moment later just because the `me` call
 * hadn't resolved yet.
 */
export type CustomerSessionState =
  | { readonly status: "anonymous" }
  | { readonly status: "authenticated"; readonly customer: CustomerSession }
  | { readonly status: "loading" };

interface CustomerSessionContextValue {
  readonly refresh: () => Promise<void>;
  readonly session: CustomerSessionState;
  readonly setSession: (customer: CustomerSession | null) => void;
}

const CustomerSessionContext = createContext<CustomerSessionContextValue | undefined>(undefined);

export function CustomerSessionProvider({ children }: { readonly children: ReactNode }) {
  const [session, setSessionState] = useState<CustomerSessionState>({ status: "loading" });

  const refresh = useCallback(async () => {
    const result = await fetchCustomerSession();
    setSessionState(
      result.kind === "ok" ? { customer: result.value, status: "authenticated" } : { status: "anonymous" },
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setSession = useCallback((customer: CustomerSession | null) => {
    setSessionState(customer === null ? { status: "anonymous" } : { customer, status: "authenticated" });
  }, []);

  const value = useMemo(() => ({ refresh, session, setSession }), [refresh, session, setSession]);

  return <CustomerSessionContext.Provider value={value}>{children}</CustomerSessionContext.Provider>;
}

export function useCustomerSession(): CustomerSessionContextValue {
  const context = useContext(CustomerSessionContext);
  if (context === undefined) {
    throw new Error("useCustomerSession must be used within a CustomerSessionProvider");
  }
  return context;
}
