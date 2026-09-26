import { useState } from "react";
import type { FormEvent, ReactElement } from "react";

import { PlatformApiError } from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";
import { platformConfiguration } from "../config/environment.js";

/**
 * Platform sign-in.
 *
 * ---------------------------------------------------------------------------
 * NO COMPANY SELECTOR
 * ---------------------------------------------------------------------------
 *
 * A Platform Administrator belongs to no Company — the database constraint
 * makes any other state impossible — so there is nothing to choose. Offering a
 * Company field here would also be actively harmful: it would suggest the
 * chosen Company is what grants access, when the Company a Platform action
 * targets is resolved server-side, later, and separately.
 *
 * The Company Portal's own sign-in has no Company field either; it takes the
 * tenant from the request host. Neither screen has ever asked the browser which
 * tenant it would like to be.
 */
export function PlatformLoginPage(): ReactElement {
  const session = usePlatformSession();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      await session.signIn(identifier, password);
    } catch (failure) {
      // Deliberately one message for every failure mode. Distinguishing
      // "no such account" from "wrong password" — or naming a Company account
      // that tried to sign in here — would turn this form into a directory.
      setError(
        failure instanceof PlatformApiError && failure.status >= 500
          ? "The Platform is unavailable. Try again shortly."
          : "The sign-in details are not valid for Platform Administration.",
      );
      setSubmitting(false);
    }
  }

  return (
    <main className="platform-login">
      <form className="platform-login__card" onSubmit={(event) => void submit(event)}>
        <p className="platform-login__eyebrow">TawseelHub</p>
        <h1 className="platform-login__title">Platform Administration</h1>
        <p className="platform-login__subtitle">{platformConfiguration.siteName}</p>

        <label className="platform-field" htmlFor="platform-identifier">
          <span>Username</span>
          <input
            autoComplete="username"
            id="platform-identifier"
            name="identifier"
            onChange={(event) => setIdentifier(event.target.value)}
            required
            type="text"
            value={identifier}
          />
        </label>

        <label className="platform-field" htmlFor="platform-password">
          <span>Password</span>
          <input
            autoComplete="current-password"
            id="platform-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>

        {error === undefined ? null : (
          <p className="platform-login__error" role="alert">
            {error}
          </p>
        )}

        <button className="platform-button" disabled={submitting} type="submit">
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
