import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { ApiClient, ApiError } from "../../api/api-client.js";

/**
 * Where a Company user establishes their own password.
 *
 * This is the Company-facing end of a link a Platform Administrator issued.
 * It is deliberately here and not in the Platform Portal: the Platform manages
 * the account, the person owns the credential, and the two must never be the
 * same screen.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN IS NEVER PERSISTED
 * ---------------------------------------------------------------------------
 *
 * It is read from the URL, held in a variable, and used. Nothing writes it to
 * `localStorage`, `sessionStorage` or a cookie. On success the URL is replaced
 * so a browser-history entry does not carry a working credential link, and the
 * person is sent to the ordinary sign-in page to use the password they just
 * chose.
 */
interface Described {
  readonly displayName: string;
  readonly username: string;
  readonly companyName: string;
  readonly purpose: "activation" | "reset";
}

export function AccountSetupView({ token }: { token: string }) {
  const [api] = useState(() => new ApiClient());
  const [described, setDescribed] = useState<Described | undefined>();
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .post<Described>("auth/account-setup/describe", { token })
      .then((result) => {
        if (!cancelled) setDescribed(result);
      })
      .catch(() => {
        if (!cancelled) setInvalid(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    if (password !== confirmation) {
      setError("The two passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("auth/account-setup/complete", { password, token });
      // Remove the token from the address bar and from history before anything
      // else happens.
      globalThis.history?.replaceState(null, "", "/");
      setDone(true);
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : "The password could not be set. Ask your administrator for a new link.",
      );
      setSubmitting(false);
    }
  }

  if (invalid) {
    return (
      <main className="account-setup">
        <h1>This link is no longer valid</h1>
        <p>
          It may have expired, already been used, or been replaced by a newer one. Ask your
          administrator for a new link.
        </p>
        <a href="/">Go to sign in</a>
      </main>
    );
  }

  if (done) {
    return (
      <main className="account-setup">
        <h1>Password set</h1>
        <p>You can now sign in with your new password.</p>
        <a href="/">Go to sign in</a>
      </main>
    );
  }

  if (described === undefined) {
    return (
      <main className="account-setup">
        <p>Checking your link…</p>
      </main>
    );
  }

  return (
    <main className="account-setup">
      <h1>{described.purpose === "activation" ? "Set your password" : "Choose a new password"}</h1>
      <p>
        {described.displayName} · {described.username} · {described.companyName}
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="account-setup-password">
          <span>New password</span>
          <input
            autoComplete="new-password"
            id="account-setup-password"
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        <label htmlFor="account-setup-confirm">
          <span>Confirm password</span>
          <input
            autoComplete="new-password"
            id="account-setup-confirm"
            minLength={8}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            type="password"
            value={confirmation}
          />
        </label>
        {error === undefined ? null : <p role="alert">{error}</p>}
        <button disabled={submitting} type="submit">
          {submitting ? "Saving…" : "Set password"}
        </button>
      </form>
    </main>
  );
}
