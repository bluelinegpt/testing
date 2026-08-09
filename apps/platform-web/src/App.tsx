import type { ReactElement } from "react";

import { usePlatformSession } from "./app/PlatformSession.js";
import { PlatformLoginPage } from "./pages/PlatformLoginPage.js";
import { PlatformShell } from "./pages/PlatformShell.js";

/**
 * The Portal has exactly two states, and the server decides which.
 *
 * There is no "protected route" wrapper that a component could forget to use:
 * an unauthenticated session renders the sign-in page and nothing else is
 * mounted, so no protected screen can exist in a state where it might slip
 * through. `loading` is rendered rather than skipped because assuming
 * "anonymous" while `/platform/auth/me` is still in flight would flash the
 * sign-in form at an administrator who is, in fact, signed in.
 */
export function App(): ReactElement {
  const session = usePlatformSession();

  if (session.status === "loading") {
    return (
      <main className="platform-loading">
        <p>Checking your Platform session…</p>
      </main>
    );
  }

  return session.status === "authenticated" ? <PlatformShell /> : <PlatformLoginPage />;
}
