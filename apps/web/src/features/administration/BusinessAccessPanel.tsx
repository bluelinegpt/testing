import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";

type Kind = "employee" | "driver" | "trader";
type AccessRow = Record<string, unknown> & {
  id: string;
  accountId: string;
  accessStatus: string;
};
type EligibleUser = {
  accountId: string;
  accountKind: string;
  displayName: string;
  username: string;
};
type RoleOption = { id: string; name: string };
type TemporaryCredentials = { password: string; username: string };

const idempotencyKey = (operation: string) => `${operation}:${crypto.randomUUID()}`;

export function BusinessAccessPanel({
  api,
  entityId,
  kind,
  onNavigate,
  profileCode,
  profileMobileNumber,
  profileName,
}: {
  readonly api: ApiClient;
  readonly entityId: string;
  readonly kind: Kind;
  readonly onNavigate: (path: string) => void;
  readonly profileCode?: string | undefined;
  readonly profileMobileNumber?: string;
  readonly profileName?: string | undefined;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly AccessRow[]>([]);
  const [users, setUsers] = useState<readonly EligibleUser[]>([]);
  const [roles, setRoles] = useState<readonly RoleOption[]>([]);
  const [accountId, setAccountId] = useState("");
  const [creating, setCreating] = useState(false);
  const [employeeRoleIds, setEmployeeRoleIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [temporaryCredentials, setTemporaryCredentials] = useState<TemporaryCredentials>();
  const [error, setError] = useState<string>();
  const message = (cause: unknown, fallback: string) =>
    cause instanceof ApiError
      ? t(`access.errors.codes.${cause.code}`, { defaultValue: cause.message || fallback })
      : fallback;
  const base =
    kind === "trader"
      ? `configuration/traders/${entityId}/portal-users`
      : `configuration/${kind}s/${entityId}/system-access`;

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [links, eligible, rolePage] = await Promise.all([
        api.get<readonly AccessRow[]>(base),
        kind === "trader"
          ? Promise.resolve([] as readonly EligibleUser[])
          : api.get<readonly EligibleUser[]>(`${base}/eligible-users`),
        kind === "employee"
          ? api.get<{ items: readonly RoleOption[] }>("roles?page=1&pageSize=100&status=active")
          : Promise.resolve({ items: [] as readonly RoleOption[] }),
      ]);
      setRows(links);
      setUsers(eligible);
      setRoles(rolePage.items);
    } catch (cause) {
      setError(message(cause, t("access.errors.load")));
    }
  }, [api, base, kind, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const link = async () => {
    if (!accountId) return;
    try {
      await api.post(
        kind === "trader" ? `${base}/link` : `${base}/link-user`,
        { accountId },
        { "X-Idempotency-Key": idempotencyKey(`${kind}-link`) },
      );
      setAccountId("");
      await load();
    } catch (cause) {
      setError(message(cause, t("access.errors.action")));
    }
  };

  const createTraderPortalUser = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const response = await api.post<{
        temporaryPassword: string;
        username: string;
      }>(`${base}/create`, {}, { "X-Idempotency-Key": idempotencyKey("trader-portal-create") });
      setTemporaryCredentials({
        password: response.temporaryPassword,
        username: response.username,
      });
      await load();
    } catch (cause) {
      setError(message(cause, t("access.errors.action")));
    } finally {
      setSaving(false);
    }
  };

  const employeeUsername = (profileMobileNumber ?? "").replace(/\D/g, "");
  const employeeCreationRoles = roles.filter((role) => {
    const name = role.name.trim().toLowerCase();
    return name === "company administrator" || name === "orders";
  });
  const createEmployeeUser = async () => {
    if (!employeeUsername || employeeRoleIds.length === 0) return;
    setSaving(true);
    setError(undefined);
    try {
      const response = await api.post<{ temporaryPassword: string }>(
        `${base}/create-user`,
        {
          displayName: profileName ?? employeeUsername,
          preferredLanguage: "en",
          roleIds: employeeRoleIds,
          username: employeeUsername,
        },
        { "X-Idempotency-Key": idempotencyKey("employee-create") },
      );
      setTemporaryCredentials({
        password: response.temporaryPassword,
        username: employeeUsername,
      });
      await load();
    } catch (cause) {
      setError(message(cause, t("access.errors.action")));
    } finally {
      setSaving(false);
    }
  };

  const userAction = async (
    row: AccessRow,
    name: "disable" | "lock" | "reactivate" | "reset-password" | "unlock",
  ) => {
    const needsReason = name === "disable" || name === "lock" || name === "reset-password";
    const reason = needsReason ? globalThis.prompt(t("common.reason"))?.trim() : undefined;
    if (needsReason && !reason) return;
    setError(undefined);
    try {
      const response = await api.post<{ temporaryPassword?: string }>(
        `users/${row.accountId}/${name}`,
        reason ? { reason } : {},
      );
      if (name === "reset-password" && response.temporaryPassword) {
        setTemporaryCredentials({
          password: response.temporaryPassword,
          username: String(row.username ?? row.accountId),
        });
      }
      await load();
    } catch (cause) {
      setError(message(cause, t("access.errors.action")));
    }
  };

  const action = async (
    row: AccessRow,
    name: "restore" | "revoke" | "revoke-sessions" | "suspend",
  ) => {
    const reason =
      name === "suspend" || name === "revoke"
        ? globalThis.prompt(t("common.reason"))?.trim()
        : undefined;
    if ((name === "suspend" || name === "revoke") && !reason) return;
    try {
      await api.post(`configuration/business-access/${row.id}/${name}`, reason ? { reason } : {});
      await load();
    } catch (cause) {
      setError(message(cause, t("access.errors.action")));
    }
  };

  return (
    <section className="detail-panel business-access-panel">
      <header>
        <div>
          <h3>{t(kind === "trader" ? "access.portalUsers" : "access.systemAccess")}</h3>
          <p>{t("access.sourceOwned")}</p>
          <p>
            {t("access.requiredAccountKind")}:{" "}
            <strong>
              {t(`userAdmin.accountKinds.${kind === "employee" ? "company_user" : kind}`)}
            </strong>
          </p>
        </div>
      </header>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {kind === "trader" ? (
        rows.some((row) => row.accessStatus !== "revoked") ? null : (
          <div className="business-access-linker">
            <button
              className="button button-primary"
              disabled={saving}
              onClick={() => void createTraderPortalUser()}
              type="button"
            >
              {saving ? t("common.working") : t("access.createTraderPortalUser")}
            </button>
          </div>
        )
      ) : kind === "employee" && !rows.some((row) => row.accessStatus !== "revoked") ? (
        <div className="business-access-linker">
          <fieldset>
            <legend>{t("userAdmin.roles")}</legend>
            {employeeCreationRoles.map((role) => (
              <label key={role.id}>
                <input
                  checked={employeeRoleIds.includes(role.id)}
                  onChange={(event) =>
                    setEmployeeRoleIds((current) =>
                      event.target.checked
                        ? [...current, role.id]
                        : current.filter((id) => id !== role.id),
                    )
                  }
                  type="checkbox"
                />
                {role.name}
              </label>
            ))}
          </fieldset>
          <p>
            {t("userAdmin.username")}: <bdi>{employeeUsername || "—"}</bdi>
          </p>
          <button
            className="button button-primary"
            disabled={saving || !employeeUsername || employeeRoleIds.length === 0}
            onClick={() => void createEmployeeUser()}
            type="button"
          >
            {saving ? t("common.working") : t("access.createEmployeeUser")}
          </button>
        </div>
      ) : rows.some((row) => row.accessStatus !== "revoked") ? null : (
        <div className="business-access-linker">
          <button
            className="button button-secondary"
            onClick={() => {
              setError(undefined);
              setCreating(true);
            }}
            type="button"
          >
            {t("access.createEmployeeUser")}
          </button>
          {users.length > 0 ? (
            <>
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                <option value="">{t("access.linkEligibleExisting")}</option>
                {users.map((user) => (
                  <option key={user.accountId} value={user.accountId}>
                    {user.username} · {user.displayName} ·{" "}
                    {t(`userAdmin.accountKinds.${user.accountKind}`)}
                  </option>
                ))}
              </select>
              <button
                className="button button-primary"
                disabled={!accountId}
                onClick={() => void link()}
                type="button"
              >
                {t("access.link")}
              </button>
            </>
          ) : null}
        </div>
      )}
      {rows.length === 0 ? (
        <p>{t("access.noLinkedUser")}</p>
      ) : (
        <div className="table-scroll-x">
          <table>
            <thead>
              <tr>
                {[
                  "user",
                  "username",
                  "accountKind",
                  "contact",
                  "status",
                  "roles",
                  "activity",
                  "actions",
                ].map((key) => (
                  <th key={key}>{t(`access.columns.${key}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{String(row.displayName ?? row.accountId)}</td>
                  <td>
                    <bdi>{String(row.username ?? "—")}</bdi>
                  </td>
                  <td>{t(`userAdmin.accountKinds.${String(row.accountKind)}`)}</td>
                  <td>
                    {String(row.email ?? "—")}
                    <small>
                      <bdi>{String(row.mobileNumber ?? "—")}</bdi>
                    </small>
                  </td>
                  <td>
                    {t(`access.status.${row.accessStatus}`)}
                    <small>
                      {t("access.userStatus")}: {String(row.userStatus ?? "—")}
                    </small>
                    <small>
                      {t("access.mustChangePassword")}:{" "}
                      {row.mustChangePassword ? t("common.yes") : t("common.no")}
                    </small>
                  </td>
                  <td>{Array.isArray(row.roles) ? row.roles.join(", ") : "—"}</td>
                  <td>
                    {t("access.lastLogin")}: {String(row.lastLoginAt ?? "—")}
                    <small>
                      {t("access.linkCreated")}: {String(row.linkCreatedAt ?? "—")}
                    </small>
                  </td>
                  <td>
                    <div className="table-actions">
                      <button
                        onClick={() => onNavigate(`/configuration/users/${row.accountId}`)}
                        type="button"
                      >
                        {t("access.openUser")}
                      </button>
                      <button onClick={() => void userAction(row, "reset-password")} type="button">
                        {t("userAdmin.resetPassword")}
                      </button>
                      {row.userStatus === "locked" ? (
                        <button onClick={() => void userAction(row, "unlock")} type="button">
                          {t("userAdmin.unlock")}
                        </button>
                      ) : (
                        <button onClick={() => void userAction(row, "lock")} type="button">
                          {t("userAdmin.lock")}
                        </button>
                      )}
                      {row.userStatus === "disabled" ? (
                        <button onClick={() => void userAction(row, "reactivate")} type="button">
                          {t("userAdmin.reactivate")}
                        </button>
                      ) : (
                        <button onClick={() => void userAction(row, "disable")} type="button">
                          {t("userAdmin.disable")}
                        </button>
                      )}
                      {row.accessStatus !== "revoked" ? (
                        <>
                          {row.accessStatus === "suspended" ? (
                            <button onClick={() => void action(row, "restore")} type="button">
                              {t("access.restore")}
                            </button>
                          ) : row.accessStatus !== "revoked" ? (
                            <button onClick={() => void action(row, "suspend")} type="button">
                              {t("access.suspend")}
                            </button>
                          ) : null}
                          {row.accessStatus !== "revoked" ? (
                            <button onClick={() => void action(row, "revoke")} type="button">
                              {t("access.revoke")}
                            </button>
                          ) : null}
                        </>
                      ) : null}
                      <button onClick={() => void action(row, "revoke-sessions")} type="button">
                        {t("access.revokeSessions")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && kind !== "employee" ? (
        <CreateLinkedUser
          api={api}
          base={base}
          kind={kind}
          profileCode={profileCode}
          profileName={profileName}
          roles={roles}
          onClose={() => setCreating(false)}
          onCreated={async (credentials) => {
            setCreating(false);
            setTemporaryCredentials(credentials);
            await load();
          }}
          onError={(cause) => setError(message(cause, t("access.errors.action")))}
        />
      ) : null}
      {temporaryCredentials ? (
        <Modal
          closeLabel={t("common.close")}
          onRequestClose={() => setTemporaryCredentials(undefined)}
          title={t("access.temporaryPassword")}
          titleId="business-access-temporary-password"
        >
          <p>{t("access.temporaryPasswordWarning")}</p>
          <p>
            <strong>{t("userAdmin.username")}:</strong> <bdi>{temporaryCredentials.username}</bdi>
          </p>
          <div className="temporary-password-value">
            <bdi>{temporaryCredentials.password}</bdi>
          </div>
          <div className="modal-actions">
            <button
              className="button button-primary"
              onClick={() => setTemporaryCredentials(undefined)}
              type="button"
            >
              {t("common.done")}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function CreateLinkedUser({
  api,
  base,
  kind,
  profileCode,
  profileName,
  roles,
  onClose,
  onCreated,
  onError,
}: {
  readonly api: ApiClient;
  readonly base: string;
  readonly kind: Kind;
  readonly profileCode?: string | undefined;
  readonly profileName?: string | undefined;
  readonly roles: readonly RoleOption[];
  readonly onClose: () => void;
  readonly onCreated: (credentials: TemporaryCredentials) => Promise<void>;
  readonly onError: (cause: unknown) => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState(
    profileCode ? `${kind === "employee" ? "employee" : kind}.${profileCode.toLowerCase()}` : "",
  );
  const [displayName, setDisplayName] = useState(profileName ?? "");
  // Email is optional and is not copied automatically from the Employee
  // record because that address may already identify another Company User.
  const [email, setEmail] = useState("");
  // Mobile is also an optional login identifier. Do not copy it automatically:
  // one person or business contact number may already identify another account.
  const [mobileNumber, setMobileNumber] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState<"en" | "ar">("en");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await api.post<{ temporaryPassword: string }>(
        `${base}/create-user`,
        {
          displayName,
          ...(email.trim() ? { email } : {}),
          ...(mobileNumber.trim() ? { mobileNumber } : {}),
          preferredLanguage,
          ...(kind === "employee" ? { roleIds } : {}),
          username,
        },
        { "X-Idempotency-Key": idempotencyKey(`${kind}-create`) },
      );
      await onCreated({ password: response.temporaryPassword, username });
    } catch (cause) {
      onError(cause);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("access.createAndLink")}
      titleId={`create-${kind}-user-title`}
    >
      <form onSubmit={(event) => void submit(event)}>
        <p>{t("access.accountKindManagedBySystem")}</p>
        <label className="field">
          <span>{t("userAdmin.accountKind")}</span>
          <input
            disabled
            value={t(`userAdmin.accountKinds.${kind === "employee" ? "company_user" : kind}`)}
          />
        </label>
        <label className="field">
          <span>{t("userAdmin.username")}</span>
          <input
            required
            minLength={3}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("common.name")}</span>
          <input
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("access.emailOptional")}</span>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="field">
          <span>{t("access.mobileOptional")}</span>
          <input value={mobileNumber} onChange={(event) => setMobileNumber(event.target.value)} />
        </label>
        <label className="field">
          <span>{t("userAdmin.preferredLanguage")}</span>
          <select
            value={preferredLanguage}
            onChange={(event) => setPreferredLanguage(event.target.value as "en" | "ar")}
          >
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </select>
        </label>
        {kind === "employee" ? (
          <fieldset>
            <legend>{t("userAdmin.roles")}</legend>
            {roles.map((role) => (
              <label key={role.id}>
                <input
                  checked={roleIds.includes(role.id)}
                  onChange={(event) =>
                    setRoleIds((current) =>
                      event.target.checked
                        ? [...current, role.id]
                        : current.filter((id) => id !== role.id),
                    )
                  }
                  type="checkbox"
                />
                {role.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button
            className="button button-primary"
            disabled={saving || (kind === "employee" && roleIds.length === 0)}
            type="submit"
          >
            {saving ? t("common.saving") : t("access.createAndLink")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
