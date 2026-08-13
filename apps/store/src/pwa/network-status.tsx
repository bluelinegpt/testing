import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Reusable network-status abstraction -- Prompt 3D §24-26.
 *
 * ---------------------------------------------------------------------------
 * WHY "OFFLINE" IS ITS OWN STATE, NOT JUST ANOTHER API ERROR
 * ---------------------------------------------------------------------------
 *
 * `navigator.onLine` reflects the DEVICE's network interface, not whether
 * any particular request will succeed -- but it is the only signal that
 * distinguishes "you have no connection" from "the API returned an error"
 * (§24: "do not equate every API error with offline"). Pages already have
 * their own honest failure states (`CommerceFailure`'s `not_found` vs
 * `unavailable`, this prompt's `MessageState onRetry`); this module adds the
 * one thing they cannot see on their own -- the browser's own connectivity
 * signal -- as a small global banner, not a blocking modal (§25).
 */
export type NetworkStatus = "offline" | "online";

const NetworkStatusContext = createContext<NetworkStatus>("online");

export function NetworkStatusProvider({ children }: { readonly children: ReactNode }) {
  const [status, setStatus] = useState<NetworkStatus>(() =>
    typeof navigator === "undefined" || navigator.onLine ? "online" : "offline",
  );

  useEffect(() => {
    const goOnline = () => setStatus("online");
    const goOffline = () => setStatus("offline");
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return <NetworkStatusContext.Provider value={status}>{children}</NetworkStatusContext.Provider>;
}

export function useNetworkStatus(): NetworkStatus {
  return useContext(NetworkStatusContext);
}
