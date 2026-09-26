import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";

import {
  PlatformApiError,
  platformApi,
  type CompanySession,
  type CompanyUser,
  type SetupLink,
  type UserDeletionEligibility,
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
  const [sessionsForUsername, setSessionsForUsername] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<readonly CompanySession[] | undefined>(undefined);
  const [sessionsError, setSessionsError] = useState(false);
  /**
   * `deletionTarget` is set SYNCHRONOUSLY on click, before the eligibility
   * request even starts. That is what makes the panel appear the instant
   * someone clicks Delete, in a loading state naming the row they clicked --
   * rather than only appearing once the network call resolves, by which point
   * a click on any row but the last had already scrolled out of the area the
   * click happened in.
   *
   * The error from a failed eligibility check is kept SEPARATE from the
   * page's general `error` banner. That banner sits at the top of the page,
   * so a deletion attempted on a row far down the Administrators table would
   * show its error a screen-height away from the click that caused it --
   * exactly the same defect as the confirmation panel, in the other
   * direction. `deletionError` renders inside the same anchored panel as
   * everything else about this action.
   */
  const [deletionTarget, setDeletionTarget] = useState<CompanyUser | undefined>(undefined);
  const [deletion, setDeletion] = useState<UserDeletionEligibility | undefined>(undefined);
  const [deletionLoading, setDeletionLoading] = useState(false);
  const [deletionError, setDeletionError] = useState<string | undefined>(undefined);
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [deletionSuccessMessage, setDeletionSuccessMessage] = useState<string | undefined>(
    undefined,
  );
  const deletionPanelRef = useRef<HTMLElement>(null);

  // Scrolls the panel into view the moment a target is chosen -- on the
  // click, not on the response -- so it is visible regardless of which row
  // in the table was clicked or how long the eligibility check takes.
  useEffect(() => {
    if (deletionTarget === undefined) return;
    // Not just an optional element -- `scrollIntoView` itself is absent in
    // jsdom, so the method is checked directly rather than only the ref.
    const panel = deletionPanelRef.current;
    if (typeof panel?.scrollIntoView === "function") {
      panel.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [deletionTarget]);

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

  async function loadSessions(accountId: string): Promise<void> {
    setSessions(undefined);
    setSessionsError(false);
    try {
      setSessions(await platformApi.userSessions(companyId, accountId));
    } catch {
      setSessions([]);
      setSessionsError(true);
    }
  }

  function showSessions(user: CompanyUser): void {
    setSessionsFor(user.accountId);
    setSessionsForUsername(user.username);
    void loadSessions(user.accountId);
  }

  function formatSessionDate(value: string | null, includeDate = true): string {
    if (value === null || value.trim() === "") return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const iso = date.toISOString();
    return includeDate ? iso.slice(0, 19).replace("T", " ") : iso.slice(11, 19);
  }

  async function inspectDeletion(user: CompanyUser): Promise<void> {
    // Set BEFORE the request, not after: this is what makes the panel appear
    // on the click rather than on the response, in a "checking" state that
    // already names the user, so there is a visible reaction to the click no
    // matter how slow or fast the network is.
    setDeletionTarget(user);
    setDeletion(undefined);
    setDeletionError(undefined);
    setDeletionSuccessMessage(undefined);
    setDeletionConfirmation("");
    setDeletionLoading(true);
    try {
      setDeletion(await platformApi.userDeletionEligibility(companyId, user.accountId));
    } catch {
      // A normal `eligible: false` result never reaches here -- it is a 200
      // response, not a thrown error. This branch is reserved for a check
      // that could not be completed at all: the request failed, or the
      // server itself errored. The message is fixed rather than the raw
      // server text -- unlike a genuine business-rule outcome (eligible or
      // blocked, both explained by the server), a failed CHECK should not
      // surface backend internals, and a fixed message is one less thing
      // that needs translating or auditing for leakage later.
      setDeletionError("Unable to check whether this user can be deleted.");
    } finally {
      setDeletionLoading(false);
    }
  }

  async function executeDeletion(): Promise<void> {
    if (deletionTarget === undefined || deletion === undefined) return;
    setBusy(true);
    setDeletionError(undefined);
    try {
      await platformApi.deleteUser(companyId, deletion.accountId, deletionConfirmation);
      setDeletionTarget(undefined);
      setDeletion(undefined);
      setDeletionConfirmation("");
      setDeletionSuccessMessage("User deleted successfully.");
      await load();
      // Deleting an Administrator can change whether the Company still has
      // one, which the readiness panel above this section reports.
      onChanged();
    } catch (failure) {
      // Eligibility can change between the preview and this click -- another
      // administrator's action, a role change, a new record for this user.
      // The server re-checks at commit time and this is that check's real
      // answer, which is more useful than a generic retry prompt would be.
      setDeletionError(
        failure instanceof PlatformApiError
          ? failure.message
          : "User could not be deleted because dependencies changed. Refresh and try again.",
      );
    } finally {
      setBusy(false);
    }
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
                      onClick={() => showSessions(user)}
                      type="button"
                    >
                      Sessions
                    </button>
                    <button
                      className="platform-button platform-button--quiet"
                      disabled={busy || deletionLoading}
                      onClick={() => void inspectDeletion(user)}
                      type="button"
                    >
                      Delete user
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {sessionsFor === undefined ? null : (
        <section aria-labelledby="company-user-sessions-heading">
          <h4 id="company-user-sessions-heading">Sessions</h4>
          <p className="platform-muted">User: {sessionsForUsername ?? "Selected user"}</p>
          {sessions === undefined ? (
            <p role="status">Loading sessions...</p>
          ) : sessionsError ? (
            <div role="alert">
              <p>Unable to load sessions.</p>
              <button
                className="platform-button platform-button--quiet"
                onClick={() => void loadSessions(sessionsFor)}
                type="button"
              >
                Retry
              </button>
            </div>
          ) : sessions.length === 0 ? (
            <p className="platform-muted">No sessions found for this user.</p>
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
                      {formatSessionDate(entry.createdAt)}
                    </td>
                    <td>
                      {formatSessionDate(entry.lastSeenAt, false)}
                    </td>
                    <td>
                      {formatSessionDate(entry.expiresAt)}
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
                                await loadSessions(sessionsFor);
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
                    await loadSessions(sessionsFor);
                  });
                }}
                type="button"
              >
                Revoke all sessions
              </button>
            ) : null}
            <button
              className="platform-button platform-button--quiet"
              onClick={() => {
                setSessionsFor(undefined);
                setSessionsForUsername(undefined);
                setSessions(undefined);
                setSessionsError(false);
              }}
              type="button"
            >
              Close
            </button>
          </div>
        </section>
      )}

      {deletionSuccessMessage === undefined ? null : (
        <p className="platform-linkbox" role="status">
          {deletionSuccessMessage}
        </p>
      )}

      {/*
        ONE panel, ONE place, for every state this action can be in --
        checking, failed-to-check, blocked, or eligible. Anchored by
        `deletionPanelRef` and scrolled into view the instant a row's Delete
        button is clicked (see the effect above), so the panel is where the
        click happened rather than wherever it falls in the page's fixed
        layout. Point 2's four expected outcomes and point 14's "visible near
        the action" are the same requirement seen from two directions, and
        this is the one structure that satisfies both: exactly one visible
        state is reachable from a click, and it is always in the same,
        findable place.
      */}
      {deletionTarget === undefined ? null : (
        <section aria-labelledby="user-deletion-heading" ref={deletionPanelRef}>
          <h4 id="user-deletion-heading">
            Delete user: {deletionTarget.displayName ?? deletionTarget.username}
          </h4>

          {deletionLoading ? (
            <p role="status">
              Checking whether {deletionTarget.username} can be deleted…
            </p>
          ) : deletionError !== undefined ? (
            <div role="alert">
              <p>{deletionError}</p>
              <div className="platform-actions">
                <button
                  className="platform-button platform-button--quiet"
                  onClick={() => void inspectDeletion(deletionTarget)}
                  type="button"
                >
                  Retry
                </button>
                <button
                  className="platform-button platform-button--quiet"
                  onClick={() => setDeletionTarget(undefined)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : deletion === undefined ? null : deletion.eligible ? (
            <>
              <dl className="platform-detail-list">
                <dt>User Name</dt>
                <dd>{deletion.displayName ?? deletion.username}</dd>
                <dt>Username/login</dt>
                <dd>{deletion.username}</dd>
                <dt>Company</dt>
                <dd>{deletion.companyName}</dd>
                <dt>Role</dt>
                <dd>{deletionTarget.roles.join(", ") || "—"}</dd>
              </dl>
              <p role="alert">This permanently deletes the user account.</p>
              <p>
                To permanently delete this user, type exactly:{" "}
                <code>{deletion.confirmationChallenge}</code>
              </p>
              <label className="platform-field" htmlFor="delete-user-confirmation">
                <span>Confirmation</span>
                <input
                  autoComplete="off"
                  id="delete-user-confirmation"
                  onChange={(event) => setDeletionConfirmation(event.target.value)}
                  placeholder={deletion.confirmationChallenge}
                  value={deletionConfirmation}
                />
              </label>
              {deletionConfirmation.length === 0 ||
              deletionConfirmation === deletion.confirmationChallenge ? null : (
                <p className="platform-warning" role="alert">
                  Confirmation does not match. Type <code>{deletion.confirmationChallenge}</code>{" "}
                  exactly.
                </p>
              )}
              <div className="platform-actions">
                <button
                  className="platform-button platform-button--quiet"
                  disabled={busy}
                  onClick={() => setDeletionTarget(undefined)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="platform-button"
                  disabled={busy || deletionConfirmation !== deletion.confirmationChallenge}
                  onClick={() => void executeDeletion()}
                  title={
                    deletionConfirmation === deletion.confirmationChallenge
                      ? undefined
                      : `Type ${deletion.confirmationChallenge} exactly to enable this button`
                  }
                  type="button"
                >
                  Permanently Delete User
                </button>
              </div>
            </>
          ) : (
            <>
              <dl className="platform-detail-list">
                <dt>User Name</dt>
                <dd>{deletion.displayName ?? deletion.username}</dd>
                <dt>Username/login</dt>
                <dd>{deletion.username}</dd>
                <dt>Company</dt>
                <dd>{deletion.companyName}</dd>
                <dt>Role</dt>
                <dd>{deletionTarget.roles.join(", ") || "—"}</dd>
              </dl>
              <p role="alert">{deletion.reason}</p>
              {(deletion.blockingCategories ?? []).length === 0 ? null : (
                <ul>
                  {(deletion.blockingCategories ?? []).map((blocker) => (
                    <li key={blocker.category}>
                      {blocker.category}: {blocker.rows}
                    </li>
                  ))}
                </ul>
              )}
              <p className="platform-muted">
                Recommended action: {deletion.recommendedAction === "deactivate" ? "Deactivate" : "—"}
              </p>
              <button
                className="platform-button platform-button--quiet"
                onClick={() => setDeletionTarget(undefined)}
                type="button"
              >
                Cancel
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}
