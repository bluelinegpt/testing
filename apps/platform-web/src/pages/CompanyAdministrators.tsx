import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactElement } from "react";

import {
  PlatformApiError,
  platformApi,
  type CompanySession,
  type CompanyUser,
  type SetupLink,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

/**
 * Company administrators and account support.
 *
 * An onboarding and support surface, not a replacement for the Company
 * portal's own user administration. It exists because a Company with no users
 * has nobody who could open that portal.
 *
 * ---------------------------------------------------------------------------
 * THE LINK IS SHOWN ONCE AND KEPT NOWHERE
 * ---------------------------------------------------------------------------
 *
 * A credential link lives in component state and dies with the component. It is
 * never written to `localStorage` or `sessionStorage`, never re-fetched, and
 * never appears in the user list or the audit trail. If it is lost the correct
 * action is to issue a new one — which revokes the old one, so a mislaid link
 * stops working rather than lingering.
 */
export function CompanyAdministrators({
  companyId,
  onChanged,
}: {
  companyId: string;
  onChanged: () => void;
}): ReactElement {
  const session = usePlatformSession();
  const canManage = session.can("platform.users.manage");
  const canRead = session.can("platform.users.read");

  const [users, setUsers] = useState<readonly CompanyUser[] | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [link, setLink] = useState<(SetupLink & { forUser: string }) | undefined>(undefined);
  const [sessionsFor, setSessionsFor] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<readonly CompanySession[]>([]);

  const load = useCallback(async () => {
    if (!canRead) return;
    try {
      setUsers(await platformApi.companyUsers(companyId));
    } catch {
      setUsers([]);
    }
  }, [companyId, canRead]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canRead) {
    // The heading still renders: the section exists, the caller simply cannot
    // see inside it. Hiding it entirely would look like the Company has no
    // administrators at all.
    return (
      <>
        <h3>Administrators</h3>
        <p className="platform-muted">
          Viewing Company users requires the <code>platform.users.read</code> permission.
        </p>
      </>
    );
  }

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      await load();
      onChanged();
    } catch (failure) {
      setError(
        failure instanceof PlatformApiError
          ? failure.message
          : "The action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      const created = await platformApi.createAdministrator(companyId, {
        displayName: String(form.get("displayName") ?? ""),
        username: String(form.get("username") ?? ""),
        email: String(form.get("email") ?? ""),
        mobileNumber: String(form.get("mobileNumber") ?? ""),
        preferredLanguage: String(form.get("preferredLanguage") ?? "en"),
      });
      setLink({ ...created, forUser: String(form.get("username") ?? "") });
      setCreating(false);
    });
  }

  async function issue(user: CompanyUser, kind: "activation" | "password-reset"): Promise<void> {
    const prompt =
      kind === "activation"
        ? `Create a new activation link for ${user.username}? Any existing link stops working.`
        : `Create a password-reset link for ${user.username}? This ends their active sessions.`;
    if (!globalThis.confirm(prompt)) return;
    await run(async () => {
      setLink({
        ...(await platformApi.issueSetupLink(companyId, user.accountId, kind)),
        forUser: user.username,
      });
    });
  }

  async function act(
    user: CompanyUser,
    action: "unlock" | "deactivate" | "reactivate",
  ): Promise<void> {
    const prompts: Record<typeof action, string> = {
      unlock: `Unlock ${user.username}?`,
      deactivate: `Deactivate ${user.username} and revoke its active sessions?`,
      reactivate: `Reactivate ${user.username}?`,
    };
    if (!globalThis.confirm(prompts[action])) return;
    let reason: string | undefined;
    if (action !== "unlock") {
      const entered = globalThis.prompt(`Reason for ${action}:`);
      if (entered === null || entered.trim().length < 3) return;
      reason = entered.trim();
    }
    await run(() => platformApi.userAction(companyId, user.accountId, action, reason));
  }

  async function showSessions(user: CompanyUser): Promise<void> {
    setSessionsFor(user.accountId);
    setSessions(await platformApi.userSessions(companyId, user.accountId));
  }

  return (
    <>
      <div className="platform-panel__header">
        <h3>Administrators</h3>
        {canManage && !creating ? (
          <button
            className="platform-button"
            onClick={() => {
              // Clearing the error here matters more than it looks. Without it
              // a failure from ANY earlier action stays on screen through
              // opening and closing this form, so a stale message is
              // indistinguishable from a fresh failure -- including when the
              // request never left the browser at all.
              setError(undefined);
              setCreating(true);
            }}
            type="button"
          >
            Create Company Administrator
          </button>
        ) : null}
      </div>

      {error === undefined ? null : (
        <p className="platform-login__error" role="alert">
          {error}
        </p>
      )}

      {link === undefined ? null : (
        <div className="platform-linkbox" role="status">
          <strong>One-time setup link for {link.forUser}</strong>
          <p className="platform-muted">
            Shown once and not stored anywhere. Send it to the administrator through a channel you
            trust. It expires{" "}
            {new Date(link.expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC, can be used
            once, and is replaced if you issue another.
          </p>
          <code className="platform-link">{link.setupUrl}</code>
          <div className="platform-actions">
            <button
              className="platform-button platform-button--quiet"
              onClick={() => void globalThis.navigator.clipboard?.writeText(link.setupUrl)}
              type="button"
            >
              Copy link
            </button>
            <button
              className="platform-button platform-button--quiet"
              onClick={() => setLink(undefined)}
              type="button"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {creating ? (
        <form className="platform-form" onSubmit={(event) => void create(event)}>
          {/*
            One Name field, which may hold Arabic or English - the product's
            established rule. No role or permission input: the server selects
            the Company Administrator role, and the request has no field for one.
          */}
          <label className="platform-field" htmlFor="admin-displayName">
            <span>Name</span>
            <input id="admin-displayName" name="displayName" required type="text" />
          </label>
          <label className="platform-field" htmlFor="admin-username">
            <span>Username</span>
            <input id="admin-username" name="username" required type="text" />
          </label>
          <label className="platform-field" htmlFor="admin-email">
            <span>Email</span>
            <input id="admin-email" name="email" required type="email" />
          </label>
          <div className="platform-field-group">
            <label className="platform-field" htmlFor="admin-mobileNumber">
              <span>Mobile</span>
              <input
                aria-describedby="admin-mobile-hint"
                id="admin-mobileNumber"
                name="mobileNumber"
                required
                type="text"
              />
            </label>
            <small className="platform-muted" id="admin-mobile-hint">
              UAE mobile, for example 0506468442.
            </small>
          </div>
          <label className="platform-field" htmlFor="admin-preferredLanguage">
            <span>Language</span>
            <select defaultValue="en" id="admin-preferredLanguage" name="preferredLanguage">
              <option value="en">en</option>
              <option value="ar">ar</option>
            </select>
          </label>
          <p className="platform-muted">
            No password is set here. The administrator receives a one-time link and chooses their
            own.
          </p>
          <div className="platform-actions">
            <button
              className="platform-button platform-button--quiet"
              onClick={() => {
                setError(undefined);
                setCreating(false);
              }}
              type="button"
            >
              Cancel
            </button>
            <button className="platform-button" disabled={busy} type="submit">
              {busy ? "Creating…" : "Create administrator"}
            </button>
          </div>
        </form>
      ) : null}

      {users === undefined ? (
        <p>Loading…</p>
      ) : users.length === 0 ? (
        <p className="platform-muted">No Company Administrator configured</p>
      ) : (
        <table className="platform-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Username</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Last login</th>
              <th scope="col">Created</th>
              {canManage ? <th scope="col">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.accountId}>
                <td>{user.displayName ?? "—"}</td>
                <td>{user.username}</td>
                <td>{user.roles.join(", ") || "—"}</td>
                <td>
                  <span className={`platform-badge platform-badge--${user.state}`}>
                    {user.state.replace(/_/g, " ")}
                  </span>
                  {user.failedLoginAttempts > 0 ? (
                    <span className="platform-muted"> · {user.failedLoginAttempts} failed</span>
                  ) : null}
                </td>
                <td>
                  {user.lastLoginAt === null
                    ? "—"
                    : new Date(user.lastLoginAt).toISOString().slice(0, 10)}
                </td>
                <td>{new Date(user.createdAt).toISOString().slice(0, 10)}</td>
                {canManage ? (
                  <td className="platform-rowactions">
                    {/* Only actions that make sense for the current state. */}
                    {user.state === "invitation_pending" ? (
                      <button
                        className="platform-button platform-button--quiet"
                        disabled={busy}
                        onClick={() => void issue(user, "activation")}
                        type="button"
                      >
                        Activation link
                      </button>
                    ) : null}
                    {user.state !== "disabled" ? (
                      <button
                        className="platform-button platform-button--quiet"
                        disabled={busy}
                        onClick={() => void issue(user, "password-reset")}
                        type="button"
                      >
                        Password reset
                      </button>
                    ) : null}
                    {user.state === "locked" ? (
                      <button
                        className="platform-button platform-button--quiet"
                        disabled={busy}
                        onClick={() => void act(user, "unlock")}
                        type="button"
                      >
                        Unlock
                      </button>
                    ) : null}
                    {user.state === "disabled" ? (
                      <button
                        className="platform-button platform-button--quiet"
                        disabled={busy}
                        onClick={() => void act(user, "reactivate")}
                        type="button"
                      >
                        Reactivate
                      </button>
                    ) : (
                      <button
                        className="platform-button platform-button--quiet"
                        disabled={busy}
                        onClick={() => void act(user, "deactivate")}
                        type="button"
                      >
                        Deactivate
                      </button>
                    )}
                    <button
                      className="platform-button platform-button--quiet"
                      disabled={busy}
                      onClick={() => void showSessions(user)}
                      type="button"
                    >
                      Sessions
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {sessionsFor === undefined ? null : (
        <>
          <h4>Sessions</h4>
          {sessions.length === 0 ? (
            <p className="platform-muted">No sessions recorded.</p>
          ) : (
            <table className="platform-table">
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Device</th>
                  <th scope="col">State</th>
                  {canManage ? <th scope="col">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {sessions.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {new Date(entry.createdAt).toISOString().slice(0, 19).replace("T", " ")}
                    </td>
                    <td>
                      {entry.lastSeenAt === null
                        ? "—"
                        : new Date(entry.lastSeenAt).toISOString().slice(11, 19)}
                    </td>
                    <td>
                      {new Date(entry.expiresAt).toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="platform-truncate">{entry.userAgent ?? "—"}</td>
                    <td>{entry.revokedAt === null ? "active" : "revoked"}</td>
                    {canManage ? (
                      <td>
                        {entry.revokedAt === null ? (
                          <button
                            className="platform-button platform-button--quiet"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await platformApi.revokeSession(companyId, sessionsFor, entry.id);
                                setSessions(await platformApi.userSessions(companyId, sessionsFor));
                              })
                            }
                            type="button"
                          >
                            Revoke
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="platform-actions">
            {canManage ? (
              <button
                className="platform-button platform-button--quiet"
                disabled={busy}
                onClick={() => {
                  if (!globalThis.confirm("Revoke all active sessions for this user?")) return;
                  void run(async () => {
                    await platformApi.revokeAllSessions(companyId, sessionsFor);
                    setSessions(await platformApi.userSessions(companyId, sessionsFor));
                  });
                }}
                type="button"
              >
                Revoke all sessions
              </button>
            ) : null}
            <button
              className="platform-button platform-button--quiet"
              onClick={() => setSessionsFor(undefined)}
              type="button"
            >
              Close
            </button>
          </div>
        </>
      )}
    </>
  );
}
