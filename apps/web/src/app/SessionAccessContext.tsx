import { createContext, useContext, type ReactNode } from "react";

/**
 * The Company, the User's permissions and the navigator, available to any
 * screen without threading them through every intermediate component.
 *
 * This exists for cross-module panels — Related Records is the first — that are
 * dropped into deeply nested dialogs which have no reason to know about
 * permissions or routing. It carries no session secrets: only the Company
 * identifier used to scope query caches and the permission list the shell
 * already uses for menu and route gating. The backend remains the authority on
 * every request.
 *
 * `companyId` also acts as the cache boundary: consumers key their data on it,
 * so switching Company can never show another Company's records.
 */
export interface SessionAccess {
  readonly companyId: string;
  readonly navigate: (path: string) => void;
  readonly permissions: readonly string[];
}

const SessionAccessContext = createContext<SessionAccess | undefined>(undefined);

export function SessionAccessProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: SessionAccess;
}) {
  return <SessionAccessContext.Provider value={value}>{children}</SessionAccessContext.Provider>;
}

/**
 * Returns the session access values, or `undefined` outside the provider.
 * Callers degrade gracefully rather than throwing, so a component rendered in
 * a test harness or a standalone story cannot crash the page.
 */
export function useSessionAccess(): SessionAccess | undefined {
  return useContext(SessionAccessContext);
}
