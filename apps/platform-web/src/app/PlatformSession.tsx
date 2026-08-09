import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { platformApi, type PlatformIdentity } from "../api/platform-client.js";

/**
 * Platform session state, held in memory only.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NOTHING TO RESTORE FROM
 * ---------------------------------------------------------------------------
 *
 * A reload throws this state away. It is rebuilt by asking the API who the
 * caller is — `GET /platform/auth/me` — which succeeds because the browser
 * still holds the HttpOnly session cookie. Nothing is read from, or written to,
 * `localStorage`, `sessionStorage` or IndexedDB.
 *
 * That inversion is the whole point. The server is the only place a session
 * exists, so revoking it server-side signs the administrator out everywhere at
 * once, and a stale tab cannot resurrect a session by replaying something it
 * cached.
 */
export type SessionStatus = "loading" | "authenticated" | "anonymous";

export interface PlatformSession {
  readonly status: SessionStatus;
  readonly identity: PlatformIdentity | undefined;
  readonly can: (permission: string) => boolean;
  readonly signIn: (identifier: string, password: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const SessionContext = createContext<PlatformSession | undefined>(undefined);

export function PlatformSessionProvider({ children }: { children: ReactNode }): ReactElement {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [identity, setIdentity] = useState<PlatformIdentity | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void platformApi
      .me()
      .then((current) => {
        if (cancelled) return;
        setIdentity(current);
        setStatus("authenticated");
      })
      .catch(() => {
        if (cancelled) return;
        // Any failure here — 401, 403, network — means "not signed in". The
        // Portal must not guess otherwise: showing a shell to someone the
        // server will refuse produces a screen of failed requests.
        setIdentity(undefined);
        setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (login: string, password: string) => {
    const next = await platformApi.login(login, password);
    setIdentity(next);
    setStatus("authenticated");
  }, []);

  const signOut = useCallback(async () => {
    try {
      await platformApi.logout();
    } finally {
      // Local state is cleared even if the call failed. The server session is
      // the authority, and leaving the shell rendered after a sign-out attempt
      // is worse than showing the sign-in page one request early.
      setIdentity(undefined);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo<PlatformSession>(
    () => ({
      status,
      identity,
      // Permission checks here decide what to RENDER, never what is allowed.
      // Every route is enforced again by the API, which is the only boundary
      // that counts.
      can: (permission: string) => identity?.permissions.includes(permission) === true,
      signIn,
      signOut,
    }),
    [identity, signIn, signOut, status],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function usePlatformSession(): PlatformSession {
  const session = useContext(SessionContext);
  if (session === undefined) {
    throw new Error("usePlatformSession must be used inside PlatformSessionProvider");
  }
  return session;
}
